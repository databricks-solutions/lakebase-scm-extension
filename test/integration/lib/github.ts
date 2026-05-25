/**
 * Shared GitHub PR + workflow primitives, substrate-driven.
 *
 * Both python-devloop and ecommerce integration tests used to keep their
 * own shell-out copies of these (gh CLI, parsed via jq). Now both delegate
 * to substrate's octokit-backed exports.
 */

import {
  createPullRequest, mergePullRequest, listIssueComments, listWorkflowRuns,
} from '@databricks-solutions/lakebase-app-dev-kit';
import * as cp from 'child_process';

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface WorkflowRunResult {
  conclusion: string;
  runId: number;
}

export interface WaitForWorkflowOptions {
  branch?: string;
  event?: string;
  afterRunId?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Create a PR via substrate octokit; returns the PR number. baseBranch
 * defaults to 'main' for back-compat with the single-tier flow, but
 * the two-tier suites pass 'staging' here so feature PRs target the
 * staging tier (and a separate staging→main promotion PR fires merge.yml
 * against prod).
 */
export async function createPR(
  ownerRepo: string,
  title: string,
  branchName: string,
  body: string,
  baseBranch: string = 'main',
): Promise<number> {
  const url = await createPullRequest({
    ownerRepo,
    headBranch: branchName,
    title,
    body,
    baseBranch,
  });
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) { throw new Error(`Could not extract PR number from: ${url}`); }
  return parseInt(match[1], 10);
}

/** Merge a PR via substrate octokit (merge-commit, deletes remote head branch). */
export async function mergePR(ownerRepo: string, prNumber: number): Promise<void> {
  await mergePullRequest({
    ownerRepo,
    pullNumber: prNumber,
    method: 'merge',
    deleteRemoteBranch: true,
  });
}

/** Get PR comment bodies via substrate octokit. */
export async function getPRComments(ownerRepo: string, prNumber: number): Promise<string[]> {
  return listIssueComments(ownerRepo, prNumber);
}

/**
 * substrate.listWorkflowRuns is repo-wide (no workflow-file filter), so we
 * filter the returned list locally by matching the run's `name` against the
 * workflow file's basename. Falls back to substring match for resilience.
 */
export function matchesWorkflowFile(run: { name: string }, workflowFile: string): boolean {
  const stem = workflowFile.replace(/\.ya?ml$/i, '');
  return run.name === stem || run.name.toLowerCase() === stem.toLowerCase() ||
         run.name.includes(stem);
}

export async function getLatestRunId(ownerRepo: string, workflowFile: string): Promise<number> {
  try {
    const runs = await listWorkflowRuns(ownerRepo, 25);
    const match = runs.find((r) => matchesWorkflowFile(r, workflowFile));
    return match ? match.id : 0;
  } catch { return 0; }
}

export async function waitForWorkflowRun(
  ownerRepo: string,
  workflowFile: string,
  opts: WaitForWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  const timeoutMs = opts.timeoutMs ?? 360_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000;
  const afterRunId = opts.afterRunId ?? 0;
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const runs = await listWorkflowRuns(ownerRepo, 25);
      const matching = runs.filter((r) => matchesWorkflowFile(r, workflowFile));
      for (const run of matching) {
        if (afterRunId && run.id <= afterRunId) { continue; }
        if (opts.branch && run.branch !== opts.branch) { continue; }
        if (opts.event && run.event !== opts.event) { continue; }
        if (run.status === 'completed') {
          return { conclusion: run.conclusion, runId: run.id };
        }
        break;
      }
    } catch {}
    await delay(pollIntervalMs);
  }
  throw new Error(
    `Workflow ${workflowFile} did not complete within ${timeoutMs / 1000}s ` +
    `(branch: ${opts.branch || 'any'}, event: ${opts.event || 'any'}, afterRunId: ${afterRunId})`,
  );
}

/**
 * Last N lines of logs from a workflow run. Substrate doesn't expose
 * `gh run view --log` yet, so we keep the shell-out.
 */
export function getWorkflowLogs(ownerRepo: string, runId: number, lines = 50): string {
  try {
    return cp.execSync(
      `gh run view ${runId} --repo "${ownerRepo}" --log 2>&1 | tail -${lines}`,
      { timeout: 30_000 },
    ).toString().trim();
  } catch { return '(could not fetch workflow logs)'; }
}

/**
 * "Blocking" runs are those that:
 *   1. queued OR in_progress, AND
 *   2. created after `notBefore` (default: call-time minus 60s lookback), AND
 *   3. last updated within `stuckAfterMs` (default 120s).
 * Filters out pre-session runs and orphaned in_progress runs left behind
 * when self-hosted runners auto-update mid-job.
 */
export function isInFlight(
  r: { status: string; createdAt?: string; updatedAt?: string },
  notBefore: number,
  stuckAfterMs: number,
): boolean {
  if (r.status !== 'queued' && r.status !== 'in_progress') return false;
  const created = r.createdAt ? Date.parse(r.createdAt) : NaN;
  if (Number.isFinite(created) && created < notBefore) return false;
  const updated = r.updatedAt ? Date.parse(r.updatedAt) : NaN;
  if (Number.isFinite(updated) && Date.now() - updated > stuckAfterMs) return false;
  return true;
}

export async function waitForRunnerIdle(
  ownerRepo: string,
  timeoutMs = 300_000,
  opts: { notBefore?: number; stuckAfterMs?: number } = {},
): Promise<void> {
  const startTime = Date.now();
  const notBefore = opts.notBefore ?? (startTime - 60_000);
  const stuckAfterMs = opts.stuckAfterMs ?? 120_000;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const runs = await listWorkflowRuns(ownerRepo, 25);
      const blocking = runs.filter((r) => isInFlight(r, notBefore, stuckAfterMs));
      if (blocking.length === 0) { return; }
    } catch {}
    await delay(10_000);
  }
}
