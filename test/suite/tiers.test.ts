import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { projectProtectedTierNames, isLongRunningTier } from '../../src/utils/tiers';
import { setKnownTierNames } from '../../src/utils/theme';
import * as config from '../../src/utils/config';
import type { LakebaseConfig } from '../../src/utils/config';

// A minimal LakebaseConfig with overridable tier-relevant fields. Only the
// fields isLongRunningTier / projectProtectedTierNames read matter here.
function cfg(overrides: Partial<LakebaseConfig> = {}): LakebaseConfig {
  return {
    databricksHost: '', lakebaseProjectId: '', autoCreateBranch: true,
    autoRefreshCredentials: true, migrationPath: '', migrationPattern: /x/,
    migrationGlob: '*', language: 'python', showUnifiedRepo: true,
    productionReadOnly: true, trunkBranch: '', stagingBranch: '', baseBranch: '',
    tierNames: [], gitBranchPrefix: '', databricksAuthStorage: '',
    ...overrides,
  };
}

describe('utils/tiers (extension consumes the kit; overrides are extension-owned)', () => {
  afterEach(() => {
    sinon.restore();
    setKnownTierNames([]); // reset the discovered-tier cache between tests
  });

  describe('projectProtectedTierNames', () => {
    it('is the kit default set when the project configures no overrides', () => {
      sinon.stub(config, 'getConfig').returns(cfg());
      const names = projectProtectedTierNames();
      for (const n of ['main', 'master', 'staging', 'dev']) {
        assert.equal(names.has(n), true, `${n} should be protected by default`);
      }
      // uat/perf are NOT protected by default (opt-in per project).
      assert.equal(names.has('uat'), false);
      assert.equal(names.has('perf'), false);
    });

    it('unions the kit default with the project overrides (tierNames + trunk/staging/base)', () => {
      sinon.stub(config, 'getConfig').returns(
        cfg({ tierNames: ['qa', 'Demo'], stagingBranch: 'stg', baseBranch: 'integration' }),
      );
      const names = projectProtectedTierNames();
      for (const n of ['qa', 'demo', 'stg', 'integration', 'staging', 'dev']) {
        assert.equal(names.has(n), true, `${n} should be protected`);
      }
    });
  });

  describe('isLongRunningTier', () => {
    it('a long-running branch with a protected name (in the cache) is a tier', () => {
      sinon.stub(config, 'getConfig').returns(cfg());
      setKnownTierNames(['staging']); // discovered long-running tier
      assert.equal(isLongRunningTier('staging'), true);
    });

    it('an off-convention long-running branch is an ordinary branch (the new rule)', () => {
      sinon.stub(config, 'getConfig').returns(cfg());
      // `scratch` is long-running (in the cache) but its name is NOT protected.
      setKnownTierNames(['scratch']);
      assert.equal(isLongRunningTier('scratch'), false);
    });

    it('a project override (tierNames) protects an off-default long-running name', () => {
      sinon.stub(config, 'getConfig').returns(cfg({ tierNames: ['qa'] }));
      setKnownTierNames(['qa']);
      assert.equal(isLongRunningTier('qa'), true);
    });

    it('uat is not protected by default even when long-running', () => {
      sinon.stub(config, 'getConfig').returns(cfg());
      setKnownTierNames(['uat']);
      assert.equal(isLongRunningTier('uat'), false);
    });

    it('before the first listBranches (empty cache) falls back to the protected-name check', () => {
      sinon.stub(config, 'getConfig').returns(cfg());
      setKnownTierNames([]); // cache empty
      assert.equal(isLongRunningTier('staging'), true);   // protected name -> tier
      assert.equal(isLongRunningTier('scratch'), false);  // off-convention -> ordinary
    });

    it('the trunk (main) is a tier even though it is NOT in the cache (it pairs with the default/production branch)', () => {
      sinon.stub(config, 'getConfig').returns(cfg());
      // The kit excludes the default branch from the tier cache, so `main`
      // is never cached. It must still classify as a tier (the production tier).
      setKnownTierNames(['staging']); // populated cache, but `main` not in it
      assert.equal(isLongRunningTier('main'), true);
      assert.equal(isLongRunningTier('master'), true);
    });

    it('a configured trunkBranch alias is the trunk tier', () => {
      sinon.stub(config, 'getConfig').returns(cfg({ trunkBranch: 'release/v3' }));
      setKnownTierNames(['staging']);
      assert.equal(isLongRunningTier('release/v3'), true);
    });

    it('returns false for an empty name', () => {
      sinon.stub(config, 'getConfig').returns(cfg());
      assert.equal(isLongRunningTier(''), false);
    });
  });
});
