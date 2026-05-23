import { strict as assert } from 'assert';
import { delay } from '../../src/utils/delay';

describe('delay', () => {
  it('resolves after the requested interval', async () => {
    const start = Date.now();
    await delay(25);
    assert.ok(Date.now() - start >= 20);
  });
});
