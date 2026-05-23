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
import { promisify } from 'util';
import * as tar from 'tar';
import findJavaHome from 'find-java-home';
import treeKill from 'tree-kill';
import { getWorkspaceRoot } from '../utils/config';
import { delay } from '../utils/delay';
import { GitHubService } from './githubService';

const execFile = promisify(cp.execFile);

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
  private lastRunnerPid?: number;

  constructor(private githubService: GitHubService = new GitHubService()) {}

  private runnerDir(projectName: string): string {
    return path.join(RUNNERS_DIR, projectName);
  }

  /** Download and cache the GitHub Actions runner tarball (`fetch`, not curl). */
  private async ensureCachedArchive(): Promise<string> {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cachedPath = path.join(CACHE_DIR, RUNNER_ARCHIVE);
    if (fs.existsSync(cachedPath)) {
      return cachedPath;
    }
    const response = await fetch(RUNNER_URL);
    if (!response.ok) {
      throw new Error(`Failed to download runner: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(cachedPath, buffer);
    return cachedPath;
  }

  /** Resolve JAVA_HOME: env var first, then find-java-home (macOS/Linux). */
  private async resolveJavaHome(): Promise<string | undefined> {
    if (process.env.JAVA_HOME) {
      return process.env.JAVA_HOME;
    }
    return new Promise(resolve => {
      findJavaHome((err: Error | null, javaHome?: string) => {
        resolve(err ? undefined : javaHome);
      });
    });
  }

  /**
   * Download, configure, and start a self-hosted runner for a Lakebase project.
   * GitHub API calls go through {@link GitHubService}; only `config.sh` / `run.sh`
   * remain as subprocesses (GitHub-provided binaries).
   */
  async setupRunner(
    fullRepoName: string,
    projectName: string,
    progress?: (msg: string) => void,
  ): Promise<RunnerInfo> {
    const report = progress || (() => {});
    const dir = this.runnerDir(projectName);
    const runnerName = `lakebase-${projectName}`;

    this.preflightDatabricksAuth(report);
    this.stopRunner(projectName);

    report('Downloading runner binary...');
    const archive = await this.ensureCachedArchive();
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(path.join(dir, 'config.sh'))) {
      report('Extracting runner...');
      await tar.extract({ file: archive, cwd: dir });
    }

    const diagPages = path.join(dir, '_diag', 'pages');
    if (fs.existsSync(diagPages)) {
      fs.rmSync(diagPages, { recursive: true, force: true });
      fs.mkdirSync(diagPages, { recursive: true });
    }

    const runnerFile = path.join(dir, '.runner');
    let needsConfig = !fs.existsSync(runnerFile);

    if (needsConfig) {
      this.resetRunnerConfig(dir, projectName);
    }

    if (!needsConfig) {
      let urlMismatch = false;
      try {
        const runnerJson = JSON.parse(fs.readFileSync(runnerFile, 'utf-8'));
        const configuredUrl: string = runnerJson.gitHubUrl || runnerJson.serverUrl || runnerJson.agentUrl || '';
        const expectedUrl = `https://github.com/${fullRepoName}`;
        urlMismatch = !!configuredUrl && !configuredUrl.startsWith(expectedUrl);
      } catch { urlMismatch = true; }

      if (urlMismatch) {
        report('Runner configured against a different repo — resetting...');
        this.resetRunnerConfig(dir, projectName);
        needsConfig = true;
      } else {
        try {
          const runnerId = await this.githubService.getRunnerIdByName(fullRepoName, runnerName);
          if (!runnerId) {
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
      const regToken = await this.githubService.createRegistrationToken(fullRepoName);
      cp.execSync(
        `./config.sh --url "https://github.com/${fullRepoName}" --token "${regToken}" --name "${runnerName}" --labels self-hosted --unattended --replace`,
        { cwd: dir, timeout: 60000 }
      );
    }

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
    } catch { /* non-fatal */ }

    report('Starting runner...');
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    const javaHome = await this.resolveJavaHome();
    if (javaHome && !env.JAVA_HOME) {
      env.JAVA_HOME = javaHome;
    }

    const child = cp.spawn('./run.sh', [], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env,
    });
    child.unref();
    this.lastRunnerPid = child.pid;

    if (child.pid) {
      fs.writeFileSync(path.join(dir, '.pid'), String(child.pid));
    }

    report('Waiting for runner to come online...');
    let online = false;
    for (let i = 0; i < 12; i++) {
      try {
        const status = await this.githubService.getRunnerStatus(fullRepoName, runnerName);
        if (status === 'online') { online = true; break; }
      } catch { /* retry */ }
      await delay(5000);
    }

    if (!online) {
      throw new Error(`Runner "${runnerName}" did not come online within 60 seconds`);
    }

    report('Runner is online.');
    return { name: runnerName, dir, pid: child.pid, online: true };
  }

  /**
   * Stop the local runner process. Prefers stored pid + tree-kill; falls back to
   * pkill when pid is unknown (legacy .NET child processes).
   */
  stopRunner(projectName: string): void {
    const dir = this.runnerDir(projectName);
    const pidFile = path.join(dir, '.pid');
    let pid = this.lastRunnerPid;

    if (fs.existsSync(pidFile)) {
      pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      try { fs.unlinkSync(pidFile); } catch {}
    }

    if (pid) {
      try {
        treeKill(pid, 'SIGKILL');
      } catch {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    } else {
      try {
        cp.execSync(`pkill -9 -f "${dir.replace(/\//g, '\\/')}.*Runner" 2>/dev/null || true`, { timeout: 5000 });
      } catch {}
    }

    this.lastRunnerPid = undefined;

    for (const staleDir of ['_diag/pages', '_work/_temp', '_work/_actions']) {
      const fullPath = path.join(dir, staleDir);
      if (fs.existsSync(fullPath)) {
        try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch {}
      }
    }
    try { fs.mkdirSync(path.join(dir, '_diag', 'pages'), { recursive: true }); } catch {}
  }

  private preflightDatabricksAuth(report: (msg: string) => void): void {
    const root = getWorkspaceRoot();
    if (!root) { return; }

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
    } catch (err: any) {
      const stderr = (err.stderr?.toString() || err.message || '').toString();
      const profileSuffix = profile ? ` -p ${profile}` : '';
      const hostSuffix = host ? ` --host ${host}` : '';
      const reAuthCmd = `databricks auth login${hostSuffix}${profileSuffix}`;
      if (/refresh token is invalid|cannot get access token|unauthenticated/i.test(stderr)) {
        report(
          `⚠ Databricks CLI auth on the runner is expired. Re-auth before your next CI run:\n    ${reAuthCmd}`
        );
      } else {
        report(
          `⚠ Could not verify Databricks CLI auth (${stderr.split('\n')[0].slice(0, 120)}). Re-auth if needed:\n    ${reAuthCmd}`
        );
      }
    }
  }

  private resetRunnerConfig(dir: string, projectName: string): void {
    const stateFiles = [
      '.runner', '.credentials', '.credentials_rsaparams', '.path', '.service', 'svc.sh', '.runner_migrated',
    ];
    for (const f of stateFiles) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `actions.runner.${projectName}.plist`);
    if (process.platform === 'darwin' && fs.existsSync(plist)) {
      execFile('launchctl', ['unload', plist]).catch(() => {});
      try { fs.unlinkSync(plist); } catch {}
    }
  }

  /** Stop, deregister from GitHub, and delete the on-disk runner directory. */
  async removeRunner(fullRepoName: string, projectName: string): Promise<void> {
    const dir = this.runnerDir(projectName);
    const runnerName = `lakebase-${projectName}`;

    this.stopRunner(projectName);
    await delay(2000);

    try {
      const runnerId = await this.githubService.getRunnerIdByName(fullRepoName, runnerName);
      if (runnerId) {
        await this.githubService.deleteRunner(fullRepoName, runnerId);
      }
    } catch {}

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  isRunning(projectName: string): boolean {
    const pidFile = path.join(this.runnerDir(projectName), '.pid');
    if (!fs.existsSync(pidFile)) { return false; }
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

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

  /** Check which required CI secrets exist on the repo (via Octokit). */
  async checkCiSecrets(fullRepoName: string): Promise<{ present: string[]; missing: string[] }> {
    const required = ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'LAKEBASE_PROJECT_ID'];
    try {
      const names = await this.githubService.listSecretNames(fullRepoName);
      const present = required.filter(k => names.includes(k));
      const missing = required.filter(k => !names.includes(k));
      return { present, missing };
    } catch {
      return { present: [], missing: required };
    }
  }

  /** Set DATABRICKS_* and LAKEBASE_PROJECT_ID secrets on the repo (via Octokit). */
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
      await this.githubService.setRepoSecret(fullRepoName, key, value);
    }
  }

  async getRecentWorkflowRuns(fullRepoName: string, limit = 5): Promise<Array<{ id: number; name: string; status: string; conclusion: string; branch: string; event: string }>> {
    return this.githubService.listWorkflowRuns(fullRepoName, limit);
  }
}
