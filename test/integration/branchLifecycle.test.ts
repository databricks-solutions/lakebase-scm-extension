/**
 * Integration test: Lakebase Branch Create + Delete Lifecycle
 *
 * Tests the new create/delete branch features against LIVE Lakebase APIs.
 *
 * Prerequisites:
 * - `databricks auth login` — authenticated to a workspace with Lakebase
 * - DATABRICKS_HOST env var or ~/.databrickscfg configured
 * - LAKEBASE_PROJECT_ID env var or .env with a valid project
 *
 * Run: npm run test:integration -- --grep "Branch Lifecycle"
 */

import { strict as assert } from 'assert';
import { LakebaseService } from '../../src/services/lakebaseService';

const timestamp = Date.now().toString(36);
const TEST_BRANCH_NAME = `int-test-${timestamp}`;

describe('Branch Lifecycle Integration', function () {
  this.timeout(120000);

  let lakebaseService: LakebaseService;
  let branchCreated = false;

  before(async () => {
    lakebaseService = new LakebaseService();

    if (!process.env.DATABRICKS_HOST) {
      process.env.DATABRICKS_HOST = 'https://fevm-serverless-stable-ecparr.cloud.databricks.com';
    }
    lakebaseService.setHostOverride(process.env.DATABRICKS_HOST);

    const projectId = process.env.LAKEBASE_PROJECT_ID || 'lakebase-ecommerce-demo';
    lakebaseService.setProjectIdOverride(projectId);
    console.log(`  Using project: ${projectId}`);

    // Verify we can list branches (auth is working)
    const branches = await lakebaseService.listBranches();
    assert.ok(branches.length > 0, 'Should have at least a default branch');
    console.log(`  Project has ${branches.length} existing branches`);

    const defaultBranch = branches.find(b => b.isDefault);
    assert.ok(defaultBranch, 'Should have a default (production) branch');
    console.log(`  Default branch: ${defaultBranch!.branchId} (${defaultBranch!.state})`);
  });

  // ── Create Branch ───────────────────────────────────────────────

  describe('Create Branch from Production', () => {
    it('creates a branch from the default branch', async function () {
      this.timeout(90000);
      console.log(`  Creating Lakebase branch "${TEST_BRANCH_NAME}" from production...`);

      const branch = await lakebaseService.createBranch(TEST_BRANCH_NAME);

      assert.ok(branch, 'Branch should be created');
      assert.strictEqual(branch!.state, 'READY', 'Branch should be READY');
      assert.ok(branch!.branchId.includes(TEST_BRANCH_NAME.substring(0, 20)),
        `Branch ID should contain test name (got: ${branch!.branchId})`);
      console.log(`  Created: ${branch!.branchId} (${branch!.state})`);
      branchCreated = true;
    });

    it('returns existing branch if already exists', async function () {
      if (!branchCreated) { this.skip(); return; }
      this.timeout(30000);

      const branch = await lakebaseService.createBranch(TEST_BRANCH_NAME);
      assert.ok(branch, 'Should return existing branch');
      assert.strictEqual(branch!.state, 'READY');
      console.log(`  Idempotent create returned: ${branch!.branchId}`);
    });

    it('branch appears in branch list', async function () {
      if (!branchCreated) { this.skip(); return; }

      const branches = await lakebaseService.listBranches();
      const found = branches.find(b => b.branchId.includes(TEST_BRANCH_NAME.substring(0, 20)));
      assert.ok(found, `Branch "${TEST_BRANCH_NAME}" should appear in list`);
      console.log(`  Found in list: ${found!.branchId} (${found!.state})`);
    });
  });

  // ── Delete Branch ───────────────────────────────────────────────

  describe('Delete Branch', () => {
    it('deletes the test branch', async function () {
      if (!branchCreated) { this.skip(); return; }
      this.timeout(30000);

      // Get the full resource name for deletion
      const branches = await lakebaseService.listBranches();
      const target = branches.find(b => b.branchId.includes(TEST_BRANCH_NAME.substring(0, 20)));
      assert.ok(target, 'Target branch should exist before deletion');

      console.log(`  Deleting branch "${target!.branchId}" (${target!.name})...`);
      await lakebaseService.deleteBranch(target!.name);
      console.log(`  Deleted.`);
    });

    it('branch no longer appears in branch list', async function () {
      if (!branchCreated) { this.skip(); return; }

      // Small delay for API consistency
      await new Promise(resolve => setTimeout(resolve, 3000));

      const branches = await lakebaseService.listBranches();
      const found = branches.find(b => b.branchId.includes(TEST_BRANCH_NAME.substring(0, 20)));
      assert.ok(!found, 'Deleted branch should not appear in list');
      console.log(`  Confirmed: branch no longer in list`);
    });
  });

  // ── Recreate (the delete → recreate cycle) ─────────────────────

  describe('Recreate Branch (delete + create cycle)', () => {
    let recreatedBranch = false;

    it('recreates the branch from production after deletion', async function () {
      if (!branchCreated) { this.skip(); return; }
      this.timeout(90000);

      console.log(`  Recreating branch "${TEST_BRANCH_NAME}" from production...`);
      const branch = await lakebaseService.createBranch(TEST_BRANCH_NAME);

      assert.ok(branch, 'Recreated branch should exist');
      assert.strictEqual(branch!.state, 'READY', 'Recreated branch should be READY');
      console.log(`  Recreated: ${branch!.branchId} (${branch!.state})`);
      recreatedBranch = true;
    });

    it('recreated branch appears in list', async function () {
      if (!recreatedBranch) { this.skip(); return; }

      const branches = await lakebaseService.listBranches();
      const found = branches.find(b => b.branchId.includes(TEST_BRANCH_NAME.substring(0, 20)));
      assert.ok(found, 'Recreated branch should appear in list');
    });
  });

  // ── Cleanup ─────────────────────────────────────────────────────

  after(async function () {
    this.timeout(30000);
    try {
      const branches = await lakebaseService.listBranches();
      const target = branches.find(b => b.branchId.includes(TEST_BRANCH_NAME.substring(0, 20)));
      if (target) {
        console.log(`  [cleanup] Deleting leftover branch ${target.branchId}`);
        await lakebaseService.deleteBranch(target.name);
      }
    } catch (e: any) {
      console.log(`  [cleanup] Branch cleanup failed: ${e.message}`);
    }
  });
});
