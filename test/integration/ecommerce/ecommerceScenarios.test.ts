/**
 * E-Commerce Backend – Iterative Feature Development Scenarios
 *
 * Full end-to-end: creates a GitHub repo + Lakebase project via ProjectCreationService,
 * scaffolds a Maven/Spring Boot project, starts an ephemeral self-hosted runner,
 * then runs 8 iterative scenarios (each: branch → code → migration → PR → merge → verify).
 * The runner executes the actual pr.yml and merge.yml workflows (Flyway, tests, schema diff).
 *
 * Run: npm run test:integration -- --grep "E-Commerce"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../../../src/services/gitService';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { ScaffoldService } from '../../../src/services/scaffoldService';
import { ProjectCreationService, ProjectCreationInput } from '../../../src/services/projectCreationService';
import {
  ScenarioContext, git, verifyTableExists, verifyTableNotExists, verifyMigrationApplied, queryProduction,
  saveFailedCiRunLogs,
} from './helpers';
import {
  installFailureTracker, preservedResourcesBanner,
  createLongRunningBranch, release,
  assertBackupSnapshotLifecycle, assertSchemaContainsOnBranch,
  resolveDefaultBranchName,
} from '../lib';
import { ensureRunnerBinary, startRunner, cleanupStaleRunners, RunnerHandle } from './runner';
import { scaffoldMavenProject } from './mavenProject';

// Force substrate's static fallback Java scaffold instead of Spring Initializr.
// The Initializr-extracted project would carry a dynamic ${ProjectName}Application
// class (colliding with the test's deterministic DemoApplication.java) and its
// stock .gitignore (clobbering substrate's .gitignore.base which has .env/
// application-local.properties). The fallback ships exactly the files we need
// (matching pom.xml deps, application.properties with spring.config.import,
// DemoApplication, DemoApplicationTests, V1 placeholder migration), so this
// single env-var flip drops ~400 lines of overlay from mavenProject.ts.
process.env.LAKEBASE_SCAFFOLD_FALLBACK = '1';

import { runScenario as scenario1_6 } from './scenario1_6_AllEntities';
import { runScenario as scenario7 } from './scenario7AlterProduct';
import { runScenario as scenario8 } from './scenario8DropBook';

const cp = require('child_process');
const timestamp = Date.now().toString(36);
const PROJECT_NAME = `ecom-${timestamp}`;

// Mutable object – scenario files receive this reference during Mocha's synchronous
// describe-body processing, then Object.assign populates it in before().
const ctx = {} as ScenarioContext;
let created = false;
let runner: RunnerHandle | undefined;
let signalHandlersInstalled = false;
let cleanupInFlight = false;

const dbcli = (cmd: string, dbHost: string, timeoutMs = 30000): string =>
  cp.execSync(cmd, { timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: dbHost } }).toString();

// Shared end-of-run handler. Saves CI logs, stops the ephemeral runner,
// then prints a banner naming every preserved resource + the exact
// command to teardown later via test/integration/lib/cleanup-cli.ts.
//
// HARD RULE: this function never deletes Lakebase projects, GitHub repos,
// or the local project directory. Teardown is exclusively the cleanup-CLI's
// job, gated on per-resource y/N confirmation by a human. There is
// intentionally no env-var bypass - "I'll just set the flag this once"
// is exactly the mistake that destroyed prior runs' debugging trails.
async function fullCleanup(reason: string): Promise<void> {
  if (cleanupInFlight) {
    console.log(`  [cleanup:${reason}] already in-flight, skipping`);
    return;
  }
  cleanupInFlight = true;
  // Save CI run logs so a failing build-and-test job's log survives even
  // if the operator later runs cleanup-cli. Pure side-effect; failures
  // here never block the post-run banner.
  if (created && ctx.fullRepoName) {
    try { await saveFailedCiRunLogs(ctx.fullRepoName); }
    catch (e: any) { console.log(`  [ci-logs] save failed: ${e?.message || e}`); }
  }
  // Stop the ephemeral self-hosted runner. The runner registration is
  // tied to the (now-preserved) repo and would otherwise dangle, so
  // stopping it is the one cleanup step we always do.
  if (runner) {
    try { runner.cleanup(ctx as any); console.log(`  [cleanup:runner] OK`); }
    catch (e: any) { console.log(`  [cleanup:runner] FAILED: ${e?.message || e}`); }
    runner = undefined;
  }
  // Print the banner so the operator sees exactly what survived + how
  // to clean it up later.
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
  libReapOrphans('ecom-', dbHost, parseInt(process.env.ECOM_REAP_AGE_MS || '3600000', 10));

describe('E-Commerce Backend – 8 Iterative Scenarios', function () {
  this.timeout(7200000); // 2 hours overall (8 scenarios × ~10 min each)

  // Track which mocha tests failed so the preserved-resources banner can
  // list them. The suite never auto-destroys regardless of pass/fail; this
  // tracker is for the post-run summary, not for any teardown decision.
  installFailureTracker();

  // ── Setup: Project + Maven + Runner ─────────────────────────────────

  before(async function () {
    this.timeout(300000); // 5 min for setup

    // Wipe stale diagnostic logs from prior runs so the post-run inspection
    // never confuses an old failure with this run's. Keep anything modified
    // in the last 60s - the launch-cli creates the current log via nohup
    // redirect seconds before mocha boots, so an mtime cutoff reliably
    // preserves the active file descriptor's target.
    try {
      const logDir = '/tmp/two-tier-runs';
      if (fs.existsSync(logDir)) {
        const cutoffMs = Date.now() - 60_000;
        for (const f of fs.readdirSync(logDir)) {
          if (!f.endsWith('.log')) continue;
          const fp = path.join(logDir, f);
          try {
            const st = fs.statSync(fp);
            if (st.mtimeMs < cutoffMs) fs.unlinkSync(fp);
          } catch { /* ignore individual file errors */ }
        }
      }
    } catch { /* never let log cleanup abort setup */ }

    // Refuse to start if another ecom integration run is already in progress.
    // Throws before any cloud resources are created, so a stray parallel
    // launch can't create orphaned Lakebase project + GitHub repo pairs.
    acquireSingleRunLock('ecom');

    // Kill any leftover runners from previous failed runs
    cleanupStaleRunners();

    const gitService = new GitService();
    const lakebaseService = new LakebaseService();
    // Pre-flight: requires DATABRICKS_TEST_HOST + authenticated databricks
    // CLI + authenticated gh CLI. Throws IntegrationSetupError with exact
    // setup commands if any piece is missing. No silent default – the test
    // creates real cloud resources under the contributor's account.
    const { databricksHost: dbHost, githubUser: ghUser } = assertIntegrationCredentials();

    // Install OS signal handlers before any resources are created so a
    // ctrl-c during create-project still triggers cleanup.
    installSignalHandlers();

    // Reap any ecom-* projects leaked by prior runs (older than 1 hour).
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
    // scaffoldMavenProject is called from the progress callback right BEFORE the initial commit,
    // so pom.xml/mvnw/DemoApplication.java are included in the first commit (avoids a second
    // push that triggers merge.yml before the runner is ready).
    const result = await creationService.createProject(input, (step, detail) => {
      console.log(`    [setup] ${step}${detail ? ' – ' + detail : ''}`);
      if (step === 'Creating initial commit...') {
        // Inject Maven files before the commit
        scaffoldMavenProject(projectDir);
        console.log(`    [setup] Maven project injected into initial commit.`);
      }
    });
    assert.ok(result.projectDir.includes(PROJECT_NAME));
    assert.ok(result.githubRepoUrl.includes(PROJECT_NAME));
    console.log(`    [setup] Project created (with Maven scaffold).\n`);

    // Step 3: Download and start ephemeral self-hosted runner
    const runnerDir = ensureRunnerBinary();
    runner = startRunner(ctx, runnerDir);
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
    console.log(`    [setup] Ready – 8 scenarios + 2 promotions will execute.\n`);
  });

  // ── Scenarios 1-6: All Entities (one branch, one PR, one merge) ──

  describe('Scenarios 1-6: All Entities', function () {
    this.timeout(600000);
    before(function () { if (!created) { this.skip(); } });
    scenario1_6(ctx);
  });

  // ── Scenario 7: ALTER TABLE (Product Reviews) ────────────────────

  describe('Scenario 7: ALTER TABLE', function () {
    this.timeout(600000);
    before(function () { if (!created) { this.skip(); } });
    scenario7(ctx);
  });

  // ── Step E1: Promote staging → main (after scenario 7) ───────────
  // Exercises merge.yml's substrate-routed cut-backup + migrate against
  // the prod (default) Lakebase branch. After this promotion, prod
  // should carry V2..V8 (scenarios 1-6 entities + scenario 7's ALTER).

  describe('Step E1: Release staging → main (post-scenario 7)', function () {
    this.timeout(900000);
    before(function () { if (!created) { this.skip(); } });

    let releaseResult: Awaited<ReturnType<typeof release>>;

    it('opens + merges staging → main PR and merge.yml succeeds', async () => {
      releaseResult = await release({
        from: 'staging',
        to: 'main',
        ownerRepo: ctx.fullRepoName,
        releaseLabel: 'post-scenario-7',
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

    it('prod (default) Lakebase branch now carries scenario 1-7 tables', async () => {
      const prodBranch = await resolveDefaultBranchName({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
      });
      await assertSchemaContainsOnBranch({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
        lakebaseService: ctx.lakebaseService,
        branchName: prodBranch,
        expectedTables: [
          'book', 'product', 'customer', 'cart', 'cart_item',
          'orders', 'order_item', 'wishlist', 'wishlist_item',
        ],
      });
    });
  });

  // ── Scenario 8: DROP TABLE (Remove Book) ─────────────────────────

  describe('Scenario 8: DROP TABLE', function () {
    this.timeout(600000);
    before(function () { if (!created) { this.skip(); } });
    scenario8(ctx);
  });

  // ── Step E2: Promote staging → main (after scenario 8 / final) ──
  // Final promotion exercises merge.yml against a DROP migration on
  // prod. After this, the book table must be gone from prod and the
  // remaining 8 tables present.

  describe('Step E2: Release staging → main (final, post-scenario 8)', function () {
    this.timeout(900000);
    before(function () { if (!created) { this.skip(); } });

    let releaseResult: Awaited<ReturnType<typeof release>>;

    it('opens + merges final staging → main PR and merge.yml succeeds', async () => {
      releaseResult = await release({
        from: 'staging',
        to: 'main',
        ownerRepo: ctx.fullRepoName,
        releaseLabel: 'final-post-scenario-8',
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

    it('prod has book DROPPED and the remaining 8 tables present', async () => {
      const prodBranch = await resolveDefaultBranchName({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
      });
      await assertSchemaContainsOnBranch({
        projectName: ctx.projectName,
        databricksHost: ctx.dbHost,
        lakebaseService: ctx.lakebaseService,
        branchName: prodBranch,
        expectedTables: [
          'product', 'customer', 'cart', 'cart_item',
          'orders', 'order_item', 'wishlist', 'wishlist_item',
        ],
        unexpectedTables: ['book'],
      });
    });
  });

  // ── Final Verification ───────────────────────────────────────────

  describe('Final Verification', function () {
    this.timeout(120000);
    before(function () { if (!created) { this.skip(); } });

    it('8 migrations applied (V2-V9) in flyway_schema_history', async () => {
      for (let v = 2; v <= 9; v++) {
        const applied = await verifyMigrationApplied(ctx, String(v));
        assert.ok(applied, `V${v} should be applied`);
      }
    });

    it('book table does NOT exist (dropped in V9)', async () => {
      assert.ok(await verifyTableNotExists(ctx, 'book'));
    });

    it('all 8 remaining tables exist on production', async () => {
      const tables = ['product', 'customer', 'cart', 'cart_item', 'orders', 'order_item', 'wishlist', 'wishlist_item'];
      for (const table of tables) {
        assert.ok(await verifyTableExists(ctx, table), `${table} should exist`);
      }
    });

    it('flyway_schema_history has exactly 9 user migrations (V1 placeholder + V2-V9)', async () => {
      // Exclude the BASELINE row that Flyway adds under -DbaselineOnMigrate=true
      // (Lakebase's `public` schema is always non-empty). We assert on the
      // user-migration count, not the raw row count.
      const count = await queryProduction(ctx, "SELECT COUNT(*) FROM flyway_schema_history WHERE success=true AND type <> 'BASELINE';");
      assert.strictEqual(parseInt(count, 10), 9, `Expected 9 user migrations, got ${count}`);
    });

    it('3 merge commits on main (scenarios 1-6, 7, 8)', () => {
      const merges = cp.execSync('git log --merges --oneline', { cwd: ctx.projectDir, timeout: 10000 }).toString().trim();
      const lines = merges.split('\n').filter(Boolean);
      assert.ok(lines.length >= 3, `Expected 3+ merge commits, got ${lines.length}`);
    });

    it('Book Java files absent from repo', () => {
      const bookFiles = ['model/Book.java', 'repository/BookRepository.java', 'service/BookService.java', 'controller/BookController.java'];
      for (const f of bookFiles) {
        const fullPath = path.join(ctx.projectDir, 'src', 'main', 'java', 'com', 'example', 'demo', f);
        assert.ok(!fs.existsSync(fullPath), `${f} should not exist locally`);
      }
    });

    it('all other Java files present', () => {
      const expectedFiles = [
        'model/Product.java', 'model/Customer.java', 'model/Cart.java', 'model/CartItem.java',
        'model/Order.java', 'model/OrderItem.java', 'model/OrderStatus.java',
        'model/Wishlist.java', 'model/WishlistItem.java',
        'repository/ProductRepository.java', 'repository/CustomerRepository.java',
        'repository/CartRepository.java', 'repository/CartItemRepository.java',
        'repository/OrderRepository.java', 'repository/OrderItemRepository.java',
        'repository/WishlistRepository.java', 'repository/WishlistItemRepository.java',
        'service/ProductService.java', 'service/CustomerService.java',
        'service/CartService.java', 'service/OrderService.java', 'service/WishlistService.java',
        'controller/ProductController.java', 'controller/CustomerController.java',
        'controller/CartController.java', 'controller/OrderController.java', 'controller/WishlistController.java',
      ];
      for (const f of expectedFiles) {
        const fullPath = path.join(ctx.projectDir, 'src', 'main', 'java', 'com', 'example', 'demo', f);
        assert.ok(fs.existsSync(fullPath), `${f} should exist`);
      }
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
