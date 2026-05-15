import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SchemaDiffProvider } from '../../src/providers/schemaDiffProvider';
import { SchemaDiffService, SchemaDiffResult } from '../../src/services/schemaDiffService';
import { GitService } from '../../src/services/gitService';

describe('SchemaDiffProvider', () => {
  let provider: SchemaDiffProvider;
  let schemaDiffStub: sinon.SinonStubbedInstance<SchemaDiffService>;
  let gitStub: sinon.SinonStubbedInstance<GitService>;

  beforeEach(() => {
    schemaDiffStub = sinon.createStubInstance(SchemaDiffService);
    gitStub = sinon.createStubInstance(GitService);
    gitStub.getChangedFiles.resolves([]);
    provider = new SchemaDiffProvider(schemaDiffStub as any, gitStub as any);
  });

  afterEach(() => sinon.restore());

  function makeDiff(overrides: Partial<SchemaDiffResult> = {}): SchemaDiffResult {
    return {
      branchName: 'feature-x',
      timestamp: new Date().toISOString(),
      migrations: [],
      created: [],
      modified: [],
      removed: [],
      branchTables: [],
      inSync: true,
      ...overrides,
    };
  }

  describe('showDiff', () => {
    it('uses cached diff when forceRefresh=false and cache exists', async () => {
      const diff = makeDiff({ branchName: 'cached-branch' });
      schemaDiffStub.getCachedDiff.returns(diff);

      await provider.showDiff(false, []);

      assert.strictEqual(schemaDiffStub.getCachedDiff.called, true);
      assert.strictEqual(schemaDiffStub.compareBranchSchemas.called, false);
    });

    it('calls compareBranchSchemas when no cache exists', async () => {
      schemaDiffStub.getCachedDiff.returns(undefined);
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());

      await provider.showDiff(false, []);

      assert.strictEqual(schemaDiffStub.compareBranchSchemas.called, true);
    });

    it('calls compareBranchSchemas with force when forceRefresh=true', async () => {
      schemaDiffStub.getCachedDiff.returns(makeDiff()); // cache exists
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());

      await provider.showDiff(true, []);

      // Should skip cache and call compareBranchSchemas
      assert.strictEqual(schemaDiffStub.compareBranchSchemas.called, true);
    });

    it('passes branchId through to cache and compareBranchSchemas', async () => {
      schemaDiffStub.getCachedDiff.returns(undefined);
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());

      await provider.showDiff(false, [], 'specific-branch');

      assert.strictEqual(schemaDiffStub.getCachedDiff.firstCall.args[0], 'specific-branch');
      assert.strictEqual(schemaDiffStub.compareBranchSchemas.firstCall.args[0], 'specific-branch');
    });
  });

  describe('showTableDiff', () => {
    it('uses provided diff without re-fetching', async () => {
      const diff = makeDiff({
        created: [{ type: 'TABLE', name: 'users', columns: [{ name: 'id', dataType: 'integer' }] }],
      });

      await provider.showTableDiff('users', 'created', diff);
      assert.strictEqual(schemaDiffStub.compareBranchSchemas.called, false);
    });

    it('fetches diff when none provided', async () => {
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff({
        created: [{ type: 'TABLE', name: 'users', columns: [{ name: 'id', dataType: 'integer' }] }],
      }));

      await provider.showTableDiff('users', 'created');
      assert.strictEqual(schemaDiffStub.compareBranchSchemas.called, true);
    });

    it('shows error when diff has error', async () => {
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff({ error: 'failed' }));

      // Should not throw
      await provider.showTableDiff('users', 'created');
    });
  });

  describe('refresh', () => {
    it('does nothing when panel is not open', async () => {
      await provider.refresh();
      // No errors, no panel interaction
      assert.ok(true);
    });

    it('re-renders when panel is open', async () => {
      // Open a panel first
      schemaDiffStub.getCachedDiff.returns(makeDiff());
      await provider.showDiff(false, []);

      // Now refresh should fetch fresh code changes and re-render
      schemaDiffStub.getCachedDiff.returns(makeDiff({ branchName: 'refreshed' }));
      await provider.refresh();

      assert.ok(schemaDiffStub.getCachedDiff.callCount >= 2);
      // gitService.getChangedFiles should have been called by refresh
      assert.ok(gitStub.getChangedFiles.called);
    });

    it('fetches fresh code changes even when schema is cached', async () => {
      // Open panel with cached schema
      schemaDiffStub.getCachedDiff.returns(makeDiff());
      await provider.showDiff(false, []);

      // Simulate new code changes appearing
      gitStub.getChangedFiles.resolves([
        { status: 'added', path: 'src/new-file.ts' },
        { status: 'modified', path: 'src/changed.ts' },
      ]);

      await provider.refresh();

      // Schema should still be cached (no pg_dump)
      assert.strictEqual(schemaDiffStub.compareBranchSchemas.called, false);
      // But code changes should be freshly fetched
      assert.ok(gitStub.getChangedFiles.called);
    });
  });

  describe('dispose', () => {
    it('disposes without error', () => {
      assert.doesNotThrow(() => provider.dispose());
    });

    it('disposes open panels', async () => {
      schemaDiffStub.getCachedDiff.returns(makeDiff());
      await provider.showDiff(false, []);
      assert.doesNotThrow(() => provider.dispose());
    });
  });
});
