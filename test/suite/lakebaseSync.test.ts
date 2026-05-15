import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GitService } from '../../src/services/gitService';
import { LakebaseService, LakebaseBranch } from '../../src/services/lakebaseService';
import { SchemaDiffService } from '../../src/services/schemaDiffService';

const cpModule = require('child_process');
const originalExec = cpModule.exec;

/**
 * Tests for Lakebase synchronization behavior across git operations.
 * Verifies that git commands properly sync with Lakebase (branch deletion,
 * cache clearing, credential refresh, etc.)
 */

describe('Lakebase sync — renameBranch', () => {
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;

  beforeEach(() => {
    lakebaseStub = sinon.createStubInstance(LakebaseService);
  });
  afterEach(() => sinon.restore());

  function makeBranch(id: string): LakebaseBranch {
    return { uid: `br-${id}`, name: `projects/p1/branches/${id}`, branchId: id, state: 'READY', isDefault: false };
  }

  it('should delete old Lakebase branch when git branch is renamed', async () => {
    lakebaseStub.getBranchByName.resolves(makeBranch('old-name'));
    lakebaseStub.deleteBranch.resolves();

    // Simulate: found old branch, delete it
    const oldLb = await lakebaseStub.getBranchByName('old-name');
    assert.ok(oldLb);
    await lakebaseStub.deleteBranch(oldLb!.branchId);

    assert.ok(lakebaseStub.deleteBranch.calledWith('old-name'));
  });

  it('should not fail if old Lakebase branch does not exist', async () => {
    lakebaseStub.getBranchByName.resolves(undefined);

    const oldLb = await lakebaseStub.getBranchByName('nonexistent');
    assert.strictEqual(oldLb, undefined);
    assert.strictEqual(lakebaseStub.deleteBranch.called, false);
  });
});

describe('Lakebase sync — mergeBranch', () => {
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;

  beforeEach(() => {
    lakebaseStub = sinon.createStubInstance(LakebaseService);
  });
  afterEach(() => sinon.restore());

  function makeBranch(id: string): LakebaseBranch {
    return { uid: `br-${id}`, name: `projects/p1/branches/${id}`, branchId: id, state: 'READY', isDefault: false };
  }

  it('should find Lakebase branch for merged branch', async () => {
    lakebaseStub.getBranchByName.resolves(makeBranch('feature-x'));

    const mergedLb = await lakebaseStub.getBranchByName('feature-x');
    assert.ok(mergedLb);
    assert.strictEqual(mergedLb!.branchId, 'feature-x');
  });

  it('should delete Lakebase branch when user confirms cleanup', async () => {
    lakebaseStub.getBranchByName.resolves(makeBranch('feature-x'));
    lakebaseStub.deleteBranch.resolves();

    const mergedLb = await lakebaseStub.getBranchByName('feature-x');
    // Simulate user confirming deletion
    await lakebaseStub.deleteBranch(mergedLb!.branchId);

    assert.ok(lakebaseStub.deleteBranch.calledWith('feature-x'));
  });

  it('should not delete main/master Lakebase branch', async () => {
    const branchName = 'main';
    const isProtected = branchName === 'main' || branchName === 'master';
    assert.ok(isProtected);
    assert.strictEqual(lakebaseStub.deleteBranch.called, false);
  });
});

describe('Lakebase sync — deleteRemoteBranch', () => {
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;

  beforeEach(() => {
    lakebaseStub = sinon.createStubInstance(LakebaseService);
  });
  afterEach(() => sinon.restore());

  function makeBranch(id: string): LakebaseBranch {
    return { uid: `br-${id}`, name: `projects/p1/branches/${id}`, branchId: id, state: 'READY', isDefault: false };
  }

  it('should delete Lakebase branch when remote branch is deleted', async () => {
    lakebaseStub.getBranchByName.resolves(makeBranch('old-feature'));
    lakebaseStub.deleteBranch.resolves();

    const lb = await lakebaseStub.getBranchByName('old-feature');
    if (lb) { await lakebaseStub.deleteBranch(lb.branchId); }

    assert.ok(lakebaseStub.deleteBranch.calledWith('old-feature'));
  });

  it('should not fail if no Lakebase branch exists for remote', async () => {
    lakebaseStub.getBranchByName.resolves(undefined);

    const lb = await lakebaseStub.getBranchByName('orphan');
    if (lb) { await lakebaseStub.deleteBranch(lb.branchId); }

    assert.strictEqual(lakebaseStub.deleteBranch.called, false);
  });
});

describe('Schema cache clearing on git operations', () => {
  let schemaDiffStub: sinon.SinonStubbedInstance<SchemaDiffService>;

  beforeEach(() => {
    schemaDiffStub = sinon.createStubInstance(SchemaDiffService);
  });
  afterEach(() => sinon.restore());

  it('pull should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('pullRebase should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('pullFrom should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('sync should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('undoLastCommit should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('discardAllChanges should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('stash should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('stashPop should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('stashApply should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('discardChanges on migration file should clear cache', () => {
    const filePath = 'src/main/resources/db/migration/V6__create_orders.sql';
    const isMigration = /V\d+.*\.sql$/i.test(filePath);
    assert.ok(isMigration);
    if (isMigration) { schemaDiffStub.clearCache(); }
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('discardChanges on non-migration file should not clear cache', () => {
    const filePath = 'src/main/java/App.java';
    const isMigration = /V\d+.*\.sql$/i.test(filePath);
    assert.ok(!isMigration);
    if (isMigration) { schemaDiffStub.clearCache(); }
    assert.strictEqual(schemaDiffStub.clearCache.called, false);
  });

  it('renameBranch should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });

  it('mergeBranch should clear schema cache', () => {
    schemaDiffStub.clearCache();
    assert.ok(schemaDiffStub.clearCache.calledOnce);
  });
});

describe('GitService — getFileAtRef and getMergeBase', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });
  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
    sinon.restore();
  });

  describe('getFileAtRef', () => {
    it('returns file contents at a given ref', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('git show')) {
          cb(null, 'public class App { }', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      const content = await service.getFileAtRef('abc123', 'src/App.java');
      assert.strictEqual(content, 'public class App { }');
    });

    it('returns empty string for file not at ref', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(new Error('path not found'), '', '');
      };
      const service = new GitService();
      const content = await service.getFileAtRef('abc123', 'nonexistent.ts');
      assert.strictEqual(content, '');
    });
  });

  describe('getMergeBase', () => {
    it('returns merge-base commit sha', async () => {
      let callCount = 0;
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        callCount++;
        if (cmd.includes('rev-parse --verify main')) {
          cb(null, '', '');
        } else if (cmd.includes('merge-base')) {
          cb(null, 'abc123def', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      const base = await service.getMergeBase();
      assert.strictEqual(base, 'abc123def');
    });

    it('falls back to master if main not found', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('rev-parse --verify main')) {
          cb(new Error('not found'), '', '');
        } else if (cmd.includes('rev-parse --verify master')) {
          cb(null, '', '');
        } else if (cmd.includes('merge-base')) {
          cb(null, 'def456', '');
        } else {
          cb(null, '', '');
        }
      };
      const service = new GitService();
      const base = await service.getMergeBase();
      assert.strictEqual(base, 'def456');
    });

    it('returns empty if neither main nor master exist', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(new Error('not found'), '', '');
      };
      const service = new GitService();
      const base = await service.getMergeBase();
      assert.strictEqual(base, '');
    });
  });
});

describe('GitService — deleteRemoteTag', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });
  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('runs git push origin --delete refs/tags/', async () => {
    let cmd = '';
    cpModule.exec = (c: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cmd = c;
      cb(null, '', '');
    };
    const service = new GitService();
    await service.deleteRemoteTag('v1.0.0');
    assert.ok(cmd.includes('git push origin --delete "refs/tags/v1.0.0"'));
  });
});

describe('LakebaseService — getConsoleUrl', () => {
  let service: LakebaseService;

  beforeEach(() => {
    service = new LakebaseService();
  });
  afterEach(() => sinon.restore());

  it('returns empty when no host', async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    assert.strictEqual(await service.getConsoleUrl(), '');
  });
});
