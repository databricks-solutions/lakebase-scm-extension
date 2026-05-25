/**
 * Small repro for the cut-backup primitive (pre-migrate snapshot lifecycle).
 *
 * Exercises ONLY `cutBackup` and the Lakebase branch metadata it produces.
 * No git repo, no GitHub repo, no scaffold, no migrations. Runs in ~60s vs
 * ~30 min for the full e-commerce suite, so it's the right loop for
 * diagnosing why a backup branch doesn't appear, has the wrong source,
 * or fails to reach READY.
 *
 * cutBackup is the rollback contract's foundation: every release flow
 * calls it before applying migrations so a rollback always has a known
 * point to restore to. Naming + source-branch fidelity matter; this test
 * pins both.
 *
 * Pre-flight: same as the ecommerce suite - DATABRICKS_TEST_HOST set
 * + authenticated databricks CLI.
 *
 * Run: npm run test:integration -- --grep "cut-backup"
 */

import { strict as assert } from 'assert';
import * as cp from 'child_process';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { cutBackup } from '@databricks-solutions/lakebase-app-dev-kit';
import { assertIntegrationCredentials } from '../lib/credentials';

describe('cut-backup primitive (small repro)', function () {
  this.timeout(300000); // 5 min

  let projectName: string;
  let lakebaseService: LakebaseService;
  let dbHost: string;
  let defaultBranchName: string;

  before(async function () {
    const creds = assertIntegrationCredentials();
    dbHost = creds.databricksHost;
    process.env.DATABRICKS_HOST = dbHost;

    projectName = `lbbackup-${Date.now().toString(36)}`;
    console.log(`\n  Project: ${projectName}`);
    console.log(`  Host: ${dbHost}\n`);

    // 1. Create the Lakebase project. Blocks until ready; no extra polling.
    lakebaseService = new LakebaseService();
    lakebaseService.setHostOverride(dbHost);
    lakebaseService.setProjectIdOverride(projectName);
    console.log(`  [setup] Creating Lakebase project...`);
    const created = await lakebaseService.createProject(projectName);
    console.log(`  [setup] Lakebase project ready (state=${created.state}).`);

    // 2. Discover the default branch name. The kit's cutBackup needs the
    //    SOURCE branch, which on a fresh project is whatever Lakebase
    //    decided to name the initial branch (typically "main", but we
    //    don't hardcode that).
    const raw = cp
      .execSync(`databricks postgres list-branches "projects/${projectName}" -o json`, {
        env: { ...process.env, DATABRICKS_HOST: dbHost },
        timeout: 30_000,
      })
      .toString();
    const parsed = JSON.parse(raw) as unknown;
    const branches = (Array.isArray(parsed)
      ? parsed
      : ((parsed as { branches?: unknown[] }).branches ?? [])) as Array<{
      name?: string;
    }>;
    assert.ok(branches.length >= 1, 'New Lakebase project should have at least one default branch');
    const fullName = branches[0].name || '';
    defaultBranchName = fullName.split('/').pop() || 'main';
    console.log(`  [setup] Default branch: ${defaultBranchName}`);
  });

  it('cutBackup creates a Lakebase branch forked from the source', async function () {
    const backupName = `pre-migrate-test-${Date.now().toString(36)}`;
    console.log(`  [test] Calling cutBackup(source=${defaultBranchName}, backup=${backupName})...`);
    const result = await cutBackup({
      sourceBranch: defaultBranchName,
      backupName,
      instance: projectName,
      host: dbHost,
    });
    console.log(`  [test] cutBackup returned: ${JSON.stringify(result, null, 2)}`);

    assert.ok(result, 'cutBackup must return a result');

    // Verify the backup branch is now in Lakebase and forks from the source.
    const raw = cp
      .execSync(`databricks postgres list-branches "projects/${projectName}" -o json`, {
        env: { ...process.env, DATABRICKS_HOST: dbHost },
        timeout: 30_000,
      })
      .toString();
    const parsed = JSON.parse(raw) as unknown;
    const branches = (Array.isArray(parsed)
      ? parsed
      : ((parsed as { branches?: unknown[] }).branches ?? [])) as Array<{
      name?: string;
      spec?: { source_branch?: string };
      status?: { source_branch?: string };
    }>;
    const backup = branches.find(
      (b) => typeof b.name === 'string' && b.name.endsWith(`/branches/${backupName}`),
    );
    assert.ok(backup, `Backup branch '${backupName}' should exist in Lakebase`);
    const src = backup.spec?.source_branch || backup.status?.source_branch || '';
    assert.match(
      src,
      new RegExp(`branches/${defaultBranchName}$`),
      `Backup must fork from '${defaultBranchName}'; got source=${src}`,
    );
  });

  it('cutBackup is idempotent on the same backupName', async function () {
    const backupName = `idempotent-test-${Date.now().toString(36)}`;
    console.log(`  [test] First cutBackup call...`);
    const first = await cutBackup({
      sourceBranch: defaultBranchName,
      backupName,
      instance: projectName,
      host: dbHost,
    });
    console.log(`  [test] Second cutBackup call (same backupName)...`);
    const second = await cutBackup({
      sourceBranch: defaultBranchName,
      backupName,
      instance: projectName,
      host: dbHost,
    });

    // Idempotency contract: same backupName must resolve to the same backup
    // branch. The substrate must NOT double-cut.
    assert.equal(
      second.backup.name,
      first.backup.name,
      'Idempotent cutBackup must return the same backup branch resource',
    );

    const raw = cp
      .execSync(`databricks postgres list-branches "projects/${projectName}" -o json`, {
        env: { ...process.env, DATABRICKS_HOST: dbHost },
        timeout: 30_000,
      })
      .toString();
    const parsed = JSON.parse(raw) as unknown;
    const branches = (Array.isArray(parsed)
      ? parsed
      : ((parsed as { branches?: unknown[] }).branches ?? [])) as Array<{ name?: string }>;
    const matches = branches.filter(
      (b) => typeof b.name === 'string' && b.name.endsWith(`/branches/${backupName}`),
    );
    assert.equal(matches.length, 1, `Exactly one '${backupName}' branch should exist after two cutBackup calls`);
  });

  after(async function () {
    if (process.env.LBBACKUP_NO_TEARDOWN === '1') {
      console.log(`  [teardown] skipped (LBBACKUP_NO_TEARDOWN=1). Project preserved: ${projectName}`);
      return;
    }
    try {
      console.log(`  [teardown] Deleting Lakebase project ${projectName}...`);
      await lakebaseService.deleteProject(projectName);
    } catch (e) {
      console.log(`  [teardown] Lakebase delete failed (continuing): ${(e as Error)?.message}`);
    }
    console.log(`  [teardown] Done.`);
  });
});
