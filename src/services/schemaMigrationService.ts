import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, getWorkspaceRoot } from '../utils/config';

export interface MigrationFile {
  version: string;
  description: string;
  filename: string;
  fullPath: string;
}

export interface MigrationSchemaChange {
  type: 'created' | 'modified' | 'removed';
  tableName: string;
  columns: Array<{ name: string; dataType: string }>;
  migration?: MigrationFile;
}

export class SchemaMigrationService {
  listMigrations(): MigrationFile[] {
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
   * Accepts a SQL string directly — no file I/O needed.
   */
  static parseSql(sql: string): MigrationSchemaChange[] {
    const changes: MigrationSchemaChange[] = [];

    const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\);/gi;
    let match;
    while ((match = createRegex.exec(sql)) !== null) {
      const tableName = match[1];
      if (tableName === 'flyway_schema_history') { continue; }
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
  parseMigrationSchemaChanges(migrations: MigrationFile[]): MigrationSchemaChange[] {
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
