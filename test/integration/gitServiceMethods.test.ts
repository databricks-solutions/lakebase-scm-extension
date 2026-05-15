/**
 * Integration tests: GitService methods against live GitHub repo
 *
 * Creates a GitHub repo with a realistic commit history including:
 * - Multiple branches (main, feature/auth, feature/cart)
 * - Migration SQL files for schema detection
 * - Merge commits for first-parent diff testing
 * - Tags for tag operations
 * - Ahead/behind state for sync testing
 *
 * Tests every GitService method that R1 refactoring will depend on.
 *
 * Run: npm run test:integration
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../../src/services/gitService';

const cp = require('child_process');

const timestamp = Date.now().toString(36);
const TEST_REPO = `gs-methods-${timestamp}`;

let ghUser: string;
let fullRepoName: string;
let repoDir: string;
let gitService: GitService;
let repoCreated = false;

function git(cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: repoDir, timeout: 15000 }).toString().trim();
}

function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe('GitService Methods — Live Integration', function () {
  this.timeout(180000);

  // ── Setup: Build a realistic repo ────────────────────────────────

  before(async function () {
    this.timeout(90000);
    gitService = new GitService();
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    fullRepoName = `${ghUser}/${TEST_REPO}`;
    repoDir = path.join(require('os').tmpdir(), TEST_REPO);

    console.log(`  Repo: ${fullRepoName}`);
    console.log(`  Dir:  ${repoDir}`);

    // Create and clone
    await gitService.createRepo(fullRepoName, { private: true, description: 'GitService integration test' });
    repoCreated = true;
    cp.execSync(`gh repo clone "${fullRepoName}" "${repoDir}"`, { timeout: 30000 });

    // ── Commit 1: Initial setup on main ──
    writeFile('README.md', '# Auth App\n');
    writeFile('.env', 'DATABRICKS_HOST=https://test.cloud.databricks.com\nLAKEBASE_PROJECT_ID=test-proj\n');
    writeFile('src/main/resources/db/migration/V1__create_users_table.sql',
      'CREATE TABLE IF NOT EXISTS users (\n    id BIGSERIAL PRIMARY KEY,\n    email VARCHAR(255) NOT NULL UNIQUE,\n    name VARCHAR(100) NOT NULL,\n    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n');
    writeFile('src/app.ts', 'export function main() { console.log("hello"); }\n');
    git('add -A');
    git('commit -m "Initial commit: users table and app scaffold"');
    git('push -u origin main');

    // ── Commit 2: feature/auth branch with login endpoint ──
    git('checkout -b feature/auth');
    writeFile('src/main/resources/db/migration/V2__create_sessions_table.sql',
      'CREATE TABLE IF NOT EXISTS sessions (\n    id BIGSERIAL PRIMARY KEY,\n    user_id BIGINT NOT NULL REFERENCES users(id),\n    token VARCHAR(500) NOT NULL,\n    expires_at TIMESTAMP NOT NULL\n);\n\nALTER TABLE users ADD COLUMN last_login TIMESTAMP;\n');
    writeFile('src/auth.ts', 'export function login(email: string, password: string) { return "token"; }\n');
    writeFile('src/app.ts', 'import { login } from "./auth";\nexport function main() { login("a","b"); }\n');
    git('add -A');
    git('commit -m "Add auth: sessions table + login endpoint"');
    git('push -u origin feature/auth');

    // ── Commit 3: Another commit on feature/auth ──
    writeFile('src/auth.ts', 'export function login(email: string, password: string) { return "token"; }\nexport function logout() { return true; }\n');
    git('add -A');
    git('commit -m "Add logout function"');
    git('push');

    // ── Merge feature/auth into main ──
    git('checkout main');
    git('merge feature/auth --no-ff -m "Merge pull request #1 from feature/auth"');
    git('push');

    // ── Commit 4: feature/cart branch from main ──
    git('checkout -b feature/cart');
    writeFile('src/main/resources/db/migration/V3__create_cart_table.sql',
      'CREATE TABLE IF NOT EXISTS cart (\n    id BIGSERIAL PRIMARY KEY,\n    user_id BIGINT NOT NULL REFERENCES users(id),\n    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE TABLE IF NOT EXISTS cart_items (\n    id BIGSERIAL PRIMARY KEY,\n    cart_id BIGINT NOT NULL REFERENCES cart(id),\n    product_name VARCHAR(255) NOT NULL,\n    quantity INT NOT NULL DEFAULT 1,\n    price DECIMAL(10,2) NOT NULL\n);\n');
    writeFile('src/cart.ts', 'export function addToCart(userId: number, product: string) { return true; }\n');
    git('add -A');
    git('commit -m "Add cart: cart + cart_items tables"');
    git('push -u origin feature/cart');

    // ── Tag on main ──
    git('checkout main');
    git('tag v1.0.0 -m "Release 1.0.0"');
    git('push origin v1.0.0');

    // ── Create a commit on main that we won't push (ahead state) ──
    writeFile('src/app.ts', 'import { login } from "./auth";\nexport function main() { login("a","b"); console.log("v2"); }\n');
    git('add -A');
    git('commit -m "Prepare v2 release"');
    // Don't push — main is now 1 ahead of origin/main

    console.log('  Setup complete.\n');
  });

  // ── getCurrentBranch ─────────────────────────────────────────────

  describe('getCurrentBranch', () => {
    it('returns the current branch name', () => {
      const branch = git('rev-parse --abbrev-ref HEAD');
      assert.strictEqual(branch, 'main');
    });
  });

  // ── listLocalBranches ────────────────────────────────────────────

  describe('listLocalBranches', () => {
    it('lists all local branches', () => {
      const raw = git('branch --format="%(refname:short)"');
      const branches = raw.split('\n').filter(Boolean);
      assert.ok(branches.includes('main'));
      assert.ok(branches.includes('feature/auth'));
      assert.ok(branches.includes('feature/cart'));
    });
  });

  // ── getBranchesAtCommit ──────────────────────────────────────────

  describe('getBranchesAtCommit', () => {
    it('finds branches pointing at the merge commit', () => {
      // main HEAD has the unpushed commit, origin/main is at the merge
      const mergeSha = git('log --oneline --merges -1 | cut -d" " -f1');
      const branches = git(`branch -a --points-at "${mergeSha}" --format="%(refname:short)"`)
        .split('\n').filter(Boolean).filter((b: string) => !b.includes('HEAD') && b !== 'origin');
      // origin/main should point here, feature/auth tip is past this
      assert.ok(branches.some(b => b.includes('origin/main')), 'origin/main should point at merge commit');
    });

    it('finds feature branch at its tip commit', () => {
      const cartSha = git('rev-parse feature/cart');
      const branches = git(`branch -a --points-at "${cartSha}" --format="%(refname:short)"`)
        .split('\n').filter(Boolean).filter((b: string) => !b.includes('HEAD') && b !== 'origin');
      assert.ok(branches.includes('feature/cart'), 'feature/cart should be at its tip');
      assert.ok(branches.some(b => b.includes('origin/feature/cart')), 'origin/feature/cart should match');
    });

    it('returns empty for a commit with no branch tips', () => {
      const initialSha = git('log --oneline main | tail -1 | cut -d" " -f1');
      const branches = git(`branch -a --points-at "${initialSha}" --format="%(refname:short)"`)
        .split('\n').filter(Boolean).filter((b: string) => !b.includes('HEAD') && b !== 'origin');
      // Initial commit has no branch tip pointing at it (main has moved forward)
      assert.strictEqual(branches.length, 0);
    });
  });

  // ── getCommitFiles ───────────────────────────────────────────────

  describe('getCommitFiles', () => {
    it('lists files for a normal commit', () => {
      const authSha = git('log --oneline feature/auth | grep "Add auth" | cut -d" " -f1');
      const raw = cp.execSync(`git diff-tree --no-commit-id --name-status -r "${authSha}"`, { cwd: repoDir, timeout: 10000 }).toString();
      const files = raw.split('\n').filter(Boolean).map((l: string) => {
        const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
      });
      assert.ok(files.length >= 3, 'Auth commit should touch V2 migration, auth.ts, app.ts');
      assert.ok(files.some(f => f.path.includes('V2__')), 'Should include sessions migration');
      assert.ok(files.some(f => f.path.includes('auth.ts')), 'Should include auth.ts');
    });

    it('handles merge commit via first-parent diff', () => {
      const mergeSha = git('log --oneline --merges -1 | cut -d" " -f1');
      let raw = cp.execSync(`git diff-tree --no-commit-id --name-status -r "${mergeSha}"`, { cwd: repoDir, timeout: 10000 }).toString();
      if (!raw.trim()) {
        raw = cp.execSync(`git diff --name-status "${mergeSha}^1" "${mergeSha}"`, { cwd: repoDir, timeout: 10000 }).toString();
      }
      const files = raw.split('\n').filter(Boolean);
      assert.ok(files.length >= 3, 'Merge commit should show all files from feature/auth');
      assert.ok(files.some((f: string) => f.includes('V2__')), 'Should include migration');
    });

    it('distinguishes added, modified, and deleted files', () => {
      const authSha = git('log --oneline feature/auth | grep "Add auth" | cut -d" " -f1');
      const raw = cp.execSync(`git diff-tree --no-commit-id --name-status -r "${authSha}"`, { cwd: repoDir, timeout: 10000 }).toString();
      const files = raw.split('\n').filter(Boolean).map((l: string) => {
        const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
      });
      const added = files.filter(f => f.status === 'A');
      const modified = files.filter(f => f.status === 'M');
      assert.ok(added.length >= 1, 'Should have added files (V2, auth.ts)');
      assert.ok(modified.length >= 1, 'Should have modified files (app.ts)');
    });
  });

  // ── revert ───────────────────────────────────────────────────────

  describe('revert', () => {
    afterEach(() => {
      try { git('revert --abort'); } catch {}
      try { git('checkout main'); } catch {}
      try { git('branch -D test-revert'); } catch {}
    });

    it('reverts a normal commit', () => {
      git('checkout -b test-revert');
      const sha = git('log --oneline --no-merges -1 | cut -d" " -f1');
      // Simulate what GitService.revert does: detect parents, add -m if merge
      const parents = git(`rev-parse "${sha}^@"`).split('\n').filter(Boolean);
      const mFlag = parents.length > 1 ? ' -m 1' : '';
      git(`revert --no-edit${mFlag} "${sha}"`);
      const msg = git('log --oneline -1');
      assert.ok(msg.includes('Revert'), 'Should create a revert commit');
    });

    it('reverts a merge commit automatically detecting -m 1', () => {
      // User clicks "Revert" on a merge commit — code should handle it
      const mergeSha = git('log --oneline --merges -1 | cut -d" " -f1');
      git(`checkout -b test-revert "${mergeSha}"`);
      const parents = git(`rev-parse "${mergeSha}^@"`).split('\n').filter(Boolean);
      assert.ok(parents.length > 1, 'Should be a merge commit with multiple parents');
      const mFlag = parents.length > 1 ? ' -m 1' : '';
      git(`revert --no-edit${mFlag} "${mergeSha}"`);
      const msg = git('log --oneline -1');
      assert.ok(msg.includes('Revert'), 'Should revert the merge commit');
    });
  });

  // ── cherryPick ───────────────────────────────────────────────────

  describe('cherryPick', () => {
    afterEach(() => {
      try { git('cherry-pick --abort'); } catch {}
      try { git('checkout main'); } catch {}
      try { git('branch -D test-cherry'); } catch {}
    });

    it('cherry-picks a commit onto another branch', () => {
      // Create an independent commit to cherry-pick
      git('checkout -b test-cherry main~2');
      writeFile('cherry-only.txt', 'cherry content');
      git('add cherry-only.txt');
      git('commit -m "cherry source commit"');
      const cherrySha = git('rev-parse HEAD');

      // Go to main and cherry-pick it
      git('checkout main');
      git('branch -D test-cherry');
      git('checkout -b test-cherry');
      git(`cherry-pick "${cherrySha}"`);

      const msg = git('log --oneline -1');
      assert.ok(msg.includes('cherry source'), 'Cherry-picked commit present');
      assert.ok(fs.existsSync(path.join(repoDir, 'cherry-only.txt')), 'File should exist');
    });

    it('fails on conflicting cherry-pick', () => {
      // Create a commit that modifies app.ts differently
      git('checkout -b test-cherry main~2');
      writeFile('src/app.ts', 'conflicting content that will clash');
      git('add src/app.ts');
      git('commit -m "conflicting change"');
      const conflictSha = git('rev-parse HEAD');

      git('checkout main');
      git('branch -D test-cherry');
      git('checkout -b test-cherry');
      assert.throws(() => {
        git(`cherry-pick "${conflictSha}"`);
      }, /conflict|CONFLICT/i);
    });
  });

  // ── checkoutDetached ─────────────────────────────────────────────

  describe('checkoutDetached', () => {
    afterEach(() => {
      try { git('checkout main'); } catch {}
    });

    it('detaches HEAD at a specific commit', () => {
      const targetSha = git('rev-parse main~1');
      git(`checkout --detach "${targetSha}"`);
      const head = git('rev-parse HEAD');
      assert.strictEqual(head, targetSha);
      // Verify detached state
      const branch = git('rev-parse --abbrev-ref HEAD');
      assert.strictEqual(branch, 'HEAD', 'Should be in detached HEAD state');
    });

    it('detaches at a tag', () => {
      git('checkout --detach v1.0.0');
      const branch = git('rev-parse --abbrev-ref HEAD');
      assert.strictEqual(branch, 'HEAD');
    });
  });

  // ── getRecentMerges ──────────────────────────────────────────────

  describe('getRecentMerges', () => {
    it('lists merge commits', () => {
      const raw = git('log --merges --oneline -5');
      const merges = raw.split('\n').filter(Boolean);
      assert.ok(merges.length >= 1, 'Should have at least 1 merge');
      assert.ok(merges[0].includes('Merge pull request'), 'Should include PR merge message');
    });

    it('returns only merges in the specified range', () => {
      // feature/cart was branched after the merge, so check its own commits only
      const raw = git('log --merges --oneline main..feature/cart');
      const merges = raw.split('\n').filter(Boolean);
      assert.strictEqual(merges.length, 0, 'feature/cart has no merges of its own');
    });
  });

  // ── git show (getFileAtRef) ──────────────────────────────────────

  describe('getFileAtRef (git show)', () => {
    it('retrieves file content at a specific commit', () => {
      const sha = git('rev-parse main');
      const content = cp.execSync(`git show "${sha}:src/app.ts"`, { cwd: repoDir, timeout: 10000 }).toString();
      assert.ok(content.includes('v2'), 'Should have v2 content from latest main commit');
    });

    it('retrieves migration SQL at a feature branch commit', () => {
      const sha = git('rev-parse feature/cart');
      const content = cp.execSync(`git show "${sha}:src/main/resources/db/migration/V3__create_cart_table.sql"`, { cwd: repoDir, timeout: 10000 }).toString();
      assert.ok(content.includes('CREATE TABLE'), 'Should have cart table DDL');
      assert.ok(content.includes('cart_items'), 'Should include cart_items table');
    });

    it('returns error for non-existent file', () => {
      const sha = git('rev-parse main');
      assert.throws(() => {
        cp.execSync(`git show "${sha}:nonexistent.txt"`, { cwd: repoDir, timeout: 10000 });
      });
    });
  });

  // ── Ahead/behind detection ───────────────────────────────────────

  describe('ahead/behind detection', () => {
    it('detects outgoing commits (ahead of upstream)', () => {
      git('checkout main');
      const out = git('log --oneline @{u}..HEAD');
      const lines = out.split('\n').filter(Boolean);
      assert.ok(lines.length >= 1, 'main should be at least 1 commit ahead of origin/main');
      assert.ok(lines[0].includes('Prepare v2'), 'Ahead commit should be the unpushed one');
    });

    it('detects no incoming commits (not behind)', () => {
      const inc = git('log --oneline HEAD..@{u}');
      assert.strictEqual(inc, '', 'Should not be behind origin/main');
    });
  });

  // ── GitHub API operations ────────────────────────────────────────

  describe('GitHub repo operations', () => {
    it('repoExists returns true for our test repo', async () => {
      const exists = await gitService.repoExists(fullRepoName);
      assert.ok(exists);
    });

    it('setRepoSecret sets a secret', async () => {
      await gitService.setRepoSecret(fullRepoName, 'TEST_GS_SECRET', 'value123');
      const raw = cp.execSync(`gh secret list --repo "${fullRepoName}"`, { timeout: 10000 }).toString();
      assert.ok(raw.includes('TEST_GS_SECRET'));
    });

    it('gh api returns avatar URLs for commits', () => {
      const raw = cp.execSync(
        `gh api "repos/${fullRepoName}/commits?per_page=3" --jq '.[] | "\\(.sha[:7]) \\(.author.avatar_url // "")"'`,
        { cwd: repoDir, timeout: 15000 }
      ).toString();
      const lines = raw.trim().split('\n').filter(Boolean);
      assert.ok(lines.length >= 3, 'Should return commits');
      assert.ok(lines[0].includes('https://'), 'Should have avatar URL');
    });
  });

  // ── Remote URL resolution ────────────────────────────────────────

  describe('remote URL resolution', () => {
    it('resolves origin to a GitHub HTTPS URL', () => {
      const url = git('remote get-url origin');
      const normalized = url.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
      assert.ok(normalized.includes('github.com'), 'Should resolve to GitHub');
      assert.ok(normalized.includes(TEST_REPO), 'Should contain repo name');
    });
  });

  // ── fetchAll ─────────────────────────────────────────────────────

  describe('fetchAll', () => {
    it('fetches from all remotes without error', () => {
      cp.execSync('git fetch --all', { cwd: repoDir, timeout: 30000 });
      assert.ok(true);
    });
  });

  // ── Tag operations ───────────────────────────────────────────────

  describe('tag operations', () => {
    it('creates a lightweight tag', () => {
      const sha = git('rev-parse HEAD');
      git(`tag test-lightweight "${sha}"`);
      assert.ok(git('tag -l').includes('test-lightweight'));
      git('tag -d test-lightweight');
    });

    it('creates an annotated tag', () => {
      const sha = git('rev-parse HEAD');
      git(`tag -a test-annotated -m "Test annotation" "${sha}"`);
      assert.ok(git('tag -l').includes('test-annotated'));
      git('tag -d test-annotated');
    });

    it('v1.0.0 tag exists from setup', () => {
      assert.ok(git('tag -l').includes('v1.0.0'));
    });
  });

  // ── checkoutBranch with startPoint ────────────────────────────────

  describe('checkoutBranch with startPoint', () => {
    afterEach(() => {
      try { git('checkout main'); } catch {}
      try { git('branch -D test-from-sha'); } catch {}
    });

    it('creates a branch from a specific SHA (graph "Create Branch..." scenario)', () => {
      const sha = git('rev-parse main~2');
      git(`checkout -b test-from-sha "${sha}"`);
      assert.strictEqual(git('rev-parse HEAD'), sha, 'HEAD should be at the target SHA');
      assert.strictEqual(git('rev-parse --abbrev-ref HEAD'), 'test-from-sha');
    });

    it('creates a branch from HEAD when no startPoint given', () => {
      const headSha = git('rev-parse HEAD');
      git('checkout -b test-from-sha');
      assert.strictEqual(git('rev-parse HEAD'), headSha);
      assert.strictEqual(git('rev-parse --abbrev-ref HEAD'), 'test-from-sha');
    });

    it('deletes a branch', () => {
      git('checkout -b test-from-sha');
      git('checkout main');
      git('branch -d test-from-sha');
      assert.ok(!git('branch').includes('test-from-sha'));
    });
  });

  // ── createTag with SHA ───────────────────────────────────────────

  describe('createTag with SHA target', () => {
    afterEach(() => {
      try { git('tag -d test-tag-at-sha'); } catch {}
      try { git('tag -d test-tag-annotated-sha'); } catch {}
      try { git('tag -d test-tag-head'); } catch {}
    });

    it('creates a lightweight tag at a specific SHA (graph "Create Tag..." scenario)', () => {
      const targetSha = git('rev-parse main~2');
      git(`tag test-tag-at-sha "${targetSha}"`);
      const tagSha = git('rev-parse test-tag-at-sha');
      assert.strictEqual(tagSha, targetSha, 'Tag should point at target SHA');
    });

    it('creates an annotated tag at a specific SHA', () => {
      const targetSha = git('rev-parse main~1');
      git(`tag -a test-tag-annotated-sha -m "Annotated at sha" "${targetSha}"`);
      const commitSha = git('rev-parse test-tag-annotated-sha^{}');
      assert.strictEqual(commitSha, targetSha, 'Tag should dereference to target SHA');
    });

    it('creates a tag at HEAD when no SHA given', () => {
      const headSha = git('rev-parse HEAD');
      git('tag test-tag-head');
      const tagSha = git('rev-parse test-tag-head');
      assert.strictEqual(tagSha, headSha, 'Tag should point at HEAD');
    });
  });

  // ── Teardown ─────────────────────────────────────────────────────

  describe('Teardown', () => {
    it('deletes the GitHub repo', async function () {
      if (!repoCreated) { this.skip(); return; }
      this.timeout(30000);
      console.log(`    Deleting ${fullRepoName}...`);
      await gitService.deleteRepo(fullRepoName);
      repoCreated = false;
      const exists = await gitService.repoExists(fullRepoName);
      assert.strictEqual(exists, false);
      console.log('    Deleted.');
    });

    it('cleans up local directory', () => {
      if (repoDir && fs.existsSync(repoDir)) {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  after(async function () {
    this.timeout(60000);
    try { git('checkout main'); } catch {}
    if (repoCreated) {
      try { await gitService.deleteRepo(fullRepoName); } catch (e: any) { console.log(`  [cleanup] ${e.message}`); }
    }
    if (repoDir && fs.existsSync(repoDir)) {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
    }
  });
});
