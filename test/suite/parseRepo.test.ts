import { strict as assert } from 'assert';
import { formatOwnerRepo, parseOwnerRepo } from '../../src/utils/parseRepo';

describe('parseOwnerRepo', () => {
  it('parses owner/repo slug', () => {
    assert.deepStrictEqual(parseOwnerRepo('acme/widget'), { owner: 'acme', repo: 'widget' });
  });

  it('parses HTTPS GitHub URL', () => {
    assert.deepStrictEqual(
      parseOwnerRepo('https://github.com/acme/widget.git'),
      { owner: 'acme', repo: 'widget' },
    );
  });

  it('parses SSH GitHub URL', () => {
    assert.deepStrictEqual(
      parseOwnerRepo('git@github.com:acme/widget.git'),
      { owner: 'acme', repo: 'widget' },
    );
  });

  it('throws on invalid input', () => {
    assert.throws(() => parseOwnerRepo('not-a-repo'), /Invalid GitHub repo reference/);
  });
});

describe('formatOwnerRepo', () => {
  it('joins owner and repo', () => {
    assert.strictEqual(formatOwnerRepo('acme', 'widget'), 'acme/widget');
  });
});
