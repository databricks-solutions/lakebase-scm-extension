import { strict as assert } from 'assert';
import { sanitizeArtifactId } from '../../src/utils/mavenCoords';

describe('mavenCoords', () => {
  describe('sanitizeArtifactId', () => {
    it('lowercases and replaces invalid characters with hyphens', () => {
      assert.strictEqual(sanitizeArtifactId('My Project'), 'my-project');
    });

    it('prefixes leading digits', () => {
      assert.strictEqual(sanitizeArtifactId('123-app'), 'app-123-app');
    });

    it('returns demo for empty input', () => {
      assert.strictEqual(sanitizeArtifactId('---'), 'demo');
    });
  });
});
