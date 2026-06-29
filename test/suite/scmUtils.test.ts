import { strict as assert } from 'assert';
import { parseBranchResourcePath, normalizeBranchName } from '../../src/utils/branchParsing';
import { classifyGitError } from '../../src/utils/errorClassification';
import { gitOpErrorMessage, commitLanded } from '../../src/utils/scmOps';

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

  it('classifies the create-flow auth precondition (W5) as auth', () => {
    // The substrate's create-project auth precondition throws this; the create
    // command routes it to "Connect Workspace" via classifyGitError.
    assert.strictEqual(
      code('Databricks authentication is required before creating a project. Run: databricks auth login --host https://x.cloud.databricks.com'),
      'auth',
    );
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

describe('gitOpErrorMessage', () => {
  it('gives a sign-in message for stale auth (not a generic push failure)', () => {
    const m = gitOpErrorMessage('Push', 'auth', 'request failed: 401');
    assert.match(m.text, /Databricks auth is stale|Connect Workspace|databricks auth login/);
  });
  it('tells the user to pull on a real rejection', () => {
    const m = gitOpErrorMessage('Sync', 'rejected', 'failed to push some refs');
    assert.match(m.text, /Pull, then sync again/i);
    assert.strictEqual(m.severity, 'error');
  });
  it('falls back to the raw message for unknown', () => {
    const m = gitOpErrorMessage('Pull', 'unknown', 'boom');
    assert.match(m.text, /Pull failed: boom/);
  });
});

describe('commitLanded (truthful-commit decision)', () => {
  it('true when HEAD advanced and nothing is staged', () => {
    assert.strictEqual(commitLanded('aaa', 'bbb', false), true);
  });
  it('false when HEAD did not move', () => {
    assert.strictEqual(commitLanded('aaa', 'aaa', false), false);
  });
  it('false when something is still staged even if HEAD moved', () => {
    assert.strictEqual(commitLanded('aaa', 'bbb', true), false);
  });
  it('false on an unborn branch (no HEAD)', () => {
    assert.strictEqual(commitLanded(undefined, undefined, false), false);
  });
});
