import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, getEnvConfig, getWorkspaceRoot } from '../utils/config';
import { isMigrationMetadataTable } from '../utils/migrationMetadata';
import {
  applySchemaMigrations as substrateApplyMigrations,
  listSchemaMigrations as substrateListMigrations,
  schemaMigrationStatus as substrateMigrationStatus,
  rollbackSchemaMigration as substrateRollbackMigration,
  type ApplySchemaMigrationsResult,
  type SchemaMigrationFile as SubstrateMigrationFile,
  type SchemaMigrationStatusResult,
  type RollbackSchemaMigrationResult,
} from '@databricks-solutions/lakebase-app-dev-kit';
import { LakebaseService } from './lakebaseService';

export interface SchemaMigrationFile {
  version: string;
  description: string;
  filename: string;
  fullPath: string;
}

export interface MigrationSchemaChange {
  type: 'created' | 'modified' | 'removed';
  tableName: string;
  columns: Array<{ name: string; dataType: string }>;
  migration?: SchemaMigrationFile;
}

export class SchemaMigrationService {
  /** Optional. Required by the substrate-proxy methods (apply / rollback /
   *  migrationStatus) so they can resolve the effective Databricks host
   *  the same way SchemaDiffService does. The legacy file-scan paths
   *  (listMigrations, parseAlembic, parseSql, watchMigrations) do not
   *  need it. */
  private lakebaseService?: LakebaseService;

  constructor(lakebaseService?: LakebaseService) {
    this.lakebaseService = lakebaseService;
  }

  /** Resolve {instance, branch, projectDir} from VS Code config + env.
   *  Throws with a single clear message if any required input is missing,
   *  so the call sites do not have to duplicate the same checks. */
  private resolveSubstrateContext(): { instance: string; branch: string; projectDir: string } {
    const instance = getConfig().lakebaseProjectId;
    if (!instance) {
      throw new Error('lakebaseProjectId is not configured. Set it in extension settings or via LAKEBASE_PROJECT_ID.');
    }
    const branch = getEnvConfig().LAKEBASE_BRANCH_ID;
    if (!branch) {
      throw new Error('LAKEBASE_BRANCH_ID is not set in the workspace .env.');
    }
    const projectDir = getWorkspaceRoot();
    if (!projectDir) {
      throw new Error('No workspace root open. Open a folder in VS Code first.');
    }
    return { instance, branch, projectDir };
  }

  /** Mutate DATABRICKS_HOST to the extension's effective host around a
   *  substrate call. The substrate's databricks-CLI shellouts read it
   *  from env. Restore the prior value (including unset) afterwards. */
  private async withEffectiveHost<T>(fn: () => Promise<T>): Promise<T> {
    const host = this.lakebaseService?.getEffectiveHost();
    const prior = process.env.DATABRICKS_HOST;
    if (host) process.env.DATABRICKS_HOST = host;
    try {
      return await fn();
    } finally {
      if (prior === undefined) delete process.env.DATABRICKS_HOST;
      else process.env.DATABRICKS_HOST = prior;
    }
  }

  /** Substrate proxy: enumerate pending + applied migrations against the
   *  current branch. No DB connection required; pure file scan. Returns
   *  the substrate's SchemaMigrationFile shape (includes `tool` + `type`,
   *  omits `fullPath`). The legacy listMigrations() above stays for
   *  call sites that need fullPath. */
  listMigrationsViaSubstrate(): SubstrateMigrationFile[] {
    const projectDir = getWorkspaceRoot();
    if (!projectDir) {
      throw new Error('No workspace root open. Open a folder in VS Code first.');
    }
    return substrateListMigrations({ projectDir });
  }

  /** Substrate proxy: apply all pending migrations against the current
   *  branch. Auto-detects language (Java/Kotlin → Flyway, Python →
   *  Alembic, Node.js → Knex stub). Async so that synchronous context
   *  resolution errors surface as Promise rejections, not sync throws. */
  async applyMigrationsViaSubstrate(): Promise<ApplySchemaMigrationsResult> {
    const ctx = this.resolveSubstrateContext();
    return this.withEffectiveHost(() => substrateApplyMigrations(ctx));
  }

  /** Substrate proxy: roll back to `target`. Target syntax is
   *  tool-specific (Alembic: revision id or "-1"; Flyway Community:
   *  throws — no undo support). */
  async rollbackMigrationViaSubstrate(target: string): Promise<RollbackSchemaMigrationResult> {
    const ctx = this.resolveSubstrateContext();
    return this.withEffectiveHost(() => substrateRollbackMigration({ ...ctx, target }));
  }

  /** Substrate proxy: report current head + pending list. Read-only. */
  async migrationStatusViaSubstrate(): Promise<SchemaMigrationStatusResult> {
    const ctx = this.resolveSubstrateContext();
    return this.withEffectiveHost(() => substrateMigrationStatus(ctx));
  }

  listMigrations(): SchemaMigrationFile[] {
    const root = getWorkspaceRoot();
    if (!root) {
      return [];
    }

    const config = getConfig();
    const migrationDir = path.join(root, config.migrationPath);

    if (!fs.existsSync(migrationDir)) {
      return [];
    }

    const files = fs.readdirSync(migrationDir)
      .filter(f => config.migrationPattern.test(f))
      .sort();

    return files.map(f => {
      // Parse by language: Flyway V{version}__{desc}.sql, Alembic {hash}_{desc}.py, Knex {timestamp}_{desc}.js
      const flywayMatch = f.match(/^V(\d+(?:\.\d+)*)__(.+)\.sql$/i);
      const alembicMatch = f.match(/^([0-9a-f][\w]*)_(.+)\.py$/i);
      const knexMatch = f.match(/^(\d+)_(.+)\.(js|ts)$/i);
      const match = flywayMatch || alembicMatch || knexMatch;
      return {
        version: match ? match[1] : '?',
        description: match ? match[2].replace(/_/g, ' ') : f,
        filename: f,
        fullPath: path.join(migrationDir, f),
      };
    });
  }

  getLatestVersion(): string | undefined {
    const migrations = this.listMigrations();
    if (migrations.length === 0) {
      return undefined;
    }
    return migrations[migrations.length - 1].version;
  }

  getMigrationCount(): number {
    return this.listMigrations().length;
  }

  /**
   * Parse raw SQL to extract schema changes (CREATE TABLE, ALTER TABLE, DROP TABLE).
   * Accepts a SQL string directly – no file I/O needed.
   */
  static parseSql(sql: string): MigrationSchemaChange[] {
    const changes: MigrationSchemaChange[] = [];

    const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\);/gi;
    let match;
    while ((match = createRegex.exec(sql)) !== null) {
      const tableName = match[1];
      if (isMigrationMetadataTable(tableName)) { continue; }
      const columns: Array<{ name: string; dataType: string }> = [];
      for (const line of match[2].split('\n')) {
        const colMatch = line.trim().match(/^(\w+)\s+(.+?)(?:,?\s*$)/);
        if (colMatch && !colMatch[2].match(/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i)) {
          columns.push({ name: colMatch[1], dataType: colMatch[2].replace(/,\s*$/, '') });
        }
      }
      changes.push({ type: 'created', tableName, columns });
    }

    const alterAddRegex = /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\s+(.+?);/gi;
    while ((match = alterAddRegex.exec(sql)) !== null) {
      changes.push({
        type: 'modified', tableName: match[1],
        columns: [{ name: match[2], dataType: match[3] }],
      });
    }

    const dropRegex = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)/gi;
    while ((match = dropRegex.exec(sql)) !== null) {
      changes.push({ type: 'removed', tableName: match[1], columns: [] });
    }

    return changes;
  }

  /**
   * Parse migration files to extract schema changes.
   * Supports SQL (Flyway/Knex), Python (Alembic op.create_table/drop_table/add_column).
   */
  parseMigrationSchemaChanges(migrations: SchemaMigrationFile[]): MigrationSchemaChange[] {
    const changes: MigrationSchemaChange[] = [];
    for (const mig of migrations) {
      if (!fs.existsSync(mig.fullPath)) { continue; }
      const content = fs.readFileSync(mig.fullPath, 'utf-8');
      const parser = mig.filename.endsWith('.py') ? SchemaMigrationService.parseAlembic : SchemaMigrationService.parseSql;
      for (const change of parser(content)) {
        changes.push({ ...change, migration: mig });
      }
    }
    return changes;
  }

  /** Parse Alembic Python migration files for op.create_table, op.drop_table, op.add_column */
  static parseAlembic(py: string): MigrationSchemaChange[] {
    const changes: MigrationSchemaChange[] = [];
    let match;

    // op.create_table('name', ...)
    const createRegex = /op\.create_table\(\s*['"](\w+)['"]/g;
    while ((match = createRegex.exec(py)) !== null) {
      const tableName = match[1];
      // Extract sa.Column('name', sa.Type) from the create_table block
      const columns: Array<{ name: string; dataType: string }> = [];
      const blockStart = match.index;
      const blockEnd = py.indexOf(')', blockStart + match[0].length);
      if (blockEnd > blockStart) {
        const block = py.substring(blockStart, blockEnd);
        const colRegex = /sa\.Column\(\s*['"](\w+)['"]\s*,\s*sa\.(\w+)/g;
        let colMatch;
        while ((colMatch = colRegex.exec(block)) !== null) {
          columns.push({ name: colMatch[1], dataType: colMatch[2] });
        }
      }
      changes.push({ type: 'created', tableName, columns });
    }

    // op.drop_table('name')
    const dropRegex = /op\.drop_table\(\s*['"](\w+)['"]/g;
    while ((match = dropRegex.exec(py)) !== null) {
      changes.push({ type: 'removed', tableName: match[1], columns: [] });
    }

    // op.add_column('table', sa.Column('name', sa.Type))
    const addColRegex = /op\.add_column\(\s*['"](\w+)['"]\s*,\s*sa\.Column\(\s*['"](\w+)['"]\s*,\s*sa\.(\w+)/g;
    while ((match = addColRegex.exec(py)) !== null) {
      changes.push({
        type: 'modified', tableName: match[1],
        columns: [{ name: match[2], dataType: match[3] }],
      });
    }

    return changes;
  }

  watchMigrations(callback: () => void): vscode.Disposable {
    const root = getWorkspaceRoot();
    if (!root) {
      return { dispose: () => {} };
    }

    const config = getConfig();
    const pattern = new vscode.RelativePattern(root, `${config.migrationPath}/${config.migrationGlob}`);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate(callback);
    watcher.onDidChange(callback);
    watcher.onDidDelete(callback);

    return watcher;
  }
}
