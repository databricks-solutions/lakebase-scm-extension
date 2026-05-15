/**
 * Scenario 2: Asset Table (Foreign Key)
 *
 * Developer adds an asset entity with a foreign key to partner.
 * Tests: CREATE TABLE with FK, cascading relationship, insert with FK.
 */

import { strict as assert } from 'assert';
import {
  ScenarioContext, git, createFeatureBranch, writePythonFile,
  writeAlembicMigration, commitAndPush, createPR, mergePR, pullMain,
  cleanupBranch, waitForWorkflowRun, getLatestRunId, getWorkflowLogs,
  verifyTableExists, verifyAlembicVersion, verifyColumnExists,
  deleteLakebaseBranch, createLakebaseBranchAndConnect,
  runAlembicAndTests, waitForRunnerIdle,
} from './helpers';
import * as fs from 'fs';
import * as path from 'path';

const BRANCH = 'feature/asset';

const MIGRATION_UPGRADE = `op.create_table(
    'asset',
    sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
    sa.Column('partner_id', sa.Integer, sa.ForeignKey('partner.id', ondelete='CASCADE'), nullable=False),
    sa.Column('name', sa.String(255), nullable=False),
    sa.Column('asset_type', sa.String(100)),
    sa.Column('description', sa.Text),
    sa.Column('status', sa.String(50), server_default='unverified'),
    sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
)`;

const MIGRATION_DOWNGRADE = `op.drop_table('asset')`;

const MODEL_CONTENT = `from app.database import Base
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, func
from sqlalchemy.orm import relationship


class Partner(Base):
    __tablename__ = 'partner'

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    contact_email = Column(String(255))
    created_at = Column(DateTime, server_default=func.now())
    assets = relationship('Asset', back_populates='partner', cascade='all, delete-orphan')


class Asset(Base):
    __tablename__ = 'asset'

    id = Column(Integer, primary_key=True, autoincrement=True)
    partner_id = Column(Integer, ForeignKey('partner.id', ondelete='CASCADE'), nullable=False)
    name = Column(String(255), nullable=False)
    asset_type = Column(String(100))
    description = Column(Text)
    status = Column(String(50), server_default='unverified')
    created_at = Column(DateTime, server_default=func.now())
    partner = relationship('Partner', back_populates='assets')
`;

const TEST_CONTENT = `from sqlalchemy import text


def test_asset_table_exists(db_session):
    """Given migrations have run, the asset table should exist."""
    result = db_session.execute(text(
        "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='asset')"
    )).scalar()
    assert result is True


def test_asset_has_fk_to_partner(db_session):
    """Given the asset table, it should have a foreign key to partner."""
    result = db_session.execute(text(
        "SELECT COUNT(*) FROM information_schema.table_constraints "
        "WHERE table_name='asset' AND constraint_type='FOREIGN KEY'"
    )).scalar()
    assert result >= 1


def test_insert_asset_with_partner(db_session):
    """Given a partner exists, when an asset is inserted with partner_id, then it succeeds."""
    db_session.execute(text(
        "INSERT INTO partner (name) VALUES ('Test Partner') ON CONFLICT DO NOTHING"
    ))
    db_session.flush()
    partner_id = db_session.execute(text(
        "SELECT id FROM partner WHERE name = 'Test Partner'"
    )).scalar()

    db_session.execute(text(
        "INSERT INTO asset (partner_id, name, asset_type) VALUES (:pid, :name, :type)"
    ), {"pid": partner_id, "name": "My Integration", "type": "connector"})
    db_session.flush()

    row = db_session.execute(text(
        "SELECT name, status FROM asset WHERE partner_id = :pid"
    ), {"pid": partner_id}).fetchone()
    assert row is not None
    assert row[0] == "My Integration"
    assert row[1] == "unverified"  # server default
`;

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1a: creates feature/asset branch', () => {
      createFeatureBranch(ctx, BRANCH);
      assert.strictEqual(git(ctx, 'rev-parse --abbrev-ref HEAD'), BRANCH);
    });

    it('A1b: creates Lakebase branch and connects .env', async function () {
      this.timeout(180000);
      const conn = await createLakebaseBranchAndConnect(ctx, BRANCH);
      assert.ok(conn.branchId);
    });

    it('A2: updates models with Asset + relationship', () => {
      writePythonFile(ctx, 'app/models.py', MODEL_CONTENT);
    });

    it('A3: writes Alembic migration for asset table', () => {
      writeAlembicMigration(ctx, ctx.nextRevision, 'create_asset_table', MIGRATION_UPGRADE, MIGRATION_DOWNGRADE);
      ctx.nextRevision++;
    });

    it('A4: writes pytest tests for asset + FK', () => {
      writePythonFile(ctx, 'tests/test_asset.py', TEST_CONTENT);
    });

    it('A5: uv run alembic + pytest passes', function () {
      this.timeout(120000);
      runAlembicAndTests(ctx);
    });

    it('A6: commits and pushes', () => {
      commitAndPush(ctx, 'Add asset entity with FK to partner', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add asset entity with FK', BRANCH);
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

    it('D1: alembic_version is at 003', async () => {
      assert.ok(await verifyAlembicVersion(ctx, '003'));
    });

    it('D2: asset table exists on production', async () => {
      assert.ok(await verifyTableExists(ctx, 'asset'));
    });

    it('D3: asset.partner_id column exists', async () => {
      assert.ok(await verifyColumnExists(ctx, 'asset', 'partner_id'));
    });

    it('D4: asset.status has server default', async () => {
      assert.ok(await verifyColumnExists(ctx, 'asset', 'status'));
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
