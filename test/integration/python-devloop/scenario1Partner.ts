/**
 * Scenario 1: Partner Table (Initial Feature)
 *
 * Developer adds a partner entity to the app.
 * Tests: CREATE TABLE via Alembic, SQLAlchemy model, pytest, first PR through the pipeline.
 */

import { strict as assert } from 'assert';
import {
  ScenarioContext, git, createFeatureBranch, writePythonFile,
  writeAlembicMigration, commitAndPush, createPR, mergePR, pullMain,
  cleanupBranch, waitForWorkflowRun, getLatestRunId, getWorkflowLogs,
  verifyTableExists, verifyAlembicVersion, verifyFileOnGitHub,
  deleteLakebaseBranch, verifyBranchConnection, createLakebaseBranchAndConnect,
  runAlembicAndTests, waitForRunnerIdle,
} from './helpers';

const BRANCH = 'feature/partner';

const MIGRATION_UPGRADE = `op.create_table(
    'partner',
    sa.Column('id', sa.Integer, primary_key=True, autoincrement=True),
    sa.Column('name', sa.String(255), nullable=False),
    sa.Column('contact_email', sa.String(255)),
    sa.Column('created_at', sa.DateTime, server_default=sa.func.now()),
)`;

const MIGRATION_DOWNGRADE = `op.drop_table('partner')`;

const MODEL_CONTENT = `from app.database import Base
from sqlalchemy import Column, Integer, String, DateTime, func


class Partner(Base):
    __tablename__ = 'partner'

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    contact_email = Column(String(255))
    created_at = Column(DateTime, server_default=func.now())
`;

const TEST_CONTENT = `from sqlalchemy import text


def test_partner_table_exists(db_session):
    """Given the database has been migrated, the partner table should exist."""
    result = db_session.execute(text(
        "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='partner')"
    )).scalar()
    assert result is True


def test_insert_and_read_partner(db_session):
    """Given a new partner, when inserted, then it can be read back."""
    db_session.execute(text(
        "INSERT INTO partner (name, contact_email) VALUES (:name, :email)"
    ), {"name": "Acme Corp", "email": "acme@example.com"})
    db_session.flush()

    row = db_session.execute(text("SELECT name, contact_email FROM partner WHERE name = 'Acme Corp'")).fetchone()
    assert row is not None
    assert row[0] == "Acme Corp"
    assert row[1] == "acme@example.com"
`;

export function runScenario(ctx: ScenarioContext): void {
  let prNumber: number;
  let phaseAFailed = false;

  describe('Phase A: Developer', () => {
    afterEach(function () {
      if (this.currentTest?.state === 'failed') { phaseAFailed = true; }
    });

    it('A1a: creates feature/partner branch', () => {
      createFeatureBranch(ctx, BRANCH);
      assert.strictEqual(git(ctx, 'rev-parse --abbrev-ref HEAD'), BRANCH);
    });

    it('A1b: creates Lakebase branch and connects .env', async function () {
      this.timeout(180000);
      const conn = await createLakebaseBranchAndConnect(ctx, BRANCH);
      assert.ok(conn.branchId);
      assert.ok(conn.host);
    });

    it('A1-verify: .env has DATABASE_URL', () => {
      const conn = verifyBranchConnection(ctx);
      assert.ok(conn.url.includes('psycopg://'));
    });

    it('A2: writes SQLAlchemy model', () => {
      writePythonFile(ctx, 'app/models.py', MODEL_CONTENT);
    });

    it('A3: writes Alembic migration', () => {
      writeAlembicMigration(ctx, 2, 'create_partner_table', MIGRATION_UPGRADE, MIGRATION_DOWNGRADE);
      ctx.nextRevision = 3;
    });

    it('A4: writes pytest tests', () => {
      writePythonFile(ctx, 'tests/test_partner.py', TEST_CONTENT);
    });

    it('A5: uv run alembic + pytest passes', function () {
      this.timeout(120000);
      runAlembicAndTests(ctx);
    });

    it('A6: commits and pushes', () => {
      commitAndPush(ctx, 'Add partner entity with CRUD', BRANCH);
      assert.ok(git(ctx, 'log --oneline -1').includes('Add partner entity'));
    });
  });

  describe('Phase B: PR workflow', function () {
    this.timeout(420000);
    before(function () { if (phaseAFailed) { this.skip(); } });

    it('B1: creates PR', () => {
      prNumber = createPR(ctx, 'Add partner entity', BRANCH);
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

    it('C2: merges PR', () => {
      mergePR(ctx, prNumber);
    });

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

    it('D1: alembic_version is at 002', async () => {
      assert.ok(await verifyAlembicVersion(ctx, '002'));
    });

    it('D2: partner table exists on production', async () => {
      assert.ok(await verifyTableExists(ctx, 'partner'));
    });

    it('D3: Python files visible on GitHub', () => {
      assert.ok(verifyFileOnGitHub(ctx, 'app/models.py'));
      assert.ok(verifyFileOnGitHub(ctx, 'alembic/versions/002_create_partner_table.py'));
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
