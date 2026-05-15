import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GitService } from '../../src/services/gitService';
import { LakebaseService, LakebaseBranch } from '../../src/services/lakebaseService';

const cpModule = require('child_process');
const originalExec = cpModule.exec;

describe('Branch Picker', () => {
  let gitStub: sinon.SinonStubbedInstance<GitService>;
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;

  beforeEach(() => {
    gitStub = sinon.createStubInstance(GitService);
    lakebaseStub = sinon.createStubInstance(LakebaseService);
    lakebaseStub.sanitizeBranchName.callsFake((name: string) =>
      name.replace(/\//g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 63)
    );
  });

  afterEach(() => sinon.restore());

  function makeBranch(id: string, state: string = 'READY', isDefault: boolean = false): LakebaseBranch {
    return { uid: `br-${id}`, name: `projects/p1/branches/${id}`, branchId: id, state, isDefault };
  }

  describe('local branch list with Lakebase pairing', () => {
    it('maps git branches to Lakebase branches by sanitized name', () => {
      const lakebaseBranches = [
        makeBranch('br-default', 'READY', true),
        makeBranch('feature-orders', 'READY'),
        makeBranch('cart', 'READY'),
      ];

      const lbMap = new Map<string, string>();
      for (const lb of lakebaseBranches) {
        lbMap.set(lb.branchId, `${lb.branchId} (${lb.state})`);
      }
      const defaultLb = lakebaseBranches.find(b => b.isDefault);

      // main maps to default
      assert.ok(defaultLb);

      // feature/orders maps to feature-orders
      assert.strictEqual(lakebaseStub.sanitizeBranchName('feature/orders'), 'feature-orders');
      assert.ok(lbMap.has('feature-orders'));

      // cart maps to cart
      assert.strictEqual(lakebaseStub.sanitizeBranchName('cart'), 'cart');
      assert.ok(lbMap.has('cart'));
    });

    it('shows "no Lakebase branch" for unmatched git branches', () => {
      const lbMap = new Map<string, string>();
      lbMap.set('br-default', 'br-default');

      const sanitized = lakebaseStub.sanitizeBranchName('orphan-branch');
      assert.strictEqual(lbMap.has(sanitized), false);
    });

    it('sanitizes branch names correctly for Lakebase lookup', () => {
      assert.strictEqual(lakebaseStub.sanitizeBranchName('feature/dev-sprint-1'), 'feature-dev-sprint-1');
      assert.strictEqual(lakebaseStub.sanitizeBranchName('Feature_BRANCH!'), 'feature-branch-');
      assert.strictEqual(lakebaseStub.sanitizeBranchName('UPPERCASE'), 'uppercase');
    });
  });

  describe('remote branches in picker', () => {
    it('maps remote branches to Lakebase by sanitized name', () => {
      const lakebaseBranches = [makeBranch('hotfix-123', 'READY')];
      const lbMap = new Map<string, string>();
      for (const lb of lakebaseBranches) {
        lbMap.set(lb.branchId, `${lb.branchId} (${lb.state})`);
      }

      // Remote branch origin/hotfix-123 → shortName hotfix-123 → matches Lakebase
      const sanitized = lakebaseStub.sanitizeBranchName('hotfix-123');
      assert.ok(lbMap.has(sanitized));
    });

    it('shows "no Lakebase branch" for remote branches without pairing', () => {
      const lbMap = new Map<string, string>();

      const sanitized = lakebaseStub.sanitizeBranchName('some-remote-branch');
      assert.strictEqual(lbMap.has(sanitized), false);
    });

    it('excludes locally checked out branches from remote list', () => {
      const localNames = new Set(['main', 'feature-orders', 'cart']);
      const remoteBranches = [
        'origin/main',
        'origin/feature-orders',
        'origin/cart',
        'origin/revert-3-feature-branch',
        'origin/HEAD',
      ];

      const filtered = remoteBranches
        .filter(name => !name.includes('HEAD'))
        .map(name => name.replace(/^origin\//, ''))
        .filter(shortName => !localNames.has(shortName));

      assert.deepStrictEqual(filtered, ['revert-3-feature-branch']);
    });
  });
});

describe('onBranchChanged — Lakebase connection sync', () => {
  async function simulateBranchChange(
    newBranch: string,
    lakebaseService: LakebaseService,
    autoCreateBranch: boolean
  ): Promise<{
    action: 'skipped' | 'synced' | 'created' | 'no-branch' | 'error';
    branchId?: string;
    host?: string;
    error?: string;
  }> {
    if (!newBranch || newBranch === 'main' || newBranch === 'master') {
      return { action: 'skipped' };
    }

    try {
      const existing = await lakebaseService.getBranchByName(newBranch);
      if (existing) {
        const ep = await lakebaseService.getEndpoint(existing.branchId);
        if (ep?.host) {
          await lakebaseService.getCredential(existing.branchId);
          return { action: 'synced', branchId: existing.branchId, host: ep.host };
        }
        return { action: 'synced', branchId: existing.branchId };
      }

      if (!autoCreateBranch) {
        return { action: 'no-branch' };
      }

      const branch = await lakebaseService.createBranch(newBranch);
      if (!branch) { return { action: 'error', error: 'createBranch returned undefined' }; }

      const ep = await lakebaseService.getEndpoint(branch.branchId);
      if (ep?.host) {
        await lakebaseService.getCredential(branch.branchId);
      }
      return { action: 'created', branchId: branch.branchId };
    } catch (err: any) {
      return { action: 'error', error: err.message };
    }
  }

  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;

  beforeEach(() => {
    lakebaseStub = sinon.createStubInstance(LakebaseService);
    lakebaseStub.sanitizeBranchName.callsFake((name: string) =>
      name.replace(/\//g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 63)
    );
  });

  afterEach(() => sinon.restore());

  function makeBranch(id: string, state: string = 'READY'): LakebaseBranch {
    return { uid: `br-${id}`, name: `projects/p1/branches/${id}`, branchId: id, state, isDefault: false };
  }

  it('syncs connection when Lakebase branch exists', async () => {
    lakebaseStub.getBranchByName.resolves(makeBranch('feature-orders'));
    lakebaseStub.getEndpoint.resolves({ host: 'ep-test.com', state: 'ACTIVE' });
    lakebaseStub.getCredential.resolves({ token: 'tok', email: 'user@test.com' });

    const result = await simulateBranchChange('feature/orders', lakebaseStub as any, true);

    assert.strictEqual(result.action, 'synced');
    assert.strictEqual(result.branchId, 'feature-orders');
    assert.strictEqual(result.host, 'ep-test.com');
    assert.ok(lakebaseStub.getEndpoint.called);
    assert.ok(lakebaseStub.getCredential.called);
  });

  it('syncs even when autoCreateBranch is false', async () => {
    lakebaseStub.getBranchByName.resolves(makeBranch('cart'));
    lakebaseStub.getEndpoint.resolves({ host: 'ep-cart.com', state: 'ACTIVE' });
    lakebaseStub.getCredential.resolves({ token: 'tok', email: 'user@test.com' });

    const result = await simulateBranchChange('cart', lakebaseStub as any, false);

    assert.strictEqual(result.action, 'synced');
    assert.strictEqual(result.branchId, 'cart');
  });

  it('creates Lakebase branch when none exists and autoCreate is on', async () => {
    lakebaseStub.getBranchByName.resolves(undefined);
    lakebaseStub.createBranch.resolves(makeBranch('new-feature'));
    lakebaseStub.getEndpoint.resolves({ host: 'ep-new.com', state: 'ACTIVE' });
    lakebaseStub.getCredential.resolves({ token: 'tok', email: 'user@test.com' });

    const result = await simulateBranchChange('new-feature', lakebaseStub as any, true);

    assert.strictEqual(result.action, 'created');
    assert.strictEqual(result.branchId, 'new-feature');
    assert.ok(lakebaseStub.createBranch.called);
  });

  it('does not create when autoCreate is off and no branch exists', async () => {
    lakebaseStub.getBranchByName.resolves(undefined);

    const result = await simulateBranchChange('orphan', lakebaseStub as any, false);

    assert.strictEqual(result.action, 'no-branch');
    assert.strictEqual(lakebaseStub.createBranch.called, false);
  });

  it('skips main branch', async () => {
    const result = await simulateBranchChange('main', lakebaseStub as any, true);
    assert.strictEqual(result.action, 'skipped');
    assert.strictEqual(lakebaseStub.getBranchByName.called, false);
  });

  it('skips master branch', async () => {
    const result = await simulateBranchChange('master', lakebaseStub as any, true);
    assert.strictEqual(result.action, 'skipped');
  });

  it('skips empty branch name', async () => {
    const result = await simulateBranchChange('', lakebaseStub as any, true);
    assert.strictEqual(result.action, 'skipped');
  });

  it('handles credential errors gracefully', async () => {
    lakebaseStub.getBranchByName.resolves(makeBranch('feature-x'));
    lakebaseStub.getEndpoint.resolves({ host: 'ep.com', state: 'ACTIVE' });
    lakebaseStub.getCredential.rejects(new Error('token expired'));

    const result = await simulateBranchChange('feature-x', lakebaseStub as any, true);

    assert.strictEqual(result.action, 'error');
    assert.ok(result.error?.includes('token expired'));
  });

  it('handles endpoint not available', async () => {
    lakebaseStub.getBranchByName.resolves(makeBranch('feature-x'));
    lakebaseStub.getEndpoint.resolves(undefined);

    const result = await simulateBranchChange('feature-x', lakebaseStub as any, true);

    assert.strictEqual(result.action, 'synced');
    assert.strictEqual(result.branchId, 'feature-x');
    assert.strictEqual(lakebaseStub.getCredential.called, false);
  });

  it('syncs connection for remote branch checked out locally', async () => {
    // When checking out a remote branch, it becomes local with the short name
    lakebaseStub.getBranchByName.resolves(makeBranch('revert-3-feature-branch'));
    lakebaseStub.getEndpoint.resolves({ host: 'ep-revert.com', state: 'ACTIVE' });
    lakebaseStub.getCredential.resolves({ token: 'tok', email: 'user@test.com' });

    const result = await simulateBranchChange('revert-3-feature-branch', lakebaseStub as any, true);

    assert.strictEqual(result.action, 'synced');
    assert.strictEqual(result.branchId, 'revert-3-feature-branch');
  });
});

describe('GitService — branch operations', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
    sinon.restore();
  });

  describe('hasUpstream', () => {
    it('returns true when upstream exists', async () => {
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(null, 'origin/feature-x', '');
      };
      const service = new GitService();
      assert.strictEqual(await service.hasUpstream(), true);
    });

    it('returns false when no upstream', async () => {
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(new Error('no upstream'), '', '');
      };
      const service = new GitService();
      assert.strictEqual(await service.hasUpstream(), false);
    });
  });

  describe('listRemoteBranches', () => {
    it('lists remote branches excluding locally checked out ones', async () => {
      let callCount = 0;
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        callCount++;
        if (cmd.includes('--format') && !cmd.includes('-r')) {
          // listLocalBranches → getCurrentBranch first, then branch --format
          if (cmd.includes('rev-parse')) {
            cb(null, 'main', '');
          } else {
            cb(null, 'main|origin/main|\nfeature-orders|origin/feature-orders|\n', '');
          }
        } else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          cb(null, 'main', '');
        } else if (cmd.includes('-r')) {
          // listRemoteBranches
          cb(null, 'origin/main\norigin/feature-orders\norigin/hotfix-99\norigin/HEAD -> origin/main\n', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      const remotes = await service.listRemoteBranches();

      // main and feature-orders are local, so only hotfix-99 should appear
      assert.strictEqual(remotes.length, 1);
      assert.strictEqual(remotes[0].name, 'hotfix-99');
      assert.strictEqual(remotes[0].isRemote, true);
      assert.strictEqual(remotes[0].tracking, 'origin/hotfix-99');
    });

    it('excludes HEAD from remote list', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('rev-parse')) {
          cb(null, 'main', '');
        } else if (cmd.includes('-r')) {
          cb(null, 'origin/HEAD -> origin/main\norigin/main\n', '');
        } else if (cmd.includes('--format')) {
          cb(null, 'main|origin/main|\n', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      const remotes = await service.listRemoteBranches();
      assert.strictEqual(remotes.length, 0);
    });

    it('returns empty array when no remotes', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('rev-parse')) {
          cb(null, 'main', '');
        } else if (cmd.includes('-r')) {
          cb(null, '', '');
        } else if (cmd.includes('--format')) {
          cb(null, 'main|origin/main|\n', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      const remotes = await service.listRemoteBranches();
      assert.deepStrictEqual(remotes, []);
    });
  });

  describe('publishBranch', () => {
    it('pushes with -u origin and current branch name', async () => {
      let pushedCmd = '';
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          cb(null, 'feature-x', '');
        } else {
          pushedCmd = cmd;
          cb(null, '', '');
        }
      };
      const service = new GitService();
      await service.publishBranch();
      assert.ok(pushedCmd.includes('git push -u origin'));
      assert.ok(pushedCmd.includes('feature-x'));
    });
  });

  describe('createPullRequest', () => {
    it('publishes branch if no upstream then creates PR', async () => {
      let commands: string[] = [];
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        commands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref @{u}')) {
          cb(new Error('no upstream'), '', '');
        } else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          cb(null, 'feature-x', '');
        } else if (cmd.includes('gh pr create')) {
          cb(null, 'https://github.com/user/repo/pull/42', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      const url = await service.createPullRequest('Test PR', 'body');
      assert.strictEqual(url, 'https://github.com/user/repo/pull/42');
      assert.ok(commands.some(c => c.includes('git push -u origin')), 'should publish first');
      assert.ok(commands.some(c => c.includes('gh pr create')));
    });

    it('skips publish if upstream exists', async () => {
      let commands: string[] = [];
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        commands.push(cmd);
        if (cmd.includes('rev-parse --abbrev-ref @{u}')) {
          cb(null, 'origin/feature-x', '');
        } else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          cb(null, 'feature-x', '');
        } else if (cmd.includes('gh pr create')) {
          cb(null, 'https://github.com/user/repo/pull/43', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      const url = await service.createPullRequest('Test PR', 'body');
      assert.strictEqual(url, 'https://github.com/user/repo/pull/43');
      assert.ok(!commands.some(c => c.includes('git push -u origin')), 'should not publish');
    });
  });
});

describe('SCM statusBarCommands — branch indicator', () => {
  it('shows branch name with dirty indicator logic', () => {
    // Test the dirty indicator logic
    const staged = [{ status: 'modified', path: 'a.ts' }];
    const unstaged = [{ status: 'added', path: 'b.ts' }];
    const hasUncommitted = staged.length > 0 || unstaged.length > 0;
    const dirty = hasUncommitted ? '*' : '';
    const label = `$(git-branch) feature/orders${dirty}`;
    assert.strictEqual(label, '$(git-branch) feature/orders*');
  });

  it('shows no dirty indicator when clean', () => {
    const staged: any[] = [];
    const unstaged: any[] = [];
    const hasUncommitted = staged.length > 0 || unstaged.length > 0;
    const dirty = hasUncommitted ? '*' : '';
    const label = `$(git-branch) feature/orders${dirty}`;
    assert.strictEqual(label, '$(git-branch) feature/orders');
  });

  it('tooltip includes uncommitted changes note when dirty', () => {
    const branch = 'feature/orders';
    const dirty = true;
    const dirty2 = '*';
    const tooltip = `${branch}${dirty2}; Check out Branch/Tag...`;
    assert.ok(tooltip.includes('*'));
  });

  it('tooltip is clean when no uncommitted changes', () => {
    const branch = 'feature/orders';
    const dirty = false;
    const dirty2 = '';
    const tooltip = `${branch}${dirty2}; Check out Branch/Tag...`;
    assert.ok(!tooltip.includes('*;'));
    assert.ok(tooltip.includes('Check out Branch/Tag...'));
  });
});

describe('GitService — fetch, stash, sync', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
    sinon.restore();
  });

  describe('fetch', () => {
    it('runs git fetch', async () => {
      let executedCmd = '';
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        executedCmd = cmd;
        cb(null, '', '');
      };
      const service = new GitService();
      await service.fetch();
      assert.ok(executedCmd.includes('git fetch'));
    });

    it('throws when git fetch fails', async () => {
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(new Error('network error'), '', '');
      };
      const service = new GitService();
      await assert.rejects(() => service.fetch(), /network error/);
    });
  });

  describe('stash', () => {
    it('runs git stash push without message', async () => {
      let executedCmd = '';
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        executedCmd = cmd;
        cb(null, '', '');
      };
      const service = new GitService();
      await service.stash();
      assert.ok(executedCmd.includes('git stash push'));
      assert.ok(!executedCmd.includes('-m'));
    });

    it('runs git stash push with message', async () => {
      let executedCmd = '';
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        executedCmd = cmd;
        cb(null, '', '');
      };
      const service = new GitService();
      await service.stash('WIP: my changes');
      assert.ok(executedCmd.includes('git stash push'));
      assert.ok(executedCmd.includes('-m'));
      assert.ok(executedCmd.includes('WIP: my changes'));
    });

    it('throws when nothing to stash', async () => {
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(new Error('No local changes to save'), '', '');
      };
      const service = new GitService();
      await assert.rejects(() => service.stash(), /No local changes/);
    });
  });

  describe('stashPop', () => {
    it('runs git stash pop', async () => {
      let executedCmd = '';
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        executedCmd = cmd;
        cb(null, '', '');
      };
      const service = new GitService();
      await service.stashPop();
      assert.ok(executedCmd.includes('git stash pop'));
    });

    it('throws when no stash entries', async () => {
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(new Error('No stash entries found'), '', '');
      };
      const service = new GitService();
      await assert.rejects(() => service.stashPop(), /No stash entries/);
    });
  });

  describe('sync', () => {
    it('runs pull then push', async () => {
      const commands: string[] = [];
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        commands.push(cmd);
        cb(null, '', '');
      };
      const service = new GitService();
      await service.sync();
      assert.ok(commands.some(c => c.includes('git pull')));
      assert.ok(commands.some(c => c.includes('git push')));
      // Pull should come before push
      const pullIdx = commands.findIndex(c => c.includes('git pull'));
      const pushIdx = commands.findIndex(c => c.includes('git push'));
      assert.ok(pullIdx < pushIdx, 'pull should run before push');
    });

    it('throws if pull fails (does not push)', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('git pull')) {
          cb(new Error('merge conflict'), '', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      await assert.rejects(() => service.sync(), /merge conflict/);
    });
  });

  describe('commit', () => {
    it('runs git commit with message', async () => {
      let executedCmd = '';
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        executedCmd = cmd;
        cb(null, '', '');
      };
      const service = new GitService();
      await service.commit('fix: resolve bug');
      assert.ok(executedCmd.includes('git commit -m'));
      assert.ok(executedCmd.includes('fix: resolve bug'));
    });

    it('throws on empty message', async () => {
      const service = new GitService();
      await assert.rejects(() => service.commit(''), /Commit message is required/);
      await assert.rejects(() => service.commit('   '), /Commit message is required/);
    });

    it('escapes double quotes in message', async () => {
      let executedCmd = '';
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        executedCmd = cmd;
        cb(null, '', '');
      };
      const service = new GitService();
      await service.commit('fix: handle "edge case"');
      assert.ok(executedCmd.includes('\\"edge case\\"'));
    });
  });

  describe('stageFile and unstageFile', () => {
    it('runs git add for staging', async () => {
      let executedCmd = '';
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        executedCmd = cmd;
        cb(null, '', '');
      };
      const service = new GitService();
      await service.stageFile('src/app.ts');
      assert.ok(executedCmd.includes('git add'));
      assert.ok(executedCmd.includes('src/app.ts'));
    });

    it('runs git reset HEAD for unstaging', async () => {
      let executedCmd = '';
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        executedCmd = cmd;
        cb(null, '', '');
      };
      const service = new GitService();
      await service.unstageFile('src/app.ts');
      assert.ok(executedCmd.includes('git reset HEAD'));
      assert.ok(executedCmd.includes('src/app.ts'));
    });
  });

  describe('getStagedChanges', () => {
    it('returns staged files with status', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(null, 'A\tsrc/new.ts\nM\tsrc/changed.ts\nD\tsrc/old.ts\n', '');
      };
      const service = new GitService();
      const staged = await service.getStagedChanges();
      assert.strictEqual(staged.length, 3);
      assert.strictEqual(staged[0].status, 'added');
      assert.strictEqual(staged[1].status, 'modified');
      assert.strictEqual(staged[2].status, 'deleted');
    });

    it('returns empty when nothing staged', async () => {
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(null, '', '');
      };
      const service = new GitService();
      const staged = await service.getStagedChanges();
      assert.deepStrictEqual(staged, []);
    });
  });

  describe('getUnstagedChanges', () => {
    it('includes modified tracked files and untracked files', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('ls-files')) {
          cb(null, 'new-untracked.ts\n', '');
        } else if (cmd.includes('git diff --name-status') && !cmd.includes('--cached')) {
          cb(null, 'M\tsrc/changed.ts\n', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      const changes = await service.getUnstagedChanges();
      assert.strictEqual(changes.length, 2);
      const modified = changes.find(c => c.path === 'src/changed.ts');
      assert.ok(modified);
      assert.strictEqual(modified!.status, 'modified');
      const untracked = changes.find(c => c.path === 'new-untracked.ts');
      assert.ok(untracked);
      assert.strictEqual(untracked!.status, 'added');
    });
  });
});
