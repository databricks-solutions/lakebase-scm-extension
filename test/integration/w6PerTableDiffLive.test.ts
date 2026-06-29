/**
 * W6 Live Integration: per-table schema diff on a forked feature branch.
 *
 * The eval found the per-table schema-diff crashed with a `name.trim` TypeError
 * when the target branch's parent was recorded only as a Lakebase resource path
 * (an empty short-name flowed into normalizeTierName). The fix made the
 * extension's branch-name normalize null-safe (schemaDiffService + tiers, via
 * normalizeBranchName). This test exercises the REAL path end-to-end: provision
 * a project, fork a feature branch off the default (so its source is a resource
 * path), then run SchemaDiffService.compareBranchSchemas against the fork and
 * assert it returns a result WITHOUT crashing (no TypeError / `.trim`).
 *
 * Gated on LAKEBASE_TEST_E2E=1 + DATABRICKS_TEST_HOST. Run SCOPED (never the
 * full test:integration glob):
 *   TS_NODE_TRANSPILE_ONLY=1 npx mocha --require test/setup.js \
 *     --require ts-node/register 'test/integration/w6PerTableDiffLive.test.ts' --timeout 240000
 */

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LakebaseService } from '../../src/services/lakebaseService';
import { SchemaDiffService } from '../../src/services/schemaDiffService';
import {
  createLakebaseProject,
  deleteLakebaseProject,
} from '@databricks-solutions/lakebase-app-dev-kit';

const liveE2E = process.env.LAKEBASE_TEST_E2E === '1';
const host = (process.env.DATABRICKS_TEST_HOST || '').trim();
const ready = liveE2E && !!host;

(ready ? describe : describe.skip)('W6 per-table diff – Live Integration', function () {
  this.timeout(240000);

  const projectId = `w6-pertable-${Date.now().toString(36)}`;
  let lakebaseService: LakebaseService;
  let schemaDiffService: SchemaDiffService;
  let projectDir: string;
  let forkedBranchId: string;
  let provisioned = false;
  const prevProjectDir = process.env.LAKEBASE_PROJECT_DIR;

  before(async function () {
    this.timeout(180000);
    // Provision a fresh project so we control the fork + teardown.
    await createLakebaseProject({ projectId, host });
    provisioned = true;

    lakebaseService = new LakebaseService();
    lakebaseService.setHostOverride(host);
    lakebaseService.setProjectIdOverride(projectId);

    const def = await lakebaseService.getDefaultBranch();
    assert.ok(def, 'project should have a default branch');
    console.log(`  default branch: ${def!.branchId}`);

    // Fork a feature branch off the default. Its Lakebase source_branch is the
    // default's resource path , the W6 trigger shape.
    const forked = await lakebaseService.createBranch('feature/w6-probe', def!.branchId);
    assert.ok(forked, 'forked feature branch should be created');
    forkedBranchId = forked!.branchId;
    console.log(`  forked branch: ${forkedBranchId}`);

    // Drive getConfig()/getEnvConfig() headlessly: getWorkspaceRoot() falls
    // back to LAKEBASE_PROJECT_DIR, and getConfig reads .env there.
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `w6-${projectId}-`));
    fs.writeFileSync(
      path.join(projectDir, '.env'),
      `LAKEBASE_PROJECT_ID=${projectId}\nLAKEBASE_BRANCH_ID=${forkedBranchId}\nDATABRICKS_HOST=${host}\n`,
    );
    process.env.LAKEBASE_PROJECT_DIR = projectDir;

    schemaDiffService = new SchemaDiffService(lakebaseService);
  });

  it('compareBranchSchemas on the forked branch returns a result, no name.trim crash', async function () {
    this.timeout(120000);
    let result: any;
    let threw: unknown;
    try {
      result = await schemaDiffService.compareBranchSchemas(forkedBranchId, /* force */ true);
    } catch (err) {
      threw = err;
    }
    // The W6 bug was a synchronous TypeError (`Cannot read properties of
    // undefined (reading 'trim')`) thrown out of resolveComparisonBranch.
    assert.ok(!threw, `compareBranchSchemas must not throw (got: ${threw instanceof Error ? threw.message : String(threw)})`);
    assert.ok(result, 'should return a SchemaDiffResult');
    // If the diff couldn't be computed for an unrelated reason, the result
    // carries an `error` string , but it must NOT be the .trim crash.
    if (result.error) {
      assert.ok(!/trim|TypeError|undefined/i.test(result.error),
        `diff error must not be the normalize crash (got: ${result.error})`);
    }
    console.log(`  result: ${result.error ? `error="${result.error}"` : `inSync=${result.inSync}, created=${result.created?.length ?? 0}, modified=${result.modified?.length ?? 0}`}`);
  });

  after(async function () {
    this.timeout(60000);
    if (prevProjectDir === undefined) { delete process.env.LAKEBASE_PROJECT_DIR; }
    else { process.env.LAKEBASE_PROJECT_DIR = prevProjectDir; }
    if (projectDir && fs.existsSync(projectDir)) {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* */ }
    }
    if (provisioned) {
      try { await deleteLakebaseProject({ projectId, host }); } catch { /* best effort */ }
    }
  });
});
