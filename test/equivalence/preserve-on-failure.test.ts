// Hermetic tests for test/integration/lib/preserve-on-failure.ts.
//
// These guard the cleanup-default-off invariant: even if a future commit
// re-introduces "teardown on success" logic somewhere, the module's
// public surface here is the contract every test suite consumes.

import { strict as assert } from 'assert';
import {
  installFailureTracker,
  markTestFailed,
  didAnyTestFail,
  getFailedTestTitles,
  preservedResourcesBanner,
} from '../integration/lib/preserve-on-failure';

describe('preserve-on-failure module', () => {
  // The module's failure counter is process-wide on purpose - run order
  // would otherwise leak across describes. Each test captures the
  // pre-state and restores it. NOTE: there is no `resetFailureCount`
  // export by design; this test cheats via the module's public API
  // (markTestFailed isn't reversible, so we snapshot length before).
  let initialFailureCount = 0;
  before(() => {
    initialFailureCount = getFailedTestTitles().length;
  });

  it('markTestFailed records the title', () => {
    const before = getFailedTestTitles().length;
    markTestFailed('hermetic-test-failure-A');
    assert.strictEqual(getFailedTestTitles().length, before + 1);
    assert.ok(getFailedTestTitles().includes('hermetic-test-failure-A'));
  });

  it('didAnyTestFail returns true once any failure is recorded', () => {
    assert.strictEqual(didAnyTestFail(), true);
  });

  it('installFailureTracker throws when afterEach is not in scope', () => {
    // Capture and temporarily clear the mocha global so we exercise the
    // guard. Restoring is critical so subsequent tests see mocha again.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    const saved = g.afterEach;
    g.afterEach = undefined;
    try {
      assert.throws(
        () => installFailureTracker(),
        /afterEach not available/,
      );
    } finally {
      g.afterEach = saved;
    }
  });

  it('preservedResourcesBanner names every passed resource', () => {
    const banner = preservedResourcesBanner({
      githubRepo: 'kevin-hartman/ecom-hermetic',
      lakebaseProject: 'ecom-hermetic',
      databricksHost: 'https://test.cloud.databricks.com',
      projectDir: '/tmp/ecom-hermetic',
    });
    assert.ok(banner.includes('PRESERVED INTEGRATION RESOURCES'));
    assert.ok(banner.includes('kevin-hartman/ecom-hermetic'));
    assert.ok(banner.includes('ecom-hermetic'));
    assert.ok(banner.includes('https://test.cloud.databricks.com'));
    assert.ok(banner.includes('/tmp/ecom-hermetic'));
    // Cleanup command line is the only path operators ever see for
    // teardown - regressing it would silently break the contract.
    assert.ok(banner.includes('npx ts-node test/integration/lib/cleanup-cli.ts'));
    assert.ok(banner.includes('--repo kevin-hartman/ecom-hermetic'));
    assert.ok(banner.includes('--project ecom-hermetic'));
    assert.ok(banner.includes('--host https://test.cloud.databricks.com'));
    assert.ok(banner.includes('--dir /tmp/ecom-hermetic'));
  });

  it('preservedResourcesBanner omits missing resource lines', () => {
    const banner = preservedResourcesBanner({
      githubRepo: 'kevin-hartman/only-repo',
    });
    assert.ok(banner.includes('kevin-hartman/only-repo'));
    assert.ok(!banner.includes('Lakebase project:'));
    assert.ok(!banner.includes('Local dir:'));
    assert.ok(!banner.includes('--project'));
    assert.ok(!banner.includes('--dir'));
  });

  it('preservedResourcesBanner reflects the failure status when failures exist', () => {
    // The previous "hermetic-test-failure-A" is still in the tracker.
    const banner = preservedResourcesBanner({ githubRepo: 'k/r' });
    assert.ok(/\d+ test failure/.test(banner));
    assert.ok(banner.includes('hermetic-test-failure-A'));
  });

  // Sanity: nothing in the suite should have called installFailureTracker
  // on its own; only markTestFailed in test 1. Anything else means a
  // future change leaked state.
  it('failure count grew by exactly the failures we recorded', () => {
    assert.strictEqual(
      getFailedTestTitles().length - initialFailureCount,
      1,
    );
  });
});
