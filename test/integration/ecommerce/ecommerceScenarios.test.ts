/**
 * E-Commerce Backend — Iterative Feature Development Scenarios
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
import { ScenarioContext, git, verifyTableExists, verifyTableNotExists, verifyMigrationApplied, queryProduction } from './helpers';
import { ensureRunnerBinary, startRunner, cleanupStaleRunners, RunnerHandle } from './runner';
import { scaffoldMavenProject } from './mavenProject';

import { runScenario as scenario1_6 } from './scenario1_6_AllEntities';
import { runScenario as scenario7 } from './scenario7AlterProduct';
import { runScenario as scenario8 } from './scenario8DropBook';

const cp = require('child_process');
const timestamp = Date.now().toString(36);
const PROJECT_NAME = `ecom-${timestamp}`;

// Mutable object — scenario files receive this reference during Mocha's synchronous
// describe-body processing, then Object.assign populates it in before().
const ctx = {} as ScenarioContext;
let created = false;
let runner: RunnerHandle | undefined;

describe('E-Commerce Backend — 8 Iterative Scenarios', function () {
  this.timeout(7200000); // 2 hours overall (8 scenarios × ~10 min each)

  // ── Setup: Project + Maven + Runner ─────────────────────────────────

  before(async function () {
    this.timeout(300000); // 5 min for setup

    // Kill any leftover runners from previous failed runs
    cleanupStaleRunners();

    const gitService = new GitService();
    const lakebaseService = new LakebaseService();
    const dbHost = process.env.DATABRICKS_HOST || 'https://fevm-serverless-stable-ecparr.cloud.databricks.com';
    process.env.DATABRICKS_HOST = dbHost;
    lakebaseService.setHostOverride(dbHost);
    lakebaseService.setProjectIdOverride(PROJECT_NAME);

    const scaffoldService = new ScaffoldService(path.resolve(__dirname, '../../../'));
    const creationService = new ProjectCreationService(gitService, lakebaseService, scaffoldService);
    const ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    const parentDir = require('os').homedir();
    const projectDir = path.join(parentDir, PROJECT_NAME);

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
      console.log(`    [setup] ${step}${detail ? ' — ' + detail : ''}`);
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

    created = true;
    console.log(`    [setup] Ready — 8 scenarios will execute.\n`);
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

  // ── Scenario 8: DROP TABLE (Remove Book) ─────────────────────────

  describe('Scenario 8: DROP TABLE', function () {
    this.timeout(600000);
    before(function () { if (!created) { this.skip(); } });
    scenario8(ctx);
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

    it('flyway_schema_history has exactly 9 entries (V1 placeholder + V2-V9)', async () => {
      const count = await queryProduction(ctx, 'SELECT COUNT(*) FROM flyway_schema_history WHERE success=true;');
      assert.strictEqual(parseInt(count, 10), 9, `Expected 9 migrations, got ${count}`);
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

  // ── Teardown ─────────────────────────────────────────────────────
  // Set ECOM_NO_TEARDOWN=1 to skip cleanup (for manual review of resources)

  describe('Teardown', () => {
    it('stops runner and cleans up project', async function () {
      if (!created) { this.skip(); return; }
      if (process.env.ECOM_NO_TEARDOWN) {
        console.log(`\n    Teardown SKIPPED (ECOM_NO_TEARDOWN=1).`);
        console.log(`    GitHub repo: https://github.com/${ctx.fullRepoName}`);
        console.log(`    Lakebase project: ${ctx.projectName}`);
        console.log(`    Local dir: ${ctx.projectDir}\n`);
        this.skip();
        return;
      }
      this.timeout(120000);
      console.log('\n    Cleaning up...');
      if (runner) { runner.cleanup(ctx); }
      await ctx.creationService.cleanupProject(ctx.input);
      created = false;
      console.log('    Done.\n');
    });
  });

  // Safety net: always clean up (unless ECOM_NO_TEARDOWN)
  after(async function () {
    this.timeout(120000);
    if (process.env.ECOM_NO_TEARDOWN) { return; }
    if (runner) {
      try { runner.cleanup(ctx); } catch (e: any) { console.log(`  [cleanup:runner] ${e.message}`); }
    }
    if (created) {
      try { await ctx.creationService.cleanupProject(ctx.input); } catch (e: any) {
        console.log(`  [cleanup:project] ${e.message}`);
      }
    }
  });
});
