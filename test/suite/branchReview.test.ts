import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';
import { GitService } from '../../src/services/gitService';
import { SchemaDiffService, SchemaDiffResult } from '../../src/services/schemaDiffService';
import { SchemaScmProvider } from '../../src/providers/schemaScmProvider';
import { SchemaDiffProvider } from '../../src/providers/schemaDiffProvider';

describe('Branch Review — full branch scope', () => {
  let gitStub: sinon.SinonStubbedInstance<GitService>;
  let migrationStub: sinon.SinonStubbedInstance<SchemaMigrationService>;
  let schemaDiffStub: sinon.SinonStubbedInstance<SchemaDiffService>;
  let provider: SchemaScmProvider;

  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];

    gitStub = sinon.createStubInstance(GitService);
    gitStub.getCachedBranch.returns('feature/orders');
    gitStub.getCurrentBranch.resolves('feature/orders');
    gitStub.getMergeBase.resolves('abc123');
    gitStub.getStagedChanges.resolves([]);
    gitStub.getChangedFiles.resolves([]);
    gitStub.listMigrationsOnBranch.resolves([]);
    (gitStub as any).onBranchChanged = new (vscode as any).EventEmitter().event;

    migrationStub = sinon.createStubInstance(SchemaMigrationService);
    migrationStub.listMigrations.returns([]);
    migrationStub.watchMigrations.returns({ dispose: () => {} });
    migrationStub.parseMigrationSchemaChanges.returns([]);

    schemaDiffStub = sinon.createStubInstance(SchemaDiffService);
  });

  afterEach(() => {
    if (provider) { provider.dispose(); }
    sinon.restore();
  });

  function makeDiff(overrides: Partial<SchemaDiffResult> = {}): SchemaDiffResult {
    return {
      branchName: 'feature-orders',
      timestamp: new Date().toISOString(),
      migrations: [],
      created: [],
      modified: [],
      removed: [],
      branchTables: [],
      inSync: true,
      ...overrides,
    };
  }

  describe('Changes group shows working tree changes (Git SCM parity)', () => {
    it('shows only uncommitted/unstaged changes', async () => {
      gitStub.getStagedChanges.resolves([]);
      gitStub.getUnstagedChanges.resolves([
        { status: 'modified', path: 'src/model/Order.java' },
        { status: 'added', path: 'src/new-file.ts' },
      ]);
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(gitStub.getUnstagedChanges.called);
    });

    it('shows empty Code group when working tree is clean', async () => {
      gitStub.getStagedChanges.resolves([]);
      gitStub.getUnstagedChanges.resolves([]);
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(gitStub.getUnstagedChanges.called);
    });

    it('staged files appear in Staged group, not Code group', async () => {
      gitStub.getStagedChanges.resolves([
        { status: 'modified', path: 'pom.xml' },
      ]);
      gitStub.getUnstagedChanges.resolves([
        { status: 'added', path: 'src/new.ts' },
      ]);
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(gitStub.getStagedChanges.called);
      assert.ok(gitStub.getUnstagedChanges.called);
    });
  });

  describe('Lakebase group — live database diff (requires lakebaseService)', () => {
    it('shows empty lakebase group when no lakebaseService provided', async () => {
      gitStub.getStagedChanges.resolves([]);
      gitStub.getUnstagedChanges.resolves([
        { status: 'added', path: 'src/main/resources/db/migration/V6__create_orders.sql' },
      ]);

      // No lakebaseService → Lakebase group stays empty (live DB diff not available)
      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 150));

      // Migration file parsing is no longer used — schema comes from live DB diff
      assert.strictEqual(migrationStub.parseMigrationSchemaChanges.called, false);
    });

    it('shows empty lakebase group when working tree is clean', async () => {
      gitStub.getStagedChanges.resolves([]);
      gitStub.getUnstagedChanges.resolves([]);

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.strictEqual(migrationStub.parseMigrationSchemaChanges.called, false);
    });
  });

  describe('Combined view — code changes + live DB schema', () => {
    it('shows unstaged code changes; lakebase group empty without lakebaseService', async () => {
      gitStub.getStagedChanges.resolves([]);
      gitStub.getUnstagedChanges.resolves([
        { status: 'added', path: 'src/model/Order.java' },
        { status: 'added', path: 'src/controller/OrderController.java' },
        { status: 'modified', path: 'pom.xml' },
      ]);

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(gitStub.getUnstagedChanges.called);
      // No lakebaseService → no DB diff → no migration parsing
      assert.strictEqual(migrationStub.parseMigrationSchemaChanges.called, false);
    });
  });
});

describe('Branch Diff webview — migration fallback', () => {
  let schemaDiffStub: sinon.SinonStubbedInstance<SchemaDiffService>;
  let gitStub: sinon.SinonStubbedInstance<GitService>;
  let migrationStub: sinon.SinonStubbedInstance<SchemaMigrationService>;
  let diffProvider: SchemaDiffProvider;

  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];

    schemaDiffStub = sinon.createStubInstance(SchemaDiffService);
    gitStub = sinon.createStubInstance(GitService);
    gitStub.getChangedFiles.resolves([]);
    gitStub.listMigrationsOnBranch.resolves([]);

    migrationStub = sinon.createStubInstance(SchemaMigrationService);
    migrationStub.listMigrations.returns([]);
    migrationStub.parseMigrationSchemaChanges.returns([]);

    diffProvider = new SchemaDiffProvider(schemaDiffStub as any, gitStub as any, migrationStub as any);
  });

  afterEach(() => {
    diffProvider.dispose();
    sinon.restore();
  });

  function makeDiff(overrides: Partial<SchemaDiffResult> = {}): SchemaDiffResult {
    return {
      branchName: 'feature-orders',
      timestamp: new Date().toISOString(),
      migrations: [],
      created: [],
      modified: [],
      removed: [],
      branchTables: [],
      inSync: true,
      ...overrides,
    };
  }

  it('supplements in-sync pg_dump with migration file changes', async () => {
    schemaDiffStub.getCachedDiff.returns(makeDiff({ inSync: true }));

    // Branch has V6 not on main
    gitStub.listMigrationsOnBranch.resolves(['V1__init.sql']);
    migrationStub.listMigrations.returns([
      { version: '1', description: 'init', filename: 'V1__init.sql', fullPath: '/fake/V1' },
      { version: '6', description: 'orders', filename: 'V6__create_orders.sql', fullPath: '/fake/V6' },
    ]);
    migrationStub.parseMigrationSchemaChanges.returns([
      { type: 'created', tableName: 'orders', columns: [{ name: 'id', dataType: 'bigint' }], migration: {} as any },
    ]);

    await diffProvider.showDiff(false, []);

    assert.ok(migrationStub.parseMigrationSchemaChanges.called);
  });

  it('does not supplement when pg_dump found real differences', async () => {
    schemaDiffStub.getCachedDiff.returns(makeDiff({
      inSync: false,
      created: [{ type: 'TABLE', name: 'orders' }],
    }));

    await diffProvider.showDiff(false, []);

    // Migration fallback should not be triggered
    assert.strictEqual(migrationStub.parseMigrationSchemaChanges.called, false);
  });

  it('does not supplement when no new migrations exist', async () => {
    schemaDiffStub.getCachedDiff.returns(makeDiff({ inSync: true }));
    gitStub.listMigrationsOnBranch.resolves(['V1__init.sql']);
    migrationStub.listMigrations.returns([
      { version: '1', description: 'init', filename: 'V1__init.sql', fullPath: '/fake/V1' },
    ]);

    await diffProvider.showDiff(false, []);

    assert.strictEqual(migrationStub.parseMigrationSchemaChanges.called, false);
  });
});

describe('SchemaMigrationService — parseMigrationSchemaChanges', () => {
  let service: SchemaMigrationService;
  let tmpDir: string;

  beforeEach(() => {
    service = new SchemaMigrationService();
    tmpDir = path.join('/tmp', `flyway-parse-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('parses CREATE TABLE statements', () => {
    const sqlPath = path.join(tmpDir, 'V6__create_orders.sql');
    fs.writeFileSync(sqlPath, `CREATE TABLE orders (
  id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  total DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);`);

    const migrations = [{ version: '6', description: 'create orders', filename: 'V6__create_orders.sql', fullPath: sqlPath }];
    const changes = service.parseMigrationSchemaChanges(migrations);

    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].type, 'created');
    assert.strictEqual(changes[0].tableName, 'orders');
    assert.ok(changes[0].columns.length >= 3);
    assert.ok(changes[0].columns.find(c => c.name === 'id'));
    assert.ok(changes[0].columns.find(c => c.name === 'customer_id'));
  });

  it('parses multiple CREATE TABLEs in one file', () => {
    const sqlPath = path.join(tmpDir, 'V7__create_order_items.sql');
    fs.writeFileSync(sqlPath, `CREATE TABLE order_item (
  id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  quantity INTEGER DEFAULT 1
);

CREATE TABLE order_status (
  id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  status VARCHAR(50)
);`);

    const migrations = [{ version: '7', description: 'create order items', filename: 'V7__create_order_items.sql', fullPath: sqlPath }];
    const changes = service.parseMigrationSchemaChanges(migrations);

    assert.strictEqual(changes.length, 2);
    assert.strictEqual(changes[0].tableName, 'order_item');
    assert.strictEqual(changes[1].tableName, 'order_status');
  });

  it('parses ALTER TABLE ADD COLUMN', () => {
    const sqlPath = path.join(tmpDir, 'V8__add_email.sql');
    fs.writeFileSync(sqlPath, `ALTER TABLE customer ADD COLUMN email VARCHAR(255);`);

    const migrations = [{ version: '8', description: 'add email', filename: 'V8__add_email.sql', fullPath: sqlPath }];
    const changes = service.parseMigrationSchemaChanges(migrations);

    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].type, 'modified');
    assert.strictEqual(changes[0].tableName, 'customer');
    assert.strictEqual(changes[0].columns[0].name, 'email');
  });

  it('parses DROP TABLE', () => {
    const sqlPath = path.join(tmpDir, 'V9__drop_legacy.sql');
    fs.writeFileSync(sqlPath, `DROP TABLE IF EXISTS legacy_data;`);

    const migrations = [{ version: '9', description: 'drop legacy', filename: 'V9__drop_legacy.sql', fullPath: sqlPath }];
    const changes = service.parseMigrationSchemaChanges(migrations);

    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].type, 'removed');
    assert.strictEqual(changes[0].tableName, 'legacy_data');
  });

  it('skips flyway_schema_history table', () => {
    const sqlPath = path.join(tmpDir, 'V1__init.sql');
    fs.writeFileSync(sqlPath, `CREATE TABLE flyway_schema_history (id INT);
CREATE TABLE real_table (id INT);`);

    const migrations = [{ version: '1', description: 'init', filename: 'V1__init.sql', fullPath: sqlPath }];
    const changes = service.parseMigrationSchemaChanges(migrations);

    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].tableName, 'real_table');
  });

  it('handles CREATE TABLE IF NOT EXISTS', () => {
    const sqlPath = path.join(tmpDir, 'V10__safe_create.sql');
    fs.writeFileSync(sqlPath, `CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL,
  action TEXT
);`);

    const migrations = [{ version: '10', description: 'safe create', filename: 'V10__safe_create.sql', fullPath: sqlPath }];
    const changes = service.parseMigrationSchemaChanges(migrations);

    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].tableName, 'audit_log');
  });

  it('returns empty for non-schema SQL', () => {
    const sqlPath = path.join(tmpDir, 'V11__insert_data.sql');
    fs.writeFileSync(sqlPath, `INSERT INTO config (key, value) VALUES ('version', '1.0');`);

    const migrations = [{ version: '11', description: 'insert data', filename: 'V11__insert_data.sql', fullPath: sqlPath }];
    const changes = service.parseMigrationSchemaChanges(migrations);

    assert.strictEqual(changes.length, 0);
  });
});
