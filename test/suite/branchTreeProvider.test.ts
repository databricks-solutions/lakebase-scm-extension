import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { BranchTreeProvider, BranchItem } from '../../src/providers/branchTreeProvider';
import { GitService } from '../../src/services/gitService';
import { LakebaseService, LakebaseBranch } from '../../src/services/lakebaseService';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';
import * as vscode from 'vscode';

describe('BranchTreeProvider', () => {
  let provider: BranchTreeProvider;
  let gitStub: sinon.SinonStubbedInstance<GitService>;
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;
  let migrationStub: sinon.SinonStubbedInstance<SchemaMigrationService>;

  beforeEach(() => {
    gitStub = sinon.createStubInstance(GitService);
    (gitStub as any).onBranchChanged = new (vscode as any).EventEmitter().event;

    lakebaseStub = sinon.createStubInstance(LakebaseService);
    lakebaseStub.sanitizeBranchName.callsFake((name: string) =>
      name.replace(/\//g, '-').toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 63)
    );

    migrationStub = sinon.createStubInstance(SchemaMigrationService);
    provider = new BranchTreeProvider(gitStub as any, lakebaseStub as any, migrationStub as any);
  });

  afterEach(() => sinon.restore());

  function makeBranch(id: string, isDefault: boolean = false): LakebaseBranch {
    return {
      uid: `br-${id}`,
      name: `projects/p1/branches/${id}`,
      branchId: id,
      state: 'READY',
      isDefault,
    };
  }

  describe('getChildren (root)', () => {
    it('returns a Project root item', async () => {
      const items = await provider.getChildren();
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].itemType, 'project');
    });

    it('project item expands to connection + section headers', async () => {
      lakebaseStub.checkAuth.resolves({ authenticated: true, currentHost: 'ws.databricks.com', expectedHost: 'ws.databricks.com', mismatch: false });

      const root = await provider.getChildren();
      const projectItem = root[0];
      const children = await provider.getChildren(projectItem);

      // Should have at minimum: Current Branch header + Other Branches header
      // (GitHub, Lakebase project, and connection items depend on environment)
      assert.ok(children.length >= 2);
      const currentHeader = children.find(c => c.label === 'Current Branch');
      assert.ok(currentHeader, 'should have Current Branch section');
      const otherHeader = children.find(c => c.label === 'Other Branches');
      assert.ok(otherHeader, 'should have Other Branches section');
    });

    it('lists current branch under Current Branch section', async () => {
      lakebaseStub.checkAuth.resolves({ authenticated: true, currentHost: 'ws.databricks.com', expectedHost: 'ws.databricks.com', mismatch: false });
      gitStub.listLocalBranches.resolves([
        { name: 'main', isCurrent: true, isRemote: false },
        { name: 'feature-x', isCurrent: false, isRemote: false },
      ]);
      gitStub.getCurrentBranch.resolves('main');
      lakebaseStub.listBranches.resolves([
        makeBranch('main', true),
        makeBranch('feature-x'),
      ]);
      gitStub.listMigrationsOnBranch.resolves([]);

      const root = await provider.getChildren();
      const projectChildren = await provider.getChildren(root[0]);
      const currentHeader = projectChildren.find(c => c.label === 'Current Branch')!;
      const currentBranches = await provider.getChildren(currentHeader);

      assert.strictEqual(currentBranches.length, 1);
      assert.strictEqual(currentBranches[0].itemType, 'currentBranch');
      assert.strictEqual(currentBranches[0].label, 'main');
    });

    it('lists other branches and db-only under Other Branches section', async () => {
      lakebaseStub.checkAuth.resolves({ authenticated: true, currentHost: 'ws.databricks.com', expectedHost: 'ws.databricks.com', mismatch: false });
      gitStub.listLocalBranches.resolves([
        { name: 'main', isCurrent: true, isRemote: false },
      ]);
      gitStub.getCurrentBranch.resolves('main');
      lakebaseStub.listBranches.resolves([
        makeBranch('main', true),
        makeBranch('ci-pr-42'),
      ]);
      gitStub.listMigrationsOnBranch.resolves([]);

      const root = await provider.getChildren();
      const projectChildren = await provider.getChildren(root[0]);
      const otherHeader = projectChildren.find(c => c.label === 'Other Branches')!;
      const otherBranches = await provider.getChildren(otherHeader);

      const ciItem = otherBranches.find(i => i.label?.toString().includes('ci-pr-42'));
      assert.ok(ciItem, 'db-only branch should appear');
      assert.ok(ciItem!.label?.toString().includes('db only'));
    });

    it('handles Lakebase API failure gracefully', async () => {
      lakebaseStub.checkAuth.resolves({ authenticated: true, currentHost: 'ws.databricks.com', expectedHost: 'ws.databricks.com', mismatch: false });
      gitStub.listLocalBranches.resolves([{ name: 'main', isCurrent: true, isRemote: false }]);
      gitStub.getCurrentBranch.resolves('main');
      lakebaseStub.listBranches.rejects(new Error('CLI error'));
      gitStub.listMigrationsOnBranch.resolves([]);

      const root = await provider.getChildren();
      const projectChildren = await provider.getChildren(root[0]);
      const currentHeader = projectChildren.find(c => c.label === 'Current Branch')!;
      const currentBranches = await provider.getChildren(currentHeader);

      // Should still show git branch, just without Lakebase pairing
      assert.ok(currentBranches.length >= 1);
    });
  });

  describe('getChildren (branch details)', () => {
    it('shows git tracking and db status for a branch', async () => {
      gitStub.listMigrationsOnBranch.resolves(['V1__init.sql', 'V2__table.sql']);

      const parent = new BranchItem(
        { name: 'feature-x', isCurrent: false, isRemote: false, tracking: 'origin/feature-x', ahead: 2, behind: 0 },
        makeBranch('feature-x'),
        'branch',
        'feature-x',
        1 // collapsed
      );

      const details = await provider.getChildren(parent);
      assert.ok(details.length >= 2); // At least git info + db info
    });
  });

  describe('refresh', () => {
    it('fires tree change event', () => {
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });
      provider.refresh();
      assert.ok(fired);
    });

    it('suppresses refresh when flag is set', () => {
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });
      provider.suppressRefresh = true;
      provider.refresh();
      assert.strictEqual(fired, false);
    });
  });

  describe('dispose', () => {
    it('disposes without error', () => {
      assert.doesNotThrow(() => provider.dispose());
    });
  });
});
