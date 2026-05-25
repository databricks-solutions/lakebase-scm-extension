/**
 * Small repro for the post-merge hook (Lakebase branch cleanup + ref prune).
 *
 * Exercises post-merge.sh end-to-end: parses the squash-merge commit, calls
 * delete-lakebase-branches.sh, prunes stale remotes, and deletes local
 * branches with `: gone]` upstream. Runs in ~90s vs ~30 min for the full
 * e-commerce suite, so it's the right loop for diagnosing why a feature's
 * Lakebase branch isn't getting cleaned up after PR merge.
 *
 * No GitHub repo - we use a local bare repo as origin to simulate the
 * "feature branch deleted upstream" state. The hook only cares about the
 * commit message format and `git branch -vv` showing `: gone]`, both of
 * which we can stage locally.
 *
 * Pre-flight: same as the ecommerce suite - DATABRICKS_TEST_HOST set
 * + authenticated databricks CLI.
 *
 * Run: npm run test:integration -- --grep "post-merge hook"
 */

import { strict as assert } from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LakebaseService } from '../../../src/services/lakebaseService';
import {
  createBranch,
  deployScripts,
  installHooks,
  listBranches,
} from '@databricks-solutions/lakebase-app-dev-kit';
import { assertIntegrationCredentials } from '../lib/credentials';

const HOOK_LOG = '/tmp/lakebase-post-merge.log';

describe('post-merge hook (small repro)', function () {
  this.timeout(300000); // 5 min

  let projectName: string;
  let projectDir: string;
  let bareRepoDir: string;
  let lakebaseService: LakebaseService;
  let dbHost: string;
  const featureGit = 'feature/post-merge-test';
  const featureLakebase = 'feature-post-merge-test';
  const prNumber = '42';

  before(async function () {
    const creds = assertIntegrationCredentials();
    dbHost = creds.databricksHost;
    process.env.DATABRICKS_HOST = dbHost;

    try { fs.unlinkSync(HOOK_LOG); } catch { /* ignore */ }

    projectName = `lbpmerge-${Date.now().toString(36)}`;
    const parent = os.homedir();
    projectDir = path.join(parent, projectName);
    bareRepoDir = path.join(parent, `${projectName}.git`);

    console.log(`\n  Project: ${projectName}`);
    console.log(`  Dir: ${projectDir}`);
    console.log(`  Host: ${dbHost}\n`);

    // 1. Provision Lakebase project + a feature branch + a CI ephemeral branch.
    //    The hook deletes both shapes after a merge (feature-* and ci-pr-*).
    lakebaseService = new LakebaseService();
    lakebaseService.setHostOverride(dbHost);
    lakebaseService.setProjectIdOverride(projectName);
    console.log(`  [setup] Creating Lakebase project...`);
    await lakebaseService.createProject(projectName);

    console.log(`  [setup] Creating Lakebase branches: ${featureLakebase} + ci-pr-${prNumber}...`);
    await createBranch({ branch: featureLakebase, instance: projectName, host: dbHost });
    await createBranch({ branch: `ci-pr-${prNumber}`, instance: projectName, host: dbHost });

    // 2. Init local repo with main + a feature branch tracking the bare
    //    remote. Use a long-running branch helper for main parity with how
    //    a real project comes up.
    fs.mkdirSync(bareRepoDir, { recursive: true });
    cp.execSync('git init --bare', { cwd: bareRepoDir, stdio: 'pipe' });
    fs.mkdirSync(projectDir, { recursive: true });
    cp.execSync('git init -b main', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync(`git remote add origin "${bareRepoDir}"`, { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git config user.name "Post-Merge Repro"', { cwd: projectDir, stdio: 'pipe' });

    // 3. Minimal .env (LAKEBASE_PROJECT_ID is what the hook needs).
    fs.writeFileSync(
      path.join(projectDir, '.env'),
      [`DATABRICKS_HOST=${dbHost}`, `LAKEBASE_PROJECT_ID=${projectName}`, ''].join('\n'),
    );

    // 4. Use the substrate's deployScripts + installHooks primitives -
    //    exactly what a real VS Code scaffold runs. deployScripts copies
    //    EVERY common script into <projectDir>/scripts (post-merge,
    //    sanitize-branch-name, delete-lakebase-branches, etc.) and
    //    installHooks then wires .git/hooks + pins core.hooksPath.
    await deployScripts(projectDir);
    await installHooks(projectDir);

    // 5. Instrument the installed hook so failures leave a forensic log.
    const hookDest = path.join(projectDir, '.git', 'hooks', 'post-merge');
    let hookContent = fs.readFileSync(hookDest, 'utf-8');
    const shebangEnd = hookContent.indexOf('\n') + 1;
    const instrumentation =
      `# === instrumentation (small-repro test only) ===\n` +
      `exec 2>>${HOOK_LOG}\n` +
      `echo "" >&2\n` +
      `echo "=== post-merge fired $(date) BRANCH=$(git rev-parse --abbrev-ref HEAD) ===" >&2\n` +
      `set -x\n`;
    hookContent = hookContent.slice(0, shebangEnd) + instrumentation + hookContent.slice(shebangEnd);
    fs.writeFileSync(hookDest, hookContent, { mode: 0o755 });

    // 6. Create initial commit on main + push, then create + push the
    //    feature branch, then delete it from the bare remote so the
    //    local branch shows `: gone]` on next fetch (mimicking what
    //    happens after a real PR merge with auto-delete-head-branch).
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# post-merge repro\n');
    cp.execSync('git add .', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git commit -m initial', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git push -u origin main', { cwd: projectDir, stdio: 'pipe' });

    cp.execSync(`git checkout -b ${featureGit}`, { cwd: projectDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(projectDir, 'feature.md'), '# feature work\n');
    cp.execSync('git add .', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git commit -m "feature work"', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync(`git push -u origin ${featureGit}`, { cwd: projectDir, stdio: 'pipe' });

    // Simulate "branch auto-deleted on PR merge": remove from the bare
    // remote so the next `git fetch --prune` sees it as gone.
    cp.execSync(`git --git-dir="${bareRepoDir}" branch -D ${featureGit}`, { stdio: 'pipe' });

    // 7. Switch back to main + simulate a squash-merge of the feature.
    //    The hook only runs on main and parses the commit message for
    //    (#42) and "from feature/...", so produce exactly that.
    cp.execSync('git checkout main', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync(
      `git commit --allow-empty -m "Feature work (#${prNumber}) from ${featureGit}"`,
      { cwd: projectDir, stdio: 'pipe' },
    );
    console.log(`  [setup] Local repo + Lakebase branches staged.\n`);
  });

  it('post-merge.sh deletes the ci-pr Lakebase branch + leaves unrelated branches alone', async function () {
    // Scope note: feature-branch cleanup is intentionally NOT asserted here.
    // The substrate currently extracts FEATURE_BRANCH from the squash-commit
    // body via grep, which fails in default gh squash-merge output (the body
    // doesn't contain "from <branch>"). FEIP-7116 tracks switching to
    // `gh pr view --json headRefName`. That path requires a real GitHub PR
    // to look up, which this local-bare-repo small repro deliberately
    // doesn't have - feature-branch cleanup with a live PR is exercised by
    // the ecom integration suite.
    //
    // What this test DOES validate:
    //   - The hook fires and runs through (substrate PR #22 helper discovery).
    //   - ci-pr-<N> cleanup works via PR_NUM extraction from the subject.
    //   - The hook does NOT incidentally delete unrelated branches when
    //     the FEATURE_BRANCH source is unavailable. This is the regression
    //     guard for FEIP-7116 - whatever fallback the substrate picks for
    //     missing-gh, it must not pick up false positives from arbitrary
    //     body content (e.g. the schema-diff template).
    let before = await listBranches({ instance: projectName, host: dbHost });
    const haveFeature = before.some((b) => b.name?.endsWith(`/branches/${featureLakebase}`));
    const haveCi = before.some((b) => b.name?.endsWith(`/branches/ci-pr-${prNumber}`));
    assert.ok(haveFeature, `precondition: ${featureLakebase} should exist before hook fires`);
    assert.ok(haveCi, `precondition: ci-pr-${prNumber} should exist before hook fires`);

    console.log(`  [test] Invoking post-merge hook...`);
    cp.execSync('.git/hooks/post-merge 0 0 1', { cwd: projectDir, stdio: 'pipe', timeout: 60_000 });

    if (fs.existsSync(HOOK_LOG)) {
      const log = fs.readFileSync(HOOK_LOG, 'utf-8');
      console.log(`---hook log (${log.length} bytes)---\n${log.slice(-2000)}\n---`);
    }

    // Poll for ci-pr-<N> absence; the hook calls delete-lakebase-branches.sh
    // which is fire-and-forget. featureLakebase should remain present.
    const deadline = Date.now() + 60_000;
    let remainingCi = true;
    let remainingFeature = true;
    while (Date.now() < deadline && remainingCi) {
      const after = await listBranches({ instance: projectName, host: dbHost });
      remainingCi = after.some((b) => b.name?.endsWith(`/branches/ci-pr-${prNumber}`));
      remainingFeature = after.some((b) => b.name?.endsWith(`/branches/${featureLakebase}`));
      if (remainingCi) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    assert.equal(remainingCi, false, `ci-pr-${prNumber} should have been deleted`);
    assert.equal(
      remainingFeature,
      true,
      `${featureLakebase} should still exist - the hook must not pick up false-positive feature-branch names ` +
        `from arbitrary commit-body content (FEIP-7116 regression guard)`,
    );
  });

  it('post-merge.sh prunes the local branch with `: gone]` upstream', function () {
    // After the bare remote dropped feature/post-merge-test, `git fetch
    // --prune` (run by the hook via `git remote prune origin`) should
    // mark the local tracking ref gone, and the subsequent loop should
    // delete the local branch.
    const branches = cp
      .execSync('git branch', { cwd: projectDir })
      .toString()
      .split('\n')
      .map((l) => l.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);
    assert.ok(
      !branches.includes(featureGit),
      `Local branch '${featureGit}' should have been deleted; remaining: ${branches.join(', ')}`,
    );
  });

  after(async function () {
    if (process.env.LBPMERGE_NO_TEARDOWN === '1') {
      console.log(`  [teardown] skipped (LBPMERGE_NO_TEARDOWN=1).`);
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
