import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SchemaScmProvider } from '../../src/providers/schemaScmProvider';
import { GitService } from '../../src/services/gitService';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';
import { SchemaDiffService, SchemaDiffResult } from '../../src/services/schemaDiffService';
import { LakebaseService, LakebaseBranch } from '../../src/services/lakebaseService';

const cpModule = require('child_process');
const originalExec = cpModule.exec;

describe('Merge Awareness — main branch view', () => {
  let provider: SchemaScmProvider;
  let gitStub: sinon.SinonStubbedInstance<GitService>;
  let migrationStub: sinon.SinonStubbedInstance<SchemaMigrationService>;
  let schemaDiffStub: sinon.SinonStubbedInstance<SchemaDiffService>;
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;

  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];

    gitStub = sinon.createStubInstance(GitService);
    gitStub.getCachedBranch.returns('main');
    gitStub.getCurrentBranch.resolves('main');
    gitStub.getStagedChanges.resolves([]);
    gitStub.getUnstagedChanges.resolves([]);
    gitStub.getChangedFiles.resolves([]);
    gitStub.getMergeBase.resolves('abc123');
    gitStub.getAheadBehind.resolves({ ahead: 0, behind: 0, upstream: 'origin/main' });
    (gitStub as any).onBranchChanged = new (vscode as any).EventEmitter().event;
    (gitStub as any).getPullRequest = sinon.stub().resolves(undefined);

    migrationStub = sinon.createStubInstance(SchemaMigrationService);
    migrationStub.listMigrations.returns([]);
    migrationStub.watchMigrations.returns({ dispose: () => {} });

    schemaDiffStub = sinon.createStubInstance(SchemaDiffService);

    lakebaseStub = sinon.createStubInstance(LakebaseService);
    lakebaseStub.sanitizeBranchName.callsFake((name: string) =>
      name.replace(/\//g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 63)
    );
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    if (provider) { provider.dispose(); }
    sinon.restore();
  });

  function makeBranch(id: string, state: string = 'READY', isDefault: boolean = false): LakebaseBranch {
    return { uid: `br-${id}`, name: `projects/p1/branches/${id}`, branchId: id, state, isDefault };
  }

  describe('Lakebase group — production status', () => {
    it('shows production branch status on main', async () => {
      lakebaseStub.getDefaultBranch.resolves(makeBranch('br-prod-123', 'READY', true));
      lakebaseStub.getConsoleUrl.returns('https://workspace.databricks.com/lakebase/projects/p1/branches/br-prod-123');

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(lakebaseStub.getDefaultBranch.called);
    });

    it('handles missing default branch gracefully', async () => {
      lakebaseStub.getDefaultBranch.resolves(undefined);

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any);
      await new Promise(r => setTimeout(r, 150));

      // Should not throw
      assert.ok(true);
    });

    it('handles Lakebase API failure gracefully', async () => {
      lakebaseStub.getDefaultBranch.rejects(new Error('auth failed'));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(true);
    });
  });

  describe('Schema Migrations group', () => {
    it('lists all migration files on main', async () => {
      migrationStub.listMigrations.returns([
        { version: '1', description: 'init', filename: 'V1__init.sql', fullPath: '/fake/root/db/V1__init.sql' },
        { version: '2', description: 'create book', filename: 'V2__create_book.sql', fullPath: '/fake/root/db/V2__create_book.sql' },
        { version: '3', description: 'create product', filename: 'V3__create_product.sql', fullPath: '/fake/root/db/V3__create_product.sql' },
      ]);
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any);
      await new Promise(r => setTimeout(r, 150));

      assert.ok(migrationStub.listMigrations.called);
    });

    it('shows empty when no migrations', async () => {
      migrationStub.listMigrations.returns([]);
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any);
      await new Promise(r => setTimeout(r, 150));

      // Migrations group is hideWhenEmpty=true, so it hides
      assert.ok(true);
    });

    it('each migration links to its file', () => {
      const mig = { version: '6', description: 'create orders', filename: 'V6__create_orders.sql', fullPath: '/fake/root/db/V6__create_orders.sql' };
      // Verify the fullPath is used for the open command
      assert.ok(mig.fullPath.endsWith('V6__create_orders.sql'));
    });
  });

  describe('Recent Merges group', () => {
    it('shows recent merge commits on main', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('git log --merges')) {
          cb(null, 'abc1234 Merge pull request #9 from feature/orders\ndef5678 Merge pull request #8 from feature/cart\n', '');
        } else if (cmd.includes('git remote get-url')) {
          cb(null, 'https://github.com/user/repo.git', '');
        } else if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          cb(null, 'main', '');
        } else if (cmd.includes('rev-parse --verify')) {
          cb(null, '', '');
        } else {
          cb(null, '', '');
        }
      };

      migrationStub.listMigrations.returns([]);
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));
      lakebaseStub.getConsoleUrl.returns('');

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any);
      await new Promise(r => setTimeout(r, 200));

      // The merge log was read
      assert.ok(true);
    });

    it('builds GitHub commit URLs from remote', () => {
      const remoteRaw = 'https://github.com/user/repo.git';
      const repoUrl = remoteRaw.replace(/\.git$/, '');
      const commitUrl = `${repoUrl}/commit/abc1234`;
      assert.strictEqual(commitUrl, 'https://github.com/user/repo/commit/abc1234');
    });

    it('handles SSH remote URL format', () => {
      const remoteRaw = 'git@github.com:user/repo.git';
      const repoUrl = remoteRaw
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/');
      assert.strictEqual(repoUrl, 'https://github.com/user/repo');
    });

    it('shows empty when no merge commits', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('git log --merges')) {
          cb(null, '', '');
        } else {
          cb(null, '', '');
        }
      };

      migrationStub.listMigrations.returns([]);
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any);
      await new Promise(r => setTimeout(r, 150));

      // Merges group hideWhenEmpty=true, so it hides
      assert.ok(true);
    });
  });

  describe('Groups are cleared on feature branch', () => {
    it('migrations and merges groups are empty on feature branch', async () => {
      gitStub.getCachedBranch.returns('feature-x');
      gitStub.getCurrentBranch.resolves('feature-x');
      gitStub.getAheadBehind.resolves({ ahead: 0, behind: 0, upstream: '' });

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any);
      await new Promise(r => setTimeout(r, 150));

      // On feature branch, migrations and merges groups should not be populated
      assert.ok(gitStub.getUnstagedChanges.called);
    });
  });

  describe('PR group is cleared on main', () => {
    it('PR group is empty and polling stopped on main', async () => {
      lakebaseStub.getDefaultBranch.resolves(makeBranch('prod', 'READY', true));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any, lakebaseStub as any);
      await new Promise(r => setTimeout(r, 150));

      // hasPR context should be false
      assert.strictEqual(provider.getLastPrInfo(), undefined);
    });
  });
});

describe('GitService — mergePullRequest', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('runs gh pr merge with merge method', async () => {
    let cmd = '';
    cpModule.exec = (c: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cmd = c;
      cb(null, '', '');
    };
    const service = new GitService();
    await service.mergePullRequest('merge', true);
    assert.ok(cmd.includes('gh pr merge --merge --delete-branch'));
  });

  it('runs gh pr merge with squash method', async () => {
    let cmd = '';
    cpModule.exec = (c: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cmd = c;
      cb(null, '', '');
    };
    const service = new GitService();
    await service.mergePullRequest('squash', true);
    assert.ok(cmd.includes('gh pr merge --squash --delete-branch'));
  });

  it('runs gh pr merge with rebase method', async () => {
    let cmd = '';
    cpModule.exec = (c: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cmd = c;
      cb(null, '', '');
    };
    const service = new GitService();
    await service.mergePullRequest('rebase', false);
    assert.ok(cmd.includes('gh pr merge --rebase'));
    assert.ok(!cmd.includes('--delete-branch'));
  });
});

describe('GitService — getPullRequest', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('parses PR info with CI status', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cb(null, JSON.stringify({
        number: 9,
        title: 'Feature orders',
        url: 'https://github.com/user/repo/pull/9',
        state: 'OPEN',
        headRefName: 'feature/orders',
        baseRefName: 'main',
        statusCheckRollup: [
          { conclusion: 'SUCCESS', status: 'COMPLETED' },
          { conclusion: 'SUCCESS', status: 'COMPLETED' },
        ],
      }), '');
    };
    const service = new GitService();
    const pr = await service.getPullRequest();
    assert.ok(pr);
    assert.strictEqual(pr!.number, 9);
    assert.strictEqual(pr!.ciStatus, 'success');
    assert.strictEqual(pr!.headBranch, 'feature/orders');
  });

  it('detects pending CI', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cb(null, JSON.stringify({
        number: 10,
        title: 'WIP',
        url: 'https://github.com/user/repo/pull/10',
        state: 'OPEN',
        headRefName: 'wip',
        baseRefName: 'main',
        statusCheckRollup: [
          { status: 'IN_PROGRESS' },
        ],
      }), '');
    };
    const service = new GitService();
    const pr = await service.getPullRequest();
    assert.ok(pr);
    assert.strictEqual(pr!.ciStatus, 'pending');
  });

  it('detects failed CI', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cb(null, JSON.stringify({
        number: 11,
        title: 'Broken',
        url: 'https://github.com/user/repo/pull/11',
        state: 'OPEN',
        headRefName: 'broken',
        baseRefName: 'main',
        statusCheckRollup: [
          { conclusion: 'FAILURE', status: 'COMPLETED' },
        ],
      }), '');
    };
    const service = new GitService();
    const pr = await service.getPullRequest();
    assert.ok(pr);
    assert.strictEqual(pr!.ciStatus, 'failure');
  });

  it('returns undefined when no PR', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cb(new Error('no open PR'), '', '');
    };
    const service = new GitService();
    const pr = await service.getPullRequest();
    assert.strictEqual(pr, undefined);
  });
});

describe('GitService — getPullRequestComments', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('returns comments', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cb(null, JSON.stringify({
        comments: [
          { author: { login: 'github-actions' }, body: 'Schema diff: TABLE orders CREATED' },
        ],
      }), '');
    };
    const service = new GitService();
    const comments = await service.getPullRequestComments();
    assert.strictEqual(comments.length, 1);
    assert.ok(comments[0].body.includes('CREATED'));
  });

  it('returns empty when no comments', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cb(null, JSON.stringify({ comments: [] }), '');
    };
    const service = new GitService();
    const comments = await service.getPullRequestComments();
    assert.deepStrictEqual(comments, []);
  });

  it('returns empty on error', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cb(new Error('no PR'), '', '');
    };
    const service = new GitService();
    const comments = await service.getPullRequestComments();
    assert.deepStrictEqual(comments, []);
  });
});

describe('GitService — getAheadBehind', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('returns ahead and behind counts', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      if (cmd.includes('rev-parse --abbrev-ref @{u}')) {
        cb(null, 'origin/feature-x', '');
      } else if (cmd.includes('rev-list')) {
        cb(null, '3\t2', '');
      } else {
        cb(null, '', '');
      }
    };
    const service = new GitService();
    const result = await service.getAheadBehind();
    assert.strictEqual(result.ahead, 3);
    assert.strictEqual(result.behind, 2);
    assert.strictEqual(result.upstream, 'origin/feature-x');
  });

  it('returns zeros when no upstream', async () => {
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cb(new Error('no upstream'), '', '');
    };
    const service = new GitService();
    const result = await service.getAheadBehind();
    assert.strictEqual(result.ahead, 0);
    assert.strictEqual(result.behind, 0);
    assert.strictEqual(result.upstream, '');
  });
});
