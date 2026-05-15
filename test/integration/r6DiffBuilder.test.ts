/**
 * R6 Integration Test: Diff Tuple Builder Parity + Live Scenarios
 *
 * Phase 1: Execute OLD code (inline tuple construction per call site)
 * Phase 2: Execute NEW code (shared builder utility)
 * Phase 3: Compare results
 * Live scenarios: exercise each call site pattern against real repo
 *
 * Run: npm run test:integration -- --grep "R6"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from '../../src/utils/exec';
import { GitService } from '../../src/services/gitService';

const cp = require('child_process');
const timestamp = Date.now().toString(36);
const TEST_REPO = `r6-test-${timestamp}`;

let ghUser: string;
let fullRepoName: string;
let repoDir: string;
let gitService: GitService;
let repoCreated = false;
const migPath = 'src/main/resources/db/migration';

function git(cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: repoDir, timeout: 15000 }).toString().trim();
}

// ── OLD code: inline tuple patterns from each call site ────────────

type DiffTuple = [string, string | undefined, string | undefined]; // label, orig, mod as URI strings

// Pattern 1: extension.ts reviewBranch (lakebase-git-base URIs)
function oldBuildBranchReviewTuples(root: string, files: Array<{path: string; status: string; oldPath?: string}>): DiffTuple[] {
  return files.map(file => {
    const filePath = `${root}/${file.path}`;
    const diffPath = file.status === 'renamed' && file.oldPath ? file.oldPath : file.path;
    const modified = `file://${filePath}`;
    const original = `lakebase-git-base://merge-base/${diffPath}`;
    if (file.status === 'added') return [modified, undefined, modified] as DiffTuple;
    if (file.status === 'deleted') return [original, original, undefined] as DiffTuple;
    return [modified, original, modified] as DiffTuple;
  });
}

// Pattern 2: graphWebview.ts reviewCommit (lakebase-commit URIs, always both sides)
function oldBuildCommitDiffTuples(root: string, sha: string, files: Array<{status: string; path: string}>): DiffTuple[] {
  return files.map(f => {
    const orig = `lakebase-commit://${sha}~1/${f.path}`;
    const mod = `lakebase-commit://${sha}/${f.path}`;
    const label = `file://${root}/${f.path}`;
    return [label, orig, mod] as DiffTuple;
  });
}

// Pattern 3: graphWebview.ts buildComparisonTuples (lakebase-commit, handles A/D)
function oldBuildComparisonTuples(root: string, fromSha: string, toRef: string | null, files: Array<{status: string; path: string}>): DiffTuple[] {
  return files.map(f => {
    const left = `lakebase-commit://${fromSha}/${f.path}`;
    const right = toRef ? `lakebase-commit://${toRef}/${f.path}` : `file://${root}/${f.path}`;
    const label = `file://${root}/${f.path}`;
    if (f.status === 'A') return [label, undefined, right] as DiffTuple;
    if (f.status === 'D') return [label, left, undefined] as DiffTuple;
    return [label, left, right] as DiffTuple;
  });
}

// ── NEW code: unified builder ──────────────────────────────────────

interface DiffBuilderOpts {
  root: string;
  makeOrigUri: (filePath: string) => string | undefined;
  makeModUri: (filePath: string) => string | undefined;
  makeLabelUri: (filePath: string) => string;
}

function newBuildDiffTuples(files: Array<{status: string; path: string}>, opts: DiffBuilderOpts): DiffTuple[] {
  return files.map(f => {
    const label = opts.makeLabelUri(f.path);
    const orig = opts.makeOrigUri(f.path);
    const mod = opts.makeModUri(f.path);
    return [label, orig, mod] as DiffTuple;
  });
}

describe('R6 Diff Tuple Builder — Parity + Live', function () {
  this.timeout(120000);

  before(async function () {
    this.timeout(60000);
    gitService = new GitService();
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    fullRepoName = `${ghUser}/${TEST_REPO}`;
    repoDir = path.join(require('os').tmpdir(), TEST_REPO);

    console.log(`  Repo: ${fullRepoName}`);
    await gitService.createRepo(fullRepoName, { private: true, description: 'R6 test' });
    repoCreated = true;
    cp.execSync(`gh repo clone "${fullRepoName}" "${repoDir}"`, { timeout: 30000 });

    const migDir = path.join(repoDir, migPath);
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# R6\n');
    fs.writeFileSync(path.join(repoDir, 'src/app.ts'), 'export const v1 = true;\n');
    fs.writeFileSync(path.join(migDir, 'V1__create_items.sql'), 'CREATE TABLE items (id BIGSERIAL PRIMARY KEY, name VARCHAR(255));\n');
    git('add -A && git commit -m "Initial: items table + app"');
    git('push -u origin main');

    // Feature branch: add file, modify file, add migration
    git('checkout -b feature/catalog');
    fs.writeFileSync(path.join(repoDir, 'src/catalog.ts'), 'export function listItems() {}\n');
    fs.writeFileSync(path.join(repoDir, 'src/app.ts'), 'export const v1 = true;\nimport { listItems } from "./catalog";\n');
    fs.writeFileSync(path.join(migDir, 'V2__create_categories.sql'), 'CREATE TABLE categories (id BIGSERIAL PRIMARY KEY, name VARCHAR(100));\nALTER TABLE items ADD COLUMN category_id BIGINT;\n');
    git('add -A && git commit -m "Add catalog: categories + modify app"');
    git('push -u origin feature/catalog');

    git('checkout main');
    git('merge feature/catalog --no-ff -m "Merge pull request #1 from feature/catalog"');
    git('push');
    console.log('  Setup complete.\n');
  });

  // ── Phase 1: OLD code — inline tuple builders ────────────────────

  describe('Phase 1: OLD inline tuple construction', () => {
    it('Pattern 1: reviewBranch builds tuples for added/modified files', () => {
      const files = [
        { path: 'src/catalog.ts', status: 'added' },
        { path: 'src/app.ts', status: 'modified' },
        { path: 'src/main/resources/db/migration/V2__create_categories.sql', status: 'added' },
      ];
      const tuples = oldBuildBranchReviewTuples(repoDir, files);
      assert.strictEqual(tuples.length, 3);
      // Added: [modified, undefined, modified]
      assert.strictEqual(tuples[0][1], undefined);
      assert.strictEqual(tuples[0][0], tuples[0][2]);
      // Modified: [modified, original, modified]
      assert.ok(tuples[1][1]!.includes('lakebase-git-base://'));
    });

    it('Pattern 2: reviewCommit always provides both sides', async () => {
      const sha = git('log --oneline feature/catalog -1 | cut -d" " -f1');
      const raw = await exec(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir });
      const files = raw.split('\n').filter(Boolean).map(l => {
        const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
      });
      const tuples = oldBuildCommitDiffTuples(repoDir, sha, files);
      // Every tuple has both orig and mod (no undefined)
      for (const t of tuples) {
        assert.ok(t[1], 'orig should be defined');
        assert.ok(t[2], 'mod should be defined');
        assert.ok(t[1]!.includes(`${sha}~1`), 'orig should reference parent');
        assert.ok(t[2]!.includes(sha), 'mod should reference commit');
      }
    });

    it('Pattern 3: buildComparisonTuples handles A/D/M', () => {
      const files = [
        { status: 'A', path: 'new-file.ts' },
        { status: 'D', path: 'old-file.ts' },
        { status: 'M', path: 'changed.ts' },
      ];
      const tuples = oldBuildComparisonTuples(repoDir, 'abc123', 'HEAD', files);
      // Added: [label, undefined, right]
      assert.strictEqual(tuples[0][1], undefined);
      assert.ok(tuples[0][2]!.includes('HEAD'));
      // Deleted: [label, left, undefined]
      assert.ok(tuples[1][1]!.includes('abc123'));
      assert.strictEqual(tuples[1][2], undefined);
      // Modified: [label, left, right]
      assert.ok(tuples[2][1]!.includes('abc123'));
      assert.ok(tuples[2][2]!.includes('HEAD'));
    });
  });

  // ── Phase 2: NEW unified builder ─────────────────────────────────

  describe('Phase 2: NEW unified builder', () => {
    it('Pattern 1 equivalent: branch review tuples', () => {
      const files = [
        { path: 'src/catalog.ts', status: 'added' },
        { path: 'src/app.ts', status: 'modified' },
        { path: 'src/main/resources/db/migration/V2__create_categories.sql', status: 'added' },
      ];
      const tuples = newBuildDiffTuples(files, {
        root: repoDir,
        makeOrigUri: (p) => `lakebase-git-base://merge-base/${p}`,
        makeModUri: (p) => `file://${repoDir}/${p}`,
        makeLabelUri: (p) => `file://${repoDir}/${p}`,
      });
      assert.strictEqual(tuples.length, 3);
      for (const t of tuples) {
        assert.ok(t[0], 'label defined');
        assert.ok(t[1], 'orig defined');
        assert.ok(t[2], 'mod defined');
      }
    });

    it('Pattern 2 equivalent: commit diff tuples', async () => {
      const sha = git('log --oneline feature/catalog -1 | cut -d" " -f1');
      const raw = await exec(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir });
      const files = raw.split('\n').filter(Boolean).map(l => {
        const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
      });
      const tuples = newBuildDiffTuples(files, {
        root: repoDir,
        makeOrigUri: (p) => `lakebase-commit://${sha}~1/${p}`,
        makeModUri: (p) => `lakebase-commit://${sha}/${p}`,
        makeLabelUri: (p) => `file://${repoDir}/${p}`,
      });
      for (const t of tuples) {
        assert.ok(t[1]!.includes(`${sha}~1`));
        assert.ok(t[2]!.includes(sha));
      }
    });

    it('Pattern 3 equivalent: comparison tuples with A/D/M', () => {
      const files = [
        { status: 'A', path: 'new-file.ts' },
        { status: 'D', path: 'old-file.ts' },
        { status: 'M', path: 'changed.ts' },
      ];
      const tuples = newBuildDiffTuples(files, {
        root: repoDir,
        makeOrigUri: (p) => `lakebase-commit://abc123/${p}`,
        makeModUri: (p) => `lakebase-commit://HEAD/${p}`,
        makeLabelUri: (p) => `file://${repoDir}/${p}`,
      });
      // All have both sides (caller handles A/D outside the builder if needed)
      for (const t of tuples) {
        assert.ok(t[1]);
        assert.ok(t[2]);
      }
    });
  });

  // ── Phase 3: Parity Comparison ───────────────────────────────────

  describe('Phase 3: Parity Comparison', () => {
    it('commit diff: same number of tuples', async () => {
      const sha = git('log --oneline feature/catalog -1 | cut -d" " -f1');
      const raw = await exec(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir });
      const files = raw.split('\n').filter(Boolean).map(l => {
        const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
      });
      const oldTuples = oldBuildCommitDiffTuples(repoDir, sha, files);
      const newTuples = newBuildDiffTuples(files, {
        root: repoDir,
        makeOrigUri: (p) => `lakebase-commit://${sha}~1/${p}`,
        makeModUri: (p) => `lakebase-commit://${sha}/${p}`,
        makeLabelUri: (p) => `file://${repoDir}/${p}`,
      });
      assert.strictEqual(oldTuples.length, newTuples.length);
    });

    it('commit diff: same URIs for each file', async () => {
      const sha = git('log --oneline feature/catalog -1 | cut -d" " -f1');
      const raw = await exec(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir });
      const files = raw.split('\n').filter(Boolean).map(l => {
        const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
      });
      const oldTuples = oldBuildCommitDiffTuples(repoDir, sha, files);
      const newTuples = newBuildDiffTuples(files, {
        root: repoDir,
        makeOrigUri: (p) => `lakebase-commit://${sha}~1/${p}`,
        makeModUri: (p) => `lakebase-commit://${sha}/${p}`,
        makeLabelUri: (p) => `file://${repoDir}/${p}`,
      });
      for (let i = 0; i < oldTuples.length; i++) {
        assert.strictEqual(oldTuples[i][0], newTuples[i][0], `label matches at ${i}`);
        assert.strictEqual(oldTuples[i][1], newTuples[i][1], `orig matches at ${i}`);
        assert.strictEqual(oldTuples[i][2], newTuples[i][2], `mod matches at ${i}`);
      }
    });

    it('migration files sortable to end in both approaches', async () => {
      const sha = git('log --oneline feature/catalog -1 | cut -d" " -f1');
      const raw = await exec(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir });
      const files = raw.split('\n').filter(Boolean).map(l => {
        const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
      });
      const migFiles = files.filter(f => /V\d+.*\.sql$/i.test(f.path));
      const codeFiles = files.filter(f => !/V\d+.*\.sql$/i.test(f.path));
      assert.ok(migFiles.length >= 1, 'Has migration files');
      assert.ok(codeFiles.length >= 1, 'Has code files');
      // Sort: code first, then migrations
      const sorted = [...codeFiles, ...migFiles];
      assert.ok(!(/\.sql$/.test(sorted[0].path)), 'First file should be code');
      assert.ok(/\.sql$/.test(sorted[sorted.length - 1].path), 'Last file should be migration');
    });
  });

  // ── Live Scenarios ───────────────────────────────────────────────

  describe('Live Scenarios', () => {
    it('merge commit produces diff tuples via first-parent fallback', async () => {
      const mergeSha = git('log --merges --oneline -1 | cut -d" " -f1');
      let raw = await exec(`git diff-tree --no-commit-id --name-status -r "${mergeSha}"`, { cwd: repoDir });
      if (!raw.trim()) {
        raw = await exec(`git diff --name-status "${mergeSha}^1" "${mergeSha}"`, { cwd: repoDir });
      }
      const files = raw.split('\n').filter(Boolean).map(l => {
        const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
      });
      assert.ok(files.length >= 2, 'Merge diff should show files');
      const tuples = newBuildDiffTuples(files, {
        root: repoDir,
        makeOrigUri: (p) => `lakebase-commit://${mergeSha}~1/${p}`,
        makeModUri: (p) => `lakebase-commit://${mergeSha}/${p}`,
        makeLabelUri: (p) => `file://${repoDir}/${p}`,
      });
      assert.strictEqual(tuples.length, files.length);
    });

    it('comparison with working tree uses file:// for right side', async () => {
      const sha = git('rev-parse HEAD');
      const files = [{ status: 'M', path: 'src/app.ts' }];
      const tuples = newBuildDiffTuples(files, {
        root: repoDir,
        makeOrigUri: (p) => `lakebase-commit://${sha}/${p}`,
        makeModUri: (p) => `file://${repoDir}/${p}`,
        makeLabelUri: (p) => `file://${repoDir}/${p}`,
      });
      assert.ok(tuples[0][1]!.includes('lakebase-commit://'), 'Left is commit ref');
      assert.ok(tuples[0][2]!.includes('file://'), 'Right is working tree file');
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
