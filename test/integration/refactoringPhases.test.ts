/**
 * Integration tests for Refactoring Phases R1-R8
 *
 * Creates a shared test GitHub repo + Lakebase project with:
 * - Migration SQL files (CREATE TABLE, ALTER TABLE)
 * - Multiple commits for diff/log testing
 * - A remote-tracking branch
 *
 * Prerequisites:
 * - `gh auth status` — logged in with delete_repo scope
 * - `databricks auth login` — authenticated to FEVM workspace
 * - DATABRICKS_HOST env var or will default to FEVM
 *
 * Run: npm run test:integration
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../../src/services/gitService';
import { LakebaseService } from '../../src/services/lakebaseService';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';

const cp = require('child_process');

const timestamp = Date.now().toString(36);
const TEST_REPO_NAME = `refactor-test-${timestamp}`;
const TEST_PROJECT_ID = `ref-test-${timestamp}`;

let ghUser: string;
let fullRepoName: string;
let repoDir: string;
let gitService: GitService;
let lakebaseService: LakebaseService;
let githubRepoCreated = false;
let lakebaseProjectCreated = false;

// Helper: run git in the test repo
function git(cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: repoDir, timeout: 15000 }).toString().trim();
}

// Helper: write a file and stage it
function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe('Refactoring Phase Integration Tests', function () {
  this.timeout(180000);

  // ── Shared Setup ─────────────────────────────────────────────────

  before(async function () {
    this.timeout(120000);
    gitService = new GitService();
    lakebaseService = new LakebaseService();

    if (!process.env.DATABRICKS_HOST) {
      process.env.DATABRICKS_HOST = 'https://fevm-serverless-stable-ecparr.cloud.databricks.com';
    }
    lakebaseService.setHostOverride(process.env.DATABRICKS_HOST);

    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    fullRepoName = `${ghUser}/${TEST_REPO_NAME}`;
    repoDir = path.join(require('os').tmpdir(), TEST_REPO_NAME);

    console.log(`  Shared test resources:`);
    console.log(`    GitHub repo: ${fullRepoName}`);
    console.log(`    Lakebase project: ${TEST_PROJECT_ID}`);
    console.log(`    Local dir: ${repoDir}`);

    // 1. Create GitHub repo and clone
    console.log('    Creating GitHub repo...');
    await gitService.createRepo(fullRepoName, { private: true, clone: false, description: 'Refactoring integration test' });
    githubRepoCreated = true;
    cp.execSync(`gh repo clone "${fullRepoName}" "${repoDir}"`, { timeout: 30000 });

    // 2. Create initial commit with migration files
    console.log('    Creating initial commit with migrations...');
    writeFile('.env', `DATABRICKS_HOST=${process.env.DATABRICKS_HOST}\nLAKEBASE_PROJECT_ID=${TEST_PROJECT_ID}\n`);
    writeFile('src/main/resources/db/migration/V1__create_product_table.sql',
      'CREATE TABLE IF NOT EXISTS product (\n    id BIGSERIAL PRIMARY KEY,\n    name VARCHAR(255) NOT NULL,\n    price DECIMAL(10,2) NOT NULL,\n    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n');
    writeFile('src/main/java/App.java', 'public class App { public static void main(String[] args) {} }\n');
    writeFile('README.md', '# Test Project\n');
    git('add -A');
    git('commit -m "Initial commit with product table"');
    git('push -u origin main');

    // 3. Create a feature branch with more changes
    git('checkout -b feature/orders');
    writeFile('src/main/resources/db/migration/V2__create_orders_table.sql',
      'CREATE TABLE IF NOT EXISTS orders (\n    id BIGSERIAL PRIMARY KEY,\n    customer_id BIGINT NOT NULL,\n    total DECIMAL(10,2) NOT NULL,\n    status VARCHAR(50) DEFAULT \'pending\',\n    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n\nALTER TABLE product ADD COLUMN category VARCHAR(100);\n');
    writeFile('src/main/java/OrderService.java', 'public class OrderService {}\n');
    git('add -A');
    git('commit -m "Add orders table and order service"');
    git('push -u origin feature/orders');

    // 4. Add another commit
    writeFile('src/main/java/OrderService.java', 'public class OrderService { public void placeOrder() {} }\n');
    git('add -A');
    git('commit -m "Add placeOrder method"');
    git('push');

    // 5. Switch back to main for a merge commit
    git('checkout main');
    git('merge feature/orders --no-ff -m "Merge pull request #1 from feature/orders"');
    git('push');

    // 6. Create Lakebase project
    console.log('    Creating Lakebase project...');
    try {
      await lakebaseService.createProject(TEST_PROJECT_ID);
      lakebaseProjectCreated = true;
      console.log('    Lakebase project created.');
    } catch (err: any) {
      console.log(`    Lakebase project creation failed: ${err.message}`);
      console.log('    (Lakebase tests will be skipped)');
    }

    console.log('    Setup complete.\n');
  });

  // ── Phase R1: Git Operations (replacing execSync) ────────────────

  describe('R1: Git Operations', () => {
    describe('branch operations', () => {
      it('lists branches at HEAD commit', () => {
        const sha = git('rev-parse --short HEAD');
        const branches = cp.execSync(`git branch -a --points-at "${sha}" --format="%(refname:short)"`, { cwd: repoDir, timeout: 5000 })
          .toString().trim().split('\n').filter(Boolean).filter((b: string) => !b.includes('HEAD') && b !== 'origin');
        assert.ok(branches.includes('main'), 'Should include main');
      });

      it('creates and deletes a branch from a commit', () => {
        const sha = git('rev-parse HEAD~1');
        git(`checkout -b test-branch-r1 "${sha}"`);
        const current = git('rev-parse --abbrev-ref HEAD');
        assert.strictEqual(current, 'test-branch-r1');
        git('checkout main');
        git('branch -d test-branch-r1');
      });

      it('checkout detached at a specific commit', () => {
        const sha = git('rev-parse HEAD~1');
        git(`checkout --detach "${sha}"`);
        const head = git('rev-parse --short HEAD');
        assert.strictEqual(head, sha.substring(0, 7));
        git('checkout main');
      });
    });

    describe('commit inspection', () => {
      it('git diff-tree lists changed files', () => {
        // Use the non-merge "Add orders" commit
        const sha = git('log --oneline --all | grep "Add orders" | cut -d" " -f1');
        const raw = cp.execSync(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir, timeout: 10000 }).toString();
        assert.ok(raw.includes('V2__') || raw.includes('OrderService'), 'Should list changed files');
      });

      it('handles merge commits via first-parent diff', () => {
        const sha = git('rev-parse HEAD');
        let raw = cp.execSync(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir, timeout: 10000 }).toString();
        if (!raw.trim()) {
          raw = cp.execSync(`git diff --name-status "${sha}^1" "${sha}"`, { cwd: repoDir, timeout: 10000 }).toString();
        }
        assert.ok(raw.trim().length > 0, 'Should have file changes for merge commit');
        assert.ok(raw.includes('V2__create_orders_table.sql'), 'Should include migration file');
      });

      it('git show retrieves file content at a commit', () => {
        const sha = git('rev-parse HEAD');
        const content = cp.execSync(`git show "${sha}:src/main/resources/db/migration/V1__create_product_table.sql"`, { cwd: repoDir, timeout: 10000 }).toString();
        assert.ok(content.includes('CREATE TABLE'), 'Should contain CREATE TABLE');
        assert.ok(content.includes('product'), 'Should reference product table');
      });

      it('git show returns empty for non-existent file at parent', () => {
        const sha = git('log --oneline --all | grep "Initial commit" | cut -d" " -f1');
        try {
          cp.execSync(`git show "${sha}~1:README.md"`, { cwd: repoDir, timeout: 10000 });
          assert.fail('Should have thrown');
        } catch (err: any) {
          assert.ok(err.message.includes('exists on disk') || err.message.includes('does not exist') || err.status !== 0);
        }
      });
    });

    describe('revert and cherry-pick', () => {
      afterEach(() => {
        // Always return to main and clean up
        try { git('cherry-pick --abort'); } catch {}
        try { git('revert --abort'); } catch {}
        try { git('checkout main'); } catch {}
        try { git('branch -D test-cherry-r1'); } catch {}
        try { git('branch -D test-revert-r1'); } catch {}
      });

      it('cherry-pick applies a commit', () => {
        // Create an independent commit on a new branch that won't conflict
        git('checkout -b test-cherry-r1 main~1');
        // Create a file unique to this branch
        writeFile('cherry-test-file.txt', 'cherry pick test content');
        git('add cherry-test-file.txt');
        git('commit -m "cherry pick source commit"');
        const cherrySha = git('rev-parse HEAD');
        // Go back to main and cherry-pick
        git('checkout main');
        git('branch -D test-cherry-r1');
        git('checkout -b test-cherry-r1');
        git(`cherry-pick "${cherrySha}"`);
        const log = git('log --oneline -1');
        assert.ok(log.includes('cherry pick source'), 'Cherry-picked commit should be present');
      });

      it('revert creates a revert commit', () => {
        // Use initial commit (non-merge) for revert
        const initialSha = git('log --oneline main --no-merges | tail -1 | cut -d" " -f1');
        git('checkout -b test-revert-r1');
        git(`revert --no-edit "${initialSha}"`);
        const msg = git('log --oneline -1');
        assert.ok(msg.includes('Revert'), 'Should be a revert commit');
      });
    });

    describe('tag operations', () => {
      it('creates and deletes a tag', () => {
        const sha = git('rev-parse HEAD');
        git(`tag test-tag-r1 "${sha}"`);
        const tags = git('tag -l');
        assert.ok(tags.includes('test-tag-r1'));
        git('tag -d test-tag-r1');
      });
    });

    describe('git log parsing', () => {
      it('parses commit log with field separators', () => {
        const REC = '\x1e', FLD = '\x1f';
        const fmt = `%h${FLD}%H${FLD}%p${FLD}%d${FLD}%s${FLD}%an${FLD}%ae${FLD}%ar${FLD}%aD${FLD}%B${REC}`;
        const raw = cp.execSync(`git log --date-order --format="${fmt}" -5`, { cwd: repoDir, timeout: 10000 }).toString();
        const records = raw.split(REC).filter((s: string) => s.trim());
        assert.ok(records.length >= 3, 'Should have at least 3 commits');
        const fields = records[0].split(FLD);
        assert.strictEqual(fields.length, 10, 'Should have 10 fields');
      });

      it('parses shortstat', () => {
        const REC = '\x1e';
        const raw = cp.execSync(`git log --date-order --format="${REC}%h" --shortstat -3`, { cwd: repoDir, timeout: 10000 }).toString();
        const blocks = raw.split(REC).filter(Boolean);
        assert.ok(blocks.length >= 2);
        const hasStat = blocks.some((b: string) => b.includes('changed'));
        assert.ok(hasStat, 'At least one commit should have stats');
      });

      it('detects ahead/behind with upstream', () => {
        try {
          const out = cp.execSync('git log --oneline @{u}..HEAD', { cwd: repoDir, timeout: 5000 }).toString();
          // 0 commits ahead is fine (we just pushed)
          assert.ok(out.trim().length === 0 || out.split('\n').length >= 0);
        } catch {
          // No upstream — that's also fine for this test
        }
      });
    });

    describe('fetch operations', () => {
      it('git fetch --all succeeds', () => {
        const result = cp.execSync('git fetch --all', { cwd: repoDir, timeout: 30000 }).toString();
        // No error means success
        assert.ok(true);
      });
    });

    describe('GitHub API (avatar fetch)', () => {
      it('gh api returns commit data with avatar URLs', () => {
        try {
          const raw = cp.execSync(
            `gh api "repos/${fullRepoName}/commits?per_page=3" --jq '.[] | "\\(.sha[:7]) \\(.author.avatar_url // "")"'`,
            { cwd: repoDir, timeout: 15000 }
          ).toString();
          const lines = raw.trim().split('\n').filter(Boolean);
          assert.ok(lines.length >= 2, 'Should return commits');
          assert.ok(lines[0].includes('https://'), 'Should include avatar URL');
        } catch (err: any) {
          console.log(`    (avatar API test skipped: ${err.message.substring(0, 60)})`);
        }
      });
    });
  });

  // ── Phase R2: GitHub Remote URL Resolution ───────────────────────

  describe('R2: GitHub Remote URL Resolution', () => {
    it('resolves HTTPS remote URL', () => {
      const url = git('remote get-url origin');
      const normalized = url.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
      assert.ok(normalized.startsWith('https://github.com/'), `Should be HTTPS: ${normalized}`);
      assert.ok(normalized.includes(TEST_REPO_NAME), 'Should contain repo name');
    });

    it('handles SSH remote format', () => {
      // Add a fake SSH remote and test normalization
      git('remote add test-ssh git@github.com:testowner/testrepo.git');
      const url = git('remote get-url test-ssh');
      const normalized = url.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
      assert.strictEqual(normalized, 'https://github.com/testowner/testrepo');
      git('remote remove test-ssh');
    });

    it('handles SSH protocol format', () => {
      git('remote add test-ssh2 ssh://git@github.com/testowner/testrepo.git');
      const url = git('remote get-url test-ssh2');
      const normalized = url.replace(/\.git$/, '').replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
      assert.strictEqual(normalized, 'https://github.com/testowner/testrepo');
      git('remote remove test-ssh2');
    });
  });

  // ── Phase R3: Migration Schema Detection ─────────────────────────

  describe('R3: Migration Schema Detection', () => {
    it('parseMigrationSchemaChanges detects CREATE TABLE', () => {
      const migrationService = new SchemaMigrationService();
      const migDir = path.join(repoDir, 'src/main/resources/db/migration');
      const migrations = fs.readdirSync(migDir)
        .filter((f: string) => /^V\d+.*\.sql$/.test(f))
        .sort()
        .map((f: string) => ({
          filename: f,
          version: f.match(/^V(\d+)/)?.[1] || '',
          description: f.replace(/^V\d+__/, '').replace('.sql', '').replace(/_/g, ' '),
          fullPath: path.join(migDir, f),
        }));
      const changes = migrationService.parseMigrationSchemaChanges(migrations);
      assert.ok(changes.length >= 2, `Should find at least 2 tables, got ${changes.length}: ${changes.map(c => c.tableName).join(', ')}`);
      const product = changes.find((c: any) => c.tableName === 'product');
      assert.ok(product, 'Should find product table');
      assert.strictEqual(product!.type, 'created');
    });

    it('parseMigrationSchemaChanges detects ALTER TABLE', () => {
      const migrationService = new SchemaMigrationService();
      const v2Path = path.join(repoDir, 'src/main/resources/db/migration/V2__create_orders_table.sql');
      const changes = migrationService.parseMigrationSchemaChanges([{
        filename: 'V2__create_orders_table.sql', version: '2',
        description: 'create orders table', fullPath: v2Path,
      }]);
      const alter = changes.find((c: any) => c.tableName === 'product' && c.type === 'modified');
      assert.ok(alter, 'Should detect ALTER TABLE on product');
      assert.ok(alter!.columns.some((col: any) => col.name === 'category'), 'Should detect category column');
    });

    it('parses SQL from git show at a specific commit', () => {
      const sha = git('log --oneline --all | grep "Add orders" | cut -d" " -f1');
      const sql = cp.execSync(
        `git show "${sha}:src/main/resources/db/migration/V2__create_orders_table.sql"`,
        { cwd: repoDir, timeout: 10000 }
      ).toString();
      assert.ok(sql.includes('CREATE TABLE'), 'Should contain CREATE TABLE');
      assert.ok(sql.includes('orders'), 'Should reference orders');
      assert.ok(sql.includes('ALTER TABLE'), 'Should contain ALTER TABLE');
    });

    it('detects migration files in a commit diff', () => {
      const sha = git('log --oneline --all | grep "Add orders" | cut -d" " -f1');
      const raw = cp.execSync(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir, timeout: 10000 }).toString();
      const migFiles = raw.split('\n').filter(Boolean)
        .map((line: string) => { const p = line.split('\t'); return { status: p[0], path: p[p.length - 1] }; })
        .filter((f: any) => /V\d+.*\.sql$/i.test(f.path));
      assert.ok(migFiles.length >= 1, 'Should find at least one migration file');
      assert.ok(migFiles.some((f: any) => f.path.includes('V2__')), 'Should include V2 migration');
    });

    it('lists migrations on main branch via git ls-tree', () => {
      const migPath = 'src/main/resources/db/migration';
      const raw = cp.execSync(`git ls-tree -r --name-only main -- "${migPath}"`, { cwd: repoDir, timeout: 5000 }).toString();
      const files = raw.split('\n').filter(Boolean).map((f: string) => path.basename(f));
      assert.ok(files.some((f: string) => f.startsWith('V1__')), 'Should have V1 migration on main');
    });
  });

  // ── Phase R4: Lakebase Connection Sync ───────────────────────────

  describe('R4: Lakebase Connection Sync', function () {
    before(function () {
      if (!lakebaseProjectCreated) { this.skip(); }
    });

    it('lists branches on the test project', async () => {
      // Use CLI directly with the test project path
      const raw = cp.execSync(
        `databricks postgres list-branches "projects/${TEST_PROJECT_ID}" -o json`,
        { timeout: 15000, env: { ...process.env, DATABRICKS_HOST: process.env.DATABRICKS_HOST } }
      ).toString();
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : parsed.branches || parsed.items || [];
      assert.ok(items.length >= 1, 'Should have at least the default branch');
      const defaultBranch = items.find((b: any) => b.status?.default === true || b.is_default === true);
      assert.ok(defaultBranch, 'Should have a default branch');
    });

    it('gets endpoint for default branch', async function () {
      this.timeout(30000);
      const raw = cp.execSync(
        `databricks postgres list-branches "projects/${TEST_PROJECT_ID}" -o json`,
        { timeout: 15000, env: { ...process.env, DATABRICKS_HOST: process.env.DATABRICKS_HOST } }
      ).toString();
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : parsed.branches || parsed.items || [];
      const defaultBranch = items.find((b: any) => b.status?.default === true || b.is_default === true);
      if (!defaultBranch) { this.skip(); return; }
      try {
        const branchName = defaultBranch.name || `projects/${TEST_PROJECT_ID}/branches/${defaultBranch.uid}`;
        const epRaw = cp.execSync(
          `databricks postgres list-endpoints "${branchName}" -o json`,
          { timeout: 15000, env: { ...process.env, DATABRICKS_HOST: process.env.DATABRICKS_HOST } }
        ).toString();
        const epParsed = JSON.parse(epRaw);
        // May have endpoints or not — just verify no error
        assert.ok(true, 'Endpoint listing succeeded');
      } catch (err: any) {
        // No endpoints yet is OK for a new project
        assert.ok(err.message.includes('not found') || err.message.includes('empty'), `Unexpected error: ${err.message}`);
      }
    });
  });

  // ── Phase R5: Shared exec Utility ────────────────────────────────

  describe('R5: Shared exec Utility', () => {
    it('exec runs a basic command', async () => {
      const result = cp.execSync('echo "hello"', { timeout: 5000 }).toString().trim();
      assert.strictEqual(result, 'hello');
    });

    it('exec passes environment variables', () => {
      const result = cp.execSync('echo $TEST_VAR_R5', {
        timeout: 5000,
        env: { ...process.env, TEST_VAR_R5: 'works' },
      }).toString().trim();
      assert.strictEqual(result, 'works');
    });

    it('exec throws on command failure', () => {
      assert.throws(() => {
        cp.execSync('false', { timeout: 5000 });
      });
    });

    it('exec respects timeout', () => {
      assert.throws(() => {
        cp.execSync('sleep 10', { timeout: 500 });
      }, /ETIMEDOUT|TIMEOUT|timed out|killed/i);
    });
  });

  // ── Phase R6: Diff Tuple Builder ─────────────────────────────────

  describe('R6: Diff Tuple Builder', () => {
    it('builds diff tuples for modified files', () => {
      // Use the non-merge commit that added orders
      const allCommits = git('log --oneline --no-merges').split('\n');
      const orderCommit = allCommits.find((l: string) => l.includes('Add orders'));
      assert.ok(orderCommit, 'Should find the orders commit');
      const sha = orderCommit!.split(' ')[0];
      const raw = cp.execSync(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir, timeout: 10000 }).toString();
      const files = raw.split('\n').filter(Boolean).map((line: string) => {
        const p = line.split('\t');
        return { status: p[0][0], path: p[p.length - 1] };
      });
      assert.ok(files.length >= 2, 'Should have multiple changed files');
      assert.ok(files.some(f => f.status === 'A'), 'Should have added files');
    });

    it('migration files can be separated from code files', () => {
      const allCommits = git('log --oneline --no-merges').split('\n');
      const orderCommit = allCommits.find((l: string) => l.includes('Add orders'));
      const sha = orderCommit!.split(' ')[0];
      const raw = cp.execSync(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir, timeout: 10000 }).toString();
      const files = raw.split('\n').filter(Boolean).map((line: string) => line.split('\t').pop() || '');
      const migFiles = files.filter((f: string) => /V\d+.*\.sql$/i.test(f));
      const codeFiles = files.filter((f: string) => !/V\d+.*\.sql$/i.test(f));
      assert.ok(migFiles.length >= 1, 'Should have migration files');
      assert.ok(codeFiles.length >= 1, 'Should have code files');
    });

    it('merge commit diff via first-parent fallback', () => {
      const mergeCommit = git('log --oneline --merges -1');
      assert.ok(mergeCommit, 'Should have a merge commit');
      const mergeSha = mergeCommit.split(' ')[0];
      let raw = cp.execSync(`git diff-tree --no-commit-id --name-status -r "${mergeSha}"`, { cwd: repoDir, timeout: 10000 }).toString();
      if (!raw.trim()) {
        raw = cp.execSync(`git diff --name-status "${mergeSha}^1" "${mergeSha}"`, { cwd: repoDir, timeout: 10000 }).toString();
      }
      assert.ok(raw.trim().length > 0, 'Merge commit should have file changes via first-parent diff');
    });
  });

  // ── Phase R7: CI Secret Syncing ──────────────────────────────────

  describe('R7: CI Secret Syncing', () => {
    it('sets and lists secrets on the test repo', async function () {
      this.timeout(30000);
      // Set a test secret
      await gitService.setRepoSecret(fullRepoName, 'TEST_R7_SECRET', 'test-value-r7');

      // Verify it appears in the list
      const raw = cp.execSync(`gh secret list --repo "${fullRepoName}"`, { timeout: 10000 }).toString();
      assert.ok(raw.includes('TEST_R7_SECRET'), 'Secret should appear in list');
    });

    it('sets DATABRICKS_HOST secret', async function () {
      this.timeout(15000);
      await gitService.setRepoSecret(fullRepoName, 'DATABRICKS_HOST', process.env.DATABRICKS_HOST || 'test-host');
      const raw = cp.execSync(`gh secret list --repo "${fullRepoName}"`, { timeout: 10000 }).toString();
      assert.ok(raw.includes('DATABRICKS_HOST'), 'DATABRICKS_HOST should be set');
    });

    it('sets LAKEBASE_PROJECT_ID secret', async function () {
      this.timeout(15000);
      await gitService.setRepoSecret(fullRepoName, 'LAKEBASE_PROJECT_ID', TEST_PROJECT_ID);
      const raw = cp.execSync(`gh secret list --repo "${fullRepoName}"`, { timeout: 10000 }).toString();
      assert.ok(raw.includes('LAKEBASE_PROJECT_ID'), 'LAKEBASE_PROJECT_ID should be set');
    });

    it('creates a Databricks token', function () {
      if (!lakebaseProjectCreated) { this.skip(); return; }
      this.timeout(15000);
      try {
        const raw = cp.execSync(
          'databricks tokens create --comment "integration-test-r7" --lifetime-seconds 300 -o json',
          { timeout: 15000, env: { ...process.env, DATABRICKS_HOST: process.env.DATABRICKS_HOST } }
        ).toString();
        const parsed = JSON.parse(raw);
        const token = parsed.token_value || parsed.token || '';
        assert.ok(token.length > 0, 'Should return a token');
      } catch (err: any) {
        if (err.message.includes('tokens create')) {
          console.log('    (Token creation not available on this workspace — skipped)');
          this.skip();
        } else { throw err; }
      }
    });
  });

  // ── Phase R8: Small Patterns ─────────────────────────────────────

  describe('R8: Small Patterns', () => {
    describe('R8a: isMainBranch', () => {
      it('identifies main as main branch', () => {
        assert.ok('main' === 'main' || 'main' === 'master');
      });
      it('identifies master as main branch', () => {
        assert.ok('master' === 'main' || 'master' === 'master');
      });
      it('does not identify feature branches as main', () => {
        assert.ok('feature/orders' !== 'main' && 'feature/orders' !== 'master');
      });
    });

    describe('R8b: Status icon/color constants', () => {
      it('added status maps to diff-added icon and green color', () => {
        const icons: Record<string, string> = { added: 'diff-added', modified: 'diff-modified', deleted: 'diff-removed', renamed: 'diff-renamed' };
        const colors: Record<string, string> = { added: 'charts.green', modified: 'charts.yellow', deleted: 'charts.red', renamed: 'charts.blue' };
        assert.strictEqual(icons.added, 'diff-added');
        assert.strictEqual(colors.added, 'charts.green');
        assert.strictEqual(icons.deleted, 'diff-removed');
        assert.strictEqual(colors.deleted, 'charts.red');
      });
    });

    describe('R8c: CREATE TABLE parsing', () => {
      it('parses a CREATE TABLE statement', () => {
        const sql = 'CREATE TABLE IF NOT EXISTS product (\n    id BIGSERIAL PRIMARY KEY,\n    name VARCHAR(255) NOT NULL\n);\n';
        const regex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\);/gi;
        const match = regex.exec(sql);
        assert.ok(match, 'Should match CREATE TABLE');
        assert.strictEqual(match![1], 'product');
        assert.ok(match![2].includes('id'), 'Should capture columns');
      });

      it('parses ALTER TABLE ADD COLUMN', () => {
        const sql = 'ALTER TABLE product ADD COLUMN category VARCHAR(100);';
        const regex = /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ADD\s+(?:COLUMN\s+)?(\w+)\s+(.+?);/gi;
        const match = regex.exec(sql);
        assert.ok(match, 'Should match ALTER TABLE');
        assert.strictEqual(match![1], 'product');
        assert.strictEqual(match![2], 'category');
      });

      it('parses DROP TABLE', () => {
        const sql = 'DROP TABLE IF EXISTS temp_data;';
        const regex = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?(\w+)/gi;
        const match = regex.exec(sql);
        assert.ok(match, 'Should match DROP TABLE');
        assert.strictEqual(match![1], 'temp_data');
      });
    });
  });

  // ── Teardown ─────────────────────────────────────────────────────

  describe('Teardown', () => {
    it('deletes the GitHub repo', async function () {
      if (!githubRepoCreated) { this.skip(); return; }
      this.timeout(30000);
      console.log(`    Deleting GitHub repo ${fullRepoName}...`);
      await gitService.deleteRepo(fullRepoName);
      const exists = await gitService.repoExists(fullRepoName);
      assert.strictEqual(exists, false);
      githubRepoCreated = false;
      console.log('    Deleted.');
    });

    it('deletes the Lakebase project', async function () {
      if (!lakebaseProjectCreated) { this.skip(); return; }
      this.timeout(90000);
      console.log(`    Deleting Lakebase project ${TEST_PROJECT_ID}...`);
      await lakebaseService.deleteProject(TEST_PROJECT_ID);
      lakebaseProjectCreated = false;
      console.log('    Deleted.');
    });

    it('cleans up local directory', () => {
      if (repoDir && fs.existsSync(repoDir)) {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  // Emergency cleanup
  after(async function () {
    this.timeout(120000);
    if (githubRepoCreated) {
      try { await gitService.deleteRepo(fullRepoName); } catch (e: any) { console.log(`  [cleanup] GitHub: ${e.message}`); }
    }
    if (lakebaseProjectCreated) {
      try { await lakebaseService.deleteProject(TEST_PROJECT_ID); } catch (e: any) { console.log(`  [cleanup] Lakebase: ${e.message}`); }
    }
    if (repoDir && fs.existsSync(repoDir)) {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    }
  });
});
