/**
 * Self-Hosted GitHub Actions Runner Service
 *
 * Manages a persistent local runner for each Lakebase project.
 * Runner binary is cached at ~/.cache/github-actions-runner/.
 * Runner instances live at ~/.lakebase/runners/{project-name}/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { getWorkspaceRoot } from '../utils/config';

const RUNNER_VERSION = '2.333.1';
const RUNNER_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const RUNNER_OS = process.platform === 'darwin' ? 'osx' : 'linux';
const RUNNER_ARCHIVE = `actions-runner-${RUNNER_OS}-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz`;
const RUNNER_URL = `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ARCHIVE}`;
const CACHE_DIR = path.join(os.homedir(), '.cache', 'github-actions-runner');
const RUNNERS_DIR = path.join(os.homedir(), '.lakebase', 'runners');

export interface RunnerInfo {
  name: string;
  dir: string;
  pid?: number;
  online: boolean;
}

export class RunnerService {

  /** Get the runner directory for a project */
  private runnerDir(projectName: string): string {
    return path.join(RUNNERS_DIR, projectName);
  }

  /** Download runner binary if not cached. Returns path to cached archive. */
  private ensureCachedArchive(): string {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cachedPath = path.join(CACHE_DIR, RUNNER_ARCHIVE);
    if (fs.existsSync(cachedPath)) {
      return cachedPath;
    }
    cp.execSync(`curl -fsSL -o "${cachedPath}" "${RUNNER_URL}"`, { timeout: 120000 });
    return cachedPath;
  }

  /**
   * Deploy and start a self-hosted runner for a GitHub repo.
   * Idempotent — if a runner is already configured for this project, restarts it.
   *
   * @param fullRepoName - GitHub repo (e.g. "owner/my-app")
   * @param projectName - Lakebase project name (used for runner directory + name)
   * @param progress - Optional progress callback
   * @returns Runner info
   */
  async setupRunner(
    fullRepoName: string,
    projectName: string,
    progress?: (msg: string) => void,
  ): Promise<RunnerInfo> {
    const report = progress || (() => {});
    const dir = this.runnerDir(projectName);
    const runnerName = `lakebase-${projectName}`;

    // Databricks auth preflight. Jobs that call the SDK on the runner host
    // fall through to the user's ~/.databrickscfg when env vars aren't set;
    // a stale OAuth refresh token there surfaces mid-run as cryptic "refresh
    // token is invalid" warnings. Catch it up front. Non-fatal — runner
    // still starts; user gets an actionable message.
    this.preflightDatabricksAuth(report);

    // Stop existing runner if running
    this.stopRunner(projectName);

    // Extract runner binary
    report('Downloading runner binary...');
    const archive = this.ensureCachedArchive();
    fs.mkdirSync(dir, { recursive: true });

    // Only extract if not already extracted (config.sh exists)
    if (!fs.existsSync(path.join(dir, 'config.sh'))) {
      report('Extracting runner...');
      cp.execSync(`tar xzf "${archive}" -C "${dir}"`, { timeout: 60000 });
    }

    // Clear stale diagnostics (prevents "file already exists" errors after crashes)
    const diagPages = path.join(dir, '_diag', 'pages');
    if (fs.existsSync(diagPages)) {
      fs.rmSync(diagPages, { recursive: true, force: true });
      fs.mkdirSync(diagPages, { recursive: true });
    }

    // Configure runner — skip if already configured AND still registered on GitHub
    const runnerFile = path.join(dir, '.runner');
    let needsConfig = !fs.existsSync(runnerFile);

    // .runner may be missing but other state files (.credentials, .path, svc.sh,
    // launchd plist) can linger from a prior configure. `config.sh` itself only
    // checks .runner, but when it fails mid-install those stragglers can cause
    // subsequent runs to behave oddly. If we're going to reconfigure, start clean.
    if (needsConfig) {
      this.resetRunnerConfig(dir, projectName);
    }

    if (!needsConfig) {
      // .runner exists — verify it points at THIS repo and is still registered on GitHub.
      // If the runner was previously configured against a different URL (e.g. after an
      // org/owner migration), --replace on config.sh no-ops and it exits with "already
      // configured". So we also need a URL-match check.
      let urlMismatch = false;
      try {
        const runnerJson = JSON.parse(fs.readFileSync(runnerFile, 'utf-8'));
        const configuredUrl: string = runnerJson.gitHubUrl || runnerJson.serverUrl || runnerJson.agentUrl || '';
        const expectedUrl = `https://github.com/${fullRepoName}`;
        urlMismatch = !!configuredUrl && !configuredUrl.startsWith(expectedUrl);
      } catch { /* unreadable .runner — treat as needing reconfig */ urlMismatch = true; }

      if (urlMismatch) {
        report('Runner configured against a different repo — resetting...');
        this.resetRunnerConfig(dir, projectName);
        needsConfig = true;
      } else {
        try {
          const check = cp.execSync(
            `gh api repos/${fullRepoName}/actions/runners --jq '.runners[] | select(.name == "${runnerName}") | .id'`,
            { timeout: 10000 }
          ).toString().trim();
          if (!check) {
            report('Runner registration stale — reconfiguring...');
            this.resetRunnerConfig(dir, projectName);
            needsConfig = true;
          } else {
            report('Runner already configured — restarting...');
          }
        } catch {
          report('Could not verify runner — reconfiguring...');
          this.resetRunnerConfig(dir, projectName);
          needsConfig = true;
        }
      }
    }

    if (needsConfig) {
      report('Registering runner with GitHub...');
      let regToken: string;
      try {
        regToken = cp.execSync(
          `gh api -X POST repos/${fullRepoName}/actions/runners/registration-token --jq '.token'`,
          { timeout: 15000 }
        ).toString().trim();
      } catch (err: any) {
        const combined = `${err.stderr?.toString() || ''}${err.stdout?.toString() || ''}${err.message || ''}`;
        if (/404|Not Found/i.test(combined)) {
          let activeUser = '<unknown>';
          try {
            const status = cp.execSync('gh auth status 2>&1', { timeout: 5000 }).toString();
            const match = status.match(/account (\S+).*Active account: true/s);
            if (match) { activeUser = match[1]; }
          } catch { /* ignore */ }
          const owner = fullRepoName.split('/')[0];
          throw new Error(
            `GitHub returned 404 for "${fullRepoName}". The active gh user "${activeUser}" can't see this repo — it's likely private and owned by a different account. Run \`gh auth switch --user ${owner}\` (or login via \`gh auth login\`) and retry.`
          );
        }
        throw err;
      }

      cp.execSync(
        `./config.sh --url "https://github.com/${fullRepoName}" --token "${regToken}" --name "${runnerName}" --labels self-hosted --unattended --replace`,
        { cwd: dir, timeout: 60000 }
      );
    }

    // `actions/setup-python` and `actions/setup-node` hardcode
    // `/Users/runner/hostedtoolcache` as the install path on macOS (it's
    // `actions/python-versions`' installer script -- the path is baked into
    // the shell script that gets downloaded, NOT read from env). On GitHub-
    // hosted runners `/Users/runner` is the runner user's home and exists by
    // default. On self-hosted runners running as a normal user (e.g.
    // `kevin.hartman`) it doesn't exist, and the first `setup-python` job
    // fails with `mkdir: /Users/runner: Permission denied`.
    //
    // RUNNER_TOOL_CACHE only redirects setup-python's cache-lookup, not where
    // the installer writes -- setting it to a different path just makes
    // setup-python re-download every run because the two dirs drift.
    //
    // The only durable fix is creating `/Users/runner/hostedtoolcache` with
    // the runner user as owner. That requires sudo and can't be done from
    // the extension -- surface a clear one-time instruction instead.
    try {
      const toolCacheDefault = '/Users/runner/hostedtoolcache';
      let needsSetup = false;
      try {
        fs.accessSync(toolCacheDefault, fs.constants.W_OK);
      } catch {
        needsSetup = true;
      }
      if (needsSetup) {
        const userLogin = os.userInfo().username;
        report(
          `One-time setup required before setup-python works: run in a real terminal (needs sudo):\n` +
            `    sudo mkdir -p ${toolCacheDefault}\n` +
            `    sudo chown -R ${userLogin} /Users/runner`,
        );
      }
    } catch {
      // Non-fatal: surfacing a hint is best-effort.
    }

    // Start in background
    report('Starting runner...');
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (!env.JAVA_HOME) {
      try {
        env.JAVA_HOME = cp.execSync('/usr/libexec/java_home 2>/dev/null', { timeout: 5000 }).toString().trim();
      } catch {}
    }

    const child = cp.spawn('./run.sh', [], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env,
    });
    child.unref();

    // Write PID file for later management
    fs.writeFileSync(path.join(dir, '.pid'), String(child.pid));

    // Wait for runner to come online
    report('Waiting for runner to come online...');
    let online = false;
    for (let i = 0; i < 12; i++) {
      try {
        const status = cp.execSync(
          `gh api repos/${fullRepoName}/actions/runners --jq '.runners[] | select(.name == "${runnerName}") | .status'`,
          { timeout: 10000 }
        ).toString().trim();
        if (status === 'online') { online = true; break; }
      } catch {}
      cp.execSync('sleep 5');
    }

    if (!online) {
      throw new Error(`Runner "${runnerName}" did not come online within 60 seconds`);
    }

    report('Runner is online.');
    return { name: runnerName, dir, pid: child.pid, online: true };
  }

  /** Stop the runner for a project (kill all processes, clear stale state, don't deregister) */
  stopRunner(projectName: string): void {
    const dir = this.runnerDir(projectName);

    // Kill the run.sh wrapper process
    const pidFile = path.join(dir, '.pid');
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      try { process.kill(pid, 'SIGKILL'); } catch {}
      try { fs.unlinkSync(pidFile); } catch {}
    }

    // Kill ALL child Runner.Listener and Runner.Worker processes for this runner dir
    // (run.sh spawns Runner.Listener which spawns Runner.Worker — kill -9 on run.sh
    //  does NOT kill the .NET child processes)
    try {
      cp.execSync(`pkill -9 -f "${dir.replace(/\//g, '\\/')}.*Runner" 2>/dev/null || true`, { timeout: 5000 });
    } catch {}

    // Wait for processes to die
    try { cp.execSync('sleep 1'); } catch {}

    // Clear all stale state that causes errors on restart
    for (const staleDir of ['_diag/pages', '_work/_temp', '_work/_actions']) {
      const fullPath = path.join(dir, staleDir);
      if (fs.existsSync(fullPath)) {
        try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch {}
      }
    }
    try { fs.mkdirSync(path.join(dir, '_diag', 'pages'), { recursive: true }); } catch {}
  }

  /**
   * Verify the runner host has a working Databricks CLI auth. Reads the
   * workspace's .env for DATABRICKS_CONFIG_PROFILE and calls
   * `databricks current-user me` to confirm the refresh token is still
   * valid. Non-fatal: on failure, surfaces a warning via the progress
   * callback with the exact command to re-auth.
   */
  private preflightDatabricksAuth(report: (msg: string) => void): void {
    const root = getWorkspaceRoot();
    if (!root) { return; }

    // Read DATABRICKS_CONFIG_PROFILE + DATABRICKS_HOST from .env (best-effort)
    let profile = '';
    let host = '';
    try {
      const envFile = path.join(root, '.env');
      if (fs.existsSync(envFile)) {
        const content = fs.readFileSync(envFile, 'utf-8');
        profile = content.match(/^DATABRICKS_CONFIG_PROFILE=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
        host = content.match(/^DATABRICKS_HOST=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
      }
    } catch { /* non-fatal */ }

    const profileArg = profile ? `--profile "${profile}"` : '';
    try {
      cp.execSync(`databricks current-user me ${profileArg} -o json`, { timeout: 10_000, stdio: 'pipe' });
      // Success — no message. Silence is golden.
    } catch (err: any) {
      const stderr = (err.stderr?.toString() || err.message || '').toString();
      const profileSuffix = profile ? ` -p ${profile}` : '';
      const hostSuffix = host ? ` --host ${host}` : '';
      const reAuthCmd = `databricks auth login${hostSuffix}${profileSuffix}`;
      if (/refresh token is invalid|cannot get access token|unauthenticated/i.test(stderr)) {
        report(
          `⚠ Databricks CLI auth on the runner is expired. The runner will start, but jobs that call the SDK via default auth (e.g. Python SDK calls to AI endpoints, Unity Catalog) will fail with "refresh token is invalid". Re-auth before your next CI run:\n    ${reAuthCmd}`
        );
      } else {
        report(
          `⚠ Could not verify Databricks CLI auth on the runner (${stderr.split('\n')[0].slice(0, 120)}). Jobs using SDK default-auth may fail. Re-auth if needed:\n    ${reAuthCmd}`
        );
      }
    }
  }

  /**
   * Wipe local runner configuration without touching the unpacked binaries.
   * Clears:
   *  - .runner / .credentials / .credentials_rsaparams (config + auth)
   *  - .path / .env-generated marker files (config.sh byproducts)
   *  - .service / svc.sh / macOS launchd plist (any prior "install as service")
   *
   * Best-effort: every unlink/rm is wrapped — missing files are fine, and we
   * don't want a single failure to block the retry flow.
   */
  private resetRunnerConfig(dir: string, projectName: string): void {
    const stateFiles = [
      '.runner',
      '.credentials',
      '.credentials_rsaparams',
      '.path',
      '.service',
      'svc.sh',
      // `.runner_migrated` is an in-place upgrade marker. Some runner versions
      // treat its presence as "already configured" even when .runner itself is
      // gone, which makes config.sh bail before validating the token. Nuke it.
      '.runner_migrated',
    ];
    for (const f of stateFiles) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    // Remove macOS launchd plist if one was installed for this runner
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `actions.runner.${projectName}.plist`);
    try {
      cp.execSync(`launchctl unload "${plist}" 2>/dev/null || true`, { timeout: 5000 });
    } catch {}
    try { fs.unlinkSync(plist); } catch {}
  }

  /** Remove the runner entirely (stop, deregister from GitHub, delete directory) */
  async removeRunner(fullRepoName: string, projectName: string): Promise<void> {
    const dir = this.runnerDir(projectName);
    const runnerName = `lakebase-${projectName}`;

    // Stop process
    this.stopRunner(projectName);

    // Wait for process to die
    cp.execSync('sleep 2');

    // Deregister via API
    try {
      const runnerId = cp.execSync(
        `gh api repos/${fullRepoName}/actions/runners --jq '.runners[] | select(.name == "${runnerName}") | .id'`,
        { timeout: 10000 }
      ).toString().trim();
      if (runnerId) {
        cp.execSync(`gh api -X DELETE repos/${fullRepoName}/actions/runners/${runnerId}`, { timeout: 10000 });
      }
    } catch {}

    // Remove directory
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  /** Check if a runner is currently running for a project */
  isRunning(projectName: string): boolean {
    const pidFile = path.join(this.runnerDir(projectName), '.pid');
    if (!fs.existsSync(pidFile)) { return false; }
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  /** Get info about a project's runner */
  getRunnerInfo(projectName: string): RunnerInfo | undefined {
    const dir = this.runnerDir(projectName);
    if (!fs.existsSync(dir)) { return undefined; }
    const pidFile = path.join(dir, '.pid');
    let pid: number | undefined;
    if (fs.existsSync(pidFile)) {
      pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    }
    return {
      name: `lakebase-${projectName}`,
      dir,
      pid,
      online: this.isRunning(projectName),
    };
  }

  /** Get the runner's latest log file path */
  getLatestLogFile(projectName: string): string | undefined {
    const dir = this.runnerDir(projectName);
    const diagDir = path.join(dir, '_diag');
    if (!fs.existsSync(diagDir)) { return undefined; }
    const logs = fs.readdirSync(diagDir)
      .filter(f => f.startsWith('Runner_') && f.endsWith('.log'))
      .sort()
      .reverse();
    return logs.length > 0 ? path.join(diagDir, logs[0]) : undefined;
  }

  /** Get the runner's worker log file path (active job output) */
  getLatestWorkerLog(projectName: string): string | undefined {
    const dir = this.runnerDir(projectName);
    const diagDir = path.join(dir, '_diag');
    if (!fs.existsSync(diagDir)) { return undefined; }
    const logs = fs.readdirSync(diagDir)
      .filter(f => f.startsWith('Worker_') && f.endsWith('.log'))
      .sort()
      .reverse();
    return logs.length > 0 ? path.join(diagDir, logs[0]) : undefined;
  }

  /**
   * Check which of the three CI secrets (DATABRICKS_HOST, DATABRICKS_TOKEN,
   * LAKEBASE_PROJECT_ID) are already set on the GitHub repo. Returns lists
   * of present and missing names. Returns all-missing if `gh secret list`
   * fails (no auth, no permissions, etc.).
   */
  async checkCiSecrets(fullRepoName: string): Promise<{ present: string[]; missing: string[] }> {
    const required = ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'LAKEBASE_PROJECT_ID'];
    try {
      const raw = cp.execSync(
        `gh secret list --repo "${fullRepoName}" --json name -q '.[].name'`,
        { timeout: 10000 }
      ).toString().trim();
      const names = raw ? raw.split('\n').map(s => s.trim()).filter(Boolean) : [];
      const present = required.filter(k => names.includes(k));
      const missing = required.filter(k => !names.includes(k));
      return { present, missing };
    } catch {
      return { present: [], missing: required };
    }
  }

  /**
   * Set the three CI secrets (DATABRICKS_HOST, DATABRICKS_TOKEN,
   * LAKEBASE_PROJECT_ID) on the GitHub repo. Values are passed via stdin
   * to avoid shell escaping issues with tokens.
   */
  async setupCiSecrets(
    fullRepoName: string,
    secrets: { DATABRICKS_HOST: string; DATABRICKS_TOKEN: string; LAKEBASE_PROJECT_ID: string },
    progress?: (msg: string) => void,
  ): Promise<void> {
    const report = progress || (() => {});
    for (const [key, value] of Object.entries(secrets)) {
      if (!value) {
        throw new Error(`Missing value for ${key}`);
      }
      report(`Setting ${key}...`);
      cp.execSync(`gh secret set ${key} --repo "${fullRepoName}"`, {
        input: value,
        timeout: 15000,
      });
    }
  }

  /** List recent workflow runs from GitHub for the repo */
  getRecentWorkflowRuns(fullRepoName: string, limit = 5): Array<{ id: number; name: string; status: string; conclusion: string; branch: string; event: string }> {
    try {
      const raw = cp.execSync(
        `gh run list --repo "${fullRepoName}" --limit ${limit} --json databaseId,name,status,conclusion,headBranch,event`,
        { timeout: 15000 }
      ).toString().trim();
      const runs = JSON.parse(raw || '[]');
      return runs.map((r: any) => ({
        id: r.databaseId,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion || '',
        branch: r.headBranch || '',
        event: r.event || '',
      }));
    } catch {
      return [];
    }
  }
}
