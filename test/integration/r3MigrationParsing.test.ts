/**
 * R3 Integration Test: Migration Schema Detection Parity
 *
 * Phase 1: Execute the OLD code (inline SQL parsing in graphWebview + per-site migration diff)
 * Phase 2: Execute the NEW code (SchemaMigrationService.parseSql + getNewMigrationChanges)
 * Compare: Results must be identical
 *
 * Tests against a real repo with migration SQL files.
 *
 * Run: npm run test:integration -- --grep "R3 Migration"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../../src/services/gitService';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';

const cp = require('child_process');
const timestamp = Date.now().toString(36);

let ghUser: string;
let gitService: GitService;

function createMigrationRepo(name: string): { fullName: string; dir: string } {
  const fullName = `${ghUser}/${name}`;
  const dir = path.join(require('os').tmpdir(), name);
  cp.execSync(`gh repo create "${fullName}" --private --description "R3 parity test"`, { timeout: 30000 });
  cp.execSync(`gh repo clone "${fullName}" "${dir}"`, { timeout: 30000 });

  // Commit 1: initial with V1 migration
  const migDir = path.join(dir, 'src/main/resources/db/migration');
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(path.join(migDir, 'V1__create_users_table.sql'),
    'CREATE TABLE IF NOT EXISTS users (\n    id BIGSERIAL PRIMARY KEY,\n    email VARCHAR(255) NOT NULL UNIQUE,\n    name VARCHAR(100) NOT NULL,\n    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# R3 Test\n');
  cp.execSync('git add -A && git commit -m "Initial: users table"', { cwd: dir, timeout: 15000 });
  cp.execSync('git push -u origin main', { cwd: dir, timeout: 15000 });

  // Commit 2: feature branch with V2 (CREATE + ALTER) and V3 (DROP)
  cp.execSync('git checkout -b feature/orders', { cwd: dir, timeout: 5000 });
  fs.writeFileSync(path.join(migDir, 'V2__create_orders_and_alter_users.sql'),
    'CREATE TABLE IF NOT EXISTS orders (\n    id BIGSERIAL PRIMARY KEY,\n    user_id BIGINT NOT NULL REFERENCES users(id),\n    total DECIMAL(10,2) NOT NULL,\n    status VARCHAR(50) DEFAULT \'pending\',\n    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE IF NOT EXISTS order_items (\n    id BIGSERIAL PRIMARY KEY,\n    order_id BIGINT NOT NULL REFERENCES orders(id),\n    product VARCHAR(255) NOT NULL,\n    quantity INT DEFAULT 1,\n    price DECIMAL(10,2) NOT NULL\n);\n\nALTER TABLE users ADD COLUMN last_order_at TIMESTAMP;\n');
  fs.writeFileSync(path.join(migDir, 'V3__drop_temp_table.sql'),
    'DROP TABLE IF EXISTS temp_import;\n');
  cp.execSync('git add -A && git commit -m "Add orders, order_items, alter users, drop temp"', { cwd: dir, timeout: 15000 });
  cp.execSync('git push -u origin feature/orders', { cwd: dir, timeout: 15000 });

  // Merge into main
  cp.execSync('git checkout main', { cwd: dir, timeout: 5000 });
  cp.execSync('git merge feature/orders --no-ff -m "Merge pull request #1 from feature/orders"', { cwd: dir, timeout: 10000 });
  cp.execSync('git push', { cwd: dir, timeout: 15000 });

  return { fullName, dir };
}

function deleteRepo(fullName: string, dir: string): void {
  try { cp.execSync(`gh repo delete "${fullName}" --yes`, { timeout: 15000 }); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── OLD code: inline SQL parsing (copied from graphWebview.ts fetchSchema) ──

function oldParseSql(sql: string): Array<{name: string; status: string; columns: Array<{name: string; type: string; change: string}>}> {
  const tables: Array<{name: string; status: string; columns: Array<{name: string; type: string; change: string}>}> = [];
  const seen = new Set<string>();

  const createRx = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\);/gi;
  let cm: RegExpExecArray | null;
  while ((cm = createRx.exec(sql)) !== null) {
    if (cm[1] === 'flyway_schema_history' || seen.has(cm[1])) { continue; }
    seen.add(cm[1]);
    const cols: Array<{name: string; type: string; change: string}> = [];
    for (const line of cm[2].split('\n')) {
      const colM = line.trim().match(/^(\w+)\s+(.+?)(?:,?\s*$)/);
      if (colM && !/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(colM[2])) {
        cols.push({ name: colM[1], type: colM[2].replace(/,\s*$/, ''), change: 'add' });
      }
    }
    tables.push({ name: cm[1], status: 'CREATED', columns: cols });
  }

  const alterRx = /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\s+(.+?);/gi;
  while ((cm = alterRx.exec(sql)) !== null) {
    const tName = cm[1], cName = cm[2], cType = cm[3];
    if (seen.has(tName)) {
      const t = tables.find(x => x.name === tName);
      if (t) { t.columns.push({ name: cName, type: cType, change: 'add' }); }
    } else {
      seen.add(tName);
      tables.push({ name: tName, status: 'MODIFIED', columns: [{ name: cName, type: cType, change: 'add' }] });
    }
  }

  const dropRx = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)/gi;
  while ((cm = dropRx.exec(sql)) !== null) {
    if (!seen.has(cm[1])) { seen.add(cm[1]); tables.push({ name: cm[1], status: 'REMOVED', columns: [] }); }
  }

  return tables;
}

// ── OLD code: migration diff pattern (copied from extension.ts/schemaScmProvider.ts) ──

function oldGetNewMigrationChanges(repoDir: string, migPath: string): Array<{type: string; tableName: string; columns: Array<{name: string; dataType: string}>}> {
  const migrationService = new SchemaMigrationService();
  const mainMigs = cp.execSync(`git ls-tree -r --name-only main -- "${migPath}"`, { cwd: repoDir, timeout: 5000 })
    .toString().split('\n').filter(Boolean).map((f: string) => path.basename(f));
  const mainSet = new Set(mainMigs);
  const fullMigDir = path.join(repoDir, migPath);
  const allFiles = fs.readdirSync(fullMigDir).filter((f: string) => /^V\d+.*\.sql$/.test(f)).sort();
  const allMigrations = allFiles.map((f: string) => ({
    filename: f, version: f.match(/^V(\d+)/)?.[1] || '',
    description: f.replace(/^V\d+__/, '').replace('.sql', '').replace(/_/g, ' '),
    fullPath: path.join(fullMigDir, f),
  }));
  const newMigrations = allMigrations.filter(m => !mainSet.has(m.filename));
  return migrationService.parseMigrationSchemaChanges(newMigrations);
}

describe('R3 Migration Schema Detection — Parity Test', function () {
  this.timeout(120000);

  let repo: { fullName: string; dir: string };
  const migPath = 'src/main/resources/db/migration';

  before(async function () {
    this.timeout(60000);
    gitService = new GitService();
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    console.log('  Creating test repo with migrations...');
    repo = createMigrationRepo(`r3-test-${timestamp}`);
    console.log(`    ${repo.fullName}`);
  });

  // ── Phase 1: OLD code — inline SQL parsing ───────────────────────

  describe('Phase 1: OLD code (inline SQL parsing from graphWebview)', () => {
    it('parses V2 migration: CREATE TABLE orders + order_items + ALTER users', () => {
      const sql = fs.readFileSync(path.join(repo.dir, migPath, 'V2__create_orders_and_alter_users.sql'), 'utf-8');
      const tables = oldParseSql(sql);
      assert.ok(tables.some(t => t.name === 'orders' && t.status === 'CREATED'), 'Should find orders CREATED');
      assert.ok(tables.some(t => t.name === 'order_items' && t.status === 'CREATED'), 'Should find order_items CREATED');
      assert.ok(tables.some(t => t.name === 'users' && t.status === 'MODIFIED'), 'Should find users MODIFIED');
      const users = tables.find(t => t.name === 'users');
      assert.ok(users!.columns.some(c => c.name === 'last_order_at'), 'users should have last_order_at column');
    });

    it('parses V3 migration: DROP TABLE', () => {
      const sql = fs.readFileSync(path.join(repo.dir, migPath, 'V3__drop_temp_table.sql'), 'utf-8');
      const tables = oldParseSql(sql);
      assert.ok(tables.some(t => t.name === 'temp_import' && t.status === 'REMOVED'), 'Should find temp_import REMOVED');
    });

    it('parses V1 migration: CREATE TABLE users with columns', () => {
      const sql = fs.readFileSync(path.join(repo.dir, migPath, 'V1__create_users_table.sql'), 'utf-8');
      const tables = oldParseSql(sql);
      assert.strictEqual(tables.length, 1);
      assert.strictEqual(tables[0].name, 'users');
      assert.strictEqual(tables[0].status, 'CREATED');
      assert.ok(tables[0].columns.some(c => c.name === 'id'), 'Should have id column');
      assert.ok(tables[0].columns.some(c => c.name === 'email'), 'Should have email column');
      assert.ok(tables[0].columns.some(c => c.name === 'name'), 'Should have name column');
    });

    it('parses SQL from git show at a commit', () => {
      const featureSha = cp.execSync('git log --oneline feature/orders -1 | cut -d" " -f1', { cwd: repo.dir }).toString().trim();
      const sql = cp.execSync(`git show "${featureSha}:${migPath}/V2__create_orders_and_alter_users.sql"`, { cwd: repo.dir, timeout: 5000 }).toString();
      const tables = oldParseSql(sql);
      assert.ok(tables.length >= 3, 'Should find at least 3 table changes');
    });
  });

  // ── Phase 2: NEW code (SchemaMigrationService.parseMigrationSchemaChanges) ──

  describe('Phase 2: NEW code (SchemaMigrationService.parseMigrationSchemaChanges)', () => {
    it('parses V2 migration: CREATE TABLE orders + order_items + ALTER users', () => {
      const migrationService = new SchemaMigrationService();
      const changes = migrationService.parseMigrationSchemaChanges([{
        filename: 'V2__create_orders_and_alter_users.sql', version: '2',
        description: 'create orders and alter users',
        fullPath: path.join(repo.dir, migPath, 'V2__create_orders_and_alter_users.sql'),
      }]);
      assert.ok(changes.some(c => c.tableName === 'orders' && c.type === 'created'), 'Should find orders created');
      assert.ok(changes.some(c => c.tableName === 'order_items' && c.type === 'created'), 'Should find order_items created');
      assert.ok(changes.some(c => c.tableName === 'users' && c.type === 'modified'), 'Should find users modified');
      const users = changes.find(c => c.tableName === 'users' && c.type === 'modified');
      assert.ok(users!.columns.some(c => c.name === 'last_order_at'), 'users should have last_order_at');
    });

    it('parses V3 migration: DROP TABLE', () => {
      const migrationService = new SchemaMigrationService();
      const changes = migrationService.parseMigrationSchemaChanges([{
        filename: 'V3__drop_temp_table.sql', version: '3',
        description: 'drop temp table',
        fullPath: path.join(repo.dir, migPath, 'V3__drop_temp_table.sql'),
      }]);
      assert.ok(changes.some(c => c.tableName === 'temp_import' && c.type === 'removed'), 'Should find temp_import removed');
    });

    it('parses V1 migration: CREATE TABLE users with columns', () => {
      const migrationService = new SchemaMigrationService();
      const changes = migrationService.parseMigrationSchemaChanges([{
        filename: 'V1__create_users_table.sql', version: '1',
        description: 'create users table',
        fullPath: path.join(repo.dir, migPath, 'V1__create_users_table.sql'),
      }]);
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0].tableName, 'users');
      assert.strictEqual(changes[0].type, 'created');
      assert.ok(changes[0].columns.some(c => c.name === 'id'), 'Should have id');
      assert.ok(changes[0].columns.some(c => c.name === 'email'), 'Should have email');
      assert.ok(changes[0].columns.some(c => c.name === 'name'), 'Should have name');
    });

    it('detects new migrations vs main branch', () => {
      // Create a new unmerged feature branch from pre-merge main (main~1)
      cp.execSync('git checkout -b feature/unmerged main~1', { cwd: repo.dir, timeout: 5000 });
      const migDir = path.join(repo.dir, migPath);
      fs.writeFileSync(path.join(migDir, 'V4__create_inventory.sql'),
        'CREATE TABLE IF NOT EXISTS inventory (\n    id BIGSERIAL PRIMARY KEY,\n    product VARCHAR(255),\n    quantity INT DEFAULT 0\n);\n');
      cp.execSync('git add -A && git commit -m "Add inventory table"', { cwd: repo.dir, timeout: 15000 });

      // Now detect new migrations: V4 is new vs main~1 (which only has V1)
      const changes = oldGetNewMigrationChanges(repo.dir, migPath);
      assert.ok(changes.some(c => c.tableName === 'inventory' && c.type === 'created'), 'inventory created');
      cp.execSync('git checkout main', { cwd: repo.dir, timeout: 5000 });
      cp.execSync('git branch -D feature/unmerged', { cwd: repo.dir, timeout: 5000 });
    });
  });

  // ── Phase 3: Parity Comparison ───────────────────────────────────

  describe('Phase 3: Parity Comparison', () => {
    it('same tables detected from V2 SQL', () => {
      const sql = fs.readFileSync(path.join(repo.dir, migPath, 'V2__create_orders_and_alter_users.sql'), 'utf-8');
      const oldTables = oldParseSql(sql).map(t => t.name).sort();

      const migrationService = new SchemaMigrationService();
      const newChanges = migrationService.parseMigrationSchemaChanges([{
        filename: 'V2__create_orders_and_alter_users.sql', version: '2',
        description: '', fullPath: path.join(repo.dir, migPath, 'V2__create_orders_and_alter_users.sql'),
      }]);
      const newTables = newChanges.map(c => c.tableName).sort();

      assert.deepStrictEqual(oldTables, newTables, 'Same tables detected');
    });

    it('same status types (CREATED/MODIFIED/REMOVED vs created/modified/removed)', () => {
      const sql = fs.readFileSync(path.join(repo.dir, migPath, 'V2__create_orders_and_alter_users.sql'), 'utf-8');
      const oldStatuses = oldParseSql(sql).map(t => ({ name: t.name, status: t.status.toLowerCase() })).sort((a, b) => a.name.localeCompare(b.name));

      const migrationService = new SchemaMigrationService();
      const newStatuses = migrationService.parseMigrationSchemaChanges([{
        filename: 'V2__create_orders_and_alter_users.sql', version: '2',
        description: '', fullPath: path.join(repo.dir, migPath, 'V2__create_orders_and_alter_users.sql'),
      }]).map(c => ({ name: c.tableName, status: c.type })).sort((a, b) => a.name.localeCompare(b.name));

      assert.deepStrictEqual(oldStatuses, newStatuses, 'Same statuses');
    });

    it('same column names detected for CREATE TABLE', () => {
      const sql = fs.readFileSync(path.join(repo.dir, migPath, 'V1__create_users_table.sql'), 'utf-8');
      const oldCols = oldParseSql(sql)[0].columns.map(c => c.name).sort();

      const migrationService = new SchemaMigrationService();
      const newCols = migrationService.parseMigrationSchemaChanges([{
        filename: 'V1__create_users_table.sql', version: '1',
        description: '', fullPath: path.join(repo.dir, migPath, 'V1__create_users_table.sql'),
      }])[0].columns.map(c => c.name).sort();

      assert.deepStrictEqual(oldCols, newCols, 'Same columns');
    });

    it('same ALTER TABLE column detected', () => {
      const sql = fs.readFileSync(path.join(repo.dir, migPath, 'V2__create_orders_and_alter_users.sql'), 'utf-8');
      const oldAlter = oldParseSql(sql).find(t => t.name === 'users');
      const oldCol = oldAlter!.columns[0].name;

      const migrationService = new SchemaMigrationService();
      const newAlter = migrationService.parseMigrationSchemaChanges([{
        filename: 'V2__create_orders_and_alter_users.sql', version: '2',
        description: '', fullPath: path.join(repo.dir, migPath, 'V2__create_orders_and_alter_users.sql'),
      }]).find(c => c.tableName === 'users');
      const newCol = newAlter!.columns[0].name;

      assert.strictEqual(oldCol, newCol, 'Same ALTER column name');
    });

    it('same DROP TABLE detected', () => {
      const sql = fs.readFileSync(path.join(repo.dir, migPath, 'V3__drop_temp_table.sql'), 'utf-8');
      const oldDrop = oldParseSql(sql).find(t => t.status === 'REMOVED');

      const migrationService = new SchemaMigrationService();
      const newDrop = migrationService.parseMigrationSchemaChanges([{
        filename: 'V3__drop_temp_table.sql', version: '3',
        description: '', fullPath: path.join(repo.dir, migPath, 'V3__drop_temp_table.sql'),
      }]).find(c => c.type === 'removed');

      assert.strictEqual(oldDrop!.name, newDrop!.tableName, 'Same dropped table');
    });
  });

  // ── Teardown ─────────────────────────────────────────────────────

  describe('Teardown', () => {
    it('deletes the test repo', () => {
      deleteRepo(repo.fullName, repo.dir);
    });
  });

  after(function () {
    this.timeout(30000);
    if (repo) { deleteRepo(repo.fullName, repo.dir); }
  });
});
