/**
 * Greenfield review , panel truthfulness (LOCAL integration, NO cloud).
 *
 * Reproduces the eval's headline symptoms against REAL git (temp repos + a bare
 * remote + a real prepare-commit-msg hook) and asserts they are fixed:
 *   - a commit that lands while a hook is noisy reports SUCCESS (not "Commit
 *     failed") and the staged group clears (W1 truthful commit);
 *   - a second push with nothing new is in-sync success, not a failure (W1);
 *   - a real non-fast-forward classifies as "rejected" / pull-first, not a
 *     generic "failed to push some refs" (W1 + classifyGitError).
 *
 * Run: npm run test:integration   (needs git on PATH; no Databricks/Lakebase).
 */

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../../src/services/gitService';
import { classifyGitError } from '../../src/utils/errorClassification';

const cp = require('child_process');

function sh(cmd: string, cwd: string): string {
  return cp.execSync(cmd, { cwd, timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  sh('git init -b main', dir);
  sh('git config user.email test@example.com', dir);
  sh('git config user.name "GF Review"', dir);
  sh('git config commit.gpgsign false', dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# greenfield review\n');
  sh('git add -A', dir);
  sh('git commit -m initial', dir);
}

describe('Greenfield review , panel truthfulness (LOCAL, no cloud)', function () {
  this.timeout(60000);

  const dirs: string[] = [];
  let gitService: GitService;

  beforeEach(() => { gitService = new GitService(); });
  afterEach(() => {
    (vscode.workspace as any).workspaceFolders = undefined;
    while (dirs.length) {
      const d = dirs.pop();
      if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  });

  function mk(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-review-'));
    dirs.push(d);
    return d;
  }
  function useRepo(dir: string): void {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: dir } }];
  }

  it('W1: a commit that lands despite a noisy prepare-commit-msg hook reports success + clears staged', async () => {
    const repo = mk();
    initRepo(repo);
    useRepo(repo);

    // Best-effort enrichment hook (mirrors the scaffold's schema-diff append):
    // writes noise to stderr but exits 0. The commit must still land + report
    // success, and the staged group must clear.
    const hookDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    const hook = path.join(hookDir, 'prepare-commit-msg');
    fs.writeFileSync(hook, '#!/bin/sh\necho "Schema diff could not be computed" 1>&2\nexit 0\n');
    fs.chmodSync(hook, 0o755);

    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 1;\n');
    sh('git add -A', repo);
    const before = sh('git rev-parse HEAD', repo);

    await gitService.commit('feat: add x'); // must resolve, not throw

    const after = sh('git rev-parse HEAD', repo);
    assert.notStrictEqual(after, before, 'HEAD should advance , the commit landed');
    const staged = await gitService.getStagedChanges();
    assert.strictEqual(staged.length, 0, 'staged group should clear (panel must not still show "Staged")');
  });

  it('W1: a second push with nothing new is in-sync success, not a failure', async () => {
    const remote = mk();
    sh('git init --bare -b main', remote);
    const repo = mk();
    initRepo(repo);
    useRepo(repo);
    sh(`git remote add origin "${remote}"`, repo);
    sh('git push -u origin main', repo);

    // Nothing new to push , must resolve (git reports "Everything up-to-date").
    await gitService.push();
  });

  it('W1: a real non-fast-forward classifies as "rejected" (pull first), not a generic failure', async () => {
    const remote = mk();
    sh('git init --bare -b main', remote);
    const local = mk();
    initRepo(local);
    sh(`git remote add origin "${remote}"`, local);
    sh('git push -u origin main', local);

    // A second clone advances the remote, so `local` is now behind.
    const other = mk();
    fs.rmSync(other, { recursive: true, force: true });
    sh(`git clone "${remote}" "${other}"`, os.tmpdir());
    sh('git config user.email test@example.com', other);
    sh('git config user.name "Other"', other);
    fs.writeFileSync(path.join(other, 'remote.txt'), 'from remote\n');
    sh('git add -A', other);
    sh('git commit -m "remote commit"', other);
    sh('git push origin main', other);

    // local makes its own commit, then pushes , non-fast-forward rejection.
    fs.writeFileSync(path.join(local, 'local.txt'), 'from local\n');
    sh('git add -A', local);
    sh('git commit -m "local commit"', local);
    useRepo(local);

    let threw = false;
    try {
      await gitService.push();
    } catch (err) {
      threw = true;
      assert.strictEqual(classifyGitError(err).code, 'rejected', 'should classify as a real rejection');
    }
    assert.ok(threw, 'push should reject on a non-fast-forward');
  });
});
