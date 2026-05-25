/**
 * Two-tier release flow helpers for the integration suites.
 *
 * The scaffolded merge.yml triggers on push to either `main` or `staging`,
 * driving a substrate-routed cut-backup + migrate against the matching
 * Lakebase branch (staging → Lakebase staging; main → Lakebase production).
 *
 * Default test flow used to be single-tier: feature PR'd straight into
 * main. That left merge.yml's promotion path (staging → main) completely
 * unexercised. This module adds the missing primitives:
 *
 *   - `createStagingBranch`: cut a Lakebase staging branch + push the
 *     paired `staging` git branch. Runs once per suite, before any
 *     feature work, so feature branches can fork off staging.
 *   - `promoteStagingToMain`: open + merge a staging-into-main PR, wait
 *     for merge.yml on the main push, return the resulting run + the
 *     name of the snapshot backup it cut.
 *   - `assertBackupSnapshotExists`: verify the cut-backup primitive
 *     actually created the rollback snapshot in Lakebase.
 *   - `assertProdSchemaContains`: verify the migration landed on the
 *     prod (default) Lakebase branch's `public` schema.
 *
 * Each promotion creates a `pre-migrate-pr-N` snapshot via the
 * substrate's `lakebase-cut-backup` CLI; the merge.yml's "Clean up or
 * preserve snapshot" step deletes it on success and preserves on
 * failure. Tests should NOT assume the snapshot survives beyond the
 * promotion they observed.
 */

import { strict as assert } from 'assert';
import * as cp from 'child_process';
import { createPR, mergePR, waitForWorkflowRun, getLatestRunId } from './github';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { GitService } from '../../../src/services/gitService';

const dbcli = (cmd: string, dbHost: string, timeoutMs = 30_000): string =>
  cp.execSync(cmd, { timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: dbHost } }).toString();

export interface StagingSetupArgs {
  projectName: string;       // Lakebase project (e.g. ecom-mpkXXX)
  projectDir: string;        // Local scaffolded project directory
  fullRepoName: string;      // owner/repo on GitHub
  databricksHost: string;    // Workspace URL
  lakebaseService: LakebaseService;
  gitService: GitService;
}

/**
 * Cut a Lakebase `staging` branch forked from the project's default
 * (prod) branch, and push the matching git `staging` branch. After
 * this call, `staging` is the merge target for feature PRs in the
 * suite. The default (prod) branch remains untouched.
 *
 * Idempotent on the Lakebase side - createBranch returns the existing
 * branch if it's already there. Idempotent on the git side because
 * we use `git push --set-upstream` which won't fail on re-push.
 */
export async function createStagingBranch(args: StagingSetupArgs): Promise<{
  lakebaseBranchName: string;
  gitBranch: string;
}> {
  // Fork a Lakebase branch off the default (prod). createBranch's
  // omitted-parentBranch path auto-discovers the project default.
  const stagingLakebase = await args.lakebaseService.createBranch({
    instance: args.projectName,
    branch: 'staging',
  });

  // Push a `staging` git branch from `main`. The post-checkout hook
  // would re-create the Lakebase branch on a fresh clone; since this
  // helper runs on the test-author's local clone (where the Lakebase
  // staging branch already exists), the createBranch call above is
  // the authoritative provisioning step. Git push just makes staging
  // visible to GitHub for the promotion-PR flow.
  cp.execSync('git fetch origin main', { cwd: args.projectDir, stdio: 'pipe' });
  cp.execSync('git checkout main', { cwd: args.projectDir, stdio: 'pipe' });
  cp.execSync('git pull --ff-only origin main', { cwd: args.projectDir, stdio: 'pipe' });
  cp.execSync('git branch -f staging main', { cwd: args.projectDir, stdio: 'pipe' });
  cp.execSync('git push -u origin staging', { cwd: args.projectDir, stdio: 'pipe' });
  // Leave the local working tree on `staging` so scenario A-steps
  // that fork from it pick up the right parent automatically.
  cp.execSync('git checkout staging', { cwd: args.projectDir, stdio: 'pipe' });

  return {
    lakebaseBranchName: stagingLakebase.name,
    gitBranch: 'staging',
  };
}

export interface PromotionResult {
  /** PR number used for the staging → main promotion. */
  prNumber: number;
  /** mergeY.yml run that fired on the resulting main push. */
  workflowRunId: number;
  /** The merge.yml run's conclusion (expected: 'success'). */
  conclusion: string;
  /** PR number that the merge.yml snapshot step embedded into the
   *  pre-migrate-pr-N branch name. May differ from prNumber when the
   *  merge commit body's first #N matches a different PR. */
  derivedPrNumberForSnapshot?: number;
}

/**
 * Promote the current state of `staging` to `main`:
 *   1. Open a "Promote staging → main" PR.
 *   2. Squash-merge it. The merge.yml `on: push: branches: [main]`
 *      handler fires.
 *   3. Wait for merge.yml to complete on `main`.
 *   4. Return run + conclusion so the caller can assert success.
 *
 * Caller is responsible for asserting the conclusion, schema effects,
 * and snapshot existence via `assertBackupSnapshotExists` /
 * `assertProdSchemaContains`.
 */
export async function promoteStagingToMain(args: {
  fullRepoName: string;
  promotionLabel: string;
  ownerLogin?: string;
  /** Bound the wait. Merge.yml's full flow runs migrate + verify;
   *  10 min is comfortable headroom. */
  timeoutMs?: number;
}): Promise<PromotionResult> {
  const baselineRun = await getLatestRunId(args.fullRepoName, 'merge.yml');
  const title = `Promote staging → main (${args.promotionLabel})`;
  const body =
    'Automated two-tier promotion from the integration suite. ' +
    'Triggers merge.yml on the main push, which runs the substrate-routed ' +
    'lakebase-cut-backup + lakebase-migrate apply against the prod Lakebase branch.';
  // createPR's helper writes against the suite-shared default base
  // (main); we pass head='staging' explicitly.
  const prNumber = await createPullRequestBase(
    args.fullRepoName,
    title,
    'staging',
    'main',
    body,
  );
  await mergePR(args.fullRepoName, prNumber);
  // merge.yml triggers on push, not on PR closure. The push event
  // fires within seconds of the squash-merge.
  const run = await waitForWorkflowRun(args.fullRepoName, 'merge.yml', {
    branch: 'main',
    event: 'push',
    afterRunId: baselineRun,
    timeoutMs: args.timeoutMs ?? 600_000,
  });
  return {
    prNumber,
    workflowRunId: run.runId,
    conclusion: run.conclusion,
    derivedPrNumberForSnapshot: prNumber,
  };
}

/**
 * Internal helper - createPR in lib/github.ts hard-codes baseBranch='main'.
 * We need feature → staging AND staging → main, so go through the
 * substrate's createPullRequest directly. Kept here (not in github.ts)
 * to avoid breaking the existing per-scenario createPR signature.
 */
async function createPullRequestBase(
  ownerRepo: string,
  title: string,
  headBranch: string,
  baseBranch: string,
  body: string,
): Promise<number> {
  const lib = await import('@databricks-solutions/lakebase-app-dev-kit');
  const url = await lib.createPullRequest({
    ownerRepo,
    headBranch,
    baseBranch,
    title,
    body,
  });
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) { throw new Error(`Could not extract PR number from: ${url}`); }
  return parseInt(match[1], 10);
}

/**
 * Verify that a pre-migrate snapshot backup branch exists in Lakebase
 * after a promotion. The merge.yml snapshot step names backups
 * `pre-migrate-pr-N` where N is the PR number; that branch SHOULD
 * exist immediately after merge.yml's cut-backup step completes and
 * BEFORE its "Clean up or preserve snapshot" step deletes it on
 * success.
 *
 * Because the cleanup step runs in the SAME job, we can't observe
 * the snapshot post-promotion in a green run. This helper takes the
 * snapshot name AND the workflow run's conclusion: on 'success' we
 * verify the snapshot is gone (cleanup deleted it); on any other
 * conclusion the snapshot must remain.
 */
export async function assertBackupSnapshotLifecycle(args: {
  projectName: string;
  databricksHost: string;
  prNumber: number;
  conclusion: string;
}): Promise<void> {
  const raw = dbcli(
    `databricks postgres list-branches projects/${args.projectName} -o json`,
    args.databricksHost,
  );
  const parsed = JSON.parse(raw) as unknown;
  const branches = Array.isArray(parsed)
    ? parsed as Array<{ name?: string }>
    : ((parsed as { branches?: unknown }).branches as Array<{ name?: string }>) ?? [];
  const snapshotMatch = branches.filter((b) =>
    typeof b.name === 'string' && b.name.includes(`pre-migrate-pr-${args.prNumber}`),
  );

  if (args.conclusion === 'success') {
    assert.equal(
      snapshotMatch.length,
      0,
      `Expected pre-migrate-pr-${args.prNumber} snapshot to be cleaned up after a green ` +
        `promotion; found ${snapshotMatch.length} matching branch(es): ` +
        `${snapshotMatch.map((b) => b.name).join(', ')}`,
    );
  } else {
    assert.ok(
      snapshotMatch.length > 0,
      `Expected pre-migrate-pr-${args.prNumber} snapshot to be PRESERVED after a ` +
        `non-success promotion (conclusion=${args.conclusion}); none found`,
    );
  }
}

/**
 * Verify that a set of tables exists on the prod (default) Lakebase
 * branch's `public` schema. Use after a successful promotion to
 * confirm migrations landed where they were supposed to.
 *
 * Connects via psql using the prod branch's credentials (resolved
 * through LakebaseService). Requires `psql` on PATH.
 */
export async function assertProdSchemaContains(args: {
  projectName: string;
  databricksHost: string;
  lakebaseService: LakebaseService;
  expectedTables: string[];
  unexpectedTables?: string[];
}): Promise<void> {
  // Find the default (prod) Lakebase branch.
  const raw = dbcli(
    `databricks postgres list-branches projects/${args.projectName} -o json`,
    args.databricksHost,
  );
  const parsed = JSON.parse(raw) as unknown;
  const branches = Array.isArray(parsed)
    ? parsed as Array<{ name?: string; status?: { default?: boolean }; is_default?: boolean }>
    : ((parsed as { branches?: unknown }).branches as Array<{ name?: string; status?: { default?: boolean }; is_default?: boolean }>) ?? [];
  const defaultBranch = branches.find((b) => b.status?.default === true || b.is_default === true);
  if (!defaultBranch?.name) {
    throw new Error(`Could not locate default Lakebase branch for project ${args.projectName}`);
  }
  const defaultBranchName = defaultBranch.name.split('/').pop()!;

  // Pull connection credentials for the prod branch.
  const cred = await args.lakebaseService.getCredential({
    instance: args.projectName,
    branch: defaultBranchName,
  });
  // cred shape: { host, port, database, username, password, ... }
  // Names vary slightly between substrate versions; use indexer access.
  const c = cred as unknown as Record<string, string | number | undefined>;
  const host = String(c.host ?? c.endpoint ?? '');
  const port = String(c.port ?? '5432');
  const db = String(c.database ?? 'databricks_postgres');
  const user = String(c.username ?? c.user ?? '');
  const password = String(c.password ?? '');

  if (!host || !user || !password) {
    throw new Error(
      `Incomplete prod Lakebase credentials for ${args.projectName}: ` +
        `host=${!!host} user=${!!user} password=${password ? '<set>' : '<unset>'}`,
    );
  }

  const tablesRaw = cp.execSync(
    `psql "host=${host} port=${port} dbname=${db} user=${user} sslmode=require" ` +
      `-t -A -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"`,
    {
      env: { ...process.env, PGPASSWORD: password },
      timeout: 30_000,
    },
  ).toString();
  const actualTables = tablesRaw.split('\n').map((s) => s.trim()).filter(Boolean);

  for (const expected of args.expectedTables) {
    assert.ok(
      actualTables.includes(expected),
      `Expected table '${expected}' on prod (default) Lakebase branch ${defaultBranchName}; ` +
        `actual tables: [${actualTables.join(', ')}]`,
    );
  }
  for (const unexpected of args.unexpectedTables ?? []) {
    assert.ok(
      !actualTables.includes(unexpected),
      `Table '${unexpected}' should NOT exist on prod (default) Lakebase branch ` +
        `${defaultBranchName} (still present after a DROP migration?); ` +
        `actual tables: [${actualTables.join(', ')}]`,
    );
  }
}
