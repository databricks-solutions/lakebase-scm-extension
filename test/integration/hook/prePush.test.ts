/**
 * Small repro for the pre-push hook (OAuth token refresh + GitHub secrets sync).
 *
 * Exercises pre-push.sh end-to-end: refreshes the Databricks OAuth token,
 * then syncs DATABRICKS_HOST / DATABRICKS_TOKEN / LAKEBASE_PROJECT_ID to
 * the repo's Actions secrets via set-repo-secrets.sh. Runs in ~60s vs
 * ~30 min for the full e-commerce suite, so it's the right loop for
 * diagnosing why CI fails on a stale token after `git push`.
 *
 * Provisions a transient GitHub repo under the running contributor's
 * PERSONAL account (not databricks-solutions; the contributor needs
 * repo:create perms wherever the test runs). The repo is private and
 * gets deleted in teardown.
 *
 * Pre-flight:
 *   - DATABRICKS_TEST_HOST set + authenticated databricks CLI
 *   - `gh auth login` (the test creates a repo + sets secrets under
 *     whatever user gh is currently authenticated as)
 *   - That user must have a token with `delete_repo` scope so teardown
 *     can clean up.
 *
 * Run: npm run test:integration -- --grep "pre-push hook"
 */

import { strict as assert } from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LakebaseService } from '../../../src/services/lakebaseService';
import {
  deployScripts,
  installHooks,
} from '@databricks-solutions/lakebase-app-dev-kit';
import { assertIntegrationCredentials } from '../lib/credentials';

const HOOK_LOG = '/tmp/lakebase-pre-push.log';

describe('pre-push hook (small repro)', function () {
  this.timeout(300000); // 5 min

  let projectName: string;
  let repoName: string;
  let fullRepoName: string;
  let projectDir: string;
  let ghUser: string;
  let lakebaseService: LakebaseService;
  let dbHost: string;

  before(async function () {
    const creds = assertIntegrationCredentials();
    dbHost = creds.databricksHost;
    ghUser = creds.githubUser;
    process.env.DATABRICKS_HOST = dbHost;

    try { fs.unlinkSync(HOOK_LOG); } catch { /* ignore */ }

    const ts = Date.now().toString(36);
    projectName = `lbpush-${ts}`;
    repoName = `lbpush-test-${ts}`;
    fullRepoName = `${ghUser}/${repoName}`;
    projectDir = path.join(os.homedir(), repoName);

    console.log(`\n  Project: ${projectName}`);
    console.log(`  GitHub repo: ${fullRepoName} (transient, private)`);
    console.log(`  Dir: ${projectDir}`);
    console.log(`  Host: ${dbHost}\n`);

    // 1. Provision Lakebase project. The hook sources LAKEBASE_PROJECT_ID
    //    from .env; the project must already exist for the secret sync
    //    payload to point at something real.
    lakebaseService = new LakebaseService();
    lakebaseService.setHostOverride(dbHost);
    lakebaseService.setProjectIdOverride(projectName);
    console.log(`  [setup] Creating Lakebase project...`);
    await lakebaseService.createProject(projectName);

    // 2. Create a transient GitHub repo under the contributor's account.
    //    Private so it doesn't show up in public listings. Empty so the
    //    initial push from the local repo is the first push.
    console.log(`  [setup] Creating GitHub repo ${fullRepoName}...`);
    cp.execSync(`gh repo create "${fullRepoName}" --private --confirm`, {
      stdio: 'pipe',
      timeout: 30_000,
    });

    // 3. Init local repo + .env + scripts.
    fs.mkdirSync(projectDir, { recursive: true });
    cp.execSync('git init -b main', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync(
      `git remote add origin "https://github.com/${fullRepoName}.git"`,
      { cwd: projectDir, stdio: 'pipe' },
    );
    cp.execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'pipe' });
    cp.execSync('git config user.name "Pre-Push Repro"', { cwd: projectDir, stdio: 'pipe' });

    fs.writeFileSync(
      path.join(projectDir, '.env'),
      [`DATABRICKS_HOST=${dbHost}`, `LAKEBASE_PROJECT_ID=${projectName}`, ''].join('\n'),
    );
    fs.writeFileSync(path.join(projectDir, '.gitignore'), '.env\n');

    // Use the substrate's deployScripts + installHooks - same path a
    // real VS Code scaffold takes. deployScripts populates the full
    // scripts/ tree (pre-push, set-repo-secrets, refresh-token, etc.);
    // installHooks wires .git/hooks + pins core.hooksPath.
    await deployScripts(projectDir);
    await installHooks(projectDir);

    // 4. Instrument the hook so silent failures leave a forensic trail.
    const hookDest = path.join(projectDir, '.git', 'hooks', 'pre-push');
    let hookContent = fs.readFileSync(hookDest, 'utf-8');
    const shebangEnd = hookContent.indexOf('\n') + 1;
    const instrumentation =
      `# === instrumentation (small-repro test only) ===\n` +
      `exec 2>>${HOOK_LOG}\n` +
      `echo "" >&2\n` +
      `echo "=== pre-push fired $(date) ===" >&2\n` +
      `set -x\n`;
    hookContent = hookContent.slice(0, shebangEnd) + instrumentation + hookContent.slice(shebangEnd);
    fs.writeFileSync(hookDest, hookContent, { mode: 0o755 });

    // 5. Initial commit so there's something to push when the test fires
    //    the hook. We do NOT push from setup - the test triggers the push.
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# pre-push repro\n');
    cp.execSync('git add .gitignore README.md', { cwd: projectDir, stdio: 'pipe' });
    // Skip hooks on the setup commit: prepare-commit-msg.sh would mint a
    // Lakebase credential + query schema diff (~30-60s) for content that
    // doesn't affect the pre-push hook signal. The push below DOES fire
    // pre-push - that's the hook under test. (FEIP-7117.)
    cp.execSync('git -c core.hooksPath=/dev/null commit -m initial', { cwd: projectDir, stdio: 'pipe' });
    console.log(`  [setup] Local repo + GitHub repo ready.\n`);
  });

  it('pre-push refreshes the token + sets all three GitHub secrets', async function () {
    // Pre-condition: the repo has no secrets yet.
    const before = cp
      .execSync(`gh secret list --repo "${fullRepoName}" --json name`, { timeout: 30_000 })
      .toString();
    const beforeNames = (JSON.parse(before) as Array<{ name: string }>).map((s) => s.name);
    assert.ok(
      !beforeNames.includes('DATABRICKS_HOST'),
      `precondition: ${fullRepoName} should have no DATABRICKS_HOST secret yet`,
    );

    // Push: triggers the pre-push hook, which refreshes the token and
    // calls set-repo-secrets.sh. Stdout/stderr go to the hook log; if
    // anything fails the push exits non-zero.
    console.log(`  [test] git push (triggers pre-push hook)...`);
    cp.execSync('git push -u origin main', { cwd: projectDir, stdio: 'pipe', timeout: 60_000 });

    if (fs.existsSync(HOOK_LOG)) {
      const log = fs.readFileSync(HOOK_LOG, 'utf-8');
      console.log(`---hook log (${log.length} bytes)---\n${log.slice(-2000)}\n---`);
    }

    // Assert all three secrets are now set. gh secret list returns names
    // (values are write-only), which is exactly what we want to verify.
    const after = cp
      .execSync(`gh secret list --repo "${fullRepoName}" --json name`, { timeout: 30_000 })
      .toString();
    const afterNames = (JSON.parse(after) as Array<{ name: string }>).map((s) => s.name);
    for (const expected of ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'LAKEBASE_PROJECT_ID']) {
      assert.ok(
        afterNames.includes(expected),
        `${expected} secret should be set on ${fullRepoName} after pre-push; have: ${afterNames.join(', ')}`,
      );
    }
  });

  after(async function () {
    if (process.env.LBPUSH_NO_TEARDOWN === '1') {
      console.log(`  [teardown] skipped (LBPUSH_NO_TEARDOWN=1).`);
      console.log(`  Project preserved: ${projectName}`);
      console.log(`  GitHub repo preserved: ${fullRepoName}`);
      console.log(`  Dir: ${projectDir}`);
      return;
    }
    try {
      console.log(`  [teardown] Deleting GitHub repo ${fullRepoName}...`);
      cp.execSync(`gh repo delete "${fullRepoName}" --yes`, { stdio: 'pipe', timeout: 30_000 });
    } catch (e) {
      console.log(`  [teardown] GitHub delete failed (continuing; needs 'delete_repo' scope): ${(e as Error)?.message}`);
    }
    try {
      console.log(`  [teardown] Deleting Lakebase project ${projectName}...`);
      await lakebaseService.deleteProject(projectName);
    } catch (e) {
      console.log(`  [teardown] Lakebase delete failed (continuing): ${(e as Error)?.message}`);
    }
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`  [teardown] Done.`);
  });
});
