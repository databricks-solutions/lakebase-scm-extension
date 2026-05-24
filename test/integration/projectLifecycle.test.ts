/**
 * Integration test: Project Lifecycle (Create + Teardown)
 *
 * Tests against LIVE APIs:
 * - GitHub (via gh CLI) — create and delete a private repo
 * - Databricks Lakebase (via databricks CLI) — create and delete a project
 *
 * Prerequisites:
 * - `gh auth status` — logged in with delete_repo scope
 * - `databricks auth login` — authenticated to a workspace with Lakebase
 * - DATABRICKS_HOST env var or ~/.databrickscfg configured
 *
 * Run: npm run test:integration
 */

import { strict as assert } from 'assert';
import { GitService } from '../../src/services/gitService';
import { LakebaseService } from '../../src/services/lakebaseService';

// Unique test identifiers to avoid collisions
const timestamp = Date.now().toString(36);
const TEST_REPO_NAME = `integration-test-${timestamp}`;
const TEST_PROJECT_ID = `int-test-${timestamp}`;

describe('Project Lifecycle Integration', function () {
  // These are long-running operations against live APIs
  this.timeout(120000);

  let gitService: GitService;
  let lakebaseService: LakebaseService;
  let ghUser: string;
  let fullRepoName: string;
  let lakebaseProjectCreated = false;
  let githubRepoCreated = false;

  before(async () => {
    gitService = new GitService();
    lakebaseService = new LakebaseService();

    // Ensure DATABRICKS_HOST is set for the CLI
    if (!process.env.DATABRICKS_HOST) {
      process.env.DATABRICKS_HOST = 'https://fevm-serverless-stable-ecparr.cloud.databricks.com';
    }
    lakebaseService.setHostOverride(process.env.DATABRICKS_HOST);

    // Determine GitHub user for full repo name
    const cp = require('child_process');
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    fullRepoName = `${ghUser}/${TEST_REPO_NAME}`;

    console.log(`  Test identifiers:`);
    console.log(`    GitHub repo: ${fullRepoName}`);
    console.log(`    Lakebase project: ${TEST_PROJECT_ID}`);
  });

  // ── GitHub Repo Lifecycle ────────────────────────────────────────

  describe('GitHub Repository', () => {
    it('creates a private repo', async () => {
      const result = await gitService.createRepo(fullRepoName, {
        private: true,
        clone: false,
        description: 'Integration test — auto-created, safe to delete',
      });
      console.log(`    Created: ${result}`);
      githubRepoCreated = true;
      assert.ok(result.includes(TEST_REPO_NAME), 'Result should contain repo name');
    });

    it('verifies repo exists', async () => {
      const exists = await gitService.repoExists(fullRepoName);
      assert.ok(exists, 'Repo should exist after creation');
    });

    it('can set a secret on the repo', async () => {
      await gitService.setRepoSecret(fullRepoName, 'TEST_SECRET', 'test-value-12345');
      // No error means success — gh secret set doesn't return output
    });

    it('verifies non-existent repo returns false', async () => {
      const exists = await gitService.repoExists(`${ghUser}/nonexistent-repo-${timestamp}`);
      assert.strictEqual(exists, false);
    });
  });

  // ── Lakebase Project Lifecycle ───────────────────────────────────

  describe('Lakebase Project', () => {
    it('creates a project', async function () {
      // This can take 30-60 seconds
      this.timeout(90000);
      console.log(`    Creating Lakebase project ${TEST_PROJECT_ID}...`);
      const result = await lakebaseService.createProject(TEST_PROJECT_ID);
      console.log(`    Created: uid=${result.uid}, state=${result.state}`);
      lakebaseProjectCreated = true;
      assert.ok(result.uid, 'Should have a uid');
      assert.ok(result.name.includes(TEST_PROJECT_ID), 'Name should contain project ID');
    });

    it('verifies project appears in list', async () => {
      // Use the CLI directly to verify since listBranches needs a configured project
      const cp = require('child_process');
      const raw = cp.execSync('databricks postgres list-projects -o json', {
        timeout: 15000,
        env: { ...process.env, ...lakebaseService['cliEnv']() },
      }).toString();
      const parsed = JSON.parse(raw);
      const projects = Array.isArray(parsed) ? parsed : parsed.projects || [];
      const found = projects.some((p: any) =>
        p.uid === TEST_PROJECT_ID ||
        (p.name && p.name.includes(TEST_PROJECT_ID))
      );
      assert.ok(found, `Project ${TEST_PROJECT_ID} should appear in project list`);
    });
  });

  // ── Teardown ─────────────────────────────────────────────────────

  describe('Teardown', () => {
    it('deletes the GitHub repo', async function () {
      if (!githubRepoCreated) { this.skip(); return; }
      this.timeout(30000);
      console.log(`    Deleting GitHub repo ${fullRepoName}...`);
      await gitService.deleteRepo(fullRepoName);
      console.log(`    Deleted.`);

      // Verify it's gone
      const exists = await gitService.repoExists(fullRepoName);
      assert.strictEqual(exists, false, 'Repo should not exist after deletion');
    });

    it('deletes the Lakebase project', async function () {
      if (!lakebaseProjectCreated) { this.skip(); return; }
      this.timeout(90000);
      console.log(`    Deleting Lakebase project ${TEST_PROJECT_ID}...`);
      await lakebaseService.deleteProject(TEST_PROJECT_ID);
      console.log(`    Deleted.`);
    });
  });

  // Emergency cleanup if tests fail partway through
  after(async function () {
    this.timeout(120000);
    if (githubRepoCreated) {
      try {
        const exists = await gitService.repoExists(fullRepoName);
        if (exists) {
          console.log(`  [cleanup] Deleting leftover GitHub repo ${fullRepoName}`);
          await gitService.deleteRepo(fullRepoName);
        }
      } catch (e: any) { console.log(`  [cleanup] GitHub cleanup failed: ${e.message}`); }
    }
    if (lakebaseProjectCreated) {
      try {
        console.log(`  [cleanup] Deleting leftover Lakebase project ${TEST_PROJECT_ID}`);
        await lakebaseService.deleteProject(TEST_PROJECT_ID);
      } catch (e: any) { console.log(`  [cleanup] Lakebase cleanup failed: ${e.message}`); }
    }
  });
});
