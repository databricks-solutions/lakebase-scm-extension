/**
 * Scenario 4: DROP TABLE (Remove partner + cascade to asset)
 *
 * Developer removes the partner entity. Because asset has a CASCADE FK,
 * both tables must be dropped in the correct order.
 * Tests: DROP TABLE with FK cascade, file cleanup, schema absence verification.
 */

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  ScenarioContext, git, createFeatureBranch, writePythonFile, deleteFile,
  writeAlembicMigration, commitAndPush, createPR, mergePR, pullMain,
  cleanupBranch, waitForWorkflowRun, getLatestRunId, getWorkflowLogs,
  verifyTableNotExists, verifyTableExists, verifyAlembicVersion,
  deleteLakebaseBranch, createLakebaseBranchAndConnect,
  runAlembicAndTests, waitForRunnerIdle, queryProduction,
} from './helpers';

const BRANCH = 'feature/drop-partner';

// Drop asset first (has FK to partner), then partner
const MIGRATION_UPGRADE = `op.drop_table('asset')
op.drop_table('partner')`;

// Recreate in reverse order for downgrade
const MIGRATION_DOWNGRADE = `op.create_table(
    'partner',
    sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
    sa.Column('name', sa.String(255), nullable=False),
    sa.Column('contact_email', sa.String(255)),
    sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
)
op.create_table(
    'asset',
    sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
    sa.Column('partner_id', sa.Integer, sa.ForeignKey('partner.id', ondelete='CASCADE'), nullable=False),
    sa.Column('name', sa.String(255), nullable=False),
    sa.Column('asset_type', sa.String(100)),
    sa.Column('description', sa.Text),
    sa.Column('status', sa.String(50), server_default='unverified'),
    sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
    sa.Column('architecture_review', sa.Text),
    sa.Column('review_status', sa.String(50), server_default='pending'),
    sa.Column('reviewed_at', sa.DateTime),
)`;

// Models file goes back to empty (just Base import)
const EMPTY_MODEL = `from app.database import Base
`;

// Test verifies tables are gone
const TEST_CONTENT = `from sqlalchemy import text


def test_partner_table_dropped(db_session):
    """Given the DROP migration has run, partner table should not exist."""
    result = db_session.execute(text(
        "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='partner')"
    )).scalar()
    assert result is False


def test_asset_table_dropped(db_session):
    """Given the DROP migration has run, asset table should not exist."""
    result = db_session.execute(text(
        "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='asset')"
    )).scalar()
    assert result is False
`;

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1a: creates feature/drop-partner branch', () => {
      createFeatureBranch(ctx, BRANCH);
      assert.strictEqual(git(ctx, 'rev-parse --abbrev-ref HEAD'), BRANCH);
    });

    it('A1b: creates Lakebase branch and connects .env', async function () {
      this.timeout(180000);
      const conn = await createLakebaseBranchAndConnect(ctx, BRANCH);
      assert.ok(conn.branchId);
    });

    it('A2: clears models file and removes entity-specific tests', () => {
      writePythonFile(ctx, 'app/models.py', EMPTY_MODEL);
      deleteFile(ctx, 'tests/test_partner.py');
      deleteFile(ctx, 'tests/test_asset.py');
      deleteFile(ctx, 'tests/test_asset_review.py');
    });

    it('A3: writes DROP TABLE migration', () => {
      writeAlembicMigration(ctx, ctx.nextRevision, 'drop_partner_and_asset', MIGRATION_UPGRADE, MIGRATION_DOWNGRADE);
      ctx.nextRevision++;
    });

    it('A4: writes pytest tests verifying tables are gone', () => {
      writePythonFile(ctx, 'tests/test_drop.py', TEST_CONTENT);
    });

    it('A5: uv run alembic + pytest passes', function () {
      this.timeout(120000);
      runAlembicAndTests(ctx);
    });

    it('A6: commits and pushes', () => {
      commitAndPush(ctx, 'Drop partner and asset tables', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Drop partner and asset tables', BRANCH);
      assert.ok(prNumber > 0);
    });

    it('B2: pr.yml succeeds', () => {
      const result = waitForWorkflowRun(ctx, 'pr.yml', { branch: BRANCH, event: 'pull_request' });
      if (result.conclusion !== 'success') {
        assert.fail(`pr.yml failed (${result.conclusion}). Logs:\n${getWorkflowLogs(ctx, result.runId)}`);
      }
    });
  });

  describe('Phase C: Merge workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });
    let beforeMergeRunId: number;

    it('C1: records latest merge.yml run ID', () => {
      beforeMergeRunId = getLatestRunId(ctx, 'merge.yml');
    });

    it('C2: merges PR', () => { mergePR(ctx, prNumber); });

    it('C3: merge.yml succeeds', () => {
      const result = waitForWorkflowRun(ctx, 'merge.yml', { branch: 'main', event: 'push', afterRunId: beforeMergeRunId });
      if (result.conclusion !== 'success') {
        assert.fail(`merge.yml failed (${result.conclusion}). Logs:\n${getWorkflowLogs(ctx, result.runId)}`);
      }
    });

    it('C4: pulls main', () => { pullMain(ctx); });
  });

  describe('Phase D: Verification', function () {
    this.timeout(60000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('D1: alembic_version is at 005', async () => {
      assert.ok(await verifyAlembicVersion(ctx, '005'));
    });

    it('D2: partner table does NOT exist on production', async () => {
      assert.ok(await verifyTableNotExists(ctx, 'partner'));
    });

    it('D3: asset table does NOT exist on production', async () => {
      assert.ok(await verifyTableNotExists(ctx, 'asset'));
    });

    it('D4: only alembic_version table remains (no app tables)', async () => {
      const count = await queryProduction(ctx,
        "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('alembic_version')"
      );
      assert.strictEqual(parseInt(count, 10), 0, `Expected 0 app tables, got ${count}`);
    });

    it('D5: cleanup feature branch', async () => {
      cleanupBranch(ctx, BRANCH);
      await deleteLakebaseBranch(ctx, BRANCH);
    });

    it('D6: wait for runner idle', function () {
      this.timeout(300000);
      waitForRunnerIdle(ctx);
    });
  });
}
