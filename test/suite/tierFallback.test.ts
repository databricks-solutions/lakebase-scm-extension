import { strict as assert } from 'assert';
import { TIER_FALLBACK_NAMES } from '../../src/utils/theme';
import { isLongRunningTier } from '../../src/providers/branchTreeProvider';

describe('TIER_FALLBACK_NAMES (single source for the conventional tier set)', () => {
  it('contains exactly the conventional trunk/tier names', () => {
    assert.deepEqual(
      [...TIER_FALLBACK_NAMES].sort(),
      ['main', 'master', 'perf', 'staging', 'uat'],
    );
  });

  it('is the set branchTreeProvider.isLongRunningTier falls back to', () => {
    // No auto-discovered tiers cached in a hermetic run, so these resolve
    // purely via the shared fallback const.
    for (const name of TIER_FALLBACK_NAMES) {
      assert.ok(isLongRunningTier(name), `${name} should be a tier`);
    }
    assert.ok(!isLongRunningTier('feature/x'));
    assert.ok(!isLongRunningTier(''));
  });
});
