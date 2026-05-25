/**
 * E-Commerce Scenario – Shared Helpers
 *
 * Common functions used by all 8 scenario files. Wraps git, gh, Lakebase CLI,
 * and psql operations so each scenario reads like a script.
 *
 * ── Service-layer routing strategy ──────────────────────────────────────
 *
 * LakebaseService methods (createBranch, deleteBranch, getEndpoint, getCredential,
 * getDefaultBranch, etc.) work correctly in the test harness because the service
 * accepts host and project-ID overrides via setHostOverride / setProjectIdOverride,
 * which the test setup configures. We route through LakebaseService wherever possible
 * so the integration tests exercise the same code paths as the VS Code extension.
 *
 * GitService methods (getGitRoot, getCurrentBranch, etc.) cannot be used here because
 * they call getWorkspaceRoot() which returns the VS Code workspace root – not the
 * temporary test project directory. There is no cwd override on GitService, so git
 * operations use the local `git()` helper with explicit `cwd: ctx.projectDir`.
 *
 * Direct CLI calls (gh, psql) are kept for the same reason – they need to target
 * the test project's repo / connection, not the VS Code workspace.
 * ────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as lib from '../lib';
export { forceDeleteLakebaseProject, forceDeleteGithubRepo, saveFailedCiRunLogs } from '../lib';
export type { WorkflowRunResult, WaitForWorkflowOptions } from '../lib';
import { GitService } from '../../../src/services/gitService';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { ScaffoldService } from '../../../src/services/scaffoldService';
import { ProjectCreationService, ProjectCreationInput } from '../../../src/services/projectCreationService';
import { SchemaMigrationService } from '../../../src/services/schemaMigrationService';
import {
  applyMigrations as substrateApplyMigrations,
  migrationStatus as substrateMigrationStatus,
} from '@databricks-solutions/lakebase-app-dev-kit';

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
  // The long-running branch this scenario PRs into. Two-tier suites set
  // 'staging'; three-tier suites would set 'dev'. Scenarios never hardcode
  // 'main' or 'staging' - they pass ctx.baseBranch to waitForWorkflowRun
  // and pullBaseBranch. See docs/two-tier-e2e-promotion-plan.md.
  baseBranch: string;
}

// ── Pause gate ──────────────────────────────────────────────────────
// Pause formats:
//   ECOM_PAUSE_AT=A5          → pause at A5 in every scenario
//   ECOM_PAUSE_AT=7:A3        → pause at A3 only in Scenario 7
//   echo 8:B2 > /tmp/ecom-pause-at  → change mid-run
// Resume: touch /tmp/ecom-continue

const PAUSE_FILE = '/tmp/ecom-pause-at';
const CONTINUE_SIGNAL = '/tmp/ecom-continue';

// Initialize pause file from env var if set
if (process.env.ECOM_PAUSE_AT) {
  fs.writeFileSync(PAUSE_FILE, process.env.ECOM_PAUSE_AT);
}

// Track current scenario number (set by each scenario's afterEach via pauseIfRequested)
let _currentScenario = 0;

function getCurrentPauseTarget(): { scenario?: number; step: string } | null {
  try {
    const raw = fs.readFileSync(PAUSE_FILE, 'utf-8').trim();
    if (!raw) { return null; }
    const colonIdx = raw.indexOf(':');
    if (colonIdx > 0) {
      return { scenario: parseInt(raw.substring(0, colonIdx), 10), step: raw.substring(colonIdx + 1) };
    }
    return { step: raw };
  } catch { return null; }
}

/** Set the current scenario number (call from each scenario file) */
export function setCurrentScenario(n: number): void { _currentScenario = n; }

/**
 * Call after each test step. If the pause target matches, pause and wait.
 * Supports scenario-qualified targets like "7:A3".
 */
export function pauseIfRequested(stepName: string, ctx?: ScenarioContext): void {
  const target = getCurrentPauseTarget();
  if (!target) { return; }
  // Check scenario qualifier
  if (target.scenario !== undefined && target.scenario !== _currentScenario) { return; }
  // Check step name match
  if (!stepName.startsWith(target.step)) { return; }
  // Remove stale signal file
  try { fs.unlinkSync(CONTINUE_SIGNAL); } catch {}
  console.log(`\n    ════════════════════════════════════════════════════`);
  console.log(`    PAUSED after ${stepName}`);
  if (ctx) {
    console.log(`    Project: ${ctx.projectName}`);
    console.log(`    Dir: ${ctx.projectDir}`);
    console.log(`    GitHub: https://github.com/${ctx.fullRepoName}`);
    console.log(`    Lakebase: ${ctx.projectName}`);
  }
  console.log(`    To continue:  touch ${CONTINUE_SIGNAL}`);
  console.log(`    To set next:  echo B3 > ${PAUSE_FILE}`);
  console.log(`    ════════════════════════════════════════════════════\n`);
  // Poll for signal file (check every 2 seconds, up to 1 hour)
  for (let i = 0; i < 1800; i++) {
    if (fs.existsSync(CONTINUE_SIGNAL)) {
      try { fs.unlinkSync(CONTINUE_SIGNAL); } catch {}
      console.log(`    Resuming...\n`);
      return;
    }
    cp.execSync('sleep 2');
  }
  throw new Error(`Timed out waiting for ${CONTINUE_SIGNAL} after 1 hour`);
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
// ── Lakebase helpers (routed through substrate via ../lib) ──────────

// ── Phase A: Developer (Local) ───────────────────────────────────────

/** A1a: Create a git feature branch from main (just the git operation). */
export function createFeatureBranch(ctx: ScenarioContext, branchName: string): void {
  const current = git(ctx, 'rev-parse --abbrev-ref HEAD');
  if (current !== 'main') {
    try {
      git(ctx, 'checkout main');
    } catch {
      git(ctx, 'branch -M main');
    }
  }
  git(ctx, 'pull origin main');
  git(ctx, `checkout -b ${branchName}`);
}

/**
 * A1b: Create a Lakebase database branch and connect .env to it.
 * Exercises the actual extension service methods:
 *   LakebaseService.createBranch() → waitForBranchReady() → getEndpoint() → getCredential()
 * Then writes SPRING_DATASOURCE_URL/USERNAME/PASSWORD to .env + application-local.properties.
 * Returns the branch info for verification.
 */
export async function createLakebaseBranchAndConnect(
  ctx: ScenarioContext,
  gitBranchName: string,
): Promise<{ branchId: string; host: string; username: string }> {
  // Use the actual LakebaseService methods – this is what the extension does
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

  // Write connection to .env (same as post-checkout hook does)
  const dbName = 'databricks_postgres';
  const jdbcUrl = `jdbc:postgresql://${ep.host}:5432/${dbName}?sslmode=require`;

  const envPath = path.join(ctx.projectDir, '.env');
  let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';

  // Remove existing connection vars
  envContent = envContent
    .split('\n')
    .filter(l => !l.startsWith('SPRING_DATASOURCE_') && !l.startsWith('LAKEBASE_HOST=') && !l.startsWith('LAKEBASE_BRANCH_ID='))
    .join('\n');

  // Append fresh connection
  envContent += [
    '',
    `LAKEBASE_HOST=${ep.host}`,
    `LAKEBASE_BRANCH_ID=${branch.branchId}`,
    `SPRING_DATASOURCE_URL=${jdbcUrl}`,
    `SPRING_DATASOURCE_USERNAME=${cred.email}`,
    `SPRING_DATASOURCE_PASSWORD=${cred.token}`,
    '',
  ].join('\n');
  fs.writeFileSync(envPath, envContent);

  // Also write application-local.properties (Maven/Spring reads this, not .env)
  // spring.flyway.enabled=false because the kit substrate's applyMigrations
  // runs the migration step before mvnw test (FEIP-7091 / FEIP-7098). The
  // test exercises substrate end-to-end; Spring Boot's auto-flyway would
  // race with it and double-apply.
  const propsContent = [
    `# Auto-generated by integration test for branch: ${branch.branchId}`,
    `spring.datasource.url=${jdbcUrl}`,
    `spring.datasource.username=${cred.email}`,
    `spring.datasource.password=${cred.token}`,
    `spring.flyway.enabled=false`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ctx.projectDir, 'application-local.properties'), propsContent);

  return { branchId: branch.branchId, host: ep.host, username: cred.email };
}

/**
 * Verify that .env has a live Lakebase branch connection.
 * Checks that SPRING_DATASOURCE_URL is a JDBC URL and USERNAME is set.
 */
export function verifyBranchConnection(ctx: ScenarioContext): { url: string; username: string } {
  const envPath = path.join(ctx.projectDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env not found');
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  const urlMatch = content.match(/^SPRING_DATASOURCE_URL=(.+)$/m);
  const userMatch = content.match(/^SPRING_DATASOURCE_USERNAME=(.+)$/m);
  if (!urlMatch || !urlMatch[1]) {
    throw new Error('SPRING_DATASOURCE_URL not set in .env');
  }
  return { url: urlMatch[1], username: userMatch ? userMatch[1] : '' };
}

/** A2: Write a Java source file to the project */
export function writeJavaFile(ctx: ScenarioContext, relativePath: string, content: string): void {
  const fullPath = path.join(ctx.projectDir, 'src', 'main', 'java', 'com', 'example', 'demo', relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/** A2: Delete a Java source file from the project */
export function deleteJavaFile(ctx: ScenarioContext, relativePath: string): void {
  const fullPath = path.join(ctx.projectDir, 'src', 'main', 'java', 'com', 'example', 'demo', relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

/** A4: Write a Java test file to the project (src/test/java/com/example/demo/) */
export function writeJavaTestFile(ctx: ScenarioContext, relativePath: string, content: string): void {
  const fullPath = path.join(ctx.projectDir, 'src', 'test', 'java', 'com', 'example', 'demo', relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/** A4: Delete a Java test file from the project */
export function deleteJavaTestFile(ctx: ScenarioContext, relativePath: string): void {
  const fullPath = path.join(ctx.projectDir, 'src', 'test', 'java', 'com', 'example', 'demo', relativePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

/** A3: Write a Flyway migration SQL file */
export function writeMigration(ctx: ScenarioContext, filename: string, sql: string): void {
  const migDir = path.join(ctx.projectDir, 'src', 'main', 'resources', 'db', 'migration');
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(path.join(migDir, filename), sql);
}

/** Pull LAKEBASE_BRANCH_ID out of the project's .env (created by
 *  createLakebaseBranchAndConnect). Throws with a clear message when
 *  missing - the substrate's applyMigrations needs an explicit branch. */
function readBranchFromEnv(projectDir: string): string {
  const envPath = path.join(projectDir, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Expected ${envPath} to exist; createLakebaseBranchAndConnect should have written it.`);
  }
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*LAKEBASE_BRANCH_ID\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error(`LAKEBASE_BRANCH_ID not found in ${envPath}.`);
}

/**
 * A5: Substrate-driven migrate + `./mvnw test` against the live Lakebase
 * branch database.
 *
 * Flow (FEIP-7091 / FEIP-7098, Option C):
 *  1. Substrate `applyMigrations` runs Flyway against the branch.
 *  2. Spring Boot's auto-flyway is disabled in application-local.properties,
 *     so mvnw test does NOT re-migrate. Hibernate validates against the
 *     already-migrated schema; the given/when/then tests run.
 *  3. Substrate `migrationStatus` verifies the head matches what was
 *     applied (single source of truth for what shipped to the branch).
 *
 * Returns the Maven output. Throws with last 80 lines if any phase fails.
 */
export async function runMavenTests(ctx: ScenarioContext, timeoutMs = 300000): Promise<string> {
  const branch = readBranchFromEnv(ctx.projectDir);

  // 1. Substrate applies migrations.
  const priorHost = process.env.DATABRICKS_HOST;
  process.env.DATABRICKS_HOST = ctx.dbHost;
  try {
    const applied = await substrateApplyMigrations({
      instance: ctx.projectName,
      branch,
      projectDir: ctx.projectDir,
    });
    console.log(`    [substrate] Flyway applied: ${applied.applied.length} migration(s), tool=${applied.tool}.`);
  } finally {
    if (priorHost === undefined) delete process.env.DATABRICKS_HOST;
    else process.env.DATABRICKS_HOST = priorHost;
  }

  // 2. Maven runs against the already-migrated schema. Spring's auto-flyway
  //    is off (see application-local.properties); Hibernate just validates.
  //    Always run online: ~/.m2/settings.xml routes through the internal
  //    maven-proxy mirror, which serves any uncached parent POM (e.g.
  //    spring-boot-starter-parent:3.5.5) on demand. The prior -o shortcut
  //    failed when a different Spring Boot version was already cached.
  let mvnOutput: string;
  try {
    mvnOutput = cp.execSync(
      `bash -c 'set -a; source .env; set +a; ./mvnw test 2>&1'`,
      { cwd: ctx.projectDir, timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: ctx.dbHost } }
    ).toString();
    console.log('    [mvnw] Tests passed.');
  } catch (err: any) {
    const output = err.stdout?.toString() || err.stderr?.toString() || err.message;
    const lastLines = output.split('\n').slice(-80).join('\n');
    throw new Error(`./mvnw test failed. Last 80 lines:\n${lastLines}`);
  }

  // 3. Substrate observes - current head must be set after a successful apply.
  process.env.DATABRICKS_HOST = ctx.dbHost;
  try {
    const status = await substrateMigrationStatus({
      instance: ctx.projectName,
      branch,
      projectDir: ctx.projectDir,
    });
    if (!status.current) {
      throw new Error(
        `substrate.migrationStatus reports no current head after apply; pending=${status.pending.length}`
      );
    }
    console.log(`    [substrate] migrationStatus: current=${status.current}, pending=${status.pending.length}.`);
  } finally {
    if (priorHost === undefined) delete process.env.DATABRICKS_HOST;
    else process.env.DATABRICKS_HOST = priorHost;
  }

  return mvnOutput;
}

/** A6: Stage, commit, and push */
export function commitAndPush(ctx: ScenarioContext, message: string, branchName: string): void {
  git(ctx, 'add -A');
  git(ctx, `commit -m "${message}"`);
  git(ctx, `push -u origin ${branchName}`);
}

// ── Phase B/C: PR + Merge ────────────────────────────────────────────

/**
 * Create a PR; returns the PR number. Defaults to baseBranch='staging' so
 * scenario PRs ride the two-tier promotion flow (feature → staging, then
 * a separate staging → main promotion fires merge.yml against prod).
 * Pass an explicit base for off-pattern PRs.
 */
export const createPR = (
  ctx: ScenarioContext,
  title: string,
  branchName: string,
  baseBranch: string = 'staging',
): Promise<number> =>
  lib.createPR(ctx.fullRepoName, title, branchName, 'Automated e-commerce scenario test', baseBranch);

/** Merge a PR (merge-commit, deletes remote head branch). */
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

/** Get PR comment bodies. Used to verify the schema-diff comment posted by pr.yml. */
export const getPRComments = (ctx: ScenarioContext, prNumber: number): Promise<string[]> =>
  lib.getPRComments(ctx.fullRepoName, prNumber);

/** Delete the feature branch locally and remotely */
export function cleanupBranch(ctx: ScenarioContext, branchName: string): void {
  try { git(ctx, 'checkout main'); } catch {}
  try { git(ctx, `branch -D ${branchName}`); } catch {}
  try { git(ctx, `push origin --delete ${branchName}`); } catch {}
}

// ── Workflow polling (runner executes pr.yml / merge.yml) ────────────

export interface WorkflowRunResult {
  conclusion: string;  // 'success' | 'failure' | 'cancelled' | ...
  runId: number;
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

// (forceDeleteLakebaseProject + forceDeleteGithubRepo re-exported at top.)

// ── Phase D: Production Verification ─────────────────────────────────

/**
 * Run a SQL query on the project's STAGING Lakebase branch. After
 * two-tier flow landed, scenario Phase D assertions should verify
 * staging state (the merge landed there, prod sees nothing until
 * Step E promotes). Pass an explicit `branch` to override (Step E
 * assertions pass 'default' to hit prod).
 */
export const queryBranch = (ctx: ScenarioContext, branch: string, sql: string): Promise<string> =>
  lib.queryBranch(ctx.projectName, branch, sql);

/**
 * Back-compat shim. Existing scenario Phase D calls expect this to
 * return rows from the branch where the merge just landed. Under
 * two-tier flow that's 'staging'. Step E assertions use queryBranch
 * with 'default' to hit prod.
 */
export const queryProduction = (ctx: ScenarioContext, sql: string): Promise<string> =>
  queryBranch(ctx, 'staging', sql);

/** Verify a table exists on the staging branch (where scenario merges land). */
export async function verifyTableExists(
  ctx: ScenarioContext,
  tableName: string,
  branch: string = 'staging',
): Promise<boolean> {
  const result = await queryBranch(ctx, branch, `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='${tableName}');`);
  return result === 't';
}

/** Verify a table does NOT exist on the staging branch. */
export async function verifyTableNotExists(
  ctx: ScenarioContext,
  tableName: string,
  branch: string = 'staging',
): Promise<boolean> {
  return !(await verifyTableExists(ctx, tableName, branch));
}

/** Verify a column exists on a table on the staging branch. */
export async function verifyColumnExists(
  ctx: ScenarioContext,
  tableName: string,
  columnName: string,
  branch: string = 'staging',
): Promise<boolean> {
  const result = await queryBranch(ctx, branch, `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${tableName}' AND column_name='${columnName}');`);
  return result === 't';
}

/** Verify a migration was applied (exists in flyway_schema_history with success=true) on the staging branch. */
export async function verifyMigrationApplied(
  ctx: ScenarioContext,
  version: string,
  branch: string = 'staging',
): Promise<boolean> {
  const result = await queryBranch(ctx, branch, `SELECT EXISTS (SELECT 1 FROM flyway_schema_history WHERE version='${version}' AND success=true);`);
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
  } catch {
    return false;
  }
}

/** Verify a file does NOT exist on the GitHub repo's main branch */
export function verifyFileNotOnGitHub(ctx: ScenarioContext, filePath: string): boolean {
  return !verifyFileOnGitHub(ctx, filePath);
}

// ── Schema Parsing ───────────────────────────────────────────────────

/** Parse migration SQL using SchemaMigrationService.parseSql and return schema changes */
export function parseMigrationSql(sql: string) {
  return SchemaMigrationService.parseSql(sql);
}

// ── Lakebase Branch Cleanup ──────────────────────────────────────────

/** Delete a Lakebase branch (non-fatal if not found) */
export async function deleteLakebaseBranch(ctx: ScenarioContext, branchName: string): Promise<void> {
  try {
    await ctx.lakebaseService.deleteBranch(branchName);
  } catch {
    // Branch may not exist – that's OK
  }
}
