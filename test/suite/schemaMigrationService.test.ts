import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';

describe('SchemaMigrationService', () => {
  let service: SchemaMigrationService;
  let tmpDir: string;

  beforeEach(() => {
    service = new SchemaMigrationService();
    tmpDir = path.join('/tmp', `flyway-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'src/main/resources/db/migration'), { recursive: true });
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  describe('listMigrations', () => {
    it('returns empty array when no migration files exist', () => {
      assert.deepStrictEqual(service.listMigrations(), []);
    });

    it('lists V*.sql files sorted by name', () => {
      const migDir = path.join(tmpDir, 'src/main/resources/db/migration');
      fs.writeFileSync(path.join(migDir, 'V2__create_table.sql'), 'CREATE TABLE t;');
      fs.writeFileSync(path.join(migDir, 'V1__init.sql'), '-- init');
      fs.writeFileSync(path.join(migDir, 'V3__add_column.sql'), 'ALTER TABLE t ADD col;');

      const result = service.listMigrations();
      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].version, '1');
      assert.strictEqual(result[0].description, 'init');
      assert.strictEqual(result[1].version, '2');
      assert.strictEqual(result[1].description, 'create table');
      assert.strictEqual(result[2].version, '3');
    });

    it('ignores non-migration files', () => {
      const migDir = path.join(tmpDir, 'src/main/resources/db/migration');
      fs.writeFileSync(path.join(migDir, 'V1__init.sql'), '-- init');
      fs.writeFileSync(path.join(migDir, 'README.md'), '# docs');
      fs.writeFileSync(path.join(migDir, 'data.csv'), 'a,b');

      assert.strictEqual(service.listMigrations().length, 1);
    });

    it('returns empty array when no workspace', () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      assert.deepStrictEqual(service.listMigrations(), []);
    });
  });

  describe('getLatestVersion', () => {
    it('returns undefined when no migrations', () => {
      assert.strictEqual(service.getLatestVersion(), undefined);
    });

    it('returns highest version', () => {
      const migDir = path.join(tmpDir, 'src/main/resources/db/migration');
      fs.writeFileSync(path.join(migDir, 'V1__a.sql'), '');
      fs.writeFileSync(path.join(migDir, 'V5__b.sql'), '');
      fs.writeFileSync(path.join(migDir, 'V3__c.sql'), '');

      assert.strictEqual(service.getLatestVersion(), '5');
    });
  });

  describe('getMigrationCount', () => {
    it('returns 0 when empty', () => {
      assert.strictEqual(service.getMigrationCount(), 0);
    });

    it('counts migration files', () => {
      const migDir = path.join(tmpDir, 'src/main/resources/db/migration');
      fs.writeFileSync(path.join(migDir, 'V1__a.sql'), '');
      fs.writeFileSync(path.join(migDir, 'V2__b.sql'), '');
      assert.strictEqual(service.getMigrationCount(), 2);
    });
  });
});
