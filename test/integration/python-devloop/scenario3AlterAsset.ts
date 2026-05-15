/**
 * Scenario 3: ALTER TABLE (Add columns to asset)
 *
 * Developer adds review fields to the existing asset table.
 * Tests: ALTER TABLE ADD COLUMN via Alembic, verify new columns on production.
 */

import { strict as assert } from 'assert';
import {
  ScenarioContext, git, createFeatureBranch, writePythonFile,
  writeAlembicMigration, commitAndPush, createPR, mergePR, pullMain,
  cleanupBranch, waitForWorkflowRun, getLatestRunId, getWorkflowLogs,
  verifyColumnExists, verifyAlembicVersion,
  deleteLakebaseBranch, createLakebaseBranchAndConnect,
  runAlembicAndTests, waitForRunnerIdle,
} from './helpers';
import * as fs from 'fs';
import * as path from 'path';

const BRANCH = 'feature/asset-review';

const MIGRATION_UPGRADE = `op.add_column('asset', sa.Column('architecture_review', sa.Text))
op.add_column('asset', sa.Column('review_status', sa.String(50), server_default='pending'))
op.add_column('asset', sa.Column('reviewed_at', sa.DateTime))`;

const MIGRATION_DOWNGRADE = `op.drop_column('asset', 'reviewed_at')
op.drop_column('asset', 'review_status')
op.drop_column('asset', 'architecture_review')`;

const UPDATED_MODEL = `from app.database import Base
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
    # Review fields (added in scenario 3)
    architecture_review = Column(Text)
    review_status = Column(String(50), server_default='pending')
    reviewed_at = Column(DateTime)
    partner = relationship('Partner', back_populates='assets')
`;

const TEST_CONTENT = `from sqlalchemy import text


def test_architecture_review_column_exists(db_session):
    """Given the ALTER migration has run, architecture_review column should exist."""
    result = db_session.execute(text(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
        "WHERE table_name='asset' AND column_name='architecture_review')"
    )).scalar()
    assert result is True


def test_review_status_default(db_session):
    """Given a new asset, review_status should default to 'pending'."""
    # Insert a partner first
    db_session.execute(text(
        "INSERT INTO partner (name) VALUES ('Review Test Partner') ON CONFLICT DO NOTHING"
    ))
    db_session.flush()
    pid = db_session.execute(text(
        "SELECT id FROM partner WHERE name = 'Review Test Partner'"
    )).scalar()

    db_session.execute(text(
        "INSERT INTO asset (partner_id, name) VALUES (:pid, 'Review Test Asset')"
    ), {"pid": pid})
    db_session.flush()

    row = db_session.execute(text(
        "SELECT review_status FROM asset WHERE name = 'Review Test Asset'"
    )).fetchone()
    assert row is not None
    assert row[0] == "pending"


def test_reviewed_at_nullable(db_session):
    """Given reviewed_at is nullable, it should be NULL for new rows."""
    row = db_session.execute(text(
        "SELECT reviewed_at FROM asset LIMIT 1"
    )).fetchone()
    if row:
        assert row[0] is None
`;

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1a: creates feature/asset-review branch', () => {
      createFeatureBranch(ctx, BRANCH);
      assert.strictEqual(git(ctx, 'rev-parse --abbrev-ref HEAD'), BRANCH);
    });

    it('A1b: creates Lakebase branch and connects .env', async function () {
      this.timeout(180000);
      const conn = await createLakebaseBranchAndConnect(ctx, BRANCH);
      assert.ok(conn.branchId);
    });

    it('A2: updates model with review fields', () => {
      writePythonFile(ctx, 'app/models.py', UPDATED_MODEL);
    });

    it('A3: writes ALTER TABLE migration', () => {
      writeAlembicMigration(ctx, ctx.nextRevision, 'add_asset_review_fields', MIGRATION_UPGRADE, MIGRATION_DOWNGRADE);
      ctx.nextRevision++;
    });

    it('A4: writes pytest tests for new columns', () => {
      writePythonFile(ctx, 'tests/test_asset_review.py', TEST_CONTENT);
    });

    it('A5: uv run alembic + pytest passes', function () {
      this.timeout(120000);
      runAlembicAndTests(ctx);
    });

    it('A6: commits and pushes', () => {
      commitAndPush(ctx, 'Add architecture review fields to asset', BRANCH);
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add review fields to asset', BRANCH);
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

    it('D1: alembic_version is at 004', async () => {
      assert.ok(await verifyAlembicVersion(ctx, '004'));
    });

    it('D2: architecture_review column exists', async () => {
      assert.ok(await verifyColumnExists(ctx, 'asset', 'architecture_review'));
    });

    it('D3: review_status column exists', async () => {
      assert.ok(await verifyColumnExists(ctx, 'asset', 'review_status'));
    });

    it('D4: reviewed_at column exists', async () => {
      assert.ok(await verifyColumnExists(ctx, 'asset', 'reviewed_at'));
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
