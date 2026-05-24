/**
 * R3 Live Integration Test: SchemaMigrationService.parseSql through refactored call sites
 *
 * Scenarios that exercise the consolidated migration parsing:
 * 1. graphWebview fetchSchema: parse SQL from git show at a commit
 * 2. extension.ts reviewBranch: detect new migrations vs main
 * 3. schemaScmProvider: Lakebase group schema changes from uncommitted migrations
 * 4. branchTreeProvider: table list from migration parsing
 *
 * Run: npm run test:integration -- --grep "R3 Live"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from '../../src/utils/exec';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';
import { GitService } from '../../src/services/gitService';

const cp = require('child_process');
const timestamp = Date.now().toString(36);
const TEST_REPO = `r3-live-${timestamp}`;

let ghUser: string;
let fullRepoName: string;
let repoDir: string;
let gitService: GitService;
let repoCreated = false;
const migPath = 'src/main/resources/db/migration';

function git(cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: repoDir, timeout: 15000 }).toString().trim();
}

describe('R3 Live Integration — SchemaMigrationService.parseSql through service layer', function () {
  this.timeout(120000);

  before(async function () {
    this.timeout(60000);
    gitService = new GitService();
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    fullRepoName = `${ghUser}/${TEST_REPO}`;
    repoDir = path.join(require('os').tmpdir(), TEST_REPO);

    console.log(`  Repo: ${fullRepoName}`);
    await gitService.createRepo(fullRepoName, { private: true, description: 'R3 live test' });
    repoCreated = true;
    cp.execSync(`gh repo clone "${fullRepoName}" "${repoDir}"`, { timeout: 30000 });

    const migDir = path.join(repoDir, migPath);
    fs.mkdirSync(migDir, { recursive: true });

    // Commit 1: V1 on main
    fs.writeFileSync(path.join(migDir, 'V1__create_products.sql'),
      'CREATE TABLE products (\n    id BIGSERIAL PRIMARY KEY,\n    name VARCHAR(255) NOT NULL,\n    price DECIMAL(10,2)\n);\n');
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# R3 Live\n');
    git('add -A && git commit -m "V1: products table"');
    git('push -u origin main');

    // Commit 2: feature branch with V2 (CREATE + ALTER) and V3 (DROP)
    git('checkout -b feature/inventory');
    fs.writeFileSync(path.join(migDir, 'V2__create_inventory.sql'),
      'CREATE TABLE inventory (\n    id BIGSERIAL PRIMARY KEY,\n    product_id BIGINT REFERENCES products(id),\n    warehouse VARCHAR(100),\n    quantity INT DEFAULT 0\n);\n\nCREATE TABLE warehouse_locations (\n    id BIGSERIAL PRIMARY KEY,\n    name VARCHAR(100),\n    address TEXT\n);\n\nALTER TABLE products ADD COLUMN sku VARCHAR(50);\n');
    fs.writeFileSync(path.join(migDir, 'V3__drop_legacy.sql'),
      'DROP TABLE IF EXISTS legacy_products;\nDROP TABLE IF EXISTS temp_import;\n');
    fs.writeFileSync(path.join(repoDir, 'src/inventory.ts'), 'export function checkStock() {}\n');
    git('add -A && git commit -m "V2+V3: inventory, warehouse, alter products, drop legacy"');
    git('push -u origin feature/inventory');

    git('checkout main');
    console.log('  Setup complete.\n');
  });

  // ── Scenario 1: Parse SQL from git show (graphWebview fetchSchema) ──

  describe('Scenario 1: Parse SQL from git show at a commit', () => {
    it('retrieves V2 SQL from feature commit and parses with SchemaMigrationService.parseSql', async () => {
      const sha = git('log --oneline feature/inventory -1 | cut -d" " -f1');
      const sql = await exec(`git show "${sha}:${migPath}/V2__create_inventory.sql"`, { cwd: repoDir });
      const changes = SchemaMigrationService.parseSql(sql);

      assert.ok(changes.some(c => c.tableName === 'inventory' && c.type === 'created'), 'inventory CREATED');
      assert.ok(changes.some(c => c.tableName === 'warehouse_locations' && c.type === 'created'), 'warehouse_locations CREATED');
      assert.ok(changes.some(c => c.tableName === 'products' && c.type === 'modified'), 'products MODIFIED');

      const inv = changes.find(c => c.tableName === 'inventory')!;
      assert.ok(inv.columns.some(c => c.name === 'product_id'), 'inventory has product_id');
      assert.ok(inv.columns.some(c => c.name === 'quantity'), 'inventory has quantity');

      const prod = changes.find(c => c.tableName === 'products' && c.type === 'modified')!;
      assert.ok(prod.columns.some(c => c.name === 'sku'), 'products ALTER added sku');
    });

    it('retrieves V3 SQL and parses DROP TABLE', async () => {
      const sha = git('log --oneline feature/inventory -1 | cut -d" " -f1');
      const sql = await exec(`git show "${sha}:${migPath}/V3__drop_legacy.sql"`, { cwd: repoDir });
      const changes = SchemaMigrationService.parseSql(sql);

      assert.ok(changes.some(c => c.tableName === 'legacy_products' && c.type === 'removed'), 'legacy_products REMOVED');
      assert.ok(changes.some(c => c.tableName === 'temp_import' && c.type === 'removed'), 'temp_import REMOVED');
    });
  });

  // ── Scenario 2: Detect new migrations vs main (reviewBranch) ─────

  describe('Scenario 2: Detect new migrations vs main branch', () => {
    it('lists migrations on main via git ls-tree', async () => {
      const raw = await exec(`git ls-tree -r --name-only main -- "${migPath}"`, { cwd: repoDir });
      const files = raw.split('\n').filter(Boolean).map(f => path.basename(f));
      assert.ok(files.includes('V1__create_products.sql'), 'main has V1');
      assert.ok(!files.includes('V2__create_inventory.sql'), 'main does NOT have V2');
    });

    it('identifies V2 and V3 as new on feature branch', async () => {
      git('checkout feature/inventory');
      const mainMigs = (await exec(`git ls-tree -r --name-only main -- "${migPath}"`, { cwd: repoDir }))
        .split('\n').filter(Boolean).map(f => path.basename(f));
      const mainSet = new Set(mainMigs);

      const fullMigDir = path.join(repoDir, migPath);
      const allFiles = fs.readdirSync(fullMigDir).filter(f => /^V\d+.*\.sql$/.test(f)).sort();
      const newFiles = allFiles.filter(f => !mainSet.has(f));

      assert.deepStrictEqual(newFiles, ['V2__create_inventory.sql', 'V3__drop_legacy.sql']);
      git('checkout main');
    });

    it('parses new migrations with parseMigrationSchemaChanges', () => {
      git('checkout feature/inventory');
      try {
        const migrationService = new SchemaMigrationService();
        const fullMigDir = path.join(repoDir, migPath);
        const newMigs = ['V2__create_inventory.sql', 'V3__drop_legacy.sql'].map(f => ({
          filename: f, version: f.match(/^V(\d+)/)?.[1] || '',
          description: f.replace(/^V\d+__/, '').replace('.sql', ''),
          fullPath: path.join(fullMigDir, f),
        }));
        const changes = migrationService.parseMigrationSchemaChanges(newMigs);

        assert.ok(changes.some(c => c.tableName === 'inventory' && c.type === 'created'));
        assert.ok(changes.some(c => c.tableName === 'products' && c.type === 'modified'));
        assert.ok(changes.some(c => c.tableName === 'legacy_products' && c.type === 'removed'));
        assert.ok(changes[0].migration, 'Should have migration reference');
        assert.ok(changes[0].migration!.filename.startsWith('V'), 'Migration filename preserved');
      } finally {
        git('checkout main');
      }
    });
  });

  // ── Scenario 3: Detect migration files in commit diff ────────────

  describe('Scenario 3: Migration files in commit diff (reviewCommit)', () => {
    it('identifies migration files from diff-tree', async () => {
      const sha = git('log --oneline feature/inventory -1 | cut -d" " -f1');
      const raw = await exec(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir });
      const files = raw.split('\n').filter(Boolean)
        .map(l => { const p = l.split('\t'); return { status: p[0], path: p[p.length - 1] }; });
      const migFiles = files.filter(f => /V\d+.*\.sql$/i.test(f.path));
      const codeFiles = files.filter(f => !/V\d+.*\.sql$/i.test(f.path));

      assert.strictEqual(migFiles.length, 2, 'Should find V2 + V3');
      assert.ok(codeFiles.some(f => f.path.includes('inventory.ts')), 'Should have code file');
    });

    it('parses each migration SQL from the commit', async () => {
      const sha = git('log --oneline feature/inventory -1 | cut -d" " -f1');
      const allChanges: any[] = [];

      for (const migFile of ['V2__create_inventory.sql', 'V3__drop_legacy.sql']) {
        const sql = await exec(`git show "${sha}:${migPath}/${migFile}"`, { cwd: repoDir });
        allChanges.push(...SchemaMigrationService.parseSql(sql));
      }

      const tables = allChanges.map(c => c.tableName).sort();
      assert.ok(tables.includes('inventory'));
      assert.ok(tables.includes('legacy_products'));
      assert.ok(tables.includes('products'));
      assert.ok(tables.includes('temp_import'));
      assert.ok(tables.includes('warehouse_locations'));
    });
  });

  // ── Scenario 4: parseSql consistency with parseMigrationSchemaChanges ──

  describe('Scenario 4: parseSql vs parseMigrationSchemaChanges consistency', () => {
    it('same tables from parseSql(git show) and parseMigrationSchemaChanges(file)', async () => {
      git('checkout feature/inventory');
      try {
        const migrationService = new SchemaMigrationService();
        const fullMigDir = path.join(repoDir, migPath);
        const v2Path = path.join(fullMigDir, 'V2__create_inventory.sql');
        const sql = fs.readFileSync(v2Path, 'utf-8');

        const fromParseSql = SchemaMigrationService.parseSql(sql).map(c => c.tableName).sort();
        const fromFile = migrationService.parseMigrationSchemaChanges([{
          filename: 'V2__create_inventory.sql', version: '2',
          description: '', fullPath: v2Path,
        }]).map(c => c.tableName).sort();

        assert.deepStrictEqual(fromParseSql, fromFile, 'Same tables from both methods');
      } finally {
        git('checkout main');
      }
    });

    it('same column names from both methods', () => {
      git('checkout feature/inventory');
      try {
        const migrationService = new SchemaMigrationService();
        const fullMigDir = path.join(repoDir, migPath);
        const v2Path = path.join(fullMigDir, 'V2__create_inventory.sql');
        const sql = fs.readFileSync(v2Path, 'utf-8');

        const psInv = SchemaMigrationService.parseSql(sql).find(c => c.tableName === 'inventory')!;
        const fInv = migrationService.parseMigrationSchemaChanges([{
          filename: 'V2__create_inventory.sql', version: '2',
          description: '', fullPath: v2Path,
        }]).find(c => c.tableName === 'inventory')!;

        const psCols = psInv.columns.map(c => c.name).sort();
        const fCols = fInv.columns.map(c => c.name).sort();
        assert.deepStrictEqual(psCols, fCols);
      } finally {
        git('checkout main');
      }
    });
  });

  // ── Teardown ─────────────────────────────────────────────────────

  describe('Teardown', () => {
    it('deletes the GitHub repo', async function () {
      if (!repoCreated) { this.skip(); return; }
      await gitService.deleteRepo(fullRepoName);
      repoCreated = false;
    });
    it('cleans up local directory', () => {
      if (fs.existsSync(repoDir)) { fs.rmSync(repoDir, { recursive: true, force: true }); }
    });
  });

  after(async function () {
    this.timeout(30000);
    if (repoCreated) { try { await gitService.deleteRepo(fullRepoName); } catch {} }
    if (fs.existsSync(repoDir)) { try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {} }
  });
});
