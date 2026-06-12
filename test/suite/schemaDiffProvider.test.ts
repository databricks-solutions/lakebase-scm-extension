import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SchemaDiffProvider, isHiddenPath } from '../../src/providers/schemaDiffProvider';
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
    it('always force-refreshes the diff, ignoring any passed-in diff', async () => {
      // Contract: showTableDiff ALWAYS calls compareBranchSchemas with
      // force=true. The 3rd arg used to short-circuit the fetch, but
      // stale upstream diffs caused empty-row renders (the tree marks a
      // table modified before the cached diff catches up). Renderer
      // re-classifies from the live diff anyway, so the parameter is
      // accepted for signature compat but ignored as a cache.
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff({
        created: [{ type: 'TABLE', name: 'users', columns: [{ name: 'id', dataType: 'integer' }] }],
      }));
      const stale = makeDiff({ created: [] }); // pretend caller has a stale diff

      await provider.showTableDiff('users', 'created', stale);

      assert.strictEqual(schemaDiffStub.compareBranchSchemas.called, true);
      // Verify force=true is the second arg so the cache is bypassed.
      assert.strictEqual(schemaDiffStub.compareBranchSchemas.firstCall.args[1], true);
    });

    it('fetches diff when none provided', async () => {
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff({
        created: [{ type: 'TABLE', name: 'users', columns: [{ name: 'id', dataType: 'integer' }] }],
      }));

      await provider.showTableDiff('users', 'created');
      assert.strictEqual(schemaDiffStub.compareBranchSchemas.called, true);
    });

    it('passes branchName through to compareBranchSchemas as the target branch', async () => {
      // Without this, expanding a non-active branch in the tree and
      // clicking a table fetches the diff for whichever branch is
      // currently in .env, not the row's branch.
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff({
        created: [{ type: 'TABLE', name: 'users', columns: [{ name: 'id', dataType: 'integer' }] }],
      }));

      await provider.showTableDiff('users', 'created', undefined, 'feature/x');

      assert.strictEqual(schemaDiffStub.compareBranchSchemas.firstCall.args[0], 'feature/x');
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

  describe('isHiddenPath (Branch Diff Summary excludes dotfiles from the compare)', () => {
    it('flags top-level dotfiles + dot-directories', () => {
      for (const p of ['.gitignore', '.env', '.tdd/features/F1/spec.json', '.lakebase/kit-ref', '.vscode/settings.json', '.github/workflows/pr.yml', '.claude/agents/driver.md']) {
        assert.strictEqual(isHiddenPath(p), true, `expected hidden: ${p}`);
      }
    });

    it('flags a dotfile nested under a visible directory', () => {
      assert.strictEqual(isHiddenPath('app/.secret'), true);
      assert.strictEqual(isHiddenPath('src/config/.keep'), true);
    });

    it('does NOT flag normal source + migration paths', () => {
      for (const p of ['src/new-file.ts', 'app/models/bug.py', 'alembic/versions/0001_init.py', 'src/main/resources/db/migration/V6__create_orders.sql', 'README.md']) {
        assert.strictEqual(isHiddenPath(p), false, `expected visible: ${p}`);
      }
    });

    it('does not treat a dot inside a filename (extension) as hidden', () => {
      assert.strictEqual(isHiddenPath('app/main.py'), false);
      assert.strictEqual(isHiddenPath('docs/v1.2.notes.md'), false);
    });

    it('drives the showDiff filter: a renamed dotfile is excluded by either side', async () => {
      // showDiff filters on path AND oldPath, so a rename into/out of a hidden
      // path is excluded. Exercised here at the predicate level.
      assert.strictEqual(isHiddenPath('.env.local'), true);   // new path hidden
      assert.strictEqual(isHiddenPath('config/app.yml'), false); // visible side
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
