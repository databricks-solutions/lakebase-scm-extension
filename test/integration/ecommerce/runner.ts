/**
 * Ephemeral Self-Hosted GitHub Actions Runner
 *
 * Downloads, configures, starts, and tears down a GitHub Actions runner
 * for the duration of the e-commerce integration test suite.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { ScenarioContext } from './helpers';

const RUNNER_VERSION = '2.333.1';
const RUNNER_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const RUNNER_OS = process.platform === 'darwin' ? 'osx' : 'linux';
const RUNNER_ARCHIVE = `actions-runner-${RUNNER_OS}-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz`;
const RUNNER_URL = `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ARCHIVE}`;
const RUNNER_CACHE_DIR = path.join(os.homedir(), '.cache', 'github-actions-runner');

export interface RunnerHandle {
  pid: number;
  runnerDir: string;
  cleanup: (ctx: ScenarioContext) => void;
}

/**
 * Download runner binary if not cached. Returns path to the cached archive.
 */
function ensureCachedArchive(): string {
  fs.mkdirSync(RUNNER_CACHE_DIR, { recursive: true });
  const cachedPath = path.join(RUNNER_CACHE_DIR, RUNNER_ARCHIVE);

  if (fs.existsSync(cachedPath)) {
    console.log(`    [runner] Using cached runner: ${cachedPath}`);
    return cachedPath;
  }

  console.log(`    [runner] Downloading runner v${RUNNER_VERSION} for ${RUNNER_OS}-${RUNNER_ARCH}...`);
  cp.execSync(`curl -fsSL -o "${cachedPath}" "${RUNNER_URL}"`, { timeout: 120000 });
  console.log(`    [runner] Downloaded to ${cachedPath}`);
  return cachedPath;
}

/**
 * Extract runner binary to a unique temp directory. Returns the runner dir path.
 */
export function ensureRunnerBinary(): string {
  const archive = ensureCachedArchive();
  const runnerDir = path.join(os.tmpdir(), `runner-${Date.now().toString(36)}`);
  fs.mkdirSync(runnerDir, { recursive: true });

  console.log(`    [runner] Extracting to ${runnerDir}...`);
  cp.execSync(`tar xzf "${archive}" -C "${runnerDir}"`, { timeout: 60000 });
  return runnerDir;
}

/**
 * Register runner with the test repo, start in background, wait for it to come online.
 */
export function startRunner(ctx: ScenarioContext, runnerDir: string): RunnerHandle {
  const runnerName = `ecom-test-${Date.now().toString(36)}`;

  // Get registration token
  console.log(`    [runner] Getting registration token for ${ctx.fullRepoName}...`);
  const regToken = cp.execSync(
    `gh api -X POST repos/${ctx.fullRepoName}/actions/runners/registration-token --jq '.token'`,
    { timeout: 15000 }
  ).toString().trim();

  // Configure (not --ephemeral: we need this runner for 16+ jobs)
  console.log(`    [runner] Configuring runner "${runnerName}"...`);
  cp.execSync(
    `./config.sh --url "https://github.com/${ctx.fullRepoName}" --token "${regToken}" --name "${runnerName}" --labels self-hosted --unattended --replace`,
    { cwd: runnerDir, timeout: 60000 }
  );

  // Start in background — ensure JAVA_HOME is set so actions/setup-java uses the local JDK
  console.log(`    [runner] Starting runner...`);
  const runnerEnv = { ...process.env };
  if (!runnerEnv.JAVA_HOME) {
    try {
      runnerEnv.JAVA_HOME = cp.execSync('/usr/libexec/java_home 2>/dev/null || echo ""', { timeout: 5000 }).toString().trim();
    } catch {}
  }
  if (runnerEnv.JAVA_HOME) {
    console.log(`    [runner] JAVA_HOME=${runnerEnv.JAVA_HOME}`);
  }
  const child = cp.spawn('./run.sh', [], {
    cwd: runnerDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: runnerEnv,
  });
  child.unref();

  // Log runner output for debugging
  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) { console.log(`    [runner:out] ${line}`); }
  });
  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) { console.log(`    [runner:err] ${line}`); }
  });

  const pid = child.pid!;

  // Wait for runner to appear online (up to 60 seconds)
  console.log(`    [runner] Waiting for runner to come online (pid=${pid})...`);
  let online = false;
  for (let i = 0; i < 12; i++) {
    try {
      const raw = cp.execSync(
        `gh api repos/${ctx.fullRepoName}/actions/runners --jq '.runners[] | select(.name == "${runnerName}") | .status'`,
        { timeout: 10000 }
      ).toString().trim();
      if (raw === 'online') {
        online = true;
        break;
      }
    } catch {
      // Runner not registered yet
    }
    cp.execSync('sleep 5');
  }

  if (!online) {
    throw new Error(`Runner "${runnerName}" did not come online within 60 seconds`);
  }
  console.log(`    [runner] Runner "${runnerName}" is online.`);

  return {
    pid,
    runnerDir,
    cleanup: (cleanupCtx: ScenarioContext) => {
      console.log(`    [runner] Cleaning up runner "${runnerName}"...`);

      // 1. Kill the process tree — SIGKILL immediately (no graceful shutdown needed for test runners)
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}

      // Wait for process to actually die
      for (let i = 0; i < 5; i++) {
        try { process.kill(pid, 0); cp.execSync('sleep 1'); } catch { break; }
      }

      // 2. Force-remove via API (works even if runner was mid-job, once process is dead)
      try {
        // Give GitHub a moment to detect the runner is offline
        cp.execSync('sleep 3');
        const runnerId = cp.execSync(
          `gh api repos/${cleanupCtx.fullRepoName}/actions/runners --jq '.runners[] | select(.name == "${runnerName}") | .id'`,
          { timeout: 10000 }
        ).toString().trim();
        if (runnerId) {
          // --force flag via input, but the API DELETE just works once the runner is offline
          cp.execSync(
            `gh api -X DELETE repos/${cleanupCtx.fullRepoName}/actions/runners/${runnerId}`,
            { timeout: 10000 }
          );
          console.log(`    [runner] Runner "${runnerName}" removed via API (id=${runnerId}).`);
        } else {
          console.log(`    [runner] Runner "${runnerName}" already removed from repo.`);
        }
      } catch (e: any) {
        // Fallback: try config.sh remove
        try {
          const removeToken = cp.execSync(
            `gh api -X POST repos/${cleanupCtx.fullRepoName}/actions/runners/remove-token --jq '.token'`,
            { timeout: 15000 }
          ).toString().trim();
          cp.execSync(`./config.sh remove --token "${removeToken}"`, { cwd: runnerDir, timeout: 30000 });
          console.log(`    [runner] Runner deregistered via config.sh.`);
        } catch {
          console.log(`    [runner] Warning: could not deregister runner: ${e.message}`);
        }
      }

      // 3. Remove runner directory
      try { fs.rmSync(runnerDir, { recursive: true, force: true }); } catch {}
      console.log(`    [runner] Cleanup complete.`);
    },
  };
}

/**
 * Kill all stale runner processes and clean up temp directories from previous runs.
 * Call at the start of the test suite to ensure a clean state.
 */
export function cleanupStaleRunners(): void {
  // Kill any leftover run.sh processes
  try {
    cp.execSync('pkill -f "actions-runner.*run\\.sh" 2>/dev/null || true', { timeout: 5000 });
  } catch {}

  // Remove stale runner temp directories
  try {
    const tmpDir = os.tmpdir();
    const entries = fs.readdirSync(tmpDir).filter(e => e.startsWith('runner-'));
    for (const entry of entries) {
      try { fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true }); } catch {}
    }
    if (entries.length > 0) {
      console.log(`    [runner] Cleaned up ${entries.length} stale runner directories.`);
    }
  } catch {}
}
