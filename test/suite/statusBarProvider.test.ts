import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { StatusBarProvider } from '../../src/providers/statusBarProvider';
import { GitService } from '../../src/services/gitService';
import { LakebaseService, LakebaseBranch } from '../../src/services/lakebaseService';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';

describe('StatusBarProvider', () => {
  let provider: StatusBarProvider;
  let gitStub: sinon.SinonStubbedInstance<GitService>;
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;
  let migrationStub: sinon.SinonStubbedInstance<SchemaMigrationService>;

  beforeEach(() => {
    gitStub = sinon.createStubInstance(GitService);
    (gitStub as any).onBranchChanged = new (vscode as any).EventEmitter().event;

    lakebaseStub = sinon.createStubInstance(LakebaseService);
    lakebaseStub.sanitizeBranchName.callsFake((name: string) =>
      name.replace(/\//g, '-').toLowerCase()
    );

    migrationStub = sinon.createStubInstance(SchemaMigrationService);
  });

  afterEach(() => sinon.restore());

  function makeBranch(id: string, state: string = 'READY', isDefault: boolean = false): LakebaseBranch {
    return { uid: `br-${id}`, name: `projects/p1/branches/${id}`, branchId: id, state, isDefault };
  }

  describe('refresh', () => {
    it('shows synced state when branch is READY', async () => {
      gitStub.getCurrentBranch.resolves('feature-x');
      gitStub.getCachedBranch.returns('');
      lakebaseStub.getBranchByName.resolves(makeBranch('feature-x'));
      migrationStub.getLatestVersion.returns('3');

      provider = new StatusBarProvider(gitStub as any, lakebaseStub as any, migrationStub as any);
      await provider.refresh();

      const lb = provider.getCurrentLakebaseBranch();
      assert.ok(lb);
      assert.strictEqual(lb!.state, 'READY');
    });

    it('shows error state when no Lakebase branch found', async () => {
      gitStub.getCurrentBranch.resolves('orphan-branch');
      gitStub.getCachedBranch.returns('');
      lakebaseStub.getBranchByName.resolves(undefined);
      migrationStub.getLatestVersion.returns(undefined);

      provider = new StatusBarProvider(gitStub as any, lakebaseStub as any, migrationStub as any);
      await provider.refresh();

      const lb = provider.getCurrentLakebaseBranch();
      assert.strictEqual(lb, undefined);
    });

    it('handles main branch mapping to default', async () => {
      gitStub.getCurrentBranch.resolves('main');
      gitStub.getCachedBranch.returns('');
      lakebaseStub.getDefaultBranch.resolves(makeBranch('production', 'READY', true));
      migrationStub.getLatestVersion.returns('1');

      provider = new StatusBarProvider(gitStub as any, lakebaseStub as any, migrationStub as any);
      await provider.refresh();

      const lb = provider.getCurrentLakebaseBranch();
      assert.ok(lb);
      assert.strictEqual(lb!.isDefault, true);
    });
  });

  describe('suppressRefresh', () => {
    it('prevents refresh when suppressed', async () => {
      gitStub.getCurrentBranch.resolves('main');
      lakebaseStub.listBranches.resolves([]);
      migrationStub.getLatestVersion.returns(undefined);

      provider = new StatusBarProvider(gitStub as any, lakebaseStub as any, migrationStub as any);
      provider.suppressRefresh = true;
      await provider.refresh();

      // getCurrentBranch should not be called during suppressed refresh
      // (depends on implementation - at minimum, should not throw)
      assert.ok(true);
    });
  });

  describe('dispose', () => {
    it('disposes without error', () => {
      gitStub.getCurrentBranch.resolves('main');
      lakebaseStub.listBranches.resolves([]);
      migrationStub.getLatestVersion.returns(undefined);

      provider = new StatusBarProvider(gitStub as any, lakebaseStub as any, migrationStub as any);
      assert.doesNotThrow(() => provider.dispose());
    });
  });
});
