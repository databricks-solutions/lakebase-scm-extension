import * as vscode from 'vscode';
import { LakebaseService } from '../services/lakebaseService';
import { SchemaDiffService } from '../services/schemaDiffService';
import { SchemaMigrationService } from '../services/schemaMigrationService';

/**
 * Content provider that returns CREATE TABLE DDL for a table on a specific branch.
 * URI format: lakebase-schema-content://production/<tableName>
 *         or: lakebase-schema-content://branch/<tableName>
 *
 * Used by the multi-diff editor to show schema diffs as DDL text.
 */
export class SchemaContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private schemaDiffService: SchemaDiffService,
    private migrationService?: SchemaMigrationService,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const side = uri.authority; // 'production' or 'branch'
    const tableName = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;

    // Prefer cached diff (fast). When empty, run a live compare — this also
    // primes the cache for the SCM provider and other callers. On error we
    // still fall through to the migration-file parser below for offline/DDL-only.
    let diff = this.schemaDiffService.getCachedDiff();
    if (!diff) {
      const live = await this.schemaDiffService.compareBranchSchemas();
      if (live && !live.error) { diff = live; }
    }

    if (diff) {
      if (side === 'branch') {
        // Look in branchTables for the full column list
        const table = diff.branchTables.find(t => t.name === tableName);
        if (table) { return this.renderCreateTable(table.name, table.columns || []); }

        // Check if it's a created table (in diff.created)
        const created = diff.created.find(t => t.name === tableName);
        if (created) { return this.renderCreateTable(created.name, created.columns || []); }
      }

      if (side === 'production') {
        // For production, check if the table is in modified (has prodColumns)
        const modified = diff.modified.find(t => t.name === tableName);
        if (modified && modified.prodColumns) {
          return this.renderCreateTable(modified.name, modified.prodColumns);
        }

        // If the table is "created" on the branch, it doesn't exist on production
        const created = diff.created.find(t => t.name === tableName);
        if (created) { return ''; } // empty — new table

        // For unchanged or removed tables, production = branch
        const branchTable = diff.branchTables.find(t => t.name === tableName);
        if (branchTable) { return this.renderCreateTable(branchTable.name, branchTable.columns || []); }
      }
    }

    // Fallback: parse migration files for table DDL
    if (this.migrationService) {
      const migrations = this.migrationService.listMigrations();
      if (migrations.length > 0) {
        const changes = this.migrationService.parseMigrationSchemaChanges(migrations);

        if (side === 'production') {
          // Production side: only show DDL for tables that are MODIFIED (existed before)
          // For CREATED tables, production should be empty (table didn't exist)
          const isCreated = changes.some(c => c.tableName === tableName && c.type === 'created');
          if (isCreated) { return ''; }
          // For modified tables, we don't have the "before" state from migrations alone
          // Return empty to show the full diff as additions
          const isModified = changes.some(c => c.tableName === tableName && c.type === 'modified');
          if (isModified) { return ''; }
        }

        // Branch side: accumulate all columns from migrations
        const columns: Array<{ name: string; dataType: string }> = [];
        for (const c of changes) {
          if (c.tableName === tableName) {
            columns.push(...c.columns);
          }
        }
        if (columns.length > 0) {
          return this.renderCreateTable(tableName, columns);
        }
      }
    }

    return `-- No schema data available for ${tableName}\n-- Run "Review Branch" or "Branch Diff" to populate via pg_dump\n`;
  }

  private renderCreateTable(name: string, columns: Array<{ name: string; dataType: string }>): string {
    if (columns.length === 0) {
      return `CREATE TABLE ${name} (\n  -- no column data available\n);\n`;
    }
    const colDefs = columns.map(c => `  ${c.name} ${c.dataType}`).join(',\n');
    return `CREATE TABLE ${name} (\n${colDefs}\n);\n`;
  }
}
