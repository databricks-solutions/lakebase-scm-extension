/**
 * Python Dev Loop — Shared Helpers
 *
 * Common functions for the Python/React integration test scenarios.
 * Wraps git, gh, Lakebase CLI, Alembic, uv, and psql operations.
 *
 * Service-layer routing follows the same strategy as the e-commerce helpers:
 * LakebaseService methods for Lakebase operations (with host/project-ID overrides),
 * direct CLI calls for git/gh/psql (needs explicit cwd targeting).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import {
  getConnection, getDefaultBranch,
  createPullRequest, mergePullRequest, listIssueComments, listWorkflowRuns,
} from '@databricks-solutions/lakebase-scm-workflow-scripts';
import { GitService } from '../../../src/services/gitService';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { ScaffoldService } from '../../../src/services/scaffoldService';
import { ProjectCreationService, ProjectCreationInput } from '../../../src/services/projectCreationService';

// ── Context shared across all scenarios ──────────────────────────────

export interface ScenarioContext {
  projectName: string;
  projectDir: string;
  ghUser: string;
  fullRepoName: string;
  dbHost: string;
  gitService: GitService;
  lakebaseService: LakebaseService;
  scaffoldService: ScaffoldService;
  creationService: ProjectCreationService;
  input: ProjectCreationInput;
  /** Tracks the next Alembic revision number (starts at 2, since 001 is the placeholder) */
  nextRevision: number;
}

// ── Shell helpers ────────────────────────────────────────────────────

/** Run a git command in the project directory */
export function git(ctx: ScenarioContext, cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: ctx.projectDir, timeout: 30000 }).toString().trim();
}

/** Run a shell command in the project directory */
export function shell(ctx: ScenarioContext, cmd: string, timeout = 30000): string {
  return cp.execSync(cmd, {
    cwd: ctx.projectDir,
    timeout,
    env: { ...process.env, DATABRICKS_HOST: ctx.dbHost },
  }).toString().trim();
}

// Format a query result row the way psql `-t -A` did: field separator '|',
// row separator newline, no header, booleans as 't'/'f', nulls empty. Keeping
// this shape so verifyTableExists / verifyAlembicVersion etc. can keep their
// `result === 't'` checks unchanged.
function formatPsqlCompatRows(rows: Array<Record<string, unknown>>, fields: Array<{ name: string }>): string {
  return rows
    .map((row) =>
      fields
        .map((f) => {
          const v = row[f.name];
          if (v === null || v === undefined) return '';
          if (v === true) return 't';
          if (v === false) return 'f';
          return String(v);
        })
        .join('|'),
    )
    .join('\n')
    .trim();
}

// ── Lakebase helpers ─────────────────────────────────────────────────

/**
 * Create a Lakebase database branch and write Python-style .env connection.
 * Uses DATABASE_URL (not SPRING_DATASOURCE_*).
 */
export async function createLakebaseBranchAndConnect(
  ctx: ScenarioContext,
  gitBranchName: string,
): Promise<{ branchId: string; host: string; username: string }> {
  const branch = await ctx.lakebaseService.createBranch(gitBranchName);
  if (!branch) {
    throw new Error(`LakebaseService.createBranch('${gitBranchName}') returned undefined`);
  }

  const ep = await ctx.lakebaseService.getEndpoint(branch.uid);
  if (!ep?.host) {
    throw new Error(`LakebaseService.getEndpoint('${branch.uid}') returned no host`);
  }

  const cred = await ctx.lakebaseService.getCredential(branch.uid);
  if (!cred.token || !cred.email) {
    throw new Error(`LakebaseService.getCredential('${branch.uid}') returned empty credentials`);
  }

  const dbName = 'databricks_postgres';
  const dbUrl = `postgresql+psycopg://${encodeURIComponent(cred.email)}:${encodeURIComponent(cred.token)}@${ep.host}:5432/${dbName}?sslmode=require`;

  const envPath = path.join(ctx.projectDir, '.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

  // Remove existing connection vars
  envContent = envContent
    .split('\n')
    .filter(l =>
      !l.startsWith('DATABASE_URL=') &&
      !l.startsWith('DB_USERNAME=') &&
      !l.startsWith('DB_PASSWORD=') &&
      !l.startsWith('LAKEBASE_HOST=') &&
      !l.startsWith('LAKEBASE_BRANCH_ID=')
    )
    .join('\n');

  envContent += [
    '',
    `DATABASE_URL=${dbUrl}`,
    `DB_USERNAME=${cred.email}`,
    `DB_PASSWORD=${cred.token}`,
    `LAKEBASE_HOST=${ep.host}`,
    `LAKEBASE_BRANCH_ID=${branch.branchId}`,
    '',
  ].join('\n');
  fs.writeFileSync(envPath, envContent);

  return { branchId: branch.branchId, host: ep.host, username: cred.email };
}

/** Verify that .env has a DATABASE_URL set */
export function verifyBranchConnection(ctx: ScenarioContext): { url: string } {
  const envPath = path.join(ctx.projectDir, '.env');
  if (!fs.existsSync(envPath)) { throw new Error('.env not found'); }
  const content = fs.readFileSync(envPath, 'utf-8');
  const match = content.match(/^DATABASE_URL=(.+)$/m);
  if (!match || !match[1]) { throw new Error('DATABASE_URL not set in .env'); }
  return { url: match[1] };
}

// ── Phase A: Developer (Local) ───────────────────────────────────────

/** A1a: Create a git feature branch from main */
export function createFeatureBranch(ctx: ScenarioContext, branchName: string): void {
  const current = git(ctx, 'rev-parse --abbrev-ref HEAD');
  if (current !== 'main') {
    try { git(ctx, 'checkout main'); } catch { git(ctx, 'branch -M main'); }
  }
  git(ctx, 'pull origin main');
  git(ctx, `checkout -b ${branchName}`);
}

/** Write a Python source file (relative to project root) */
export function writePythonFile(ctx: ScenarioContext, relativePath: string, content: string): void {
  const fullPath = path.join(ctx.projectDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/** Delete a file from the project */
export function deleteFile(ctx: ScenarioContext, relativePath: string): void {
  const fullPath = path.join(ctx.projectDir, relativePath);
  if (fs.existsSync(fullPath)) { fs.unlinkSync(fullPath); }
}

/**
 * Write an Alembic migration file.
 * Uses a zero-padded revision number (e.g., 002, 003) for deterministic ordering.
 * Returns the filename.
 */
export function writeAlembicMigration(
  ctx: ScenarioContext,
  revisionNumber: number,
  slug: string,
  upgradeSql: string,
  downgradeSql: string,
): string {
  const rev = String(revisionNumber).padStart(3, '0');
  const prevRev = String(revisionNumber - 1).padStart(3, '0');
  const filename = `${rev}_${slug}.py`;
  const content = `"""${slug.replace(/_/g, ' ')}

Revision ID: ${rev}
Revises: ${prevRev}
Create Date: auto
"""
from alembic import op
import sqlalchemy as sa

revision = '${rev}'
down_revision = '${prevRev}'
branch_labels = None
depends_on = None


def upgrade() -> None:
    ${upgradeSql.split('\n').join('\n    ')}


def downgrade() -> None:
    ${downgradeSql.split('\n').join('\n    ')}
`;
  const migDir = path.join(ctx.projectDir, 'alembic', 'versions');
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(path.join(migDir, filename), content);
  return filename;
}

/**
 * Run Alembic migrations and pytest against the live Lakebase branch database.
 * Sources .env, runs `uv run alembic upgrade head`, then `uv run pytest`.
 */
export function runAlembicAndTests(ctx: ScenarioContext, timeoutMs = 120000): string {
  try {
    const output = cp.execSync(
      `bash -c 'set -a; source .env; set +a; uv run alembic upgrade head 2>&1 && uv run pytest tests/ -x -q 2>&1'`,
      { cwd: ctx.projectDir, timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: ctx.dbHost } }
    ).toString();
    console.log('    [uv] Alembic + pytest passed.');
    return output;
  } catch (err: any) {
    const output = err.stdout?.toString() || err.stderr?.toString() || err.message;
    const lastLines = output.split('\n').slice(-60).join('\n');
    throw new Error(`Alembic/pytest failed. Last 60 lines:\n${lastLines}`);
  }
}

/** A6: Stage, commit, and push */
export function commitAndPush(ctx: ScenarioContext, message: string, branchName: string): void {
  git(ctx, 'add -A');
  git(ctx, `commit -m "${message}"`);
  git(ctx, `push -u origin ${branchName}`);
}

// ── Phase B/C: PR + Merge ────────────────────────────────────────────

/** Create a PR via substrate octokit; returns the PR number. */
export async function createPR(ctx: ScenarioContext, title: string, branchName: string): Promise<number> {
  const url = await createPullRequest({
    ownerRepo: ctx.fullRepoName,
    headBranch: branchName,
    title,
    body: 'Automated Python devloop test',
    baseBranch: 'main',
  });
  const match = url.match(/\/pull\/(\d+)/);
  if (!match) { throw new Error(`Could not extract PR number from: ${url}`); }
  return parseInt(match[1], 10);
}

/** Merge a PR via substrate octokit (admin/merge-commit). */
export async function mergePR(ctx: ScenarioContext, prNumber: number): Promise<void> {
  await mergePullRequest({
    ownerRepo: ctx.fullRepoName,
    pullNumber: prNumber,
    method: 'merge',
    deleteRemoteBranch: true,
  });
}

/** Update local main after merge */
export function pullMain(ctx: ScenarioContext): void {
  git(ctx, 'checkout main');
  git(ctx, 'pull origin main');
}

/** Get PR comment bodies via substrate octokit. */
export async function getPRComments(ctx: ScenarioContext, prNumber: number): Promise<string[]> {
  return listIssueComments(ctx.fullRepoName, prNumber);
}

/** Delete the feature branch locally and remotely */
export function cleanupBranch(ctx: ScenarioContext, branchName: string): void {
  try { git(ctx, 'checkout main'); } catch {}
  try { git(ctx, `branch -D ${branchName}`); } catch {}
  try { git(ctx, `push origin --delete ${branchName}`); } catch {}
}

// ── Workflow polling ─────────────────────────────────────────────────

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

// Substrate's listWorkflowRuns is repo-wide (no workflow-file filter), so we
// filter the returned list locally by matching the run's `name` against the
// workflow file's basename (e.g. "pr.yml" matches a workflow named "pr"). We
// fall back to substring match on filename for resilience.
function matchesWorkflowFile(run: { name: string }, workflowFile: string): boolean {
  const stem = workflowFile.replace(/\.ya?ml$/i, '');
  return run.name === stem || run.name.toLowerCase() === stem.toLowerCase() ||
         run.name.includes(stem);
}

export async function getLatestRunId(ctx: ScenarioContext, workflowFile: string): Promise<number> {
  try {
    const runs = await listWorkflowRuns(ctx.fullRepoName, 25);
    const match = runs.find((r) => matchesWorkflowFile(r, workflowFile));
    return match ? match.id : 0;
  } catch { return 0; }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForWorkflowRun(
  ctx: ScenarioContext,
  workflowFile: string,
  opts: WaitForWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  const timeoutMs = opts.timeoutMs ?? 360000;
  const pollIntervalMs = opts.pollIntervalMs ?? 15000;
  const afterRunId = opts.afterRunId ?? 0;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const runs = await listWorkflowRuns(ctx.fullRepoName, 25);
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
    `(branch: ${opts.branch || 'any'}, event: ${opts.event || 'any'}, afterRunId: ${afterRunId})`
  );
}

export function getWorkflowLogs(ctx: ScenarioContext, runId: number, lines = 50): string {
  try {
    return cp.execSync(
      `gh run view ${runId} --repo "${ctx.fullRepoName}" --log 2>&1 | tail -${lines}`,
      { timeout: 30000 }
    ).toString().trim();
  } catch { return '(could not fetch workflow logs)'; }
}

// A run is "blocking the next scenario" only if it was created (or last
// updated) after `notBefore` — typically the test session's start time, or
// the wall-clock when we kicked off the most recent scenario. Anything older
// is either pre-existing or orphaned (e.g. the self-hosted runner auto-
// updated mid-test and dropped a job into in_progress purgatory).
function isInFlight(r: { status: string; createdAt?: string; updatedAt?: string }, notBefore: number, stuckAfterMs: number): boolean {
  if (r.status !== 'queued' && r.status !== 'in_progress') return false;
  const created = r.createdAt ? Date.parse(r.createdAt) : NaN;
  if (Number.isFinite(created) && created < notBefore) return false; // pre-session, ignore
  const updated = r.updatedAt ? Date.parse(r.updatedAt) : NaN;
  if (Number.isFinite(updated) && Date.now() - updated > stuckAfterMs) return false; // stuck/orphaned, ignore
  return true;
}

export async function waitForRunnerIdle(
  ctx: ScenarioContext,
  timeoutMs = 300000,
  opts: { notBefore?: number; stuckAfterMs?: number } = {},
): Promise<void> {
  const startTime = Date.now();
  // Default cutoff: ignore runs created before the helper was called minus a
  // small lookback (handles the case where the scenario just pushed and the
  // run shows up in the API a second or two later).
  const notBefore = opts.notBefore ?? (startTime - 60_000);
  const stuckAfterMs = opts.stuckAfterMs ?? 120_000;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const runs = await listWorkflowRuns(ctx.fullRepoName, 25);
      const blocking = runs.filter((r) => isInFlight(r, notBefore, stuckAfterMs));
      if (blocking.length === 0) { return; }
    } catch {}
    await delay(10000);
  }
}

// ── Phase D: Production Verification ─────────────────────────────────

/** Run a SQL query on the production database via the substrate pg.Pool. */
export async function queryProduction(ctx: ScenarioContext, sql: string): Promise<string> {
  const def = await getDefaultBranch({ instance: ctx.projectName });
  if (!def) { throw new Error('No default Lakebase branch found'); }
  // getDefaultBranch.uid is the system ID (br-foo-xxx); getConnection's
  // `branch` arg is the human-readable branch name (the path tail of .name,
  // e.g. "production"). Passing uid causes "branch id not found".
  const branchName = def.name.split('/').pop()!;
  const pool = await getConnection({ instance: ctx.projectName, branch: branchName, output: 'pool' });
  try {
    const result = await pool.query(sql);
    return formatPsqlCompatRows(result.rows, result.fields as Array<{ name: string }>);
  } finally {
    await pool.end();
  }
}

/** Verify a table exists on production */
export async function verifyTableExists(ctx: ScenarioContext, tableName: string): Promise<boolean> {
  const result = await queryProduction(ctx, `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='${tableName}');`);
  return result === 't';
}

/** Verify a table does NOT exist on production */
export async function verifyTableNotExists(ctx: ScenarioContext, tableName: string): Promise<boolean> {
  return !(await verifyTableExists(ctx, tableName));
}

/** Verify a column exists on production */
export async function verifyColumnExists(ctx: ScenarioContext, tableName: string, columnName: string): Promise<boolean> {
  const result = await queryProduction(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${tableName}' AND column_name='${columnName}');`);
  return result === 't';
}

/** Verify a column does NOT exist on production */
export async function verifyColumnNotExists(ctx: ScenarioContext, tableName: string, columnName: string): Promise<boolean> {
  return !(await verifyColumnExists(ctx, tableName, columnName));
}

/** Verify an Alembic migration was applied (exists in alembic_version) */
export async function verifyAlembicVersion(ctx: ScenarioContext, revision: string): Promise<boolean> {
  const result = await queryProduction(ctx, `SELECT EXISTS (SELECT 1 FROM alembic_version WHERE version_num='${revision}');`);
  return result === 't';
}

/** Verify a file exists on the GitHub repo's main branch */
export function verifyFileOnGitHub(ctx: ScenarioContext, filePath: string): boolean {
  try {
    cp.execSync(
      `gh api "repos/${ctx.fullRepoName}/contents/${filePath}" --jq '.name'`,
      { timeout: 15000 }
    );
    return true;
  } catch { return false; }
}

/** Delete a Lakebase branch (non-fatal if not found) */
export async function deleteLakebaseBranch(ctx: ScenarioContext, branchName: string): Promise<void> {
  try { await ctx.lakebaseService.deleteBranch(branchName); } catch {}
}
