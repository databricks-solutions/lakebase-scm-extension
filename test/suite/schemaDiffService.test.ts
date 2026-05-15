import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { SchemaDiffService } from '../../src/services/schemaDiffService';
import { LakebaseService } from '../../src/services/lakebaseService';

describe('SchemaDiffService', () => {
  let service: SchemaDiffService;
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;
  let tmpDir: string;

  beforeEach(() => {
    lakebaseStub = sinon.createStubInstance(LakebaseService);
    service = new SchemaDiffService(lakebaseStub as any);
    tmpDir = path.join('/tmp', `schema-diff-test-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'src/main/resources/db/migration'), { recursive: true });
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
  });

  afterEach(() => {
    sinon.restore();
    fs.rmSync(tmpDir, { recursive: true });
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  function writeMigration(filename: string, content: string = '') {
    const migDir = path.join(tmpDir, 'src/main/resources/db/migration');
    fs.writeFileSync(path.join(migDir, filename), content);
  }

  describe('getCachedDiff', () => {
    it('returns undefined when cache is empty', () => {
      assert.strictEqual(service.getCachedDiff('some-branch'), undefined);
    });

    it('returns undefined when no branchId and no .env', () => {
      assert.strictEqual(service.getCachedDiff(), undefined);
    });
  });

  describe('clearCache', () => {
    it('clears specific branch cache', () => {
      // Manually populate cache via internals
      (service as any).cache.set('branch-a', {
        result: { branchName: 'a', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: Date.now(),
        createdAt: Date.now(),
      });
      assert.ok(service.getCachedDiff('branch-a'));
      service.clearCache('branch-a');
      assert.strictEqual(service.getCachedDiff('branch-a'), undefined);
    });

    it('clears all caches when no branchId given', () => {
      (service as any).cache.set('a', {
        result: { branchName: 'a', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: Date.now(),
        createdAt: Date.now(),
      });
      (service as any).cache.set('b', {
        result: { branchName: 'b', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: Date.now(),
        createdAt: Date.now(),
      });
      service.clearCache();
      assert.strictEqual(service.getCachedDiff('a'), undefined);
      assert.strictEqual(service.getCachedDiff('b'), undefined);
    });
  });

  describe('cache invalidation by migration mtime', () => {
    it('returns cached result when migrations have not changed', () => {
      writeMigration('V1__init.sql', 'CREATE TABLE t;');
      const mtime = fs.statSync(path.join(tmpDir, 'src/main/resources/db/migration/V1__init.sql')).mtimeMs;

      (service as any).cache.set('dev', {
        result: { branchName: 'dev', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: mtime + 1000, // cache built after migration
        createdAt: Date.now(),
      });

      assert.ok(service.getCachedDiff('dev'));
    });

    it('invalidates cache when a migration is newer', () => {
      (service as any).cache.set('dev', {
        result: { branchName: 'dev', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: 1000, // old
        createdAt: Date.now(),
      });

      writeMigration('V2__new_table.sql', 'CREATE TABLE t2;');
      assert.strictEqual(service.getCachedDiff('dev'), undefined);
    });
  });

  describe('cache invalidation by max age', () => {
    it('invalidates entries older than CACHE_MAX_AGE_MS', () => {
      const maxAge = (SchemaDiffService as any).CACHE_MAX_AGE_MS;

      (service as any).cache.set('dev', {
        result: { branchName: 'dev', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: Date.now() + 100000, // far future so mtime check passes
        createdAt: Date.now() - maxAge - 1, // older than max age
      });

      assert.strictEqual(service.getCachedDiff('dev'), undefined);
      // Entry should be evicted
      assert.strictEqual((service as any).cache.has('dev'), false);
    });

    it('returns entry within max age', () => {
      writeMigration('V1__init.sql');
      const mtime = fs.statSync(path.join(tmpDir, 'src/main/resources/db/migration/V1__init.sql')).mtimeMs;

      (service as any).cache.set('dev', {
        result: { branchName: 'dev', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: mtime + 1000,
        createdAt: Date.now(), // fresh
      });

      assert.ok(service.getCachedDiff('dev'));
    });
  });

  describe('cache rejects error results', () => {
    it('returns undefined for cached entries with errors', () => {
      (service as any).cache.set('dev', {
        result: { branchName: 'dev', created: [], modified: [], removed: [], inSync: false, timestamp: '', migrations: [], error: 'pg_dump failed' },
        migrationMtime: Date.now() + 100000,
        createdAt: Date.now(),
      });

      assert.strictEqual(service.getCachedDiff('dev'), undefined);
    });
  });

  describe('per-branch isolation', () => {
    it('caches different branches independently', () => {
      const now = Date.now();
      (service as any).cache.set('branch-a', {
        result: { branchName: 'a', created: [{ type: 'TABLE', name: 'users' }], modified: [], removed: [], inSync: false, timestamp: '', migrations: [] },
        migrationMtime: now + 100000,
        createdAt: now,
      });
      (service as any).cache.set('branch-b', {
        result: { branchName: 'b', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: now + 100000,
        createdAt: now,
      });

      const diffA = service.getCachedDiff('branch-a')!;
      const diffB = service.getCachedDiff('branch-b')!;
      assert.strictEqual(diffA.created.length, 1);
      assert.strictEqual(diffB.inSync, true);
    });

    it('clearing one branch does not affect others', () => {
      const now = Date.now();
      (service as any).cache.set('a', {
        result: { branchName: 'a', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: now + 100000,
        createdAt: now,
      });
      (service as any).cache.set('b', {
        result: { branchName: 'b', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: now + 100000,
        createdAt: now,
      });

      service.clearCache('a');
      assert.strictEqual(service.getCachedDiff('a'), undefined);
      assert.ok(service.getCachedDiff('b'));
    });
  });

  describe('readCachedDiff', () => {
    it('returns undefined when schema-diff.md does not exist', () => {
      assert.strictEqual(service.readCachedDiff(), undefined);
    });

    it('parses schema-diff.md from disk', () => {
      const content = `## Schema (Lakebase branch \`cart\`)

### Migrations applied on this branch (CI)
| Version | Migration |
|---------|-----------|
| V1 | init placeholder |
| V2 | create book table |

**SCHEMA CHANGES (cart vs production)**

+ TABLE books (CREATED)
  L id integer NOT NULL
  L title text NOT NULL
`;
      fs.writeFileSync(path.join(tmpDir, 'schema-diff.md'), content);

      const result = service.readCachedDiff();
      assert.ok(result);
      assert.strictEqual(result!.branchName, 'cart');
      assert.strictEqual(result!.migrations.length, 2);
      assert.strictEqual(result!.created.length, 1);
      assert.strictEqual(result!.created[0].name, 'books');
      assert.strictEqual(result!.created[0].columns!.length, 2);
    });

    it('detects error in schema-diff.md', () => {
      const content = `## Schema

# pg_dump failed or empty; falling back to migration version comparison.
`;
      fs.writeFileSync(path.join(tmpDir, 'schema-diff.md'), content);

      const result = service.readCachedDiff();
      assert.ok(result);
      assert.ok(result!.error);
    });

    it('detects in-sync state', () => {
      const content = `## Schema
No schema changes (in sync)
`;
      fs.writeFileSync(path.join(tmpDir, 'schema-diff.md'), content);

      const result = service.readCachedDiff();
      assert.ok(result);
      assert.strictEqual(result!.inSync, true);
    });
  });

  describe('generateDiff', () => {
    it('returns error when no workspace root', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      await assert.rejects(() => service.generateDiff(), /No workspace root/);
    });
  });

  describe('compareBranchSchemas', () => {
    it('returns error when no branchId configured', async () => {
      const result = await service.compareBranchSchemas();
      assert.ok(result.error);
      assert.ok(result.error!.includes('LAKEBASE_BRANCH_ID'));
    });

    it('returns cached result when cache is fresh', async () => {
      writeMigration('V1__init.sql');
      const mtime = fs.statSync(path.join(tmpDir, 'src/main/resources/db/migration/V1__init.sql')).mtimeMs;

      (service as any).cache.set('test-branch', {
        result: { branchName: 'test-branch', created: [{ type: 'TABLE', name: 'cached_table' }], modified: [], removed: [], inSync: false, timestamp: '', migrations: [] },
        migrationMtime: mtime + 1000,
        createdAt: Date.now(),
      });

      const result = await service.compareBranchSchemas('test-branch');
      assert.strictEqual(result.created[0].name, 'cached_table');
      // lakebaseService methods should NOT have been called
      assert.strictEqual(lakebaseStub.getEndpoint.called, false);
    });

    it('bypasses cache when force=true', async () => {
      writeMigration('V1__init.sql');
      const mtime = fs.statSync(path.join(tmpDir, 'src/main/resources/db/migration/V1__init.sql')).mtimeMs;

      (service as any).cache.set('test-branch', {
        result: { branchName: 'test-branch', created: [], modified: [], removed: [], inSync: true, timestamp: '', migrations: [] },
        migrationMtime: mtime + 1000,
        createdAt: Date.now(),
      });

      // Primary path (queryBranchSchema) needs getDefaultBranch to throw so fallback is used
      lakebaseStub.getDefaultBranch.rejects(new Error('not reachable'));
      // Fallback: getEndpoint returns undefined → error result (proves cache was bypassed)
      lakebaseStub.getEndpoint.resolves(undefined);

      // Write .env so branchId resolves
      fs.writeFileSync(path.join(tmpDir, '.env'), 'LAKEBASE_BRANCH_ID=test-branch\n');

      const result = await service.compareBranchSchemas('test-branch', true);
      assert.ok(result.error); // endpoint not found
      assert.strictEqual(lakebaseStub.getEndpoint.called, true);
    });
  });
});
