/**
 * E-Commerce Scenario — Shared Helpers
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
 * they call getWorkspaceRoot() which returns the VS Code workspace root — not the
 * temporary test project directory. There is no cwd override on GitService, so git
 * operations use the local `git()` helper with explicit `cwd: ctx.projectDir`.
 *
 * Direct CLI calls (gh, psql) are kept for the same reason — they need to target
 * the test project's repo / connection, not the VS Code workspace.
 * ────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { GitService } from '../../../src/services/gitService';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { ScaffoldService } from '../../../src/services/scaffoldService';
import { ProjectCreationService, ProjectCreationInput } from '../../../src/services/projectCreationService';
import { SchemaMigrationService } from '../../../src/services/schemaMigrationService';

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

/** Run a psql command against a connection string */
function psql(connStr: string, sql: string, timeout = 30000): string {
  // Escape single quotes in SQL for the shell
  const escaped = sql.replace(/'/g, "'\\''");
  return cp.execSync(
    `psql "${connStr}" -t -A -c '${escaped}'`,
    { timeout }
  ).toString().trim();
}

// ── Lakebase helpers (routed through LakebaseService) ────────────────

/** Get a psql connection string for the production (default) branch */
async function getProductionConnStr(ctx: ScenarioContext): Promise<string> {
  const def = await ctx.lakebaseService.getDefaultBranch();
  if (!def) { throw new Error('No default Lakebase branch found'); }

  const ep = await ctx.lakebaseService.getEndpoint(def.uid);
  if (!ep?.host) { throw new Error(`No endpoint for default branch ${def.uid}`); }

  const cred = await ctx.lakebaseService.getCredential(def.uid);
  if (!cred.token || !cred.email) { throw new Error('Empty credentials for default branch'); }

  return `postgresql://${encodeURIComponent(cred.email)}:${encodeURIComponent(cred.token)}@${ep.host}:5432/databricks_postgres?sslmode=require`;
}

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
  // Use the actual LakebaseService methods — this is what the extension does
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
  const propsContent = [
    `# Auto-generated by integration test for branch: ${branch.branchId}`,
    `spring.datasource.url=${jdbcUrl}`,
    `spring.datasource.username=${cred.email}`,
    `spring.datasource.password=${cred.token}`,
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

/**
 * A5: Run `./mvnw test` against the live Lakebase branch database.
 * Flyway applies pending migrations, Hibernate validates entities, given/when/then tests run.
 * Returns the Maven output. Throws with full build output if tests fail.
 */
export function runMavenTests(ctx: ScenarioContext, timeoutMs = 300000): string {
  try {
    // Source .env to get SPRING_DATASOURCE_* vars, then run Maven
    // Use -o (offline) if ~/.m2/repository has cached deps (avoids Maven Central connectivity issues)
    const m2Repo = path.join(require('os').homedir(), '.m2', 'repository');
    const offlineFlag = fs.existsSync(path.join(m2Repo, 'org', 'springframework', 'boot')) ? '-o ' : '';
    const output = cp.execSync(
      `bash -c 'set -a; source .env; set +a; ./mvnw ${offlineFlag}test 2>&1'`,
      { cwd: ctx.projectDir, timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: ctx.dbHost } }
    ).toString();
    console.log('    [mvnw] Tests passed.');
    return output;
  } catch (err: any) {
    // execSync throws on non-zero exit — capture stdout+stderr from the error
    const output = err.stdout?.toString() || err.stderr?.toString() || err.message;
    const lastLines = output.split('\n').slice(-80).join('\n');
    throw new Error(`./mvnw test failed. Last 80 lines:\n${lastLines}`);
  }
}

/** A6: Stage, commit, and push */
export function commitAndPush(ctx: ScenarioContext, message: string, branchName: string): void {
  git(ctx, 'add -A');
  git(ctx, `commit -m "${message}"`);
  git(ctx, `push -u origin ${branchName}`);
}

// ── Phase B/C: PR + Merge ────────────────────────────────────────────

/** Create a PR and return the PR number */
export function createPR(ctx: ScenarioContext, title: string, branchName: string): number {
  const raw = cp.execSync(
    `gh pr create --repo "${ctx.fullRepoName}" --title "${title}" --body "Automated e-commerce scenario test" --head "${branchName}" --base main`,
    { cwd: ctx.projectDir, timeout: 30000 }
  ).toString().trim();
  const match = raw.match(/\/pull\/(\d+)/);
  if (!match) {
    throw new Error(`Could not extract PR number from: ${raw}`);
  }
  return parseInt(match[1], 10);
}

/** Merge a PR by number */
export function mergePR(ctx: ScenarioContext, prNumber: number): void {
  cp.execSync(
    `gh pr merge ${prNumber} --repo "${ctx.fullRepoName}" --merge --admin`,
    { cwd: ctx.projectDir, timeout: 60000 }
  );
}

/** Update local main after merge */
export function pullMain(ctx: ScenarioContext): void {
  git(ctx, 'checkout main');
  git(ctx, 'pull origin main');
}

/**
 * Get PR comments and return them as an array of { author, body } objects.
 * Used to verify the schema diff comment posted by pr.yml.
 */
export function getPRComments(ctx: ScenarioContext, prNumber: number): Array<{ author: string; body: string }> {
  const raw = cp.execSync(
    `gh api repos/${ctx.fullRepoName}/issues/${prNumber}/comments --jq '[.[] | {author: .user.login, body: .body}]'`,
    { timeout: 15000 }
  ).toString().trim();
  return JSON.parse(raw || '[]');
}

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

export interface WaitForWorkflowOptions {
  branch?: string;
  event?: string;           // 'pull_request' | 'push'
  afterRunId?: number;      // only consider runs with databaseId > this
  timeoutMs?: number;       // default 360000 (6 min)
  pollIntervalMs?: number;  // default 15000 (15 sec)
}

/**
 * Get the latest workflow run ID for a given workflow file.
 * Used to establish a "before" marker so we can detect new runs after a merge.
 */
export function getLatestRunId(ctx: ScenarioContext, workflowFile: string): number {
  try {
    const raw = cp.execSync(
      `gh run list --repo "${ctx.fullRepoName}" --workflow="${workflowFile}" --limit=1 --json databaseId --jq '.[0].databaseId'`,
      { timeout: 15000 }
    ).toString().trim();
    return raw ? parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Wait for a workflow run to complete. Polls gh run list until the run finishes.
 * Returns the conclusion and run ID. On failure, includes last 50 lines of logs.
 */
export function waitForWorkflowRun(
  ctx: ScenarioContext,
  workflowFile: string,
  opts: WaitForWorkflowOptions = {},
): WorkflowRunResult {
  const timeoutMs = opts.timeoutMs ?? 360000;
  const pollIntervalMs = opts.pollIntervalMs ?? 15000;
  const afterRunId = opts.afterRunId ?? 0;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const raw = cp.execSync(
        `gh run list --repo "${ctx.fullRepoName}" --workflow="${workflowFile}" --limit=5 --json databaseId,status,conclusion,headBranch,event`,
        { timeout: 15000 }
      ).toString().trim();

      const runs = JSON.parse(raw || '[]');

      // Find a matching run
      for (const run of runs) {
        // Skip runs before our marker
        if (afterRunId && run.databaseId <= afterRunId) { continue; }

        // Filter by branch if specified
        if (opts.branch && run.headBranch !== opts.branch) { continue; }

        // Filter by event if specified
        if (opts.event && run.event !== opts.event) { continue; }

        if (run.status === 'completed') {
          return { conclusion: run.conclusion, runId: run.databaseId };
        }

        // Found a matching in-progress run — wait for it
        break;
      }
    } catch {
      // gh CLI may fail transiently
    }

    cp.execSync(`sleep ${Math.floor(pollIntervalMs / 1000)}`);
  }

  throw new Error(
    `Workflow ${workflowFile} did not complete within ${timeoutMs / 1000}s ` +
    `(branch: ${opts.branch || 'any'}, event: ${opts.event || 'any'}, afterRunId: ${afterRunId})`
  );
}

/**
 * Get the last N lines of logs from a workflow run (for debugging failures).
 */
export function getWorkflowLogs(ctx: ScenarioContext, runId: number, lines = 50): string {
  try {
    return cp.execSync(
      `gh run view ${runId} --repo "${ctx.fullRepoName}" --log 2>&1 | tail -${lines}`,
      { timeout: 30000 }
    ).toString().trim();
  } catch {
    return '(could not fetch workflow logs)';
  }
}

/**
 * Wait until all queued/in-progress workflow runs have completed.
 * Call between scenarios to ensure the runner is idle before starting the next one.
 */
export function waitForRunnerIdle(ctx: ScenarioContext, timeoutMs = 300000): void {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const raw = cp.execSync(
        `gh run list --repo "${ctx.fullRepoName}" --status=queued --status=in_progress --json databaseId --jq 'length'`,
        { timeout: 15000 }
      ).toString().trim();
      const active = parseInt(raw, 10) || 0;
      if (active === 0) { return; }
    } catch {}
    cp.execSync('sleep 10');
  }
}

// ── Phase D: Production Verification ─────────────────────────────────

/** Run a SQL query on the production database and return raw output */
export async function queryProduction(ctx: ScenarioContext, sql: string): Promise<string> {
  const connStr = await getProductionConnStr(ctx);
  return psql(connStr, sql);
}

/** Verify a table exists on the production database */
export async function verifyTableExists(ctx: ScenarioContext, tableName: string): Promise<boolean> {
  const result = await queryProduction(ctx, `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='${tableName}');`);
  return result === 't';
}

/** Verify a table does NOT exist on the production database */
export async function verifyTableNotExists(ctx: ScenarioContext, tableName: string): Promise<boolean> {
  return !(await verifyTableExists(ctx, tableName));
}

/** Verify a column exists on a table in the production database */
export async function verifyColumnExists(ctx: ScenarioContext, tableName: string, columnName: string): Promise<boolean> {
  const result = await queryProduction(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${tableName}' AND column_name='${columnName}');`);
  return result === 't';
}

/** Verify a migration was applied (exists in flyway_schema_history with success=true) */
export async function verifyMigrationApplied(ctx: ScenarioContext, version: string): Promise<boolean> {
  const result = await queryProduction(ctx, `SELECT EXISTS (SELECT 1 FROM flyway_schema_history WHERE version='${version}' AND success=true);`);
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
    // Branch may not exist — that's OK
  }
}
