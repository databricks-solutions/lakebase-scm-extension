// RunnerService, VS Code-aware shell over the substrate's runner-setup.
//
// FEIP-7065 (publish_and_consume): runner binary download, configure, start,
// stop, deregister, status all live in
// @databricks-solutions/lakebase-app-dev-kit. This service keeps:
//   - `preflightDatabricksAuth`, reads workspace .env, surfaces a re-auth
//     hint via the progress callback before substrate.setupRunner runs.
//   - Log scanning helpers (getLatestLogFile / getLatestWorkerLog) for the
//     VS Code CI Runner view.
//   - CI secrets helpers, which compose GitHubService.

import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import { getWorkspaceRoot } from "../utils/config";
import { GitHubService } from "./githubService";
import {
  setupRunner as substrateSetupRunner,
  removeRunner as substrateRemoveRunner,
  stopRunner as substrateStopRunner,
  isRunning as substrateIsRunning,
  getRunnerInfo as substrateGetRunnerInfo,
  runnerDir as substrateRunnerDir,
  runnerName as substrateRunnerName,
  type RunnerInfo as SubstrateRunnerInfo,
} from "@databricks-solutions/lakebase-app-dev-kit";

export type RunnerInfo = SubstrateRunnerInfo;

export class RunnerService {
  constructor(private githubService: GitHubService = new GitHubService()) {}

  private runnerDir(projectName: string): string {
    return substrateRunnerDir(projectName);
  }

  /**
   * Download, configure, and start a self-hosted runner. Wraps substrate's
   * setupRunner with a preflight check on Databricks CLI auth, surfaced via
   * the progress callback so users see "re-auth before CI" before the runner
   * starts queueing jobs.
   */
  async setupRunner(
    fullRepoName: string,
    projectName: string,
    progress?: (msg: string) => void,
  ): Promise<RunnerInfo> {
    const report = progress || (() => {});
    this.preflightDatabricksAuth(report);
    return substrateSetupRunner({ fullRepoName, projectName, report });
  }

  stopRunner(projectName: string): void {
    substrateStopRunner(projectName);
  }

  /** Stop, deregister from GitHub, and delete the on-disk runner directory. */
  async removeRunner(fullRepoName: string, projectName: string): Promise<void> {
    return substrateRemoveRunner({ fullRepoName, projectName });
  }

  isRunning(projectName: string): boolean {
    return substrateIsRunning(projectName);
  }

  getRunnerInfo(projectName: string): RunnerInfo | undefined {
    return substrateGetRunnerInfo(projectName);
  }

  // ── Inline: VS Code-flavored helpers ───────────────────────────

  /**
   * Best-effort check that the runner's Databricks CLI is still authenticated.
   * Reads the workspace .env to figure out which profile/host to probe, then
   * surfaces a re-auth hint via the progress callback. Non-fatal, never
   * throws; the runner can still start.
   */
  private preflightDatabricksAuth(report: (msg: string) => void): void {
    const root = getWorkspaceRoot();
    if (!root) { return; }

    let profile = "";
    let host = "";
    try {
      const envFile = path.join(root, ".env");
      if (fs.existsSync(envFile)) {
        const content = fs.readFileSync(envFile, "utf-8");
        profile = content.match(/^DATABRICKS_CONFIG_PROFILE=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
        host = content.match(/^DATABRICKS_HOST=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
      }
    } catch { /* non-fatal */ }

    const profileArg = profile ? `--profile "${profile}"` : "";
    try {
      cp.execSync(`databricks current-user me ${profileArg} -o json`, { timeout: 10_000, stdio: "pipe" });
    } catch (err: any) {
      const stderr = (err.stderr?.toString() || err.message || "").toString();
      const profileSuffix = profile ? ` -p ${profile}` : "";
      const hostSuffix = host ? ` --host ${host}` : "";
      const reAuthCmd = `databricks auth login${hostSuffix}${profileSuffix}`;
      if (/refresh token is invalid|cannot get access token|unauthenticated/i.test(stderr)) {
        report(`⚠ Databricks CLI auth on the runner is expired. Re-auth before your next CI run:\n    ${reAuthCmd}`);
      } else {
        report(`⚠ Could not verify Databricks CLI auth (${stderr.split("\n")[0].slice(0, 120)}). Re-auth if needed:\n    ${reAuthCmd}`);
      }
    }
  }

  getLatestLogFile(projectName: string): string | undefined {
    const dir = this.runnerDir(projectName);
    const diagDir = path.join(dir, "_diag");
    if (!fs.existsSync(diagDir)) { return undefined; }
    const logs = fs.readdirSync(diagDir)
      .filter(f => f.startsWith("Runner_") && f.endsWith(".log"))
      .sort()
      .reverse();
    return logs.length > 0 ? path.join(diagDir, logs[0]) : undefined;
  }

  getLatestWorkerLog(projectName: string): string | undefined {
    const dir = this.runnerDir(projectName);
    const diagDir = path.join(dir, "_diag");
    if (!fs.existsSync(diagDir)) { return undefined; }
    const logs = fs.readdirSync(diagDir)
      .filter(f => f.startsWith("Worker_") && f.endsWith(".log"))
      .sort()
      .reverse();
    return logs.length > 0 ? path.join(diagDir, logs[0]) : undefined;
  }

  // ── Composition over GitHubService ─────────────────────────────

  async checkCiSecrets(fullRepoName: string): Promise<{ present: string[]; missing: string[] }> {
    const required = ["DATABRICKS_HOST", "DATABRICKS_TOKEN", "LAKEBASE_PROJECT_ID"];
    try {
      const names = await this.githubService.listSecretNames(fullRepoName);
      const present = required.filter(k => names.includes(k));
      const missing = required.filter(k => !names.includes(k));
      return { present, missing };
    } catch {
      return { present: [], missing: required };
    }
  }

  async setupCiSecrets(
    fullRepoName: string,
    secrets: { DATABRICKS_HOST: string; DATABRICKS_TOKEN: string; LAKEBASE_PROJECT_ID: string },
    progress?: (msg: string) => void,
  ): Promise<void> {
    const report = progress || (() => {});
    for (const [key, value] of Object.entries(secrets)) {
      if (!value) { throw new Error(`Missing value for ${key}`); }
      report(`Setting ${key}...`);
      await this.githubService.setRepoSecret(fullRepoName, key, value);
    }
  }

  async getRecentWorkflowRuns(fullRepoName: string, limit = 5): Promise<Array<{ id: number; name: string; status: string; conclusion: string; branch: string; event: string }>> {
    return this.githubService.listWorkflowRuns(fullRepoName, limit);
  }
}

// Re-export runnerName for callers that previously imported it from this module.
export { substrateRunnerName as runnerName };
