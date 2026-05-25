/**
 * Python Dev Loop – Shared Helpers
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
import * as lib from '../lib';
// Re-export shared retry-aware cleanup helpers so callers that already
// import them from ./helpers don't have to change.
export { forceDeleteLakebaseProject, forceDeleteGithubRepo, saveFailedCiRunLogs } from '../lib';
export type { WorkflowRunResult, WaitForWorkflowOptions } from '../lib';
import { GitService } from '../../../src/services/gitService';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { ScaffoldService } from '../../../src/services/scaffoldService';
import { ProjectCreationService, ProjectCreationInput } from '../../../src/services/projectCreationService';
import { applyMigrations as substrateApplyMigrations } from '@databricks-solutions/lakebase-app-dev-kit';

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
  /**
   * The long-running branch this scenario PRs into. Two-tier suites set
   * 'staging'; three-tier suites would set 'dev'. Scenarios never hardcode
   * 'main' or 'staging' - they pass ctx.baseBranch to waitForWorkflowRun
   * and pullBaseBranch. See docs/two-tier-e2e-promotion-plan.md.
   */
  baseBranch: string;
}

// ── Shell helpers ────────────────────────────────────────────────────

/** Run a git command in the project directory. Timeout is generous (5 min)
 *  because checkout fires the post-checkout hook, which provisions/refreshes
 *  the Lakebase branch + endpoint + credentials. Aggressive timeouts here
 *  killed the hook mid-flight before it could write .env. */
export function git(ctx: ScenarioContext, cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: ctx.projectDir, timeout: 300000 }).toString().trim();
}

/** Poll <projectDir>/.env until LAKEBASE_BRANCH_ID matches the expected
 *  value. Used after `git checkout` to gate scenario steps on the
 *  post-checkout hook actually finishing its .env write. */
export async function waitForEnvBranchId(
  ctx: ScenarioContext,
  expectedBranchId: string,
  timeoutMs = 180000,
): Promise<void> {
  const envPath = path.join(ctx.projectDir, '.env');
  const deadline = Date.now() + timeoutMs;
  let last = '<unset>';
  while (Date.now() < deadline) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const m = content.match(/^LAKEBASE_BRANCH_ID=(.*)$/m);
      last = m ? (m[1].trim() || '<empty>') : '<unset>';
      if (last === expectedBranchId) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Timed out after ${timeoutMs / 1000}s waiting for ` +
    `.env LAKEBASE_BRANCH_ID=${expectedBranchId} (last seen: '${last}'). ` +
    `The post-checkout hook either didn't fire or failed before writing .env.`,
  );
}

/** Sanitize a git branch name to the Lakebase branch ID the hook will use. */
function sanitizeForLakebase(gitBranch: string): string {
  return gitBranch.replace(/\//g, '-').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
}

/** Run a shell command in the project directory */
export function shell(ctx: ScenarioContext, cmd: string, timeout = 30000): string {
  return cp.execSync(cmd, {
    cwd: ctx.projectDir,
    timeout,
    env: { ...process.env, DATABRICKS_HOST: ctx.dbHost },
  }).toString().trim();
}

// ── Lakebase helpers ─────────────────────────────────────────────────

/**
 * Print the .env values that drive the wrapper's parent-branch resolution.
 * Run right before any createBranch call so a debugger can tell at a
 * glance whether the post-checkout hook left .env in the expected shape.
 * Only the non-secret fields - never the JWT.
 */
function logEnvBeforeBranch(ctx: ScenarioContext, newBranchName: string): void {
  const envPath = path.join(ctx.projectDir, '.env');
  let projectId = '<unset>';
  let branchId = '<unset>';
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^(LAKEBASE_PROJECT_ID|LAKEBASE_BRANCH_ID)=(.*)$/);
      if (m) {
        if (m[1] === 'LAKEBASE_PROJECT_ID') projectId = m[2] || '<empty>';
        if (m[1] === 'LAKEBASE_BRANCH_ID') branchId = m[2] || '<empty>';
      }
    }
  } else {
    projectId = '<no .env file>';
    branchId = '<no .env file>';
  }
  const headBranch = git(ctx, 'rev-parse --abbrev-ref HEAD');
  console.log(
    `    [env-before-branch] new='${newBranchName}', git HEAD='${headBranch}', ` +
    `.env LAKEBASE_PROJECT_ID='${projectId}', LAKEBASE_BRANCH_ID='${branchId}'`,
  );
}

/**
 * Create a Lakebase database branch and write Python-style .env connection.
 * Uses DATABASE_URL (not SPRING_DATASOURCE_*).
 */
export async function createLakebaseBranchAndConnect(
  ctx: ScenarioContext,
  gitBranchName: string,
): Promise<{ branchId: string; host: string; username: string }> {
  // Use the actual LakebaseService methods - exactly the call shape the
  // VS Code extension makes when a user clicks "Create branch" in the UI.
  // The wrapper reads the current Lakebase branch from <projectDir>/.env
  // (kept current by the post-checkout hook), which getEnvConfig() resolves
  // via getWorkspaceRoot(). The test's before() block sets
  // process.env.LAKEBASE_PROJECT_DIR = ctx.projectDir so the wrapper finds
  // the same .env that VS Code's open-folder would supply.
  logEnvBeforeBranch(ctx, gitBranchName);
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
export async function createFeatureBranch(ctx: ScenarioContext, branchName: string): Promise<void> {
  // Branch off ctx.baseBranch. After each checkout, wait for the
  // post-checkout hook to update .env so the next operation reads the
  // correct LAKEBASE_BRANCH_ID. See ecommerce/helpers.ts for rationale.
  const base = ctx.baseBranch;
  const current = git(ctx, 'rev-parse --abbrev-ref HEAD');
  if (current !== base) {
    try { git(ctx, `checkout ${base}`); } catch { git(ctx, `branch -M ${base}`); }
    await waitForEnvBranchId(ctx, sanitizeForLakebase(base));
  }
  git(ctx, `pull origin ${base}`);
  git(ctx, `checkout -b ${branchName}`);
  await waitForEnvBranchId(ctx, sanitizeForLakebase(branchName));
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

/** Parse LAKEBASE_BRANCH_ID out of the project's .env (written by the
 *  post-checkout hook). Throws with a clear message when missing - the
 *  substrate's applyMigrations needs an explicit branch. */
function readBranchFromEnv(projectDir: string): string {
  const envPath = path.join(projectDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Expected ${envPath} to exist; the post-checkout hook should have written it.`);
  }
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*LAKEBASE_BRANCH_ID\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error(`LAKEBASE_BRANCH_ID not found in ${envPath}.`);
}

/**
 * Apply Alembic migrations via the substrate (FEIP-7091), then run
 * pytest against the live Lakebase branch database. Replaces the prior
 * `uv run alembic upgrade head` shell-out so the e2e test exercises
 * the substrate's `applyMigrations` end-to-end.
 *
 * pytest stays as a separate shell because it isn't a migration concern
 * and needs the .env-derived DATABASE_URL the existing `source .env`
 * pattern provides.
 */
export async function runAlembicAndTests(
  ctx: ScenarioContext,
  timeoutMs = 120000
): Promise<string> {
  const branch = readBranchFromEnv(ctx.projectDir);
  const priorHost = process.env.DATABRICKS_HOST;
  const priorPath = process.env.PATH;
  process.env.DATABRICKS_HOST = ctx.dbHost;
  // The substrate spawns `alembic` from PATH. ProjectCreationService /
  // `uv sync` installed alembic into <projectDir>/.venv/bin; prepend it
  // so the spawn resolves to the per-project venv (same path `uv run`
  // would have used).
  const venvBin = path.join(ctx.projectDir, '.venv', 'bin');
  process.env.PATH = `${venvBin}:${priorPath ?? ''}`;
  try {
    const applied = await substrateApplyMigrations({
      instance: ctx.projectName,
      branch,
      projectDir: ctx.projectDir,
    });
    console.log(`    [substrate] Alembic applied: ${applied.applied.length} migration(s).`);
  } finally {
    if (priorHost === undefined) delete process.env.DATABRICKS_HOST;
    else process.env.DATABRICKS_HOST = priorHost;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
  try {
    const output = cp.execSync(
      `bash -c 'set -a; source .env; set +a; uv run pytest tests/ -x -q 2>&1'`,
      { cwd: ctx.projectDir, timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: ctx.dbHost } }
    ).toString();
    console.log('    [uv] pytest passed.');
    return output;
  } catch (err: any) {
    const output = err.stdout?.toString() || err.stderr?.toString() || err.message;
    const lastLines = output.split('\n').slice(-60).join('\n');
    throw new Error(`pytest failed. Last 60 lines:\n${lastLines}`);
  }
}

/** A6: Stage, commit, and push */
export function commitAndPush(ctx: ScenarioContext, message: string, branchName: string): void {
  git(ctx, 'add -A');
  git(ctx, `commit -m "${message}"`);
  git(ctx, `push -u origin ${branchName}`);
}

// ── Phase B/C: PR + Merge ────────────────────────────────────────────

/**
 * Create a PR; returns the PR number. Defaults to ctx.baseBranch so
 * scenario PRs target the suite's configured base tier. Promotion PRs
 * go through the release primitive in lib/staging-promotion.ts.
 */
export const createPR = (
  ctx: ScenarioContext,
  title: string,
  branchName: string,
  baseBranch?: string,
): Promise<number> =>
  lib.createPR(ctx.fullRepoName, title, branchName, 'Automated Python devloop test', baseBranch ?? ctx.baseBranch);

/** Merge a PR (merge-commit, deletes the remote head branch). */
export const mergePR = (ctx: ScenarioContext, prNumber: number): Promise<void> =>
  lib.mergePR(ctx.fullRepoName, prNumber);

/**
 * Update the local working tree after a scenario PR merges into its base
 * branch. Two-tier suites resolve ctx.baseBranch to 'staging'; N-tier
 * suites resolve it to whatever tier this scenario was targeting. The
 * helper is tier-agnostic; the call site is what's parameterized.
 */
export function pullBaseBranch(ctx: ScenarioContext): void {
  git(ctx, `checkout ${ctx.baseBranch}`);
  git(ctx, `pull origin ${ctx.baseBranch}`);
}

/** Get PR comment bodies. */
export const getPRComments = (ctx: ScenarioContext, prNumber: number): Promise<string[]> =>
  lib.getPRComments(ctx.fullRepoName, prNumber);

/** Delete the feature branch locally and remotely */
export function cleanupBranch(ctx: ScenarioContext, branchName: string): void {
  // Hop off the feature branch onto the tier we PR'd into. ctx.baseBranch
  // is the suite's configured tier (two-tier: 'staging').
  try { git(ctx, `checkout ${ctx.baseBranch}`); } catch {}
  try { git(ctx, `branch -D ${branchName}`); } catch {}
  try { git(ctx, `push origin --delete ${branchName}`); } catch {}
}

// ── Workflow polling (delegated to lib) ──────────────────────────────

export const getLatestRunId = (ctx: ScenarioContext, workflowFile: string): Promise<number> =>
  lib.getLatestRunId(ctx.fullRepoName, workflowFile);

export const waitForWorkflowRun = (ctx: ScenarioContext, workflowFile: string, opts: lib.WaitForWorkflowOptions = {}): Promise<lib.WorkflowRunResult> =>
  lib.waitForWorkflowRun(ctx.fullRepoName, workflowFile, opts);

export const getWorkflowLogs = (ctx: ScenarioContext, runId: number, lines = 50): string =>
  lib.getWorkflowLogs(ctx.fullRepoName, runId, lines);

export const waitForRunnerIdle = (ctx: ScenarioContext, timeoutMs = 300000, opts: { notBefore?: number; stuckAfterMs?: number } = {}): Promise<void> =>
  lib.waitForRunnerIdle(ctx.fullRepoName, timeoutMs, opts);


// ── Phase D: Verification (staging by default, Step E asserts against prod) ──

/**
 * Run a SQL query on a named Lakebase branch. Two-tier flow: Phase D
 * asserts the merge landed on STAGING. Step E asserts prod via
 * branch='default'.
 */
export const queryBranch = (ctx: ScenarioContext, branch: string, sql: string): Promise<string> =>
  lib.queryBranch(ctx.projectName, branch, sql);

/** Query the project's prod (default) Lakebase branch. Used by Final
 *  Verification after all releases have promoted up the chain. */
export const queryProduction = (ctx: ScenarioContext, sql: string): Promise<string> =>
  lib.queryProduction(ctx.projectName, sql);

/** Verify a table exists on the branch where the scenario's merge lands
 *  (defaults to ctx.baseBranch). */
export async function verifyTableExists(
  ctx: ScenarioContext,
  tableName: string,
  branch?: string,
): Promise<boolean> {
  const target = branch ?? ctx.baseBranch;
  const result = await queryBranch(ctx, target, `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='${tableName}');`);
  return result === 't';
}

/** Verify a table does NOT exist on the branch (defaults to ctx.baseBranch). */
export async function verifyTableNotExists(
  ctx: ScenarioContext,
  tableName: string,
  branch?: string,
): Promise<boolean> {
  return !(await verifyTableExists(ctx, tableName, branch));
}

/** Verify a column exists on a table on the branch (defaults to ctx.baseBranch). */
export async function verifyColumnExists(
  ctx: ScenarioContext,
  tableName: string,
  columnName: string,
  branch?: string,
): Promise<boolean> {
  const target = branch ?? ctx.baseBranch;
  const result = await queryBranch(ctx, target, `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${tableName}' AND column_name='${columnName}');`);
  return result === 't';
}

/** Verify a column does NOT exist on the branch (defaults to ctx.baseBranch). */
export async function verifyColumnNotExists(
  ctx: ScenarioContext,
  tableName: string,
  columnName: string,
  branch?: string,
): Promise<boolean> {
  return !(await verifyColumnExists(ctx, tableName, columnName, branch));
}

/** Verify an Alembic migration was applied on the branch (defaults to ctx.baseBranch). */
export async function verifyAlembicVersion(
  ctx: ScenarioContext,
  revision: string,
  branch?: string,
): Promise<boolean> {
  const target = branch ?? ctx.baseBranch;
  const result = await queryBranch(ctx, target, `SELECT EXISTS (SELECT 1 FROM alembic_version WHERE version_num='${revision}');`);
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
