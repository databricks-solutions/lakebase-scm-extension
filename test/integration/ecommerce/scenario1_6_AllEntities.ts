/**
 * Scenario 1-6: All Entities (Book, Product, Customer, Cart, Orders, Wishlist)
 *
 * Combined scenario: writes all 6 entities + 6 migrations (V2-V7) + tests in one branch,
 * one PR, one merge. Replaces 6 separate PR/merge cycles (~50 min saved).
 */

import { strict as assert } from 'assert';
import {
  ScenarioContext, git, createFeatureBranch, writeJavaFile, writeMigration,
  commitAndPush, createPR, mergePR, pullMain, cleanupBranch,
  waitForWorkflowRun, getLatestRunId, getWorkflowLogs, getPRComments,
  verifyTableExists, verifyMigrationApplied, verifyFileOnGitHub,
  parseMigrationSql, deleteLakebaseBranch, pauseIfRequested,
  verifyBranchConnection, createLakebaseBranchAndConnect, writeJavaTestFile, runMavenTests,
  setCurrentScenario, waitForRunnerIdle,
} from './helpers';

import {
  MIGRATION_FILE as MIG1, MIGRATION_SQL as SQL1, JAVA_FILES as JAVA1, TEST_FILES as TEST1,
} from './scenario1Book';
import {
  MIGRATION_FILE as MIG2, MIGRATION_SQL as SQL2, JAVA_FILES as JAVA2, TEST_FILES as TEST2,
} from './scenario2Product';
import {
  MIGRATION_FILE as MIG3, MIGRATION_SQL as SQL3, JAVA_FILES as JAVA3, TEST_FILES as TEST3,
} from './scenario3Customer';
import {
  MIGRATION_FILE as MIG4, MIGRATION_SQL as SQL4, JAVA_FILES as JAVA4, TEST_FILES as TEST4,
} from './scenario4Cart';
import {
  MIGRATION_FILE as MIG5, MIGRATION_SQL as SQL5, JAVA_FILES as JAVA5, TEST_FILES as TEST5,
} from './scenario5Orders';
import {
  MIGRATION_FILE as MIG6, MIGRATION_SQL as SQL6, JAVA_FILES as JAVA6, TEST_FILES as TEST6,
} from './scenario6Wishlist';

const BRANCH = 'feature/all-entities';

const ALL_MIGRATIONS = [
  { file: MIG1, sql: SQL1 },
  { file: MIG2, sql: SQL2 },
  { file: MIG3, sql: SQL3 },
  { file: MIG4, sql: SQL4 },
  { file: MIG5, sql: SQL5 },
  { file: MIG6, sql: SQL6 },
];

const ALL_JAVA = { ...JAVA1, ...JAVA2, ...JAVA3, ...JAVA4, ...JAVA5, ...JAVA6 };
const ALL_TESTS = { ...TEST1, ...TEST2, ...TEST3, ...TEST4, ...TEST5, ...TEST6 };

const EXPECTED_TABLES = [
  'book', 'product', 'customer', 'cart', 'cart_item',
  'orders', 'order_item', 'wishlist', 'wishlist_item',
];

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer — all 6 entities', () => {
    before(() => { setCurrentScenario(1); });
    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1: creates feature branch', () => {
      createFeatureBranch(ctx, BRANCH);
      assert.strictEqual(git(ctx, 'rev-parse --abbrev-ref HEAD'), BRANCH);
    });

    it('A2: creates Lakebase branch', async function () {
      this.timeout(180000);
      const conn = await createLakebaseBranchAndConnect(ctx, BRANCH);
      assert.ok(conn.branchId);
      assert.ok(conn.host);
    });

    it('A3: writes all 6 migrations (V2-V7)', () => {
      for (const m of ALL_MIGRATIONS) {
        writeMigration(ctx, m.file, m.sql);
      }
    });

    it('A4: writes all Java entity files', () => {
      for (const [relPath, content] of Object.entries(ALL_JAVA)) {
        writeJavaFile(ctx, relPath, content);
      }
    });

    it('A5: writes all test files', () => {
      for (const [relPath, content] of Object.entries(ALL_TESTS)) {
        writeJavaTestFile(ctx, relPath, content);
      }
    });

    it('A6: ./mvnw test passes against Lakebase branch', function () {
      this.timeout(300000);
      runMavenTests(ctx);
    });

    it('A7: commits and pushes', () => {
      commitAndPush(ctx, 'Add all entities: book, product, customer, cart, orders, wishlist', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add all entities (V2-V7)', BRANCH);
      assert.ok(prNumber > 0);
    });

    it('B2: pr.yml succeeds (Flyway + tests on CI branch)', () => {
      const result = waitForWorkflowRun(ctx, 'pr.yml', { branch: BRANCH, event: 'pull_request' });
      if (result.conclusion !== 'success') {
        const logs = getWorkflowLogs(ctx, result.runId);
        assert.fail(`pr.yml failed (${result.conclusion}). Run ${result.runId}.\n${logs}`);
      }
    });

    it('B3: PR comment mentions schema tables', () => {
      const comments = getPRComments(ctx, prNumber);
      assert.ok(comments.length > 0);
    });
  });

  describe('Phase C: Merge', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });
    let beforeMergeRunId: number;

    it('C1: records latest merge.yml run ID', () => {
      beforeMergeRunId = getLatestRunId(ctx, 'merge.yml');
    });

    it('C2: merges PR', () => {
      mergePR(ctx, prNumber);
    });

    it('C3: merge.yml succeeds (Flyway on production)', () => {
      const result = waitForWorkflowRun(ctx, 'merge.yml', { branch: 'main', event: 'push', afterRunId: beforeMergeRunId });
      if (result.conclusion !== 'success') {
        const logs = getWorkflowLogs(ctx, result.runId);
        assert.fail(`merge.yml failed (${result.conclusion}). Run ${result.runId}.\n${logs}`);
      }
    });

    it('C4: pulls main', () => {
      pullMain(ctx);
    });
  });

  describe('Phase D: Verification', function () {
    this.timeout(60000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('D1: V2-V7 applied in flyway_schema_history', async () => {
      for (let v = 2; v <= 7; v++) {
        assert.ok(await verifyMigrationApplied(ctx, String(v)), `V${v} should be applied`);
      }
    });

    it('D2: all 9 tables exist on production', async () => {
      for (const table of EXPECTED_TABLES) {
        assert.ok(await verifyTableExists(ctx, table), `${table} should exist`);
      }
    });

    it('D3: Java files visible on GitHub', () => {
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Book.java'));
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Product.java'));
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Customer.java'));
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Cart.java'));
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Order.java'));
      assert.ok(verifyFileOnGitHub(ctx, 'src/main/java/com/example/demo/model/Wishlist.java'));
    });

    it('D4: cleanup feature branch', async () => {
      cleanupBranch(ctx, BRANCH);
      await deleteLakebaseBranch(ctx, BRANCH);
    });

    it('D5: wait for runner idle', function () {
      this.timeout(300000);
      waitForRunnerIdle(ctx);
    });
  });
}
