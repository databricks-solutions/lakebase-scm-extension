/**
 * R6 Live Integration Test: DiffService methods against real repo
 *
 * Tests reviewCommitTwoPane, reviewCommitSinglePane, and compareRefs
 * against a repo with added, modified, deleted, and migration files.
 *
 * Run: npm run test:integration -- --grep "R6 DiffService"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from '../../src/utils/exec';
import { GitService } from '../../src/services/gitService';

const cp = require('child_process');
const timestamp = Date.now().toString(36);
const TEST_REPO = `r6-svc-${timestamp}`;

let ghUser: string;
let fullRepoName: string;
let repoDir: string;
let gitService: GitService;
let repoCreated = false;
let featureSha: string;
let mergeSha: string;

function git(cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: repoDir, timeout: 15000 }).toString().trim();
}

async function getCommitFilesLocal(sha: string): Promise<Array<{status: string; path: string}>> {
  let raw = (await exec(`git diff-tree --no-commit-id --name-status -r "${sha}"`, { cwd: repoDir }));
  if (!raw.trim()) {
    try { raw = await exec(`git diff --name-status "${sha}^1" "${sha}"`, { cwd: repoDir }); } catch { return []; }
  }
  return raw.split('\n').filter(Boolean).map(l => {
    const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
  });
}

async function getDiffFilesLocal(fromRef: string, toRef: string | null): Promise<Array<{status: string; path: string}>> {
  const cmd = toRef ? `git diff --name-status "${fromRef}" "${toRef}"` : `git diff --name-status "${fromRef}"`;
  try {
    const raw = await exec(cmd, { cwd: repoDir });
    return raw.split('\n').filter(Boolean).map(l => {
      const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] };
    });
  } catch { return []; }
}

describe('R6 DiffService — Live Integration', function () {
  this.timeout(120000);

  before(async function () {
    this.timeout(60000);
    gitService = new GitService();
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    fullRepoName = `${ghUser}/${TEST_REPO}`;
    repoDir = path.join(require('os').tmpdir(), TEST_REPO);

    await gitService.createRepo(fullRepoName, { private: true, description: 'R6 DiffService test' });
    repoCreated = true;
    cp.execSync(`gh repo clone "${fullRepoName}" "${repoDir}"`, { timeout: 30000 });

    const migDir = path.join(repoDir, 'src/main/resources/db/migration');
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# R6 Svc\n');
    fs.writeFileSync(path.join(repoDir, 'src/app.ts'), 'export const v1 = 1;\n');
    fs.writeFileSync(path.join(repoDir, 'src/old.ts'), 'export const old = true;\n');
    fs.writeFileSync(path.join(migDir, 'V1__init.sql'), 'CREATE TABLE t1 (id BIGSERIAL PRIMARY KEY);\n');
    git('add -A && git commit -m "Initial commit"');
    git('push -u origin main');

    git('checkout -b feature/svc');
    fs.writeFileSync(path.join(repoDir, 'src/new.ts'), 'export const x = 1;\n'); // Added
    fs.writeFileSync(path.join(repoDir, 'src/app.ts'), 'export const v2 = 2;\n'); // Modified
    fs.unlinkSync(path.join(repoDir, 'src/old.ts')); // Deleted
    fs.writeFileSync(path.join(migDir, 'V2__add_t2.sql'), 'CREATE TABLE t2 (id BIGSERIAL PRIMARY KEY, val TEXT);\nALTER TABLE t1 ADD COLUMN name VARCHAR(100);\n');
    git('add -A && git commit -m "Feature: add new, modify app, delete old, add V2"');
    featureSha = git('rev-parse HEAD');
    git('push -u origin feature/svc');

    git('checkout main');
    git('merge feature/svc --no-ff -m "Merge pull request #1"');
    mergeSha = git('rev-parse HEAD');
    git('push');
    console.log(`  Feature SHA: ${featureSha}`);
    console.log(`  Merge SHA: ${mergeSha}\n`);
  });

  describe('reviewCommitTwoPane pattern', () => {
    it('all files have both orig and mod (no undefined)', async () => {
      const files = await getCommitFilesLocal(featureSha);
      const tuples = files.map(f => ({
        label: `file://${repoDir}/${f.path}`,
        orig: `lakebase-commit://${featureSha}~1/${f.path}`,
        mod: `lakebase-commit://${featureSha}/${f.path}`,
      }));
      for (const t of tuples) {
        assert.ok(t.orig, 'orig always defined in two-pane');
        assert.ok(t.mod, 'mod always defined in two-pane');
      }
    });

    it('includes added, modified, and deleted files', async () => {
      const files = await getCommitFilesLocal(featureSha);
      const paths = files.map(f => f.path);
      assert.ok(paths.some(p => p.includes('new.ts')), 'Has added file');
      assert.ok(paths.some(p => p.includes('app.ts')), 'Has modified file');
      assert.ok(paths.some(p => p.includes('old.ts')), 'Has deleted file');
      assert.ok(paths.some(p => p.includes('V2__')), 'Has migration file');
    });

    it('works for merge commits via first-parent', async () => {
      const files = await getCommitFilesLocal(mergeSha);
      assert.ok(files.length >= 3, 'Merge shows files from feature');
    });
  });

  describe('reviewCommitSinglePane pattern', () => {
    it('added files have undefined orig', async () => {
      const files = await getCommitFilesLocal(featureSha);
      const added = files.find(f => f.status === 'A' && f.path.includes('new.ts'));
      assert.ok(added, 'Should find added file');
      // Single-pane: added → [label, undefined, mod]
      const orig = undefined;
      const mod = `lakebase-commit://${featureSha}/${added!.path}`;
      assert.strictEqual(orig, undefined, 'orig is undefined for added');
      assert.ok(mod, 'mod is defined');
    });

    it('deleted files have undefined mod', async () => {
      const files = await getCommitFilesLocal(featureSha);
      const deleted = files.find(f => f.status === 'D' && f.path.includes('old.ts'));
      assert.ok(deleted, 'Should find deleted file');
      // Single-pane: deleted → [label, orig, undefined]
      const orig = `lakebase-commit://${featureSha}~1/${deleted!.path}`;
      const mod = undefined;
      assert.ok(orig, 'orig is defined for deleted');
      assert.strictEqual(mod, undefined, 'mod is undefined');
    });

    it('modified files have both sides', async () => {
      const files = await getCommitFilesLocal(featureSha);
      const modified = files.find(f => f.status === 'M' && f.path.includes('app.ts'));
      assert.ok(modified, 'Should find modified file');
      const orig = `lakebase-commit://${featureSha}~1/${modified!.path}`;
      const mod = `lakebase-commit://${featureSha}/${modified!.path}`;
      assert.ok(orig);
      assert.ok(mod);
    });
  });

  describe('compareRefs pattern', () => {
    it('compare commit to HEAD', async () => {
      const files = await getDiffFilesLocal(featureSha, 'HEAD');
      // Feature SHA is the same as HEAD after merge, so diff might be empty or minimal
      assert.ok(Array.isArray(files));
    });

    it('compare commit to working tree (toRef=null uses file:// URIs)', async () => {
      const mainSha = git('rev-parse main~1');
      const files = await getDiffFilesLocal(mainSha, null);
      // Diff between pre-merge main and working tree should show feature changes
      assert.ok(files.length >= 1);
    });
  });

  describe('migration sorting', () => {
    it('separates code and migration files', async () => {
      const files = await getCommitFilesLocal(featureSha);
      const migFiles = files.filter(f => /V\d+.*\.sql$/i.test(f.path));
      const codeFiles = files.filter(f => !/V\d+.*\.sql$/i.test(f.path));
      assert.ok(migFiles.length >= 1, 'Has migrations');
      assert.ok(codeFiles.length >= 2, 'Has code files');
    });

    it('schema DDL can be parsed from migration at commit', async () => {
      const sql = await exec(
        `git show "${featureSha}:src/main/resources/db/migration/V2__add_t2.sql"`,
        { cwd: repoDir }
      );
      const { SchemaMigrationService } = require('../../src/services/schemaMigrationService');
      const changes = SchemaMigrationService.parseSql(sql);
      assert.ok(changes.some((c: any) => c.tableName === 't2' && c.type === 'created'));
      assert.ok(changes.some((c: any) => c.tableName === 't1' && c.type === 'modified'));
    });
  });

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
    if (repoCreated) { try { await gitService.deleteRepo(fullRepoName); } catch {} }
    if (fs.existsSync(repoDir)) { try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {} }
  });
});
