/**
 * N-tier release flow helpers for the integration suites.
 *
 * Two roles in any release flow:
 *   - LONG-RUNNING BRANCHES form a directed chain ending at the project's
 *     default (usually 'main' / Lakebase 'production'). The architect
 *     declares which tier names live in the chain (e.g. two-tier:
 *     ['staging', 'main']; three-tier: ['dev', 'staging', 'main']).
 *   - A RELEASE is a merge between two adjacent tiers (from → to). The
 *     shape is identical at every tier; only the tier names change.
 *
 * This module exposes:
 *   - `createLongRunningBranch({ name, forkFromBranch, ... })`: cut a
 *     Lakebase branch + push a paired git branch named `name`. Runs once
 *     per tier the suite needs (two-tier: once for 'staging').
 *   - `release({ from, to, ... })`: open + merge a from→to PR, wait for
 *     merge.yml to complete on the `to` push, return the run + the
 *     pre-migrate snapshot lifecycle handle.
 *   - `assertBackupSnapshotLifecycle`: verify cut-backup ran and was
 *     cleaned up on green / preserved on red.
 *   - `assertSchemaContainsOnBranch`: verify migration landed on a
 *     specific Lakebase branch's `public` schema.
 *
 * Each release creates a `pre-migrate-pr-N` snapshot via the substrate's
 * `lakebase-cut-backup` CLI; merge.yml's "Clean up or preserve snapshot"
 * step deletes it on success and preserves on failure.
 */

import { strict as assert } from 'assert';
import * as cp from 'child_process';
import { createPR, mergePR, waitForWorkflowRun, getLatestRunId } from './github';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { GitService } from '../../../src/services/gitService';

const dbcli = (cmd: string, dbHost: string, timeoutMs = 30_000): string =>
  cp.execSync(cmd, { timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: dbHost } }).toString();

export interface CreateLongRunningBranchArgs {
  /** Tier name to create (e.g. 'staging', 'dev'). Used as both the git
   *  branch name and the Lakebase branch name. */
  name: string;
  /** Existing git branch to fork the new tier from. For two-tier the
   *  staging tier forks from 'main'; for three-tier the dev tier forks
   *  from 'staging' and the staging tier forks from 'main'. */
  forkFromBranch: string;
  projectName: string;
  projectDir: string;
  fullRepoName: string;
  databricksHost: string;
  lakebaseService: LakebaseService;
  gitService: GitService;
}

/**
 * Cut a long-running tier off another long-running tier. Creates the
 * Lakebase branch (via the wrapper, which forks from the project's
 * current branch per convention) and pushes the matching git branch
 * to GitHub.
 *
 * Idempotent on both the Lakebase + git sides.
 */
export async function createLongRunningBranch(
  args: CreateLongRunningBranchArgs,
): Promise<{ lakebaseBranchName: string; gitBranch: string }> {
  // Fork a Lakebase branch. createBranch with no explicit parent forks
  // from whatever's in the project's .env (kept current by the
  // post-checkout hook). Since this runs at suite start, the .env's
  // LAKEBASE_BRANCH_ID resolves to the project default / forkFromBranch's
  // Lakebase pair.
  const created = await args.lakebaseService.createBranch(args.name);
  if (!created) {
    throw new Error(
      `Failed to create Lakebase branch '${args.name}' for project ${args.projectName}`,
    );
  }

  // Push the matching git branch from the parent tier. The post-checkout
  // hook tracks the current Lakebase branch via .env; the git side just
  // makes the new tier visible on GitHub so release PRs can target it.
  cp.execSync(`git fetch origin ${args.forkFromBranch}`, { cwd: args.projectDir, stdio: 'pipe' });
  cp.execSync(`git checkout ${args.forkFromBranch}`, { cwd: args.projectDir, stdio: 'pipe' });
  cp.execSync(`git pull --ff-only origin ${args.forkFromBranch}`, { cwd: args.projectDir, stdio: 'pipe' });
  cp.execSync(`git branch -f ${args.name} ${args.forkFromBranch}`, { cwd: args.projectDir, stdio: 'pipe' });
  cp.execSync(`git push -u origin ${args.name}`, { cwd: args.projectDir, stdio: 'pipe' });
  // Leave the local working tree on the new tier so subsequent scenario
  // operations (which feature-branch off it) pick up the right parent.
  cp.execSync(`git checkout ${args.name}`, { cwd: args.projectDir, stdio: 'pipe' });

  return {
    lakebaseBranchName: created.name,
    gitBranch: args.name,
  };
}

export interface ReleaseResult {
  /** PR number used for the from→to release. */
  prNumber: number;
  /** merge.yml run that fired on the resulting `to` push. */
  workflowRunId: number;
  /** The merge.yml run's conclusion (expected: 'success'). */
  conclusion: string;
  /** PR number the merge.yml snapshot step embedded into the
   *  pre-migrate-pr-N branch name. */
  derivedPrNumberForSnapshot?: number;
}

export interface ReleaseArgs {
  /** Source tier (any long-running branch or feature branch). */
  from: string;
  /** Target tier (a long-running branch). */
  to: string;
  fullRepoName: string;
  /** Human-readable label appended to the PR title for traceability. */
  releaseLabel: string;
  /** Bound the wait. Merge.yml's full flow runs migrate + verify;
   *  10 min is comfortable headroom. */
  timeoutMs?: number;
}

/**
 * Promote `from` into `to`. Same shape for every adjacent-tier release
 * (and even feature → tier, though scenarios use the simpler
 * createPR + mergePR flow for those):
 *   1. Open a "Release: from → to" PR.
 *   2. Squash-merge it. The merge.yml `on: push: branches: [to]`
 *      handler fires.
 *   3. Wait for merge.yml to complete on `to`.
 *   4. Return run + conclusion so the caller can assert success.
 */
export async function release(args: ReleaseArgs): Promise<ReleaseResult> {
  const baselineRun = await getLatestRunId(args.fullRepoName, 'merge.yml');
  const title = `Release: ${args.from} → ${args.to} (${args.releaseLabel})`;
  const body =
    `Automated release from the integration suite. ` +
    `Triggers merge.yml on the ${args.to} push, which runs the substrate-routed ` +
    `lakebase-cut-backup + lakebase-migrate apply against the ${args.to} Lakebase branch.`;
  const prNumber = await createPullRequestBase(
    args.fullRepoName,
    title,
    args.from,
    args.to,
    body,
  );
  await mergePR(args.fullRepoName, prNumber);
  // merge.yml triggers on push, not on PR closure. The push event
  // fires within seconds of the squash-merge.
  const run = await waitForWorkflowRun(args.fullRepoName, 'merge.yml', {
    branch: args.to,
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
 * Internal helper - createPR in lib/github.ts has its own default base.
 * `release` always specifies both head and base, so we go through the
 * substrate's createPullRequest directly.
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
 * Verify the pre-migrate snapshot's lifecycle for a release. The
 * merge.yml snapshot step names backups `pre-migrate-pr-N` where N is
 * the release PR's number. On a green run, the "Clean up or preserve
 * snapshot" step deletes it (we expect the snapshot absent); on any
 * other conclusion the snapshot must remain.
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
        `release; found ${snapshotMatch.length} matching branch(es): ` +
        `${snapshotMatch.map((b) => b.name).join(', ')}`,
    );
  } else {
    assert.ok(
      snapshotMatch.length > 0,
      `Expected pre-migrate-pr-${args.prNumber} snapshot to be PRESERVED after a ` +
        `non-success release (conclusion=${args.conclusion}); none found`,
    );
  }
}

export interface AssertSchemaContainsArgs {
  projectName: string;
  databricksHost: string;
  lakebaseService: LakebaseService;
  /** Lakebase branch to query. Pass the literal branch name (e.g. the
   *  project's default branch name, which is typically 'production' for
   *  the prod tier and 'staging' / 'dev' for intermediate tiers). */
  branchName: string;
  expectedTables: string[];
  unexpectedTables?: string[];
}

/**
 * Verify the `public` schema on a specific Lakebase branch contains
 * (and doesn't contain) the expected tables. Use after a release to
 * confirm migrations landed where they were supposed to.
 *
 * Connects via psql using the branch's credentials. Requires `psql`
 * on PATH.
 */
export async function assertSchemaContainsOnBranch(
  args: AssertSchemaContainsArgs,
): Promise<void> {
  // Pull connection credentials for the target branch.
  const cred = await args.lakebaseService.getCredential({
    instance: args.projectName,
    branch: args.branchName,
  });
  const c = cred as unknown as Record<string, string | number | undefined>;
  const host = String(c.host ?? c.endpoint ?? '');
  const port = String(c.port ?? '5432');
  const db = String(c.database ?? 'databricks_postgres');
  const user = String(c.username ?? c.user ?? '');
  const password = String(c.password ?? '');

  if (!host || !user || !password) {
    throw new Error(
      `Incomplete Lakebase credentials for ${args.projectName}/${args.branchName}: ` +
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
      `Expected table '${expected}' on Lakebase branch '${args.branchName}' of ` +
        `${args.projectName}; actual tables: [${actualTables.join(', ')}]`,
    );
  }
  for (const unexpected of args.unexpectedTables ?? []) {
    assert.ok(
      !actualTables.includes(unexpected),
      `Table '${unexpected}' should NOT exist on Lakebase branch '${args.branchName}' ` +
        `of ${args.projectName} (still present after a DROP migration?); ` +
        `actual tables: [${actualTables.join(', ')}]`,
    );
  }
}

/**
 * Resolve the project's default (prod) Lakebase branch name. Use this
 * when a caller needs to query "the prod tier" without hardcoding what
 * the project decided to call it (it's usually 'production' but the
 * substrate doesn't enforce that).
 */
export async function resolveDefaultBranchName(args: {
  projectName: string;
  databricksHost: string;
}): Promise<string> {
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
  return defaultBranch.name.split('/').pop()!;
}
