import { strict as assert } from 'assert';
import { withDatabricksHostEnv } from '../../src/utils/databricksEnv';

const HOST = 'https://ws.cloud.databricks.com';
const HOST2 = 'https://other.cloud.databricks.com';

/** A promise plus its resolver, for holding fn() open mid-flight. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('withDatabricksHostEnv (ref-counted global env)', () => {
  afterEach(() => {
    delete process.env.DATABRICKS_HOST;
    delete process.env.DATABRICKS_CONFIG_PROFILE;
  });

  it('sets host + profile during fn and restores (to unset) after', async () => {
    let during: { host?: string; profile?: string } = {};
    await withDatabricksHostEnv(HOST, async () => {
      during = {
        host: process.env.DATABRICKS_HOST,
        profile: process.env.DATABRICKS_CONFIG_PROFILE,
      };
    }, { profile: 'p1' });
    assert.equal(during.host, HOST);
    assert.equal(during.profile, 'p1');
    assert.equal(process.env.DATABRICKS_HOST, undefined);
    assert.equal(process.env.DATABRICKS_CONFIG_PROFILE, undefined);
  });

  it('clears a stale ambient profile when none is provided, restores it after', async () => {
    process.env.DATABRICKS_CONFIG_PROFILE = 'ambient';
    let profileDuring: string | undefined = 'unset';
    await withDatabricksHostEnv(HOST, async () => {
      profileDuring = process.env.DATABRICKS_CONFIG_PROFILE;
    });
    assert.equal(profileDuring, undefined, 'stale ambient profile cleared during the call');
    assert.equal(process.env.DATABRICKS_CONFIG_PROFILE, 'ambient', 'restored afterward');
  });

  it('restores from throw', async () => {
    await assert.rejects(
      withDatabricksHostEnv(HOST, async () => { throw new Error('boom'); }, { profile: 'p1' }),
      /boom/,
    );
    assert.equal(process.env.DATABRICKS_HOST, undefined);
    assert.equal(process.env.DATABRICKS_CONFIG_PROFILE, undefined);
  });

  it('THE FIX: a concurrent same-env call does not strip the profile when the first finishes', async () => {
    const a = deferred();
    const b = deferred();
    let envWhileBHeld: string | undefined = 'unset';

    const callA = withDatabricksHostEnv(HOST, async () => { await a.promise; }, { profile: 'p1' });
    const callB = withDatabricksHostEnv(HOST, async () => {
      await b.promise;
      // Captured AFTER A has resolved (released below) but while B holds.
      envWhileBHeld = process.env.DATABRICKS_CONFIG_PROFILE;
    }, { profile: 'p1' });

    // Both in-flight: env applied.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(process.env.DATABRICKS_CONFIG_PROFILE, 'p1');

    a.resolve();        // A's finally runs; must NOT strip because B still holds (depth 2->1)
    await callA;
    assert.equal(process.env.DATABRICKS_CONFIG_PROFILE, 'p1', 'profile survives A finishing while B holds');

    b.resolve();
    await callB;
    assert.equal(envWhileBHeld, 'p1', 'B still saw the profile after A returned');
    assert.equal(process.env.DATABRICKS_CONFIG_PROFILE, undefined, 'restored only after the last call');
  });

  it('serializes a conflicting different-host call until the first unwinds', async () => {
    const a = deferred();
    const order: string[] = [];

    const callA = withDatabricksHostEnv(HOST, async () => {
      await a.promise;
      order.push('A-host=' + process.env.DATABRICKS_HOST);
    }, { profile: 'p1' });

    const callB = withDatabricksHostEnv(HOST2, async () => {
      order.push('B-host=' + process.env.DATABRICKS_HOST);
    }, { profile: 'p2' });

    await new Promise((r) => setTimeout(r, 5));
    // B must be waiting: env is still A's, not B's.
    assert.equal(process.env.DATABRICKS_HOST, HOST);

    a.resolve();
    await Promise.all([callA, callB]);
    assert.deepEqual(order, ['A-host=' + HOST, 'B-host=' + HOST2], 'B applied its env only after A unwound');
    assert.equal(process.env.DATABRICKS_HOST, undefined);
  });
});
