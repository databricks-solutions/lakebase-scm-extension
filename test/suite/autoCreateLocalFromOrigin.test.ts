import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GitService } from '../../src/services/gitService';

// GitService.ensureLocalBranchesForRemotes(): on a fresh clone the tree pairs on
// LOCAL branches, so origin tiers show as "db only" until checked out. This
// method creates a local tracking branch for every origin branch with no local
// counterpart (no checkout, no fetch) so the paired view works on a clean clone.
const cpModule = require('child_process');
const originalExec = cpModule.exec;

describe('GitService.ensureLocalBranchesForRemotes', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
    sinon.restore();
  });

  /** Drive substrate's git (routed through child_process.exec) from a fixture. */
  function mockGit(opts: { local: string[]; remote: string[]; current?: string }) {
    const commands: string[] = [];
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      commands.push(cmd);
      let stdout = '';
      if (/git branch -r/.test(cmd)) {
        // remote refs: include HEAD pointer (must be filtered) + each remote
        stdout = ['origin/HEAD -> origin/main', ...opts.remote.map(b => `origin/${b}`)].join('\n') + '\n';
      } else if (/git rev-parse --abbrev-ref HEAD/.test(cmd)) {
        stdout = `${opts.current ?? 'main'}\n`;
      } else if (/git branch --format/.test(cmd)) {
        // local branches (listLocalBranches): "name|upstream|track"
        stdout = opts.local.map(b => `${b}|origin/${b}|`).join('\n') + '\n';
      }
      // `git branch --track ...` and anything else: succeed with empty stdout.
      cb(null, stdout, '');
    };
    return commands;
  }

  it('creates a local tracking branch for an origin branch with no local (the release case)', async () => {
    // local: only main (a fresh clone); origin also has release.
    const commands = mockGit({ local: ['main'], remote: ['main', 'release'], current: 'main' });
    const created = await new GitService().ensureLocalBranchesForRemotes();

    assert.deepEqual(created, ['release'], 'only the origin-only branch is created');
    assert.ok(
      commands.some(c => /git branch --track "release" "origin\/release"/.test(c)),
      'issues git branch --track for release',
    );
    // main already exists locally -> never re-created.
    assert.ok(!commands.some(c => /git branch --track "main"/.test(c)), 'does not re-create main');
  });

  it('creates locals for every origin-only branch (scope = every origin branch)', async () => {
    const commands = mockGit({
      local: ['main'],
      remote: ['main', 'release', 'staging', 'feature/x'],
      current: 'main',
    });
    const created = await new GitService().ensureLocalBranchesForRemotes();

    assert.deepEqual(created.sort(), ['feature/x', 'release', 'staging']);
    assert.ok(commands.some(c => /git branch --track "feature\/x" "origin\/feature\/x"/.test(c)));
    assert.ok(commands.some(c => /git branch --track "staging" "origin\/staging"/.test(c)));
  });

  it('is a no-op when every origin branch already has a local', async () => {
    const commands = mockGit({ local: ['main', 'release'], remote: ['main', 'release'], current: 'main' });
    const created = await new GitService().ensureLocalBranchesForRemotes();

    assert.deepEqual(created, []);
    assert.ok(!commands.some(c => /git branch --track/.test(c)), 'no branch creation when nothing is missing');
  });

  it('skips a branch whose creation fails and continues with the rest (idempotent/robust)', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      if (/git branch -r/.test(cmd)) {
        cb(null, 'origin/HEAD -> origin/main\norigin/main\norigin/release\norigin/staging\n', '');
      } else if (/git rev-parse --abbrev-ref HEAD/.test(cmd)) {
        cb(null, 'main\n', '');
      } else if (/git branch --format/.test(cmd)) {
        cb(null, 'main|origin/main|\n', '');
      } else if (/git branch --track "release"/.test(cmd)) {
        cb(new Error('fatal: a branch named \'release\' already exists'), '', 'err');
      } else {
        cb(null, '', '');
      }
    };
    const created = await new GitService().ensureLocalBranchesForRemotes();
    // release failed (already exists) -> skipped; staging still created.
    assert.deepEqual(created, ['staging']);
  });
});
