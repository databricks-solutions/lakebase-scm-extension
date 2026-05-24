// Shared harness for adapter-aware equivalence tests (FEIP-7080).
//
// Each test stubs a substrate function, calls the matching extension
// proxy, and asserts:
//   1. Substrate was called with the args the proxy derived from VS Code
//      context (catches arg-mapping drift).
//   2. The proxy returned `adapter(substrateResult)` (catches adapter
//      mapping drift).
//
// The adapter contracts re-declared here are the single source of truth
// for what each proxy is allowed to transform. Drift between contract
// and proxy fails the deepStrictEqual, deliberately requiring a paired
// update.
//
// How the stub works: test/setup.js routes `require('@databricks-...')`
// to test/mocks/substrate.js, which exposes each substrate export via a
// getter consulting an `__overrides` map. stubSubstrate writes into that
// map; restoreSubstrate clears it.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const substrate = require("@databricks-solutions/lakebase-app-dev-kit");

interface SubstrateMock {
  __overrides: Record<string, unknown>;
  __real: Record<string, unknown>;
  __hasOverride: (name: string) => boolean;
  [key: string]: unknown;
}
const SUBSTRATE = substrate as SubstrateMock;

if (!("__overrides" in SUBSTRATE)) {
  throw new Error(
    "substrate mock not loaded, expected test/mocks/substrate.js via test/setup.js"
  );
}

// ---- Call trackers ------------------------------------------------------

export interface CallTracker {
  callCount: number;
  calls: unknown[][];
  firstCall: { args: unknown[] } | undefined;
  /** Substrate name this tracker is bound to (debug aid). */
  name: string;
}

const TRACKERS = new Map<string, CallTracker>();

/** Replace substrate[name] with a function returning (or invoking)
 * `returns`. Returns a per-stub call tracker. */
export function stubSubstrate(name: string, returns: unknown): CallTracker {
  if (!(name in SUBSTRATE.__real)) {
    throw new Error(`substrate has no export "${name}", stub target invalid`);
  }
  const tracker: CallTracker = { callCount: 0, calls: [], firstCall: undefined, name };
  const impl =
    typeof returns === "function"
      ? (returns as (...args: unknown[]) => unknown)
      : () => returns;
  SUBSTRATE.__overrides[name] = async (...args: unknown[]) => {
    tracker.callCount += 1;
    tracker.calls.push(args);
    if (!tracker.firstCall) {
      tracker.firstCall = { args };
    }
    return impl(...args);
  };
  TRACKERS.set(name, tracker);
  return tracker;
}

/** Drop every override. Call in afterEach. */
export function restoreSubstrate(): void {
  for (const name of Object.keys(SUBSTRATE.__overrides)) {
    delete SUBSTRATE.__overrides[name];
  }
  TRACKERS.clear();
}

// ---- Canonical fixtures -------------------------------------------------

export function sampleBranchInfo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    uid: "br-red-thunder-d24muck6",
    name: "projects/proj-x/branches/customer-entity",
    state: "READY",
    isDefault: false,
    sourceBranchName: "projects/proj-x/branches/main",
    createTime: "2026-05-01T12:00:00Z",
    ...overrides,
  };
}

export function sampleSchemaDiffResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    target: { branch: "br-feature", database: "databricks_postgres" },
    parent: { branch: "br-main", database: "databricks_postgres" },
    changes: [],
    error: undefined,
    ...overrides,
  };
}

export function sampleEndpoint(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "primary",
    host: "primary.proj-x.lakebase.databricks.com",
    state: "ACTIVE",
    ...overrides,
  };
}

// ---- Adapter contracts --------------------------------------------------

/** Mirror of lakebaseService.adaptBranchInfo. */
export function expectedBranchAdapter(b: ReturnType<typeof sampleBranchInfo>) {
  const fullName = b.name || "";
  const branchId = fullName.split("/branches/").pop() || b.uid;
  const sourceBranch = (b.sourceBranchName as string) || "";
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

// ---- VS Code context helpers -------------------------------------------

/** Plant a workspace folder so the proxies can read their session-derived
 * inputs without a real VS Code host. */
export function plantWorkspace(host = "https://example.cloud.databricks.com", projectId = "proj-x") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require("vscode");
  (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
    { uri: { fsPath: "/fake/root" } },
  ];
  return { host, projectId };
}

/** Plant VS Code workspace.getConfiguration values. Used by services that
 * read settings via `getConfig()` (e.g. SchemaDiffService reads
 * `lakebaseProjectId`). Returns a restore function. */
export function plantConfig(values: Record<string, unknown>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscode = require("vscode");
  const original = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = (_section?: string) => ({
    get: (key: string, def: unknown) => (key in values ? values[key] : def),
  });
  return () => {
    vscode.workspace.getConfiguration = original;
  };
}
