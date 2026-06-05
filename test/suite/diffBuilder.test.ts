import { strict as assert } from 'assert';
import { buildDiffTuples, sortMigrationsToEnd, DiffTuple } from '../../src/utils/diffBuilder';

// Tuples are [labelUri, origUri?, modUri?]; sortMigrationsToEnd reads
// `t[0].fsPath || t[0].path`. We pass minimal fakes so the test has no
// real vscode dependency.
function tuple(pathLike: string, useFsPath = true): DiffTuple {
  const label = useFsPath ? { fsPath: pathLike } : { path: pathLike };
  return [label as any, undefined, undefined];
}

describe('diffBuilder (single source for diff-tuple build + migration sort)', () => {
  describe('sortMigrationsToEnd', () => {
    it('classifies V<n>__*.sql paths as migrations, everything else as code', () => {
      const tuples = [
        tuple('/repo/src/app.ts'),
        tuple('/repo/db/migration/V1__init.sql'),
        tuple('/repo/README.md'),
        tuple('/repo/db/migration/V2__add_col.sql'),
      ];
      const { code, migrations } = sortMigrationsToEnd(tuples);
      assert.equal(code.length, 2);
      assert.equal(migrations.length, 2);
      assert.ok((migrations[0][0] as any).fsPath.endsWith('V1__init.sql'));
      assert.ok((migrations[1][0] as any).fsPath.endsWith('V2__add_col.sql'));
    });

    it('is case-insensitive on the .sql extension and V prefix', () => {
      const { migrations } = sortMigrationsToEnd([tuple('/x/v3__lower.SQL')]);
      assert.equal(migrations.length, 1);
    });

    it('does NOT classify a non-migration .sql (no V<n> prefix) as a migration', () => {
      const { code, migrations } = sortMigrationsToEnd([tuple('/x/seed.sql')]);
      assert.equal(migrations.length, 0);
      assert.equal(code.length, 1);
    });

    it('does NOT misclassify a code file whose name merely contains a migration basename', () => {
      // This is the bug the old DiffService.sortMigrations basename-
      // substring match could hit; the regex-on-path version does not.
      const { code, migrations } = sortMigrationsToEnd([tuple('/x/V1__init.sql.bak')]);
      assert.equal(migrations.length, 0, 'V1__init.sql.bak is not a migration');
      assert.equal(code.length, 1);
    });

    it('falls back to .path when .fsPath is absent', () => {
      const { migrations } = sortMigrationsToEnd([tuple('lakebase-commit://sha/V9__x.sql', false)]);
      assert.equal(migrations.length, 1);
    });

    it('returns empty arrays for empty input', () => {
      const { code, migrations } = sortMigrationsToEnd([]);
      assert.deepEqual(code, []);
      assert.deepEqual(migrations, []);
    });
  });

  describe('buildDiffTuples', () => {
    it('maps each file through the caller-supplied URI builders, in order', () => {
      const files = [
        { status: 'modified', path: 'a.ts' },
        { status: 'added', path: 'b.ts' },
      ];
      const tuples = buildDiffTuples(files, {
        makeLabelUri: (p) => ({ tag: 'label', p } as any),
        makeOrigUri: (p) => ({ tag: 'orig', p } as any),
        makeModUri: (p) => ({ tag: 'mod', p } as any),
      });
      assert.equal(tuples.length, 2);
      assert.deepEqual(tuples[0][0], { tag: 'label', p: 'a.ts' });
      assert.deepEqual(tuples[0][1], { tag: 'orig', p: 'a.ts' });
      assert.deepEqual(tuples[0][2], { tag: 'mod', p: 'a.ts' });
      assert.deepEqual(tuples[1][0], { tag: 'label', p: 'b.ts' });
    });

    it('propagates undefined from orig/mod builders (single-pane add/delete)', () => {
      const tuples = buildDiffTuples([{ status: 'added', path: 'new.ts' }], {
        makeLabelUri: (p) => ({ p } as any),
        makeOrigUri: () => undefined,
        makeModUri: (p) => ({ p } as any),
      });
      assert.equal(tuples[0][1], undefined);
      assert.notEqual(tuples[0][2], undefined);
    });
  });
});
