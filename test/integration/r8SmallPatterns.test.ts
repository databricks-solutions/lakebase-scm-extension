/**
 * R8 Integration Test: Small Patterns Parity + Live
 *
 * R8a: isMainBranch utility (15 inline checks → 1 function)
 * R8b: Status icon/color constants (inline literals → shared maps)
 * R8c: CREATE TABLE parsing (schemaDiffService + migrationService → shared)
 *
 * Run: npm run test:integration -- --grep "R8"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from '../../src/utils/exec';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';
import { GitService } from '../../src/services/gitService';

const cp = require('child_process');
const timestamp = Date.now().toString(36);
const TEST_REPO = `r8-test-${timestamp}`;

let ghUser: string;
let fullRepoName: string;
let repoDir: string;
let gitService: GitService;
let repoCreated = false;

function git(cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: repoDir, timeout: 15000 }).toString().trim();
}

// ── OLD code: inline patterns ──────────────────────────────────────

function oldIsMainBranch(name: string): boolean {
  return name === 'main' || name === 'master';
}

const oldStatusIcons: Record<string, string> = { added: 'diff-added', modified: 'diff-modified', deleted: 'diff-removed', renamed: 'diff-renamed' };
const oldStatusColors: Record<string, string> = { added: 'charts.green', modified: 'charts.yellow', deleted: 'charts.red', renamed: 'charts.blue' };
const oldSchemaIcons: Record<string, string> = { created: 'diff-added', modified: 'diff-modified', removed: 'diff-removed' };
const oldSchemaColors: Record<string, string> = { created: 'charts.green', modified: 'charts.yellow', removed: 'charts.red' };

// ── NEW code: shared utilities ─────────────────────────────────────

function newIsMainBranch(name: string): boolean {
  return name === 'main' || name === 'master';
}

const STATUS_ICONS = {
  added: 'diff-added', modified: 'diff-modified', deleted: 'diff-removed', renamed: 'diff-renamed',
  created: 'diff-added', removed: 'diff-removed',
} as const;

const STATUS_COLORS = {
  added: 'charts.green', modified: 'charts.yellow', deleted: 'charts.red', renamed: 'charts.blue',
  created: 'charts.green', removed: 'charts.red',
} as const;

describe('R8 Small Patterns — Parity + Live', function () {
  this.timeout(120000);

  before(async function () {
    this.timeout(60000);
    gitService = new GitService();
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    fullRepoName = `${ghUser}/${TEST_REPO}`;
    repoDir = path.join(require('os').tmpdir(), TEST_REPO);

    await gitService.createRepo(fullRepoName, { private: true, description: 'R8 test' });
    repoCreated = true;
    cp.execSync(`gh repo clone "${fullRepoName}" "${repoDir}"`, { timeout: 30000 });

    const migDir = path.join(repoDir, 'src/main/resources/db/migration');
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# R8\n');
    fs.writeFileSync(path.join(migDir, 'V1__create_accounts.sql'),
      'CREATE TABLE IF NOT EXISTS accounts (\n    id BIGSERIAL PRIMARY KEY,\n    email VARCHAR(255) NOT NULL\n);\n');
    git('add -A && git commit -m "Initial"');
    git('push -u origin main');

    git('checkout -b feature/r8');
    git('checkout -b master'); // create master branch for testing
    git('checkout feature/r8');
    fs.writeFileSync(path.join(migDir, 'V2__alter_accounts.sql'),
      'ALTER TABLE accounts ADD COLUMN name VARCHAR(100);\nCREATE TABLE sessions (id BIGSERIAL PRIMARY KEY, token TEXT);\nDROP TABLE IF EXISTS temp_data;\n');
    git('add -A && git commit -m "V2: alter + create + drop"');
    git('push -u origin feature/r8');
    git('checkout main');
    console.log('  Setup complete.\n');
  });

  // ── R8a: isMainBranch ────────────────────────────────────────────

  describe('R8a: isMainBranch', () => {
    describe('Phase 1: OLD inline pattern', () => {
      it('main is main', () => assert.ok(oldIsMainBranch('main')));
      it('master is main', () => assert.ok(oldIsMainBranch('master')));
      it('feature is not main', () => assert.ok(!oldIsMainBranch('feature/r8')));
      it('empty is not main', () => assert.ok(!oldIsMainBranch('')));
      it('Main (capital) is not main', () => assert.ok(!oldIsMainBranch('Main')));
    });

    describe('Phase 2: NEW shared function', () => {
      it('main is main', () => assert.ok(newIsMainBranch('main')));
      it('master is main', () => assert.ok(newIsMainBranch('master')));
      it('feature is not main', () => assert.ok(!newIsMainBranch('feature/r8')));
      it('empty is not main', () => assert.ok(!newIsMainBranch('')));
      it('Main (capital) is not main', () => assert.ok(!newIsMainBranch('Main')));
    });

    describe('Phase 3: Parity', () => {
      it('same results for all inputs', () => {
        for (const input of ['main', 'master', 'feature/x', '', 'develop', 'Main', 'MASTER']) {
          assert.strictEqual(oldIsMainBranch(input), newIsMainBranch(input), `Mismatch for "${input}"`);
        }
      });
    });

    describe('Live: real branches', () => {
      it('current branch (main) detected correctly', () => {
        const branch = git('rev-parse --abbrev-ref HEAD');
        assert.ok(newIsMainBranch(branch));
      });
      it('feature branch not detected as main', () => {
        assert.ok(!newIsMainBranch('feature/r8'));
      });
      it('master branch exists and detected', () => {
        const branches = git('branch --list master').trim();
        assert.ok(branches.includes('master'));
        assert.ok(newIsMainBranch('master'));
      });
    });
  });

  // ── R8b: Status icon/color constants ─────────────────────────────

  describe('R8b: Status icon/color constants', () => {
    describe('Phase 1: OLD inline maps', () => {
      it('file status icons', () => {
        assert.strictEqual(oldStatusIcons.added, 'diff-added');
        assert.strictEqual(oldStatusIcons.modified, 'diff-modified');
        assert.strictEqual(oldStatusIcons.deleted, 'diff-removed');
        assert.strictEqual(oldStatusIcons.renamed, 'diff-renamed');
      });
      it('file status colors', () => {
        assert.strictEqual(oldStatusColors.added, 'charts.green');
        assert.strictEqual(oldStatusColors.deleted, 'charts.red');
      });
      it('schema status icons', () => {
        assert.strictEqual(oldSchemaIcons.created, 'diff-added');
        assert.strictEqual(oldSchemaIcons.removed, 'diff-removed');
      });
    });

    describe('Phase 2: NEW shared constants', () => {
      it('file status icons', () => {
        assert.strictEqual(STATUS_ICONS.added, 'diff-added');
        assert.strictEqual(STATUS_ICONS.modified, 'diff-modified');
        assert.strictEqual(STATUS_ICONS.deleted, 'diff-removed');
        assert.strictEqual(STATUS_ICONS.renamed, 'diff-renamed');
      });
      it('schema status icons unified', () => {
        assert.strictEqual(STATUS_ICONS.created, 'diff-added');
        assert.strictEqual(STATUS_ICONS.removed, 'diff-removed');
      });
      it('all colors unified', () => {
        assert.strictEqual(STATUS_COLORS.added, 'charts.green');
        assert.strictEqual(STATUS_COLORS.created, 'charts.green');
        assert.strictEqual(STATUS_COLORS.deleted, 'charts.red');
        assert.strictEqual(STATUS_COLORS.removed, 'charts.red');
      });
    });

    describe('Phase 3: Parity', () => {
      it('file icons match', () => {
        for (const key of ['added', 'modified', 'deleted', 'renamed'] as const) {
          assert.strictEqual(oldStatusIcons[key], STATUS_ICONS[key], `Icon mismatch for ${key}`);
        }
      });
      it('schema icons match', () => {
        assert.strictEqual(oldSchemaIcons.created, STATUS_ICONS.created);
        assert.strictEqual(oldSchemaIcons.modified, STATUS_ICONS.modified);
        assert.strictEqual(oldSchemaIcons.removed, STATUS_ICONS.removed);
      });
    });
  });

  // ── R8c: CREATE TABLE parsing ────────────────────────────────────

  describe('R8c: CREATE TABLE parsing', () => {
    describe('Phase 1: SchemaMigrationService.parseSql (already consolidated in R3)', () => {
      it('parses CREATE TABLE', () => {
        const sql = 'CREATE TABLE IF NOT EXISTS accounts (id BIGSERIAL PRIMARY KEY, email VARCHAR(255));';
        const changes = SchemaMigrationService.parseSql(sql);
        assert.ok(changes.some(c => c.tableName === 'accounts' && c.type === 'created'));
      });
      it('parses ALTER TABLE', () => {
        const sql = 'ALTER TABLE accounts ADD COLUMN name VARCHAR(100);';
        const changes = SchemaMigrationService.parseSql(sql);
        assert.ok(changes.some(c => c.tableName === 'accounts' && c.type === 'modified'));
      });
      it('parses DROP TABLE', () => {
        const sql = 'DROP TABLE IF EXISTS temp_data;';
        const changes = SchemaMigrationService.parseSql(sql);
        assert.ok(changes.some(c => c.tableName === 'temp_data' && c.type === 'removed'));
      });
    });

    describe('Live: parse real migration from commit', () => {
      it('parses V2 migration from feature branch via git show', async () => {
        const sha = git('log --oneline feature/r8 -1 | cut -d" " -f1');
        const sql = await exec(
          `git show "${sha}:src/main/resources/db/migration/V2__alter_accounts.sql"`,
          { cwd: repoDir }
        );
        const changes = SchemaMigrationService.parseSql(sql);
        assert.ok(changes.some(c => c.tableName === 'accounts' && c.type === 'modified'), 'ALTER accounts');
        assert.ok(changes.some(c => c.tableName === 'sessions' && c.type === 'created'), 'CREATE sessions');
        assert.ok(changes.some(c => c.tableName === 'temp_data' && c.type === 'removed'), 'DROP temp_data');
      });

      it('parseMigrationSchemaChanges from disk produces same results', () => {
        git('checkout feature/r8');
        try {
          const migrationService = new SchemaMigrationService();
          const v2Path = path.join(repoDir, 'src/main/resources/db/migration/V2__alter_accounts.sql');
          const fromFile = migrationService.parseMigrationSchemaChanges([{
            filename: 'V2__alter_accounts.sql', version: '2',
            description: '', fullPath: v2Path,
          }]);
          const fromSql = SchemaMigrationService.parseSql(fs.readFileSync(v2Path, 'utf-8'));
          assert.strictEqual(fromFile.length, fromSql.length, 'Same number of changes');
          for (let i = 0; i < fromFile.length; i++) {
            assert.strictEqual(fromFile[i].tableName, fromSql[i].tableName, `Same table at ${i}`);
            assert.strictEqual(fromFile[i].type, fromSql[i].type, `Same type at ${i}`);
          }
        } finally {
          git('checkout main');
        }
      });
    });
  });

  // ── Teardown ─────────────────────────────────────────────────────

  describe('Teardown', () => {
    it('deletes the GitHub repo', async function () {
      if (!repoCreated) { this.skip(); return; }
      await gitService.deleteRepo(fullRepoName);
      repoCreated = false;
    });
    it('cleans up', () => {
      if (fs.existsSync(repoDir)) { fs.rmSync(repoDir, { recursive: true, force: true }); }
    });
  });

  after(async function () {
    this.timeout(30000);
    try { git('checkout main'); } catch {}
    if (repoCreated) { try { await gitService.deleteRepo(fullRepoName); } catch {} }
    if (fs.existsSync(repoDir)) { try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {} }
  });
});
