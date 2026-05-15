import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GitService } from '../../src/services/gitService';

const cpModule = require('child_process');
const originalExec = cpModule.exec;

describe('GitService — extended operations', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
    sinon.restore();
  });

  function mockExecCmd(handler: (cmd: string) => { stdout?: string; error?: Error }) {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      const result = handler(cmd);
      if (result.error) { cb(result.error, '', result.error.message); }
      else { cb(null, result.stdout || '', ''); }
    };
  }

  // --- Commit variants ---

  describe('commitAll', () => {
    it('stages all and commits', async () => {
      const cmds: string[] = [];
      mockExecCmd(cmd => { cmds.push(cmd); return { stdout: '' }; });
      const service = new GitService();
      await service.commitAll('feat: add feature');
      assert.ok(cmds.some(c => c.includes('git add -A')));
      assert.ok(cmds.some(c => c.includes('git commit -m') && c.includes('feat: add feature')));
    });

    it('throws on empty message', async () => {
      const service = new GitService();
      await assert.rejects(() => service.commitAll(''), /Commit message is required/);
    });
  });

  describe('commitAmend', () => {
    it('runs git commit --amend --no-edit', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.commitAmend();
      assert.ok(cmd.includes('git commit --amend --no-edit'));
    });
  });

  describe('commitAmendMessage', () => {
    it('runs git commit --amend -m', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.commitAmendMessage('updated message');
      assert.ok(cmd.includes('git commit --amend -m'));
      assert.ok(cmd.includes('updated message'));
    });
  });

  describe('undoLastCommit', () => {
    it('runs git reset --soft HEAD~1', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.undoLastCommit();
      assert.ok(cmd.includes('git reset --soft HEAD~1'));
    });
  });

  describe('commitSignedOff', () => {
    it('runs git commit -s -m', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.commitSignedOff('feat: signed');
      assert.ok(cmd.includes('git commit -s -m'));
      assert.ok(cmd.includes('feat: signed'));
    });

    it('throws on empty message', async () => {
      const service = new GitService();
      await assert.rejects(() => service.commitSignedOff(''), /Commit message is required/);
    });
  });

  describe('commitAllSignedOff', () => {
    it('stages all and commits signed off', async () => {
      const cmds: string[] = [];
      mockExecCmd(cmd => { cmds.push(cmd); return {}; });
      const service = new GitService();
      await service.commitAllSignedOff('feat: all signed');
      assert.ok(cmds.some(c => c.includes('git add -A')));
      assert.ok(cmds.some(c => c.includes('git commit -s -m')));
    });
  });

  // --- Rebase ---

  describe('abortRebase', () => {
    it('runs git rebase --abort', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.abortRebase();
      assert.ok(cmd.includes('git rebase --abort'));
    });
  });

  describe('isRebasing', () => {
    it('returns false when not rebasing', async () => {
      const service = new GitService();
      assert.strictEqual(await service.isRebasing(), false);
    });
  });

  describe('rebaseBranch', () => {
    it('runs git rebase with branch name', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.rebaseBranch('main');
      assert.ok(cmd.includes('git rebase "main"'));
    });
  });

  // --- Branch management ---

  describe('deleteBranch (git)', () => {
    it('runs git branch -d', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.deleteBranch('old-branch');
      assert.ok(cmd.includes('git branch -d "old-branch"'));
    });
  });

  describe('deleteRemoteBranch', () => {
    it('runs git push origin --delete', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.deleteRemoteBranch('old-branch');
      assert.ok(cmd.includes('git push origin --delete "old-branch"'));
    });
  });

  describe('renameBranch', () => {
    it('runs git branch -m', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.renameBranch('new-name');
      assert.ok(cmd.includes('git branch -m "new-name"'));
    });
  });

  describe('mergeBranch', () => {
    it('runs git merge', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.mergeBranch('feature-x');
      assert.ok(cmd.includes('git merge "feature-x"'));
    });
  });

  // --- Remote ---

  describe('addRemote', () => {
    it('runs git remote add', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.addRemote('upstream', 'https://github.com/org/repo.git');
      assert.ok(cmd.includes('git remote add "upstream" "https://github.com/org/repo.git"'));
    });
  });

  describe('removeRemote', () => {
    it('runs git remote remove', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.removeRemote('upstream');
      assert.ok(cmd.includes('git remote remove "upstream"'));
    });
  });

  describe('listRemotes', () => {
    it('returns list of remotes', async () => {
      mockExecCmd(cmd => {
        if (cmd.includes('git remote')) { return { stdout: 'origin\nupstream\n' }; }
        return {};
      });
      const service = new GitService();
      const remotes = await service.listRemotes();
      assert.deepStrictEqual(remotes, ['origin', 'upstream']);
    });

    it('returns empty when no remotes', async () => {
      mockExecCmd(() => ({ stdout: '' }));
      const service = new GitService();
      assert.deepStrictEqual(await service.listRemotes(), []);
    });
  });

  // --- Pull variants ---

  describe('pullRebase', () => {
    it('runs git pull --rebase', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.pullRebase();
      assert.ok(cmd.includes('git pull --rebase'));
    });
  });

  describe('pullFrom', () => {
    it('runs git pull with remote and branch', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.pullFrom('upstream', 'main');
      assert.ok(cmd.includes('git pull "upstream" "main"'));
    });
  });

  describe('pushTo', () => {
    it('runs git push with remote and branch', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.pushTo('upstream', 'main');
      assert.ok(cmd.includes('git push "upstream" "main"'));
    });
  });

  // --- Fetch variants ---

  describe('fetchPrune', () => {
    it('runs git fetch --prune', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.fetchPrune();
      assert.ok(cmd.includes('git fetch --prune'));
    });
  });

  describe('fetchAll', () => {
    it('runs git fetch --all', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.fetchAll();
      assert.ok(cmd.includes('git fetch --all'));
    });
  });

  // --- Stash variants ---

  describe('stashStaged', () => {
    it('runs git stash push --staged', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.stashStaged();
      assert.ok(cmd.includes('git stash push --staged'));
    });

    it('includes message when provided', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.stashStaged('staged WIP');
      assert.ok(cmd.includes('--staged'));
      assert.ok(cmd.includes('-m'));
      assert.ok(cmd.includes('staged WIP'));
    });
  });

  describe('stashIncludeUntracked', () => {
    it('runs git stash push --include-untracked', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.stashIncludeUntracked();
      assert.ok(cmd.includes('git stash push --include-untracked'));
    });
  });

  describe('stashList', () => {
    it('returns stash entries', async () => {
      mockExecCmd(() => ({ stdout: 'stash@{0}: WIP on main\nstash@{1}: WIP on feature\n' }));
      const service = new GitService();
      const stashes = await service.stashList();
      assert.strictEqual(stashes.length, 2);
      assert.ok(stashes[0].includes('stash@{0}'));
    });

    it('returns empty when no stashes', async () => {
      mockExecCmd(() => ({ stdout: '' }));
      const service = new GitService();
      assert.deepStrictEqual(await service.stashList(), []);
    });
  });

  describe('stashApply', () => {
    it('applies specific stash by index', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.stashApply(2);
      assert.ok(cmd.includes('git stash apply stash@{2}'));
    });

    it('defaults to index 0', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.stashApply();
      assert.ok(cmd.includes('git stash apply stash@{0}'));
    });
  });

  describe('stashDrop', () => {
    it('drops specific stash by index', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.stashDrop(1);
      assert.ok(cmd.includes('git stash drop stash@{1}'));
    });
  });

  describe('stashDropAll', () => {
    it('runs git stash clear', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.stashDropAll();
      assert.ok(cmd.includes('git stash clear'));
    });
  });

  // --- Tags ---

  describe('createTag', () => {
    it('creates lightweight tag', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.createTag('v1.0.0');
      assert.ok(cmd.includes('git tag'));
      assert.ok(cmd.includes('v1.0.0'));
      assert.ok(!cmd.includes('-a'));
    });

    it('creates annotated tag with message', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.createTag('v1.0.0', 'Release 1.0');
      assert.ok(cmd.includes('git tag -a'));
      assert.ok(cmd.includes('-m'));
      assert.ok(cmd.includes('Release 1.0'));
    });
  });

  describe('deleteTag', () => {
    it('runs git tag -d', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.deleteTag('v1.0.0');
      assert.ok(cmd.includes('git tag -d "v1.0.0"'));
    });
  });

  describe('deleteRemoteTag', () => {
    it('runs git push origin --delete refs/tags/', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.deleteRemoteTag('v1.0.0');
      assert.ok(cmd.includes('git push origin --delete "refs/tags/v1.0.0"'));
    });
  });

  describe('listTags', () => {
    it('returns tags', async () => {
      mockExecCmd(() => ({ stdout: 'v0.1.0\nv0.2.0\nv0.3.0\n' }));
      const service = new GitService();
      const tags = await service.listTags();
      assert.deepStrictEqual(tags, ['v0.1.0', 'v0.2.0', 'v0.3.0']);
    });

    it('returns empty when no tags', async () => {
      mockExecCmd(() => ({ stdout: '' }));
      const service = new GitService();
      assert.deepStrictEqual(await service.listTags(), []);
    });
  });

  // --- Worktrees ---

  describe('createWorktree', () => {
    it('runs git worktree add with path and branch', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.createWorktree('/tmp/wt', 'feature-wt');
      assert.ok(cmd.includes('git worktree add "/tmp/wt" -b "feature-wt"'));
    });
  });

  describe('listWorktrees', () => {
    it('returns worktree list', async () => {
      mockExecCmd(() => ({
        stdout: '/repo  abc1234 [main]\n/tmp/wt  def5678 [feature-wt]\n',
      }));
      const service = new GitService();
      const wt = await service.listWorktrees();
      assert.strictEqual(wt.length, 2);
    });

    it('returns empty when only main worktree', async () => {
      mockExecCmd(() => ({ stdout: '' }));
      const service = new GitService();
      assert.deepStrictEqual(await service.listWorktrees(), []);
    });
  });

  describe('removeWorktree', () => {
    it('runs git worktree remove', async () => {
      let cmd = '';
      mockExecCmd(c => { cmd = c; return {}; });
      const service = new GitService();
      await service.removeWorktree('/tmp/wt');
      assert.ok(cmd.includes('git worktree remove "/tmp/wt"'));
    });
  });

  // --- Discard ---

  describe('discardAllChanges', () => {
    it('runs checkout and clean', async () => {
      const cmds: string[] = [];
      mockExecCmd(cmd => { cmds.push(cmd); return {}; });
      const service = new GitService();
      await service.discardAllChanges();
      assert.ok(cmds.some(c => c.includes('git checkout -- .')));
      assert.ok(cmds.some(c => c.includes('git clean -fd')));
    });
  });
});
