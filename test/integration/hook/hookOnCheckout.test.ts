/**
 * Small repro for the post-checkout hook.
 *
 * Exercises ONLY the hook + Lakebase branch ops + git checkouts -
 * no GitHub repo, no self-hosted runner, no Maven project, no PR/merge
 * scenarios. Runs in ~90s vs ~30 min for the full e-commerce suite,
 * so it's the right loop for diagnosing why the alpha.9 hook silently
 * fails to write LAKEBASE_BRANCH_ID to .env during a real test run.
 *
 * The hook is INSTRUMENTED here: a small prologue redirects stderr
 * (and `set -x` trace) to /tmp/lakebase-hook.log so silent early
 * exits leave a forensic trail. Instrumentation lives in the test
 * (not the kit's template) so substrate consumers don't pay for
 * our debug needs.
 *
 * Pre-flight: same as the ecommerce suite - DATABRICKS_TEST_HOST set
 * + authenticated databricks CLI.
 *
 * Run: npm run test:integration -- --grep "post-checkout hook"
 */

import { strict as assert } from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LakebaseService } from '../../../src/services/lakebaseService';
import {
  createLongRunningBranch,
  deployScripts,
  installHooks,
} from '@databricks-solutions/lakebase-app-dev-kit';
import { assertIntegrationCredentials } from '../lib/credentials';

const HOOK_LOG = '/tmp/lakebase-hook.log';

describe('post-checkout hook (small repro)', function () {
  this.timeout(300000); // 5 min

  let projectName: string;
  let projectDir: string;
  let bareRepoDir: string;
  let lakebaseService: LakebaseService;
  let dbHost: string;

  before(async function () {
    const creds = assertIntegrationCredentials();
    dbHost = creds.databricksHost;
    process.env.DATABRICKS_HOST = dbHost;

    // Fresh hook log each run.
    try { fs.unlinkSync(HOOK_LOG); } catch { /* ignore */ }

    projectName = `lbhook-${Date.now().toString(36)}`;
    const parent = os.homedir();
    projectDir = path.join(parent, projectName);
    bareRepoDir = path.join(parent, `${projectName}.git`);

    console.log(`\n  Project: ${projectName}`);
    console.log(`  Dir: ${projectDir}`);
    console.log(`  Bare: ${bareRepoDir}`);
    console.log(`  Host: ${dbHost}`);
    console.log(`  Hook log: ${HOOK_LOG}\n`);

    // 1. Create the Lakebase project. This blocks until the project's
    //    default branch is ready, so no extra polling needed.
    lakebaseService = new LakebaseService();
    lakebaseService.setHostOverride(dbHost);
    lakebaseService.setProjectIdOverride(projectName);
    console.log(`  [setup] Creating Lakebase project...`);
    const created = await lakebaseService.createProject(projectName);
    console.log(`  [setup] Lakebase project ready (state=${created.state}).`);

    // 2. Init local bare repo as origin + working tree on main.
    fs.mkdirSync(bareRepoDir, { recursive: true });
    cp.execSync('git init --bare', { cwd: bareRepoDir, stdio: 'pipe' });
    fs.mkdirSync(projectDir, { recursive: true });
    cp.execSync('git init -b main', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync(`git remote add origin "${bareRepoDir}"`, { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git config user.name "Hook Repro"', { cwd: projectDir, stdio: 'pipe' });
    // Deliberately do NOT set core.hooksPath here - the substrate's
    // install-hook.sh / installHooks() are supposed to pin it themselves
    // (alpha.10). This test is the regression guard for that. If the
    // substrate ever stops pinning core.hooksPath, the contributor's
    // global config (e.g. /Users/<u>/.databricks/githooks) shadows the
    // hook we install below and these tests fail with .env never being
    // written. We replicate install-hook.sh's pin step manually below
    // because we copy the hook directly (skipping install-hook.sh).

    // 3. Minimal .env. Matches what deployEnv writes during scaffold:
    //    DATABRICKS_HOST + LAKEBASE_PROJECT_ID, no LAKEBASE_BRANCH_ID
    //    (hook is supposed to write that on first checkout).
    fs.writeFileSync(
      path.join(projectDir, '.env'),
      [`DATABRICKS_HOST=${dbHost}`, `LAKEBASE_PROJECT_ID=${projectName}`, ''].join('\n'),
    );

    // 4. Use the substrate's deployScripts + installHooks primitives -
    //    exactly what a real VS Code scaffold runs. deployScripts copies
    //    EVERY common script into <projectDir>/scripts; installHooks
    //    wires .git/hooks AND pins core.hooksPath to .git/hooks (the
    //    alpha.10 fix). If installHooks ever stops pinning the path,
    //    this test fails with .env never being written - regression
    //    guard for the fix.
    await deployScripts(projectDir);
    await installHooks(projectDir);

    // 5. Patch the installed hook with diagnostic instrumentation.
    //    Redirects stderr + xtrace to HOOK_LOG so silent early exits
    //    are visible. Insertion immediately after the shebang.
    const hookDest = path.join(projectDir, '.git', 'hooks', 'post-checkout');
    let hookContent = fs.readFileSync(hookDest, 'utf-8');
    const shebangEnd = hookContent.indexOf('\n') + 1;
    const instrumentation =
      `# === instrumentation (small-repro test only) ===\n` +
      `exec 2>>${HOOK_LOG}\n` +
      `echo "" >&2\n` +
      `echo "=== hook fired $(date) PREV=$1 NEW=$2 BRANCH_CHECKOUT=$3 ===" >&2\n` +
      `set -x\n`;
    hookContent = hookContent.slice(0, shebangEnd) + instrumentation + hookContent.slice(shebangEnd);
    fs.writeFileSync(hookDest, hookContent, { mode: 0o755 });

    // Assert the substrate pinned core.hooksPath - this is the alpha.10
    // regression guard. If install-hook.sh stops doing this, every other
    // assertion in this suite is meaningless because the hook never runs.
    const pinnedPath = cp
      .execSync('git config --local --get core.hooksPath', { cwd: projectDir })
      .toString()
      .trim();
    assert.equal(
      pinnedPath,
      '.git/hooks',
      'install-hook.sh must pin core.hooksPath to .git/hooks (alpha.10 regression guard)',
    );

    // 5. Initial commit + push to main. Hook does NOT fire on commit
    //    or push - only on checkout.
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# hook repro\n');
    cp.execSync('git add .', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git commit -m initial', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git push -u origin main', { cwd: projectDir, stdio: 'pipe' });
    console.log(`  [setup] Local repo ready on main.\n`);
  });

  it('createLongRunningBranch cuts staging + hook writes LAKEBASE_BRANCH_ID=staging to .env', async function () {
    console.log(`  [test] Calling createLongRunningBranch...`);
    await createLongRunningBranch({
      name: 'staging',
      forkFromBranch: 'main',
      projectId: projectName,
      workTreeDir: projectDir,
      databricksHost: dbHost,
    });
    console.log(`  [test] createLongRunningBranch returned.\n`);

    const env = fs.readFileSync(path.join(projectDir, '.env'), 'utf-8');
    console.log(`---.env after createLongRunningBranch---\n${env}\n---`);

    if (fs.existsSync(HOOK_LOG)) {
      const log = fs.readFileSync(HOOK_LOG, 'utf-8');
      console.log(`---hook log (${log.length} bytes)---\n${log}\n---`);
    } else {
      console.log(`---hook log: NOT WRITTEN (hook never fired or stderr redirect failed)---`);
    }

    assert.match(
      env,
      /^LAKEBASE_BRANCH_ID=staging$/m,
      '.env must have LAKEBASE_BRANCH_ID=staging after createLongRunningBranch + git checkout staging',
    );
  });

  it('git checkout -b feature/test-fork forks Lakebase branch from staging', async function () {
    cp.execSync('git checkout -b feature/test-fork', {
      cwd: projectDir,
      stdio: 'pipe',
      timeout: 180_000,
    });

    const env = fs.readFileSync(path.join(projectDir, '.env'), 'utf-8');
    console.log(`---.env after feature checkout---\n${env}\n---`);

    assert.match(
      env,
      /^LAKEBASE_BRANCH_ID=feature-test-fork$/m,
      '.env must point at the feature branch after checkout',
    );

    // Verify Lakebase: the feature branch's source must be 'staging',
    // NOT the default branch. This is the production chain bug we keep
    // hitting in the full suite.
    const raw = cp
      .execSync(`databricks postgres list-branches "projects/${projectName}" -o json`, {
        env: { ...process.env, DATABRICKS_HOST: dbHost },
        timeout: 30_000,
      })
      .toString();
    const parsed = JSON.parse(raw) as unknown;
    const branches = (Array.isArray(parsed)
      ? parsed
      : ((parsed as { branches?: unknown[] }).branches ?? [])) as Array<{
      name?: string;
      spec?: { source_branch?: string };
      status?: { source_branch?: string };
    }>;
    const featureBranch = branches.find(
      (b) => typeof b.name === 'string' && b.name.endsWith('/branches/feature-test-fork'),
    );
    console.log(`  feature-test-fork branch metadata: ${JSON.stringify(featureBranch, null, 2)}`);
    assert.ok(featureBranch, 'feature-test-fork should exist in Lakebase');
    const src = featureBranch.spec?.source_branch || featureBranch.status?.source_branch || '';
    assert.match(
      src,
      /branches\/staging$/,
      `feature-test-fork must fork from staging; got source=${src}`,
    );
  });

  // Regression guard for the inter-scenario chain bug from the ecom suite.
  //
  // Shape of the bug: scenario N's Phase D leaves the working tree on
  // ctx.baseBranch but .env's LAKEBASE_BRANCH_ID still points at the
  // prior feature (because no checkout happened since then to fire the
  // hook). Scenario N+1's createFeatureBranch sees `current === base`
  // and previously SKIPPED the explicit `git checkout base`, so the
  // next `git checkout -b new-feature` reads a stale parent and the
  // new Lakebase branch forks from the wrong place (chain bug).
  //
  // The helper now always runs the explicit checkout, relying on git's
  // post-checkout firing with BRANCH_CHECKOUT=1 even when the ref
  // doesn't change. This test pins that assumption: if a future git
  // change ever stops firing post-checkout on no-op branch checkouts,
  // we fail here in 30s instead of cascading through a 40-min full
  // ecom run.
  it('no-op `git checkout <samebranch>` still fires the hook and refreshes .env', function () {
    // Get back to staging via a real branch change so .env starts in a
    // known-clean state (LAKEBASE_BRANCH_ID=staging).
    cp.execSync('git checkout staging', { cwd: projectDir, stdio: 'pipe', timeout: 60_000 });
    let env = fs.readFileSync(path.join(projectDir, '.env'), 'utf-8');
    assert.match(env, /^LAKEBASE_BRANCH_ID=staging$/m, 'precondition: .env should be on staging');

    // Corrupt .env to simulate the chain-bug condition: branch id stuck
    // on a prior feature even though working tree is on staging.
    const corrupted = env.replace(
      /^LAKEBASE_BRANCH_ID=.+$/m,
      'LAKEBASE_BRANCH_ID=feature-stale-leftover',
    );
    fs.writeFileSync(path.join(projectDir, '.env'), corrupted);

    // No-op checkout: we are already on staging. The hook MUST still
    // fire and rewrite .env back to staging.
    cp.execSync('git checkout staging', { cwd: projectDir, stdio: 'pipe', timeout: 60_000 });

    env = fs.readFileSync(path.join(projectDir, '.env'), 'utf-8');
    assert.match(
      env,
      /^LAKEBASE_BRANCH_ID=staging$/m,
      'no-op `git checkout staging` must re-fire the hook and reset .env to staging; ' +
        'if this fails, the inter-scenario chain bug returns.',
    );
  });

  after(async function () {
    // Teardown - this is a transient repro, not a debuggable run.
    if (process.env.LBHOOK_NO_TEARDOWN === '1') {
      console.log(`  [teardown] skipped (LBHOOK_NO_TEARDOWN=1).`);
      console.log(`  Project preserved: ${projectName}`);
      console.log(`  Dir: ${projectDir}`);
      console.log(`  Bare: ${bareRepoDir}`);
      return;
    }
    try {
      console.log(`  [teardown] Deleting Lakebase project ${projectName}...`);
      await lakebaseService.deleteProject(projectName);
    } catch (e) {
      console.log(`  [teardown] Lakebase delete failed (continuing): ${(e as Error)?.message}`);
    }
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(bareRepoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`  [teardown] Done.`);
  });
});
