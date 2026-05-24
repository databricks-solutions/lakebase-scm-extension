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

/** Create a PR; returns the PR number. */
export const createPR = (ctx: ScenarioContext, title: string, branchName: string): Promise<number> =>
  lib.createPR(ctx.fullRepoName, title, branchName, 'Automated Python devloop test');

/** Merge a PR (merge-commit, deletes the remote head branch). */
export const mergePR = (ctx: ScenarioContext, prNumber: number): Promise<void> =>
  lib.mergePR(ctx.fullRepoName, prNumber);

/** Update local main after merge */
export function pullMain(ctx: ScenarioContext): void {
  git(ctx, 'checkout main');
  git(ctx, 'pull origin main');
}

/** Get PR comment bodies. */
export const getPRComments = (ctx: ScenarioContext, prNumber: number): Promise<string[]> =>
  lib.getPRComments(ctx.fullRepoName, prNumber);

/** Delete the feature branch locally and remotely */
export function cleanupBranch(ctx: ScenarioContext, branchName: string): void {
  try { git(ctx, 'checkout main'); } catch {}
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


// ── Phase D: Production Verification ─────────────────────────────────

/** Run a SQL query on the production database via lib (substrate pg.Pool). */
export const queryProduction = (ctx: ScenarioContext, sql: string): Promise<string> =>
  lib.queryProduction(ctx.projectName, sql);

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
