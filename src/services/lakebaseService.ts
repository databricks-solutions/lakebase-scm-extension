// LakebaseService — thin VS Code-aware shell over the substrate.
//
// FEIP-7065 (publish_and_consume): branch CRUD, endpoint lookup, credential
// minting, schema introspection, and project CRUD live in
// @databricks-solutions/lakebase-app-dev-kit. This service keeps:
//   - Per-session host + projectId overrides (set by the VS Code workspace
//     picker; substrate's CLI calls honor process.env.DATABRICKS_HOST so we
//     mutate that around each substrate call).
//   - Adapters from substrate's LakebaseBranchInfo to the richer
//     LakebaseBranch shape consumers in this extension expect.
//   - VS Code-specific helpers that aren't part of the canonical workflow
//     surface (auth profile listing, console URL, syncConnection writing
//     to .env).
//
// As substrate grows, auth/profile helpers can move there too; the proxy
// shape stays the same for callers.

import { exec } from "../utils/exec";
import { getConfig, getEnvConfig, getProjectDatabase } from "../utils/config";
import {
  createBranch as substrateCreateBranch,
  deleteBranch as substrateDeleteBranch,
  listBranches as substrateListBranches,
  getDefaultBranch as substrateGetDefaultBranch,
  getBranchByName as substrateGetBranchByName,
  waitForBranchReady as substrateWaitForBranchReady,
  createLakebaseProject as substrateCreateLakebaseProject,
  deleteLakebaseProject as substrateDeleteLakebaseProject,
  getProjectInfo as substrateGetProjectInfo,
  getEndpoint as substrateGetEndpoint,
  getCredential as substrateGetCredential,
  queryBranchSchema as substrateQueryBranchSchema,
  queryBranchTables as substrateQueryBranchTables,
  sanitizeBranchName as substrateSanitizeBranchName,
  type LakebaseBranchInfo,
} from "@databricks-solutions/lakebase-app-dev-kit";

export interface LakebaseBranch {
  /** Internal API uid (e.g. br-red-thunder-d24muck6) */
  uid: string;
  /** Full resource path (e.g. projects/.../branches/customer-entity) */
  name: string;
  /** Branch ID segment from the name path (e.g. customer-entity) */
  branchId: string;
  state: string;
  isDefault: boolean;
  /** Full resource path of the parent branch this was forked from. */
  sourceBranch?: string;
  /** Branch ID segment of the parent. */
  sourceBranchId?: string;
  endpointHost?: string;
  endpointState?: string;
}

export interface LakebaseCredential {
  token: string;
  email: string;
}

export interface AuthStatus {
  authenticated: boolean;
  currentHost: string;
  expectedHost: string;
  mismatch: boolean;
  error?: string;
}

export interface DatabricksProfile {
  name: string;
  host: string;
  cloud: string;
  authType: string;
  valid: boolean;
  hasLakebase?: boolean;
  lakebaseProjects?: Array<{ uid: string; displayName: string }>;
}

function lakebaseExec(command: string, cwd?: string, env?: Record<string, string>): Promise<string> {
  return exec(command, { cwd, env, timeout: 30000, tagAuthErrors: true });
}

function adaptBranchInfo(b: LakebaseBranchInfo): LakebaseBranch {
  const fullName = b.name || "";
  const branchId = fullName.split("/branches/").pop() || b.uid;
  const sourceBranch = b.sourceBranchName || "";
  const sourceBranchId = sourceBranch.split("/branches/").pop() || "";
  return {
    uid: b.uid,
    name: fullName,
    branchId,
    state: b.state,
    isDefault: b.isDefault === true,
    sourceBranch: sourceBranch || undefined,
    sourceBranchId: sourceBranchId || undefined,
    endpointHost: undefined,
    endpointState: undefined,
  };
}

export class LakebaseService {
  /** Runtime host override — set when user selects a workspace via the picker */
  private hostOverride: string | undefined;
  /** Runtime project ID override — set for integration tests or when workspace .env is not available */
  private projectIdOverride: string | undefined;

  private projectInstance(): string {
    if (this.projectIdOverride) { return this.projectIdOverride; }
    return getConfig().lakebaseProjectId;
  }

  private projectPath(): string {
    return `projects/${this.projectInstance()}`;
  }

  getEffectiveHost(): string {
    if (this.hostOverride) { return this.hostOverride; }
    return getConfig().databricksHost;
  }

  setHostOverride(host: string): void {
    this.hostOverride = host.replace(/\/+$/, "");
  }

  setProjectIdOverride(projectId: string): void {
    this.projectIdOverride = projectId;
  }

  /**
   * Run a substrate call with DATABRICKS_HOST mutated to the effective host.
   * Substrate's CLI invocations read process.env.DATABRICKS_HOST directly, so
   * mutating it around each call gives them the same host the extension is
   * using. Restores the prior value after — even on throw.
   */
  private async withHost<T>(fn: () => Promise<T>): Promise<T> {
    const host = this.getEffectiveHost();
    if (!host) { return fn(); }
    const prior = process.env.DATABRICKS_HOST;
    process.env.DATABRICKS_HOST = host;
    try {
      return await fn();
    } finally {
      if (prior === undefined) {
        delete process.env.DATABRICKS_HOST;
      } else {
        process.env.DATABRICKS_HOST = prior;
      }
    }
  }

  // ── Inline: auth / profile (no substrate equivalent yet) ────────

  async isAvailable(): Promise<boolean> {
    try {
      await lakebaseExec("databricks --version");
      return true;
    } catch {
      return false;
    }
  }

  async listProfiles(): Promise<DatabricksProfile[]> {
    try {
      const raw = await lakebaseExec("databricks auth profiles -o json");
      const parsed = JSON.parse(raw);
      const profiles: any[] = Array.isArray(parsed) ? parsed : parsed.profiles || [];
      return profiles.map((p: any) => ({
        name: p.name || "",
        host: p.host || "",
        cloud: p.cloud || "",
        authType: p.auth_type || "",
        valid: p.valid === true,
      }));
    } catch {
      return [];
    }
  }

  async listLakebaseProfiles(): Promise<DatabricksProfile[]> {
    const profiles = await this.listProfiles();
    const enriched: DatabricksProfile[] = [];
    for (const p of profiles) {
      if (!p.valid) { continue; }
      try {
        const raw = await lakebaseExec("databricks postgres list-projects -o json", undefined, {
          DATABRICKS_CONFIG_PROFILE: p.name,
        });
        const parsed = JSON.parse(raw);
        const projects = Array.isArray(parsed) ? parsed : parsed.projects || [];
        enriched.push({
          ...p,
          hasLakebase: projects.length > 0,
          lakebaseProjects: projects.map((pp: any) => ({
            uid: pp.uid,
            displayName: pp.status?.display_name || pp.display_name || pp.uid,
          })),
        });
      } catch {
        enriched.push({ ...p, hasLakebase: false });
      }
    }
    return enriched;
  }

  async checkAuth(): Promise<AuthStatus> {
    const expectedHost = this.getEffectiveHost().replace(/\/+$/, "");
    // Fail fast when no host is configured. Otherwise the CLI runs against
    // whatever ambient profile the user has, which may not be the project's
    // intended workspace — silent cross-workspace operations are confusing.
    if (!expectedHost) {
      return {
        authenticated: false,
        currentHost: "",
        expectedHost: "",
        mismatch: false,
        error: "No DATABRICKS_HOST configured (set it in .env or via the workspace picker)",
      };
    }
    try {
      const raw = await this.withHost(() => lakebaseExec("databricks current-user me -o json"));
      const user = JSON.parse(raw);
      const userHost = user?.host?.replace(/\/+$/, "") || expectedHost;
      return {
        authenticated: true,
        currentHost: userHost,
        expectedHost,
        mismatch: !!(expectedHost && userHost && expectedHost !== userHost),
      };
    } catch (err: any) {
      return {
        authenticated: false,
        currentHost: "",
        expectedHost,
        mismatch: false,
        error: err?.message || String(err),
      };
    }
  }

  getLoginCommand(host?: string): string {
    const target = (host || this.getEffectiveHost()).replace(/\/+$/, "");
    if (target) { return `databricks auth login --host ${target}`; }
    return "databricks auth login";
  }

  async getCurrentUserEmail(): Promise<string> {
    try {
      const raw = await this.withHost(() => lakebaseExec("databricks current-user me -o json"));
      const user = JSON.parse(raw);
      return user.userName || user.emails?.[0]?.value || "";
    } catch {
      return "";
    }
  }

  // ── Substrate-routed: branch CRUD ──────────────────────────────

  async listBranches(): Promise<LakebaseBranch[]> {
    const branches = await this.withHost(() =>
      substrateListBranches({ instance: this.projectInstance() })
    );
    return branches.map(adaptBranchInfo);
  }

  async getDefaultBranch(): Promise<LakebaseBranch | undefined> {
    const b = await this.withHost(() =>
      substrateGetDefaultBranch({ instance: this.projectInstance() })
    );
    return b ? adaptBranchInfo(b) : undefined;
  }

  async getBranchByName(name: string): Promise<LakebaseBranch | undefined> {
    const b = await this.withHost(() =>
      substrateGetBranchByName(name, { instance: this.projectInstance() })
    );
    return b ? adaptBranchInfo(b) : undefined;
  }

  async createBranch(
    gitBranch: string,
    baseBranchOverride?: string,
    currentGitBranch?: string,
  ): Promise<LakebaseBranch | undefined> {
    const sanitized = substrateSanitizeBranchName(gitBranch);
    const configuredBase = baseBranchOverride || getConfig().baseBranch;
    const parentBranch = resolveCreateBranchParent({
      sanitized,
      configuredBase,
      envBranchId: (getEnvConfig().LAKEBASE_BRANCH_ID || "").trim(),
      currentGitBranch,
      sanitize: substrateSanitizeBranchName,
      warn: (msg) => console.warn(msg),
    });

    const created = await this.withHost(() =>
      substrateCreateBranch({
        instance: this.projectInstance(),
        branch: gitBranch,
        parentBranch,
      })
    );
    return adaptBranchInfo(created);
  }

  async waitForBranchReady(branchName: string, maxAttempts = 24): Promise<LakebaseBranch | undefined> {
    // Substrate waitForBranchReady takes a timeout budget, not attempt count.
    // Match the extension's previous "5s × maxAttempts" with maxAttempts × 5s.
    try {
      const b = await this.withHost(() =>
        substrateWaitForBranchReady({
          instance: this.projectInstance(),
          branch: branchName,
          timeoutMs: maxAttempts * 5_000,
        })
      );
      return adaptBranchInfo(b);
    } catch {
      return undefined;
    }
  }

  async deleteBranch(branchNameOrUid: string): Promise<void> {
    await this.withHost(() =>
      substrateDeleteBranch({
        instance: this.projectInstance(),
        branch: branchNameOrUid,
      })
    );
  }

  // ── Substrate-routed: endpoint + credential + schema ───────────

  async getEndpoint(branchNameOrUid: string): Promise<{ host: string; state: string } | undefined> {
    return this.withHost(() =>
      substrateGetEndpoint({
        instance: this.projectInstance(),
        branch: branchNameOrUid,
      })
    );
  }

  async getCredential(branchNameOrUid: string): Promise<LakebaseCredential> {
    return this.withHost(() =>
      substrateGetCredential({
        instance: this.projectInstance(),
        branch: branchNameOrUid,
      })
    );
  }

  async enrichWithEndpoints(branches: LakebaseBranch[]): Promise<LakebaseBranch[]> {
    return Promise.all(
      branches.map(async (b) => {
        try {
          const ep = await this.getEndpoint(b.uid);
          return { ...b, endpointHost: ep?.host, endpointState: ep?.state };
        } catch {
          return b;
        }
      })
    );
  }

  /**
   * Sync .env with the current credentials for a branch. Stays inline because
   * it writes to the VS Code workspace .env and uses VS Code's window
   * notifications for retry UX.
   */
  async syncConnection(branchId: string): Promise<{ host: string; branchId: string; username: string; password: string } | undefined> {
    const vscode = require("vscode");
    const { updateEnvConnection } = require("../utils/config");
    const failTimestamp = new Date().toISOString();
    updateEnvConnection({ host: "", branchId, username: "", password: "", comment: `# Connection pending at ${failTimestamp}. If this persists, run: git checkout - && git checkout <branch>` });

    let ep = await this.getEndpoint(branchId);
    if (!ep?.host) {
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 5000));
        ep = await this.getEndpoint(branchId);
        if (ep?.host) { break; }
      }
    }
    if (!ep?.host) {
      const action = await vscode.window.showWarningMessage(
        `Lakebase endpoint for branch "${branchId}" is not available. Credentials in .env are empty.`,
        "Retry"
      );
      if (action === "Retry") { return this.syncConnection(branchId); }
      return undefined;
    }
    const cred = await this.getCredential(branchId);
    updateEnvConnection({ host: ep.host, branchId, username: cred.email, password: cred.token });
    return { host: ep.host, branchId, username: cred.email, password: cred.token };
  }

  async queryBranchTables(branchNameOrUid: string): Promise<string[]> {
    try {
      return await this.withHost(() =>
        substrateQueryBranchTables({
          instance: this.projectInstance(),
          branch: branchNameOrUid,
          database: getProjectDatabase(),
        })
      );
    } catch (err: any) {
      console.error(`[lakebase-scm] queryBranchTables failed: ${err?.message || err}`);
      return [];
    }
  }

  async queryBranchSchema(branchNameOrUid: string): Promise<Array<{ name: string; columns: Array<{ name: string; dataType: string }> }>> {
    try {
      return await this.withHost(() =>
        substrateQueryBranchSchema({
          instance: this.projectInstance(),
          branch: branchNameOrUid,
          database: getProjectDatabase(),
        })
      );
    } catch (err: any) {
      console.error(`[lakebase-scm] queryBranchSchema failed: ${err?.message || err}`);
      return [];
    }
  }

  // ── Substrate-routed: project CRUD + metadata ──────────────────

  async createProject(projectId: string): Promise<{ uid: string; name: string; state: string }> {
    return this.withHost(() =>
      substrateCreateLakebaseProject({ projectId, host: this.hostOverride })
    );
  }

  async deleteProject(projectId: string): Promise<void> {
    return this.withHost(() =>
      substrateDeleteLakebaseProject({ projectId, host: this.hostOverride })
    );
  }

  async getProjectDisplayName(): Promise<string | undefined> {
    const info = await this.withHost(() =>
      substrateGetProjectInfo({ projectId: this.projectInstance(), host: this.hostOverride })
    );
    return info?.displayName;
  }

  async getProjectUid(): Promise<string | undefined> {
    const info = await this.withHost(() =>
      substrateGetProjectInfo({ projectId: this.projectInstance(), host: this.hostOverride })
    );
    return info?.uid;
  }

  sanitizeBranchName(name: string): string {
    return substrateSanitizeBranchName(name);
  }

  /** Build the Databricks console URL for a Lakebase project or branch. */
  async getConsoleUrl(branchUid?: string): Promise<string> {
    const host = this.getEffectiveHost().replace(/\/+$/, "");
    if (!host) { return ""; }
    const projectUid = await this.getProjectUid();
    if (!projectUid) { return ""; }
    let url = `${host}/lakebase/projects/${projectUid}`;
    if (branchUid) { url += `/branches/${branchUid}`; }
    return url;
  }
}

/**
 * Decide which branch to fork a new Lakebase branch from. Extracted as a
 * pure helper so the precedence rules can be unit-tested without spinning
 * up the full LakebaseService dependency graph.
 *
 * Precedence:
 *   1. `configuredBase` — explicit override (caller-supplied or VS Code
 *      config pinning a base like "staging").
 *   2. `currentGitBranch` (sanitized) — the actual git HEAD the caller
 *      just observed. Preferred over `envBranchId` when both are present;
 *      if they disagree, `envBranchId` was stale (post-checkout hook
 *      didn't fire, or `git checkout` ran with hooks disabled). Emits a
 *      `warn` so the drift is visible.
 *   3. `envBranchId` — fallback from `.env`'s `LAKEBASE_BRANCH_ID`,
 *      used when the caller can't observe git HEAD (agent/headless flows).
 *   4. `undefined` — substrate falls through to project default.
 *
 * Returns `undefined` when the resolved parent equals `sanitized` itself
 * (no-op fork), letting substrate handle the same-name case downstream.
 */
export interface ResolveCreateBranchParentArgs {
  sanitized: string;
  configuredBase?: string;
  envBranchId: string;
  currentGitBranch?: string;
  sanitize: (s: string) => string;
  warn: (msg: string) => void;
}

export function resolveCreateBranchParent(args: ResolveCreateBranchParentArgs): string | undefined {
  if (args.configuredBase) return args.configuredBase;

  const gitBranchId = args.currentGitBranch ? args.sanitize(args.currentGitBranch) : "";

  if (gitBranchId) {
    if (args.envBranchId && args.envBranchId !== gitBranchId) {
      args.warn(
        `[lakebaseService] drift: .env LAKEBASE_BRANCH_ID="${args.envBranchId}" but git HEAD is "${gitBranchId}". ` +
          `Using git HEAD as parent for new branch "${args.sanitized}". ` +
          `Run the post-checkout hook (or git checkout <current>) to resync .env.`,
      );
    }
    if (gitBranchId !== args.sanitized) return gitBranchId;
    return undefined;
  }

  if (args.envBranchId && args.envBranchId !== args.sanitized) return args.envBranchId;
  return undefined;
}
