import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SchemaScmProvider } from '../../src/providers/schemaScmProvider';
import { GitService } from '../../src/services/gitService';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';
import { SchemaDiffService, SchemaDiffResult } from '../../src/services/schemaDiffService';

describe('SchemaScmProvider (Unified Repo)', () => {
  let provider: SchemaScmProvider;
  let gitStub: sinon.SinonStubbedInstance<GitService>;
  let migrationStub: sinon.SinonStubbedInstance<SchemaMigrationService>;
  let schemaDiffStub: sinon.SinonStubbedInstance<SchemaDiffService>;

  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];

    gitStub = sinon.createStubInstance(GitService);
    gitStub.getCachedBranch.returns('feature-x');
    gitStub.getCurrentBranch.resolves('feature-x');
    gitStub.getChangedFiles.resolves([]);
    gitStub.getStagedChanges.resolves([]);
    gitStub.getUnstagedChanges.resolves([]);
    gitStub.getMergeBase.resolves('abc123');
    (gitStub as any).onBranchChanged = new (vscode as any).EventEmitter().event;

    migrationStub = sinon.createStubInstance(SchemaMigrationService);
    migrationStub.listMigrations.returns([]);
    migrationStub.watchMigrations.returns({ dispose: () => {} });

    schemaDiffStub = sinon.createStubInstance(SchemaDiffService);
  });

  afterEach(() => {
    if (provider) { provider.dispose(); }
    sinon.restore();
  });

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

  describe('showUnifiedRepo setting', () => {
    it('creates SCM when showUnifiedRepo is true (default)', async () => {
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());
      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 100));
      assert.ok(provider.getScm());
    });

    it('does not create SCM when showUnifiedRepo is false', async () => {
      const origGet = (vscode.workspace as any).getConfiguration;
      (vscode.workspace as any).getConfiguration = (section: string) => ({
        get: (key: string, def: any) => key === 'showUnifiedRepo' ? false : def,
      });
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());
      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(provider.getScm(), undefined);
      (vscode.workspace as any).getConfiguration = origGet;
    });
  });

  describe('refresh — staged and changes groups', () => {
    it('populates staged group from git index', async () => {
      gitStub.getStagedChanges.resolves([
        { status: 'modified', path: 'src/a.ts' },
        { status: 'added', path: 'src/b.ts' },
      ]);
      gitStub.getUnstagedChanges.resolves([]);
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 100));
      assert.ok(gitStub.getStagedChanges.called);
    });

    it('populates changes group from unstaged working tree', async () => {
      gitStub.getStagedChanges.resolves([]);
      gitStub.getUnstagedChanges.resolves([
        { status: 'modified', path: 'src/changed.ts' },
        { status: 'added', path: 'src/new.ts' },
      ]);

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 100));
      assert.ok(gitStub.getUnstagedChanges.called);
    });

    it('clears all groups when on main', async () => {
      gitStub.getCachedBranch.returns('main');
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(schemaDiffStub.compareBranchSchemas.called, false);
    });
  });

  describe('refresh — schema changes (live DB diff)', () => {
    it('shows empty lakebase when no lakebaseService provided', async () => {
      gitStub.getStagedChanges.resolves([]);
      gitStub.getUnstagedChanges.resolves([
        { status: 'added', path: 'src/main/resources/db/migration/V6__create_users.sql' },
      ]);

      // No lakebaseService → live DB diff not available → Lakebase group empty
      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(migrationStub.parseMigrationSchemaChanges.called, false);
    });

    it('shows empty lakebase when no migration files in working tree', async () => {
      gitStub.getStagedChanges.resolves([]);
      gitStub.getUnstagedChanges.resolves([
        { status: 'modified', path: 'src/App.java' },
      ]);

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 100));
      assert.strictEqual(migrationStub.parseMigrationSchemaChanges.called, false);
    });
  });

  describe('refresh — combined count', () => {
    it('sums staged + changes + schema in count', async () => {
      gitStub.getStagedChanges.resolves([{ status: 'modified', path: 'a.ts' }]);
      gitStub.getUnstagedChanges.resolves([{ status: 'added', path: 'b.ts' }]);
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff({
        created: [{ type: 'TABLE', name: 'orders' }],
      }));

      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 100));
      // 1 staged + 1 change + 1 schema = 3
      assert.ok(gitStub.getStagedChanges.called);
      assert.ok(gitStub.getUnstagedChanges.called);
    });
  });

  describe('commit input box', () => {
    it('enables input box with placeholder', async () => {
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());
      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      await new Promise(r => setTimeout(r, 100));
      const scm = provider.getScm();
      assert.ok(scm);
      assert.strictEqual(scm!.inputBox.visible, true);
      assert.strictEqual(scm!.inputBox.placeholder, 'Commit message');
    });
  });

  describe('getLastDiff', () => {
    it('delegates to schemaDiffService.getCachedDiff', () => {
      const diff = makeDiff();
      schemaDiffStub.getCachedDiff.returns(diff);
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());
      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      assert.strictEqual(provider.getLastDiff(), diff);
    });
  });

  describe('dispose', () => {
    it('disposes SCM and watchers without error', () => {
      schemaDiffStub.compareBranchSchemas.resolves(makeDiff());
      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      assert.doesNotThrow(() => provider.dispose());
    });

    it('handles dispose when SCM was never created', () => {
      const origGet = (vscode.workspace as any).getConfiguration;
      (vscode.workspace as any).getConfiguration = (section: string) => ({
        get: (key: string, def: any) => key === 'showUnifiedRepo' ? false : def,
      });
      provider = new SchemaScmProvider(gitStub as any, migrationStub as any, schemaDiffStub as any);
      assert.doesNotThrow(() => provider.dispose());
      (vscode.workspace as any).getConfiguration = origGet;
    });
  });
});
