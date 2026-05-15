import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { LakebaseService, LakebaseBranch } from '../../src/services/lakebaseService';
import { getConfig, updateEnvConnection } from '../../src/utils/config';

/**
 * Tests for the auto-branch creation behavior.
 *
 * The logic lives in extension.ts as an onBranchChanged listener.
 * We extract and re-implement the same decision logic here to verify
 * each branch of behavior without needing the full extension host.
 */

/** Reproduces the auto-branch creation logic from extension.ts */
async function autoBranchHandler(
  newBranch: string,
  lakebaseService: LakebaseService,
  autoCreateBranch: boolean
): Promise<{ action: 'skipped' | 'existing' | 'created' | 'error'; branchId?: string; error?: string }> {
  if (!autoCreateBranch) { return { action: 'skipped' }; }
  if (!newBranch || newBranch === 'main' || newBranch === 'master') { return { action: 'skipped' }; }

  try {
    const existing = await lakebaseService.getBranchByName(newBranch);
    if (existing) {
      const ep = await lakebaseService.getEndpoint(existing.branchId);
      if (ep?.host) {
        await lakebaseService.getCredential(existing.branchId);
      }
      return { action: 'existing', branchId: existing.branchId };
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

describe('Auto-branch creation', () => {
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

  describe('skips when disabled', () => {
    it('does nothing when autoCreateBranch is false', async () => {
      const result = await autoBranchHandler('feature-x', lakebaseStub as any, false);
      assert.strictEqual(result.action, 'skipped');
      assert.strictEqual(lakebaseStub.getBranchByName.called, false);
    });
  });

  describe('skips for main/master', () => {
    it('skips main', async () => {
      const result = await autoBranchHandler('main', lakebaseStub as any, true);
      assert.strictEqual(result.action, 'skipped');
    });

    it('skips master', async () => {
      const result = await autoBranchHandler('master', lakebaseStub as any, true);
      assert.strictEqual(result.action, 'skipped');
    });

    it('skips empty string', async () => {
      const result = await autoBranchHandler('', lakebaseStub as any, true);
      assert.strictEqual(result.action, 'skipped');
    });
  });

  describe('existing Lakebase branch', () => {
    it('refreshes credentials when branch already exists', async () => {
      lakebaseStub.getBranchByName.resolves(makeBranch('feature-x'));
      lakebaseStub.getEndpoint.resolves({ host: 'ep-test.com', state: 'ACTIVE' });
      lakebaseStub.getCredential.resolves({ token: 'tok', email: 'user@test.com' });

      const result = await autoBranchHandler('feature-x', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'existing');
      assert.strictEqual(result.branchId, 'feature-x');
      assert.strictEqual(lakebaseStub.getEndpoint.called, true);
      assert.strictEqual(lakebaseStub.getCredential.called, true);
      assert.strictEqual(lakebaseStub.createBranch.called, false);
    });

    it('handles existing branch with no endpoint', async () => {
      lakebaseStub.getBranchByName.resolves(makeBranch('feature-x'));
      lakebaseStub.getEndpoint.resolves(undefined);

      const result = await autoBranchHandler('feature-x', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'existing');
      assert.strictEqual(lakebaseStub.getCredential.called, false);
    });
  });

  describe('new branch creation', () => {
    it('creates Lakebase branch when none exists', async () => {
      lakebaseStub.getBranchByName.resolves(undefined);
      lakebaseStub.createBranch.resolves(makeBranch('feature-new'));
      lakebaseStub.getEndpoint.resolves({ host: 'ep-new.com', state: 'ACTIVE' });
      lakebaseStub.getCredential.resolves({ token: 'newtok', email: 'user@test.com' });

      const result = await autoBranchHandler('feature/new', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'created');
      assert.strictEqual(result.branchId, 'feature-new');
      assert.strictEqual(lakebaseStub.createBranch.calledWith('feature/new'), true);
      assert.strictEqual(lakebaseStub.getEndpoint.called, true);
      assert.strictEqual(lakebaseStub.getCredential.called, true);
    });

    it('handles createBranch returning undefined', async () => {
      lakebaseStub.getBranchByName.resolves(undefined);
      lakebaseStub.createBranch.resolves(undefined);

      const result = await autoBranchHandler('feature-x', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'error');
      assert.ok(result.error?.includes('undefined'));
    });

    it('handles new branch with no endpoint', async () => {
      lakebaseStub.getBranchByName.resolves(undefined);
      lakebaseStub.createBranch.resolves(makeBranch('feature-x'));
      lakebaseStub.getEndpoint.resolves(undefined);

      const result = await autoBranchHandler('feature-x', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'created');
      assert.strictEqual(lakebaseStub.getCredential.called, false);
    });
  });

  describe('error handling', () => {
    it('returns error when CLI call fails', async () => {
      lakebaseStub.getBranchByName.rejects(new Error('not authenticated'));

      const result = await autoBranchHandler('feature-x', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'error');
      assert.ok(result.error?.includes('not authenticated'));
    });

    it('returns error when createBranch fails', async () => {
      lakebaseStub.getBranchByName.resolves(undefined);
      lakebaseStub.createBranch.rejects(new Error('quota exceeded'));

      const result = await autoBranchHandler('feature-x', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'error');
      assert.ok(result.error?.includes('quota exceeded'));
    });

    it('returns error when getCredential fails on existing branch', async () => {
      lakebaseStub.getBranchByName.resolves(makeBranch('feature-x'));
      lakebaseStub.getEndpoint.resolves({ host: 'ep-test.com', state: 'ACTIVE' });
      lakebaseStub.getCredential.rejects(new Error('token expired'));

      const result = await autoBranchHandler('feature-x', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'error');
      assert.ok(result.error?.includes('token expired'));
    });
  });

  describe('git branch name handling', () => {
    it('works with slash-separated branch names', async () => {
      lakebaseStub.getBranchByName.resolves(undefined);
      lakebaseStub.createBranch.resolves(makeBranch('feature-dev-sprint-1'));
      lakebaseStub.getEndpoint.resolves({ host: 'ep.com', state: 'ACTIVE' });
      lakebaseStub.getCredential.resolves({ token: 't', email: 'u@t.com' });

      const result = await autoBranchHandler('feature/dev-sprint-1', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'created');
      assert.strictEqual(lakebaseStub.createBranch.calledWith('feature/dev-sprint-1'), true);
    });

    it('works with simple branch names', async () => {
      lakebaseStub.getBranchByName.resolves(undefined);
      lakebaseStub.createBranch.resolves(makeBranch('cart'));
      lakebaseStub.getEndpoint.resolves({ host: 'ep.com', state: 'ACTIVE' });
      lakebaseStub.getCredential.resolves({ token: 't', email: 'u@t.com' });

      const result = await autoBranchHandler('cart', lakebaseStub as any, true);

      assert.strictEqual(result.action, 'created');
    });
  });
});
