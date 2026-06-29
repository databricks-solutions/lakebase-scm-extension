import { strict as assert } from 'assert';
import { parseBranchResourcePath, normalizeBranchName } from '../../src/utils/branchParsing';
import { classifyGitError } from '../../src/utils/errorClassification';

describe('branchParsing', () => {
  describe('parseBranchResourcePath', () => {
    it('extracts the short id from a resource path', () => {
      assert.strictEqual(parseBranchResourcePath('projects/p/branches/production'), 'production');
    });
    it('returns a bare name unchanged', () => {
      assert.strictEqual(parseBranchResourcePath('production'), 'production');
    });
    it('returns undefined for empty / null / undefined', () => {
      assert.strictEqual(parseBranchResourcePath(''), undefined);
      assert.strictEqual(parseBranchResourcePath(undefined), undefined);
      assert.strictEqual(parseBranchResourcePath(null), undefined);
    });
  });

  describe('normalizeBranchName (the .trim-crash guard)', () => {
    it('normalizes a real name (trim + lowercase)', () => {
      assert.strictEqual(normalizeBranchName('  Production '), 'production');
    });
    it('returns "" for undefined / null / empty / non-string instead of throwing', () => {
      assert.strictEqual(normalizeBranchName(undefined), '');
      assert.strictEqual(normalizeBranchName(null), '');
      assert.strictEqual(normalizeBranchName(''), '');
      // The exact crash the eval hit: a non-string parent value.
      assert.doesNotThrow(() => normalizeBranchName(undefined));
    });
  });
});

describe('classifyGitError', () => {
  const code = (msg: string) => classifyGitError(new Error(msg)).code;

  it('classifies the canonical auth signatures (superset of the old inline checks)', () => {
    assert.strictEqual(code('project id not found'), 'auth');
    assert.strictEqual(code('not authenticated'), 'auth');
    assert.strictEqual(code('request failed: 401'), 'auth');
    assert.strictEqual(code('PERMISSION_DENIED'), 'auth');
    assert.strictEqual(code('invalid token'), 'auth');
  });

  it('treats "Everything up-to-date" as in-sync, not a failure', () => {
    assert.strictEqual(code('Everything up-to-date'), 'in-sync');
  });

  it('classifies a real push rejection', () => {
    assert.strictEqual(code('failed to push some refs to origin'), 'rejected');
    assert.strictEqual(code('Updates were rejected because the tip is behind'), 'rejected');
  });

  it('classifies network + conflict + unknown', () => {
    assert.strictEqual(code('could not resolve host: github.com'), 'network');
    assert.strictEqual(code('CONFLICT (content): Merge conflict in x'), 'conflict');
    assert.strictEqual(code('some other failure'), 'unknown');
  });

  it('handles non-Error input without throwing', () => {
    assert.strictEqual(classifyGitError(undefined).code, 'unknown');
    assert.strictEqual(classifyGitError('failed to push some refs').code, 'rejected');
  });
});
