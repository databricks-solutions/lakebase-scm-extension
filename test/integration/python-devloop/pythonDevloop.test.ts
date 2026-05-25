/**
 * Python Dev Loop – 4 Iterative Scenarios
 *
 * Full end-to-end: creates a GitHub repo + Lakebase project via ProjectCreationService,
 * scaffolds a Python/FastAPI/Alembic project, starts an ephemeral self-hosted runner,
 * then runs 4 iterative scenarios (each: branch -> code -> migration -> PR -> merge -> verify).
 *
 * Scenarios:
 *   1. CREATE TABLE partner (basic table)
 *   2. CREATE TABLE asset (FK to partner)
 *   3. ALTER TABLE asset (add review columns)
 *   4. DROP TABLE partner + asset (cascade cleanup)
 *
 * Run: npm run test:integration -- --grep "Python Dev Loop"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../../../src/services/gitService';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { ScaffoldService } from '../../../src/services/scaffoldService';
import { ProjectCreationService, ProjectCreationInput } from '../../../src/services/projectCreationService';
import {
  ScenarioContext, git, verifyTableNotExists, verifyAlembicVersion, queryProduction,
  saveFailedCiRunLogs,
} from './helpers';
import {
  installFailureTracker, preservedResourcesBanner,
  createLongRunningBranch, release,
  assertBackupSnapshotLifecycle, assertSchemaContainsOnBranch,
  resolveDefaultBranchName,
} from '../lib';
import { ensureRunnerBinary, startRunner, cleanupStaleRunners, RunnerHandle } from '../ecommerce/runner';
import { scaffoldPythonProject } from './pythonProject';

import { runScenario as scenario1 } from './scenario1Partner';
import { runScenario as scenario2 } from './scenario2Asset';
import { runScenario as scenario3 } from './scenario3AlterAsset';
import { runScenario as scenario4 } from './scenario4DropPartner';

const cp = require('child_process');
const timestamp = Date.now().toString(36);
const PROJECT_NAME = `pydev-${timestamp}`;

const ctx = {} as ScenarioContext;
let created = false;
let runner: RunnerHandle | undefined;
// Tracks whether signal handlers are installed, to avoid double-install if
// before() runs twice (mocha retries / nested suites).
let signalHandlersInstalled = false;
// Re-entrancy guard – a signal mid-cleanup must not trigger another cleanup.
let cleanupInFlight = false;

const dbcli = (cmd: string, dbHost: string, timeoutMs = 30000): string =>
  cp.execSync(cmd, { timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: dbHost } }).toString();

// (B) Verify Lakebase delete propagated. The CLI `delete-project` waits for
// the operation to reach DONE, but flaky-network or partial-state runs have
// occasionally left the project visible to list-projects for a few seconds
// after delete returns. Poll list-projects until the name disappears or we
// time out.
async function waitForLakebaseProjectGone(projectName: string, dbHost: string, timeoutMs = 180000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = dbcli('databricks postgres list-projects -o json', dbHost);
      const list = JSON.parse(raw) as Array<{ name?: string }>;
      const present = list.some((p) => (p.name || '').endsWith(`/${projectName}`));
      if (!present) return true;
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

// Shared end-of-run handler. Saves CI logs, stops the ephemeral runner,
// then prints a banner naming every preserved resource + the exact
// command to teardown later via test/integration/lib/cleanup-cli.ts.
//
// HARD RULE: this function never deletes Lakebase projects, GitHub repos,
// or the local project directory. Teardown is exclusively the cleanup-CLI's
// job, gated on per-resource y/N confirmation by a human. There is
// intentionally no env-var bypass.
async function fullCleanup(reason: string): Promise<void> {
  if (cleanupInFlight) {
    console.log(`  [cleanup:${reason}] already in-flight, skipping`);
    return;
  }
  cleanupInFlight = true;
  // Save CI run logs so a failing build-and-test job's log survives even
  // if the operator later runs cleanup-cli. Pure side-effect.
  if (created && ctx.fullRepoName) {
    try { await saveFailedCiRunLogs(ctx.fullRepoName); }
    catch (e: any) { console.log(`  [ci-logs] save failed: ${e?.message || e}`); }
  }
  // Stop the ephemeral runner. Its registration is tied to the (preserved)
  // repo and would otherwise dangle, so this is the one cleanup step we
  // always do.
  if (runner) {
    try { runner.cleanup(ctx as any); console.log(`  [cleanup:runner] OK`); }
    catch (e: any) { console.log(`  [cleanup:runner] FAILED: ${e?.message || e}`); }
    runner = undefined;
  }
  if (created) {
    console.log(preservedResourcesBanner({
      githubRepo: ctx.fullRepoName,
      lakebaseProject: ctx.projectName,
      projectDir: ctx.projectDir,
      databricksHost: process.env.DATABRICKS_HOST || process.env.DATABRICKS_TEST_HOST,
    }));
  }
  cleanupInFlight = false;
}

// Signal handlers + reaper delegated to test/integration/lib/lifecycle.
import { installSignalHandlers as libInstallSignalHandlers, reapOrphanProjects as libReapOrphans, acquireSingleRunLock, assertIntegrationCredentials } from '../lib';

const installSignalHandlers = (): void =>
  libInstallSignalHandlers({
    inFlight: () => cleanupInFlight,
    setInFlight: (v) => { cleanupInFlight = v; },
    run: fullCleanup,
  });

const reapOrphanProjects = (dbHost: string): Promise<void> =>
  libReapOrphans('pydev-', dbHost);

describe('Python Dev Loop – 4 Iterative Scenarios', function () {
  this.timeout(3600000); // 1 hour overall (4 scenarios x ~10 min each)

  // Track which mocha tests failed so the preserved-resources banner can
  // list them. The suite never auto-destroys regardless of pass/fail; this
  // tracker is for the post-run summary, not for any teardown decision.
  installFailureTracker();

  // ── Setup: Project + Python scaffold + Runner ──────────────────

  before(async function () {
    this.timeout(300000);

    // Refuse to start if another pydev integration run is already in progress.
    // Throws before any cloud resources are created, so a stray parallel
    // launch can't create orphaned Lakebase project + GitHub repo pairs.
    acquireSingleRunLock('pydev');

    cleanupStaleRunners();

    const gitService = new GitService();
    const lakebaseService = new LakebaseService();
    // Pre-flight: requires DATABRICKS_TEST_HOST + authenticated databricks
    // CLI + authenticated gh CLI. Throws IntegrationSetupError with exact
    // setup commands if any piece is missing. No silent default – the test
    // creates real cloud resources under the contributor's account.
    const { databricksHost: dbHost, githubUser: ghUser } = assertIntegrationCredentials();

    // (A) Install signal handlers BEFORE any resources are created, so a
    // ctrl-c during the slow create-project step still triggers cleanup.
    installSignalHandlers();

    // (C) Reap any pydev-* projects leaked by prior runs (older than 1 hour
    // so we never touch a concurrent in-flight test).
    await reapOrphanProjects(dbHost);

    process.env.DATABRICKS_HOST = dbHost;
    lakebaseService.setHostOverride(dbHost);
    lakebaseService.setProjectIdOverride(PROJECT_NAME);

    const scaffoldService = new ScaffoldService(path.resolve(__dirname, '../../../'));
    const creationService = new ProjectCreationService(gitService, lakebaseService, scaffoldService);
    const parentDir = require('os').homedir();
    const projectDir = path.join(parentDir, PROJECT_NAME);

    // Point the wrapper's getWorkspaceRoot() at the test project directory
    // so getEnvConfig() reads <projectDir>/.env - exactly what VS Code does
    // via workspaceFolders in a normal IDE session. This is what lets the
    // post-checkout hook's LAKEBASE_BRANCH_ID writes flow through to
    // resolveCreateBranchParent without scenarios passing override args.
    process.env.LAKEBASE_PROJECT_DIR = projectDir;

    const input: ProjectCreationInput = {
      projectName: PROJECT_NAME,
      parentDir,
      databricksHost: dbHost,
      githubOwner: ghUser,
      privateRepo: true,
      language: 'python',
    };

    Object.assign(ctx, {
      projectName: PROJECT_NAME,
      projectDir,
      ghUser,
      fullRepoName: `${ghUser}/${PROJECT_NAME}`,
      dbHost,
      gitService,
      lakebaseService,
      scaffoldService,
      creationService,
      input,
      nextRevision: 2,
      // Two-tier suite: scenarios PR into staging. N-tier suites would set
      // this to whichever tier their working-branch types target.
      baseBranch: 'staging',
    });

    console.log(`\n  Project: ${PROJECT_NAME}`);
    console.log(`  Dir: ${projectDir}`);
    console.log(`  GitHub: ${ctx.fullRepoName}`);
    console.log(`  Lakebase: ${PROJECT_NAME}`);
    console.log(`  Host: ${dbHost}\n`);

    // Step 1: Create the full project (GitHub repo + Lakebase DB + scaffold + hooks + commit + push)
    const result = await creationService.createProject(input, (step, detail) => {
      console.log(`    [setup] ${step}${detail ? ' – ' + detail : ''}`);
      if (step === 'Creating initial commit...') {
        // Inject Python project files before the commit
        scaffoldPythonProject(projectDir);
        console.log(`    [setup] Python project injected into initial commit.`);
      }
    });
    assert.ok(result.projectDir.includes(PROJECT_NAME));
    assert.ok(result.githubRepoUrl.includes(PROJECT_NAME));
    console.log(`    [setup] Project created (with Python scaffold).\n`);

    // Step 2: Install Python dependencies with uv
    console.log(`    [setup] Installing Python dependencies...`);
    cp.execSync('uv sync --all-extras 2>&1', {
      cwd: projectDir,
      timeout: 120000,
      env: { ...process.env, DATABRICKS_HOST: dbHost },
    });
    console.log(`    [setup] Dependencies installed.\n`);

    // Step 3: Start ephemeral self-hosted runner
    const runnerDir = ensureRunnerBinary();
    runner = startRunner(ctx as any, runnerDir);
    console.log(`    [setup] Runner started (pid=${runner.pid}).\n`);

    // Step 4: Cut the two-tier staging branch (Lakebase + git). Feature
    // scenarios PR into this; Step E promotes staging → main, which is
    // what actually exercises merge.yml's cut-backup + migrate-prod path.
    console.log(`    [setup] Cutting Lakebase staging branch + pushing git staging…`);
    const stagingInfo = await createLongRunningBranch({
      // Architect declares two-tier: 'staging' tier forked from 'main'.
      name: 'staging',
      forkFromBranch: 'main',
      projectId: PROJECT_NAME,
      workTreeDir: ctx.projectDir,
      databricksHost: dbHost,
    });
    console.log(`    [setup] Staging ready: lakebase=${stagingInfo.lakebaseBranchName}, git=${stagingInfo.gitBranch}.\n`);

    created = true;
    console.log(`    [setup] Ready – 4 scenarios + 2 promotions will execute.\n`);
  });

  // ── Scenario 1: Partner (CREATE TABLE) ──────────────────────────

  describe('Scenario 1: Partner (CREATE TABLE)', function () {
    this.timeout(600000);
    before(function () { if (!created) { this.skip(); } });
    scenario1(ctx);
  });

  // ── Scenario 2: Asset (CREATE TABLE with FK) ────────────────────

  describe('Scenario 2: Asset (CREATE TABLE with FK)', function () {
    this.timeout(600000);
    before(function () { if (!created) { this.skip(); } });
    scenario2(ctx);
  });

  // ── Step E1: Promote staging → main (after scenario 2) ──────────
  // Exercises merge.yml's substrate-routed cut-backup + migrate against
  // the prod (default) Lakebase branch. After this, prod should carry
  // partner + asset (002, 003) plus the placeholder 001.

  describe('Step E1: Release staging → main (post-scenario 2)', function () {
    this.timeout(900000);
    before(function () { if (!created) { this.skip(); } });

    let releaseResult: Awaited<ReturnType<typeof release>>;

    it('opens + merges staging → main PR and merge.yml succeeds', async () => {
      releaseResult = await release({
        from: 'staging',
        to: 'main',
        ownerRepo: ctx.fullRepoName,
        releaseLabel: 'post-scenario-2',
      });
      assert.strictEqual(
        releaseResult.conclusion, 'success',
        `merge.yml on staging→main must succeed; got ${releaseResult.conclusion}`,
      );
    });

    it('pre-migrate snapshot was created + cleaned up on success', async () => {
      await assertBackupSnapshotLifecycle({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
        prNumber: releaseResult.prNumber,
        conclusion: releaseResult.conclusion,
      });
    });

    it('prod (default) Lakebase branch carries partner + asset tables', async () => {
      const prodBranch = await resolveDefaultBranchName({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
      });
      await assertSchemaContainsOnBranch({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
        lakebaseService: ctx.lakebaseService,
        branchName: prodBranch,
        expectedTables: ['partner', 'asset'],
      });
    });
  });

  // ── Scenario 3: ALTER TABLE (Add review columns) ────────────────

  describe('Scenario 3: ALTER TABLE (Review Fields)', function () {
    this.timeout(600000);
    before(function () { if (!created) { this.skip(); } });
    scenario3(ctx);
  });

  // ── Scenario 4: DROP TABLE (Remove partner + asset) ─────────────

  describe('Scenario 4: DROP TABLE (Cleanup)', function () {
    this.timeout(600000);
    before(function () { if (!created) { this.skip(); } });
    scenario4(ctx);
  });

  // ── Step E2: Promote staging → main (after scenario 4 / final) ─
  // Final promotion exercises merge.yml against ALTER + DROP migrations
  // on prod. After this, partner + asset must be gone from prod.

  describe('Step E2: Release staging → main (final, post-scenario 4)', function () {
    this.timeout(900000);
    before(function () { if (!created) { this.skip(); } });

    let releaseResult: Awaited<ReturnType<typeof release>>;

    it('opens + merges final staging → main PR and merge.yml succeeds', async () => {
      releaseResult = await release({
        from: 'staging',
        to: 'main',
        ownerRepo: ctx.fullRepoName,
        releaseLabel: 'final-post-scenario-4',
      });
      assert.strictEqual(
        releaseResult.conclusion, 'success',
        `Final merge.yml on staging→main must succeed; got ${releaseResult.conclusion}`,
      );
    });

    it('pre-migrate snapshot was created + cleaned up on success', async () => {
      await assertBackupSnapshotLifecycle({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
        prNumber: releaseResult.prNumber,
        conclusion: releaseResult.conclusion,
      });
    });

    it('prod has partner + asset DROPPED', async () => {
      const prodBranch = await resolveDefaultBranchName({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
      });
      await assertSchemaContainsOnBranch({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
        lakebaseService: ctx.lakebaseService,
        branchName: prodBranch,
        expectedTables: [],
        unexpectedTables: ['partner', 'asset'],
      });
    });
  });

  // ── Final Verification ──────────────────────────────────────────

  describe('Final Verification', function () {
    this.timeout(120000);
    before(function () { if (!created) { this.skip(); } });

    it('alembic_version is at 005 (4 migrations + placeholder)', async () => {
      assert.ok(await verifyAlembicVersion(ctx, '005'));
    });

    it('partner table does NOT exist (dropped in scenario 4)', async () => {
      assert.ok(await verifyTableNotExists(ctx, 'partner'));
    });

    it('asset table does NOT exist (dropped in scenario 4)', async () => {
      assert.ok(await verifyTableNotExists(ctx, 'asset'));
    });

    it('4 merge commits on main', () => {
      const merges = cp.execSync('git log --merges --oneline', { cwd: ctx.projectDir, timeout: 10000 }).toString().trim();
      const lines = merges.split('\n').filter(Boolean);
      assert.ok(lines.length >= 4, `Expected 4+ merge commits, got ${lines.length}`);
    });

    it('5 Alembic migration files in repo', () => {
      const versionsDir = path.join(ctx.projectDir, 'alembic', 'versions');
      const files = fs.readdirSync(versionsDir).filter(f => f.endsWith('.py'));
      assert.strictEqual(files.length, 5, `Expected 5 migration files (001-005), got ${files.length}`);
    });

    it('models.py is clean (no entities)', () => {
      const content = fs.readFileSync(path.join(ctx.projectDir, 'app', 'models.py'), 'utf-8');
      assert.ok(!content.includes('class Partner'), 'Partner model should be removed');
      assert.ok(!content.includes('class Asset'), 'Asset model should be removed');
    });
  });

  // ── End of run ───────────────────────────────────────────────────
  // Hard rule: this suite NEVER destroys Lakebase projects or GitHub
  // repos. `fullCleanup` only stops the ephemeral runner and prints the
  // preserved-resources banner. To teardown later, run cleanup-cli.ts;
  // see test/integration/lib/preserve-on-failure.ts for the rationale.
  after(async function () {
    this.timeout(120000);
    await fullCleanup('after');
  });
});
