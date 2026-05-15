/**
 * Scenario 8: Schema Evolution — DROP TABLE (Remove Book)
 *
 * Business pivot: books are discontinued. Remove the book entity entirely.
 * Tests: DROP TABLE, deleting Java files, verifying no collateral damage.
 */

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  ScenarioContext, git, createFeatureBranch, deleteJavaFile, writeMigration,
  commitAndPush, createPR, mergePR, pullMain, cleanupBranch,
  waitForWorkflowRun, getLatestRunId, getWorkflowLogs, getPRComments,
  verifyTableExists, verifyTableNotExists, verifyMigrationApplied,
  verifyFileNotOnGitHub, parseMigrationSql, deleteLakebaseBranch,
  verifyBranchConnection, createLakebaseBranchAndConnect, writeJavaTestFile, deleteJavaTestFile, runMavenTests,
  setCurrentScenario, waitForRunnerIdle,
} from './helpers';

const BRANCH = 'feature/remove-book';
const MIGRATION_FILE = 'V9__drop_book_table.sql';
const MIGRATION_SQL = `DROP TABLE IF EXISTS book;
`;

const BOOK_JAVA_FILES = [
  'model/Book.java',
  'repository/BookRepository.java',
  'service/BookService.java',
  'controller/BookController.java',
];

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    before(() => { setCurrentScenario(8); });

    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1: creates feature/remove-book branch', () => {
      createFeatureBranch(ctx, BRANCH);
      const current = git(ctx, 'rev-parse --abbrev-ref HEAD');
      assert.strictEqual(current, BRANCH);
    });

    it('A1b: creates Lakebase branch via LakebaseService', async function () {
      this.timeout(180000);
      const conn = await createLakebaseBranchAndConnect(ctx, BRANCH);
      assert.ok(conn.branchId, 'Lakebase branch ID should be set');
      assert.ok(conn.host, 'Endpoint host should be set');
      assert.ok(conn.username, 'Username should be set');
    });

    it('A1-verify: .env connected to Lakebase branch', () => {
      const conn = verifyBranchConnection(ctx);
      assert.ok(conn.url.includes('jdbc:postgresql://'), 'SPRING_DATASOURCE_URL should be a JDBC URL');
      assert.ok(conn.username, 'SPRING_DATASOURCE_USERNAME should be set');
    });

    it('A2: deletes all 4 Book Java files', () => {
      for (const relPath of BOOK_JAVA_FILES) {
        deleteJavaFile(ctx, relPath);
        const fullPath = path.join(ctx.projectDir, 'src', 'main', 'java', 'com', 'example', 'demo', relPath);
        assert.ok(!fs.existsSync(fullPath), `${relPath} should be deleted`);
      }
    });

    it('A3: writes V9 migration SQL (DROP TABLE)', () => {
      writeMigration(ctx, MIGRATION_FILE, MIGRATION_SQL);
    });

    it('A3-verify: parseSql extracts DROP TABLE book', () => {
      const changes = parseMigrationSql(MIGRATION_SQL);
      assert.strictEqual(changes.length, 1);
      assert.strictEqual(changes[0].type, 'removed');
      assert.strictEqual(changes[0].tableName, 'book');
      assert.strictEqual(changes[0].columns.length, 0);
    });

    it('A4: deletes Book test files', () => {
      deleteJavaTestFile(ctx, 'BookServiceTest.java');
      deleteJavaTestFile(ctx, 'BookControllerTest.java');
    });

    it('A5: ./mvnw test passes against Lakebase branch DB', function () {
      this.timeout(300000);
      runMavenTests(ctx);
    });

    it('A6: commits and pushes', () => {
      commitAndPush(ctx, 'Remove book entity — discontinued product line', BRANCH);
      // Verify git diff shows 4 deletions + 1 addition
      const stat = git(ctx, `diff --stat origin/main...${BRANCH}`);
      assert.ok(stat.includes('V9__drop_book_table.sql'), 'Should show migration file');
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Remove book entity \u2014 discontinued product line', BRANCH);
      assert.ok(prNumber > 0, `PR number should be positive, got ${prNumber}`);
    });

    it('B2: pr.yml succeeds (Flyway + tests on branch DB)', () => {
      const result = waitForWorkflowRun(ctx, 'pr.yml', { branch: BRANCH, event: 'pull_request' });
      if (result.conclusion !== 'success') {
        const logs = getWorkflowLogs(ctx, result.runId);
        assert.fail(`pr.yml failed (${result.conclusion}). Run ${result.runId}. Logs:\n${logs}`);
      }
    });

    it('B3: PR comment contains schema diff', () => {
      const comments = getPRComments(ctx, prNumber);
      assert.ok(comments.length > 0, 'PR should have at least one comment');
      const schemaDiffComment = comments.find(c =>
        c.body.includes('book') &&
        (c.body.includes('DROP') || c.body.includes('REMOVED'))
      );
      assert.ok(schemaDiffComment, 'PR comment should mention book table with DROP/REMOVED');
    });
  });

  describe('Phase C: Merge workflow', function () {
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
        assert.fail(`merge.yml failed (${result.conclusion}). Run ${result.runId}. Logs:\n${logs}`);
      }
    });

    it('C4: pulls main', () => {
      pullMain(ctx);
    });
  });

  describe('Phase D: Verification', function () {
    this.timeout(60000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('D1: V9 applied', async () => { assert.ok(await verifyMigrationApplied(ctx, '9')); });

    it('D2: book table does NOT exist on production', async () => {
      assert.ok(await verifyTableNotExists(ctx, 'book'), 'book table should be gone');
    });

    it('D2: all other tables still exist (no collateral damage)', async () => {
      for (const table of ['product', 'customer', 'cart', 'cart_item', 'orders', 'order_item', 'wishlist', 'wishlist_item']) {
        assert.ok(await verifyTableExists(ctx, table), `${table} should still exist`);
      }
    });

    it('D3: Book Java files absent from GitHub', () => {
      for (const relPath of BOOK_JAVA_FILES) {
        const ghPath = `src/main/java/com/example/demo/${relPath}`;
        assert.ok(verifyFileNotOnGitHub(ctx, ghPath), `${relPath} should not be on GitHub`);
      }
    });

    it('D4: cleanup', async () => {
      cleanupBranch(ctx, BRANCH);
      await deleteLakebaseBranch(ctx, BRANCH);
    });

    it('D5: wait for runner idle', function () {
      this.timeout(300000);
      waitForRunnerIdle(ctx);
    });
  });
}
