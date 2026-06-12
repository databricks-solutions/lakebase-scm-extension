import { strict as assert } from 'assert';
import { TIER_FALLBACK_NAMES } from '../../src/utils/theme';
import { isLongRunningTier } from '../../src/providers/branchTreeProvider';
import { DEFAULT_PROTECTED_TIER_NAMES } from '@databricks-solutions/lakebase-app-dev-kit';

describe('TIER_FALLBACK_NAMES (re-exports the kit default; no duplicated list)', () => {
  it('IS the kit default protected set (source of truth), not an extension-local copy', () => {
    assert.deepEqual([...TIER_FALLBACK_NAMES].sort(), [...DEFAULT_PROTECTED_TIER_NAMES].sort());
    assert.deepEqual([...TIER_FALLBACK_NAMES].sort(), ['dev', 'main', 'master', 'staging']);
  });

  it('is the set branchTreeProvider.isLongRunningTier falls back to (empty cache)', () => {
    // No auto-discovered tiers cached in a hermetic run, so these resolve
    // purely via the kit default set + (empty) project overrides.
    for (const name of TIER_FALLBACK_NAMES) {
      assert.ok(isLongRunningTier(name), `${name} should be a tier`);
    }
    assert.ok(!isLongRunningTier('feature/x'));
    assert.ok(!isLongRunningTier('uat')); // dropped from the default; opt-in per project
    assert.ok(!isLongRunningTier(''));
  });
});
