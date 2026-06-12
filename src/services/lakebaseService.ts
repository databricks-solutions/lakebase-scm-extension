// LakebaseService – thin VS Code-aware shell over the substrate.
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
  createLongRunningBranch as substrateCreateLongRunningBranch,
  createFeatureBranch as substrateCreateFeatureBranch,
  tierBranchNames as substrateTierBranchNames,
  type LakebaseBranchInfo,
  type CreateLongRunningBranchResult,
} from "@databricks-solutions/lakebase-app-dev-kit";
import { setKnownTierNames, isMainBranch } from "../utils/theme";
import { withDatabricksHostEnv } from "../utils/databricksEnv";
import { isAuthStorageCacheError } from "../utils/databricksAuth";

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

// Auth-error classifiers live in one place (utils/databricksAuth) and
// are re-exported here so existing importers (extension.ts) keep
// importing them from this service. They are also imported at the top
// of this file for internal use (lakebaseExec).
export { isAuthStorageCacheError, isRefreshTokenInvalidError } from "../utils/databricksAuth";

/** Canonical host key for profile matching: drop trailing slashes + lowercase
 *  so "https://X.databricks.com/" and "https://x.databricks.com" compare equal. */
function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "").toLowerCase();
}

/**
 * Module-level cache of the auth-storage mode the extension switched
 * to after a successful retry. Once we discover that `plaintext` works
 * for this host, every subsequent CLI call from this extension instance
 * passes it (in addition to .env-persisted value, which lakebaseExec
 * already honors). Cleared on `setAuthStorageRuntime("")`.
 */
let runtimeAuthStorageOverride = "";

export function setAuthStorageRuntime(value: string): void {
  runtimeAuthStorageOverride = value;
}

export function getAuthStorageRuntime(): string {
  return runtimeAuthStorageOverride;
}

/**
 * Observer fired the first time the runtime override is set by the
 * auto-retry path. The extension layer subscribes to this so it can
 * persist `DATABRICKS_AUTH_STORAGE=plaintext` to the workspace .env,
 * making the fallback stick across reloads without the user touching
 * a config file. Fires at most once per process; clear via reset.
 */
let runtimeAuthStorageObserver: ((value: string) => void) | undefined;

export function onAuthStorageRuntimeChange(cb: (value: string) => void): void {
  runtimeAuthStorageObserver = cb;
}

async function lakebaseExec(command: string, cwd?: string, env?: Record<string, string>): Promise<string> {
  // Honor DATABRICKS_AUTH_STORAGE from workspace .env when set, and
  // from the runtime override discovered by auto-retry. The CLI
  // defaults to keyring-backed storage in newer versions; plaintext is
  // the legacy file-cache mode that older saved credentials still live
  // in. Users on a workspace where re-login isn't possible can opt in
  // via .env or let the auto-retry path discover the fallback.
  const cfg = getConfig();
  const storage = cfg.databricksAuthStorage || runtimeAuthStorageOverride;
  const propagated: Record<string, string> = { ...(env ?? {}) };
  if (storage && propagated.DATABRICKS_AUTH_STORAGE === undefined) {
    propagated.DATABRICKS_AUTH_STORAGE = storage;
  }
  try {
    return await exec(command, {
      cwd,
      env: Object.keys(propagated).length > 0 ? propagated : undefined,
      timeout: 30000,
      tagAuthErrors: true,
    });
  } catch (err) {
    // Auto-retry storage-cache rejection with plaintext. If the retry
    // succeeds, persist the override at runtime so subsequent calls do
    // not pay the same retry cost. The .env-persist happens at a
    // higher layer (LakebaseService method) where we have access to
    // the workspace root.
    if (isAuthStorageCacheError(err) && propagated.DATABRICKS_AUTH_STORAGE !== "plaintext") {
      const retryEnv = { ...propagated, DATABRICKS_AUTH_STORAGE: "plaintext" };
      const result = await exec(command, {
        cwd,
        env: retryEnv,
        timeout: 30000,
        tagAuthErrors: true,
      });
      const wasUnset = runtimeAuthStorageOverride !== "plaintext";
      runtimeAuthStorageOverride = "plaintext";
      if (wasUnset && runtimeAuthStorageObserver) {
        try { runtimeAuthStorageObserver("plaintext"); } catch { /* observer must not break CLI flow */ }
      }
      return result;
    }
    throw err;
  }
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

/**
 * Thrown when the extension tries to talk to Lakebase but the workspace
 * has no `LAKEBASE_PROJECT_ID` configured. The activation flow and most
 * command handlers catch this and route to the "Set Up Lakebase for
 * This Workspace" onboarding command instead of surfacing the raw
 * substrate error.
 */
export class MissingProjectError extends Error {
  constructor(detail = "No LAKEBASE_PROJECT_ID configured for this workspace.") {
    super(detail);
    this.name = "MissingProjectError";
  }
}

/** Type guard so catches that already accept `unknown` can route reliably. */
export function isMissingProjectError(err: unknown): err is MissingProjectError {
  return err instanceof MissingProjectError || (typeof err === "object" && err !== null && (err as { name?: string }).name === "MissingProjectError");
}

export class LakebaseService {
  /** Runtime host override – set when user selects a workspace via the picker */
  private hostOverride: string | undefined;
  /** Runtime project ID override – set for integration tests or when workspace .env is not available */
  private projectIdOverride: string | undefined;

  /**
   * Resolve the active Lakebase project id from the runtime override
   * (set by the workspace picker) or `getConfig().lakebaseProjectId`
   * (read from `.env` / workspace settings). Returns the empty string
   * when nothing is configured.
   *
   * Prefer `requireProjectInstance` at the entry of any method that is
   * about to call substrate: it throws `MissingProjectError` so the
   * command-level catch can route to onboarding instead of propagating
   * an "" instance into substrate and getting back a cryptic error.
   */
  private projectInstance(): string {
    if (this.projectIdOverride) { return this.projectIdOverride; }
    return getConfig().lakebaseProjectId;
  }

  /**
   * Same lookup as `projectInstance` but throws `MissingProjectError`
   * when no project id is configured. Use this at the entry of any
   * public method that is about to call substrate; that way command
   * catches can dispatch to the onboarding flow without inspecting the
   * substrate error string.
   */
  private requireProjectInstance(): string {
    const id = this.projectInstance();
    if (!id) {
      throw new MissingProjectError();
    }
    return id;
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
   * using. Restores the prior value after, even on throw.
   *
   * Also resolves the matching `DATABRICKS_CONFIG_PROFILE` by host-match
   * against `~/.databrickscfg` and sets it in env, so CLI auth always
   * uses the right profile instead of falling back to a broken DEFAULT.
   */
  /**
   * Public wrapper around {@link withHost}. Use this to run kit
   * primitives that shell out to the `databricks` CLI but are NOT
   * methods on this service (e.g. adoptLakebaseProject, scaffoldAll,
   * createProject, getDefaultBranchId, deployEnv). Without it those
   * calls inherit only DATABRICKS_HOST (set via setHostOverride) and
   * NOT the resolved DATABRICKS_CONFIG_PROFILE, so the CLI fails with
   * "Unable to load OAuth Config" even though the extension's own
   * auth check (which goes through withHost) succeeded.
   */
  async withHostEnv<T>(fn: () => Promise<T>): Promise<T> {
    return this.withHost(fn);
  }

  private async withHost<T>(fn: () => Promise<T>): Promise<T> {
    const host = this.getEffectiveHost();
    if (!host) { return fn(); }
    // Resolve the matching profile (host-match against ~/.databrickscfg)
    // so CLI auth uses the right profile instead of a broken DEFAULT.
    const profile = (await this.resolveProfileForHost(host)) ?? undefined;
    return withDatabricksHostEnv(host, fn, profile ? { profile } : {});
  }

  /**
   * Cached host -> profile name map. `databricks auth profiles` reads
   * ~/.databrickscfg without authenticating, so this is safe even when
   * the underlying tokens are expired.
   */
  // Normalized host -> distinct VALID profile names matching it. A host
  // can legitimately appear under several profiles (e.g. DEFAULT plus a
  // named alias), and ~/.databrickscfg also carries stale/invalid entries.
  private validProfilesByHost: Record<string, string[]> | undefined;

  /**
   * Look up the profile in ~/.databrickscfg whose host matches the given
   * workspace host. Returns the profile name only when EXACTLY ONE valid
   * profile matches; returns null when none match OR the match is
   * ambiguous (more than one valid profile for the same host), so the
   * caller falls back to the CLI's own resolution rather than pinning a
   * guess. Invalid profiles are excluded entirely.
   *
   * Mirrors the kit's selectProfileForHost (databricks-profile.ts): valid +
   * exactly-one-match. Kept in sync by rule, not import, until the kit
   * alpha exposing that selector is pinned here.
   */
  async resolveProfileForHost(host: string): Promise<string | null> {
    if (!host) { return null; }
    const want = normalizeHost(host);

    let builtThisCall = false;
    if (this.validProfilesByHost === undefined) {
      await this.buildValidProfilesByHost();
      builtThisCall = true;
    }
    let matches = this.validProfilesByHost![want] ?? [];

    // Self-heal a stale "no valid profile" cache. A profile that was
    // invalid when we first cached (e.g. an expired OAuth refresh token)
    // can become valid again after an EXTERNAL `databricks auth login` the
    // extension never observed (the user fixed it in a terminal). Our cache
    // would still say "no profile for this host" and the connection stays
    // broken until a full window reload. `databricks auth profiles` is a
    // cheap config read (no network / no auth), so on a MISS rebuild once
    // before concluding there is no profile, so the next call after any
    // re-auth picks up the now-valid profile without a reload.
    if (matches.length === 0 && !builtThisCall) {
      await this.buildValidProfilesByHost();
      matches = this.validProfilesByHost![want] ?? [];
    }
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * (Re)build the validProfilesByHost map from `databricks auth profiles`.
   * Only VALID profiles with a host are recorded; a host can map to several
   * (DEFAULT + a named alias). A listProfiles failure is non-fatal: the map
   * is left empty so resolveProfileForHost returns null and the CLI falls
   * back to its own resolution.
   */
  private async buildValidProfilesByHost(): Promise<void> {
    const map: Record<string, string[]> = {};
    try {
      const profiles = await this.listProfiles();
      for (const p of profiles) {
        if (!p.valid || !p.host) { continue; }
        const key = normalizeHost(p.host);
        const names = (map[key] ??= []);
        if (!names.includes(p.name)) { names.push(p.name); }
      }
    } catch {
      // non-fatal: leave the map empty; caller returns null + CLI falls back.
    }
    this.validProfilesByHost = map;
  }

  /**
   * Force a refresh of the profile cache. Called after a re-auth flow
   * completes (the user may have added a new profile that didn't exist
   * the first time we cached).
   */
  invalidateProfileCache(): void {
    this.validProfilesByHost = undefined;
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

  /**
   * Parse a `databricks ... -o json` payload that may come back as a
   * bare array OR as an object with a named collection field. Single
   * source of truth for the array-or-`.key` unwrap that listProfiles /
   * listLakebaseProfiles each hand-rolled.
   */
  private parseCliJsonList<T = any>(raw: string, key: string): T[] {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed[key] || [];
  }

  /**
   * Fetch the authenticated user via `current-user me`, with the
   * effective host + profile env applied. Shared by checkAuth and
   * getCurrentUserEmail (both issued the identical call + parse).
   */
  private async fetchCurrentUser(): Promise<any> {
    const raw = await this.withHost(() => lakebaseExec("databricks current-user me -o json"));
    return JSON.parse(raw);
  }

  async listProfiles(): Promise<DatabricksProfile[]> {
    try {
      const raw = await lakebaseExec("databricks auth profiles -o json");
      const profiles = this.parseCliJsonList<any>(raw, "profiles");
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
        const projects = this.parseCliJsonList<any>(raw, "projects");
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
    // intended workspace – silent cross-workspace operations are confusing.
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
      const user = await this.fetchCurrentUser();
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
      const user = await this.fetchCurrentUser();
      return user.userName || user.emails?.[0]?.value || "";
    } catch {
      return "";
    }
  }

  /**
   * Probe whether the local Databricks CLI is authenticated for the given
   * profile/host. Returns rich result so callers can surface a profile-aware
   * re-auth message (substitute for runnerService's inline current-user call,
   * FEIP-7129). The profile path is needed because runnerService verifies a
   * specific profile read from a project's .env, distinct from the
   * extension's configured workspace.
   */
  async probeCliAuth(opts: { profile?: string; host?: string } = {}): Promise<
    { ok: true } | { ok: false; stderr: string }
  > {
    const profileArg = opts.profile ? ` --profile "${opts.profile}"` : "";
    const env = opts.host ? { DATABRICKS_HOST: opts.host } : undefined;
    try {
      await lakebaseExec(`databricks current-user me${profileArg} -o json`, undefined, env);
      return { ok: true };
    } catch (err: unknown) {
      const e = err as { stderr?: { toString?: () => string }; message?: string };
      const stderr = e?.stderr?.toString?.() || e?.message || String(err);
      return { ok: false, stderr };
    }
  }

  // ── Substrate-routed: branch CRUD ──────────────────────────────

  async listBranches(): Promise<LakebaseBranch[]> {
    const branches = await this.withHost(() =>
      substrateListBranches({ instance: this.requireProjectInstance() })
    );
    // FEIP-7098: refresh the theme.ts tier cache from substrate's
    // auto-discovery. Sync helpers like isTierBranch() (used by VS Code
    // input validators + status bar refresh) read this cache. Every
    // listBranches call is the natural refresh point: it's frequent
    // enough to stay current and cheap enough not to need its own RPC.
    setKnownTierNames(substrateTierBranchNames(branches));
    return branches.map(adaptBranchInfo);
  }

  async getDefaultBranch(): Promise<LakebaseBranch | undefined> {
    const b = await this.withHost(() =>
      substrateGetDefaultBranch({ instance: this.requireProjectInstance() })
    );
    return b ? adaptBranchInfo(b) : undefined;
  }

  /**
   * Resolve the Lakebase branch paired with a given git branch. The
   * trunk/main git branch maps to the project default Lakebase branch;
   * every other git branch (tier or feature) maps to a same-named
   * Lakebase branch. This is the single source of truth for the
   * trunk-vs-named branch decision that command handlers previously
   * inlined as `isMainBranch(b, trunk) ? getDefaultBranch() :
   * getBranchByName(b)`.
   *
   * @param gitBranch - current git branch name
   * @param trunkBranch - the configured trunk alias (cfg.trunkBranch)
   * @param opts.fallbackToDefault - when the named lookup misses, fall
   *   back to the default branch (used by open-in-console).
   */
  async resolveBranchForGitBranch(
    gitBranch: string,
    trunkBranch: string,
    opts: { fallbackToDefault?: boolean } = {}
  ): Promise<LakebaseBranch | undefined> {
    if (isMainBranch(gitBranch, trunkBranch)) {
      return this.getDefaultBranch();
    }
    const named = await this.getBranchByName(gitBranch);
    if (named) { return named; }
    return opts.fallbackToDefault ? this.getDefaultBranch() : undefined;
  }

  async getBranchByName(name: string): Promise<LakebaseBranch | undefined> {
    // Sanitize at entry: substrate's lookup is strict exact-string match
    // against the friendly branch_id, but callers regularly pass a raw
    // git branch (`feature/parallel-ab-test`) where the Lakebase branch
    // is the slash-stripped form. Sanitization is idempotent on already-
    // sanitized names, hardcoded values like 'staging', and UIDs (which
    // are already in [a-z0-9-]+), so this is safe across all call sites.
    const lookup = substrateSanitizeBranchName(name);
    const b = await this.withHost(() =>
      substrateGetBranchByName(lookup, { instance: this.requireProjectInstance() })
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

    // Use substrate's createFeatureBranch convention helper (FEIP-7095)
    // so feature branches get the methodology's default TTL (30d) rather
    // than substrate's raw `no_expiry: true` default. The parent is the
    // resolved parent above, not the convention helper's "staging"
    // default — the extension's parent-resolution honors the user's
    // current branch / explicit base override.
    const created = await this.withHost(() =>
      substrateCreateFeatureBranch({
        instance: this.requireProjectInstance(),
        branch: gitBranch,
        parentBranch,
      })
    );
    return adaptBranchInfo(created);
  }

  /**
   * Cut a long-running tier (staging, uat, perf, custom). Forks both a
   * Lakebase branch and a matching git branch from `forkFromBranch`, then
   * pushes the git branch to origin. Used by the `cutLongRunningBranch`
   * VS Code command (FEIP-7097).
   *
   * Delegates to substrate's createLongRunningBranch primitive; this
   * wrapper handles workspace-host mutation via withHost and surfaces a
   * typed result the command can use for the success toast.
   */
  async createLongRunningBranch(args: {
    name: string;
    forkFromBranch: string;
    workTreeDir: string;
  }): Promise<CreateLongRunningBranchResult> {
    return this.withHost(() =>
      substrateCreateLongRunningBranch({
        name: args.name,
        forkFromBranch: args.forkFromBranch,
        projectId: this.requireProjectInstance(),
        workTreeDir: args.workTreeDir,
        databricksHost: this.getEffectiveHost(),
      })
    );
  }

  async waitForBranchReady(branchName: string, maxAttempts = 24): Promise<LakebaseBranch | undefined> {
    // Substrate waitForBranchReady takes a timeout budget, not attempt count.
    // Match the extension's previous "5s × maxAttempts" with maxAttempts × 5s.
    try {
      const b = await this.withHost(() =>
        substrateWaitForBranchReady({
          instance: this.requireProjectInstance(),
          branch: substrateSanitizeBranchName(branchName),
          timeoutMs: maxAttempts * 5_000,
        })
      );
      return adaptBranchInfo(b);
    } catch {
      return undefined;
    }
  }

  /**
   * Single source of truth for the per-branch substrate call skeleton:
   * apply the effective host/profile env (withHost), resolve the project
   * instance, and sanitize the branch name (substrate's subresource
   * paths take the friendly branch_id, not a uid or a slashed git name).
   * Error handling stays at the call site, since some callers rethrow
   * (endpoint/credential) and others swallow + return a fallback (the
   * query methods).
   */
  private branchCall<T>(
    branchNameOrUid: string,
    fn: (args: { instance: string; branch: string }) => Promise<T>,
  ): Promise<T> {
    return this.withHost(() => fn({
      instance: this.requireProjectInstance(),
      branch: substrateSanitizeBranchName(branchNameOrUid),
    }));
  }

  async deleteBranch(branchNameOrUid: string): Promise<void> {
    await this.branchCall(branchNameOrUid, (a) => substrateDeleteBranch(a));
  }

  // ── Substrate-routed: endpoint + credential + schema ───────────

  async getEndpoint(branchNameOrUid: string): Promise<{ host: string; state: string } | undefined> {
    return this.branchCall(branchNameOrUid, (a) => substrateGetEndpoint(a));
  }

  async getCredential(branchNameOrUid: string): Promise<LakebaseCredential> {
    return this.branchCall(branchNameOrUid, (a) => substrateGetCredential(a));
  }

  async enrichWithEndpoints(branches: LakebaseBranch[]): Promise<LakebaseBranch[]> {
    return Promise.all(
      branches.map(async (b) => {
        try {
          // Substrate routes through `databricks postgres ...` CLI subresource
          // paths under `branches/{x}/endpoints/...`, which only accept the
          // friendly branch_id (e.g. "demo-feature"), not the uid (e.g.
          // "br-broad-sky-d2k5gewt"). Substrate hardening tracked in FEIP-7145.
          const ep = await this.getEndpoint(b.branchId);
          return { ...b, endpointHost: ep?.host, endpointState: ep?.state };
        } catch {
          return b;
        }
      })
    );
  }

  /**
   * True when .env already carries a synced connection for `branchId`,
   * i.e. the post-checkout hook (fired by the git checkout) already minted
   * credentials and rewrote .env. Lets the extension skip a redundant
   * credential mint + .env rewrite on switch (and avoids the extra
   * concurrent host-scoped CLI calls that widen the auth-env race window).
   */
  envReflectsBranch(branchId: string): boolean {
    const env = getEnvConfig();
    const sanitized = substrateSanitizeBranchName(branchId);
    return (env.LAKEBASE_BRANCH_ID || "").trim() === sanitized
      && /^postgresql:\/\//.test((env.DATABASE_URL || "").trim());
  }

  /**
   * Sync .env with the current credentials for a branch. Stays inline because
   * it writes to the VS Code workspace .env and uses VS Code's window
   * notifications for retry UX.
   */
  async syncConnection(branchId: string): Promise<{ host: string; branchId: string; username: string; password: string } | undefined> {
    // Sanitize at entry. Callers should already be passing a Lakebase
    // branchId (sanitization is idempotent in that case), but if a git
    // branch with a slash leaks through, this keeps both the substrate
    // calls and the .env we write below in the correct form.
    branchId = substrateSanitizeBranchName(branchId);
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
      return await this.branchCall(branchNameOrUid, (a) =>
        substrateQueryBranchTables({ ...a, database: getProjectDatabase() }),
      );
    } catch (err: any) {
      console.error(`[lakebase-scm] queryBranchTables failed: ${err?.message || err}`);
      return [];
    }
  }

  /**
   * Same query as `queryBranchSchema` but surfaces failures so callers can
   * render a visible diagnostic instead of a silent empty list. Used by
   * the branch tree to differentiate "branch genuinely has no tables" from
   * "schema query failed" — the silent-catch variant below masks the
   * second case.
   */
  async queryBranchSchemaWithError(
    branchNameOrUid: string,
  ): Promise<{ tables: Array<{ name: string; columns: Array<{ name: string; dataType: string }> }>; error?: string }> {
    try {
      const tables = await this.branchCall(branchNameOrUid, (a) =>
        substrateQueryBranchSchema({ ...a, database: getProjectDatabase() }),
      );
      return { tables };
    } catch (err: any) {
      const message = err?.message || String(err);
      console.error(`[lakebase-scm] queryBranchSchema failed: ${message}`);
      return { tables: [], error: message };
    }
  }

  async queryBranchSchema(branchNameOrUid: string): Promise<Array<{ name: string; columns: Array<{ name: string; dataType: string }> }>> {
    // Same query as queryBranchSchemaWithError; this variant just drops
    // the error (returns [] on failure). One source of truth.
    return (await this.queryBranchSchemaWithError(branchNameOrUid)).tables;
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
      substrateGetProjectInfo({ projectId: this.requireProjectInstance(), host: this.hostOverride })
    );
    return info?.displayName;
  }

  async getProjectUid(): Promise<string | undefined> {
    const info = await this.withHost(() =>
      substrateGetProjectInfo({ projectId: this.requireProjectInstance(), host: this.hostOverride })
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
 *   1. `configuredBase` – explicit override (caller-supplied or VS Code
 *      config pinning a base like "staging").
 *   2. `currentGitBranch` (sanitized) – the actual git HEAD the caller
 *      just observed. Preferred over `envBranchId` when both are present;
 *      if they disagree, `envBranchId` was stale (post-checkout hook
 *      didn't fire, or `git checkout` ran with hooks disabled). Emits a
 *      `warn` so the drift is visible.
 *   3. `envBranchId` – fallback from `.env`'s `LAKEBASE_BRANCH_ID`,
 *      used when the caller can't observe git HEAD (agent/headless flows).
 *   4. `undefined` – substrate falls through to project default.
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
