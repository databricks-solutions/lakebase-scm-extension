import * as cp from 'child_process';
import { getConfig, getEnvConfig, getProjectDatabase } from '../utils/config';
import { exec } from '../utils/exec';

export interface LakebaseBranch {
  /** Internal API uid (e.g. br-red-thunder-d24muck6) */
  uid: string;
  /** Full resource path (e.g. projects/.../branches/customer-entity) */
  name: string;
  /** Branch ID segment from the name path (e.g. customer-entity) */
  branchId: string;
  state: string;
  isDefault: boolean;
  /** Full resource path of the parent branch this was forked from
   *  (e.g. projects/.../branches/staging). Empty for the default branch. */
  sourceBranch?: string;
  /** Branch ID segment of the parent (e.g. "staging"). Empty for default. */
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

function sanitizeBranchName(gitBranch: string): string {
  let name = gitBranch
    .replace(/\//g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .substring(0, 63);
  // Lakebase requires a minimum branch name length of 3 characters
  while (name.length < 3) name += '-x';
  return name;
}

export class LakebaseService {
  /** Runtime host override — set when user selects a workspace via the picker */
  private hostOverride: string | undefined;
  /** Runtime project ID override — set for integration tests or when workspace .env is not available */
  private projectIdOverride: string | undefined;

  private projectPath(): string {
    if (this.projectIdOverride) {
      return `projects/${this.projectIdOverride}`;
    }
    const config = getConfig();
    return `projects/${config.lakebaseProjectId}`;
  }

  /** Get the effective host: runtime override > .env > empty */
  getEffectiveHost(): string {
    if (this.hostOverride) {
      return this.hostOverride;
    }
    const config = getConfig();
    return config.databricksHost;
  }

  /** Set a runtime host override (persists for this session) */
  setHostOverride(host: string): void {
    this.hostOverride = host.replace(/\/+$/, '');
  }

  /** Set a runtime project ID override (for integration tests or non-workspace contexts) */
  setProjectIdOverride(projectId: string): void {
    this.projectIdOverride = projectId;
  }

  /** Build env vars to inject DATABRICKS_HOST so CLI targets the correct workspace */
  private cliEnv(): Record<string, string> | undefined {
    const host = this.getEffectiveHost();
    if (host) {
      return { DATABRICKS_HOST: host };
    }
    return undefined;
  }

  /** Run a databricks CLI command, injecting DATABRICKS_HOST as env var */
  private dbcli(args: string, cwd?: string): Promise<string> {
    return lakebaseExec(`databricks ${args}`, cwd, this.cliEnv());
  }

  async isAvailable(): Promise<boolean> {
    try {
      await lakebaseExec('databricks --version');
      return true;
    } catch {
      return false;
    }
  }

  /** List all configured Databricks CLI profiles from ~/.databrickscfg */
  async listProfiles(): Promise<DatabricksProfile[]> {
    try {
      const raw = await lakebaseExec('databricks auth profiles -o json');
      const parsed = JSON.parse(raw);
      const profiles: any[] = parsed.profiles || [];
      return profiles.map(p => ({
        name: p.name || '',
        host: (p.host || '').replace(/\/+$/, ''),
        cloud: p.cloud || '',
        authType: p.auth_type || '',
        valid: p.valid === true,
      }));
    } catch {
      return [];
    }
  }

  /** List profiles that have Lakebase projects available */
  async listLakebaseProfiles(): Promise<DatabricksProfile[]> {
    const profiles = await this.listProfiles();

    // Deduplicate by host (DEFAULT and named profiles often share the same host)
    const seen = new Set<string>();
    const unique = profiles.filter(p => {
      if (seen.has(p.host)) { return false; }
      seen.add(p.host);
      return true;
    });

    const results = await Promise.all(
      unique.map(async (p) => {
        if (!p.valid) {
          return { ...p, hasLakebase: false, lakebaseProjects: [] };
        }
        try {
          const raw = await lakebaseExec(
            `databricks postgres list-projects -o json`,
            undefined,
            { DATABRICKS_HOST: p.host }
          );
          const parsed = JSON.parse(raw);
          const projects = (Array.isArray(parsed) ? parsed : parsed.projects || []);
          const lakebaseProjects = projects.map((proj: any) => ({
            uid: proj.uid || '',
            displayName: proj.status?.display_name || proj.name || '',
          }));
          return {
            ...p,
            hasLakebase: lakebaseProjects.length > 0,
            lakebaseProjects,
          };
        } catch {
          return { ...p, hasLakebase: false, lakebaseProjects: [] };
        }
      })
    );

    return results.filter(p => p.hasLakebase);
  }

  /** Check if CLI can reach the target workspace (using our DATABRICKS_HOST injection) */
  async checkAuth(): Promise<AuthStatus> {
    const expectedHost = this.getEffectiveHost().replace(/\/+$/, '');

    if (!expectedHost) {
      return {
        authenticated: false,
        currentHost: '',
        expectedHost: '(not configured)',
        mismatch: false,
        error: 'No DATABRICKS_HOST in .env',
      };
    }

    try {
      // Test with our env var injection — this is what all real operations use
      const userRaw = await this.dbcli('current-user me -o json');
      const user = JSON.parse(userRaw);
      const email = user.userName || user.emails?.[0]?.value || '';
      return {
        authenticated: true,
        currentHost: expectedHost,
        expectedHost,
        mismatch: false,
        error: undefined,
      };
    } catch (err: any) {
      // Auth failed against the target host — need to login
      return {
        authenticated: false,
        currentHost: '',
        expectedHost,
        mismatch: false,
        error: `Cannot authenticate to ${expectedHost}: ${err.message}`,
      };
    }
  }

  /** Get the login command string for the effective workspace */
  getLoginCommand(host?: string): string {
    const target = (host || this.getEffectiveHost()).replace(/\/+$/, '');
    if (target) {
      return `databricks auth login --host ${target}`;
    }
    return 'databricks auth login';
  }

  async getProjectDisplayName(): Promise<string | undefined> {
    try {
      const raw = await this.dbcli('postgres list-projects -o json');
      const parsed = JSON.parse(raw);
      const projects = Array.isArray(parsed) ? parsed : parsed.projects || [];
      const config = getConfig();
      const proj = projects.find((p: any) =>
        p.uid === config.lakebaseProjectId ||
        (p.name && p.name.endsWith(`/${config.lakebaseProjectId}`))
      );
      if (proj) {
        return proj.status?.display_name || proj.display_name || undefined;
      }
    } catch { /* ignore */ }
    return undefined;
  }

  /** Resolve the current Databricks user's email, or '' on any failure. */
  async getCurrentUserEmail(): Promise<string> {
    try {
      const raw = await this.dbcli('current-user me -o json');
      const user = JSON.parse(raw);
      return user.userName || user.emails?.[0]?.value || '';
    } catch {
      return '';
    }
  }

  async listBranches(): Promise<LakebaseBranch[]> {
    const projPath = this.projectPath();
    const raw = await this.dbcli(`postgres list-branches "${projPath}" -o json`);
    const parsed = JSON.parse(raw);

    const items: any[] = Array.isArray(parsed)
      ? parsed
      : parsed.branches || parsed.items || [];

    return items.map((b: any) => {
      const fullName: string = b.name || '';
      const uid = b.uid || b.id || '';
      // Extract the branch ID segment from the full path: projects/.../branches/{branchId}
      const branchId = fullName.split('/branches/').pop() || b.branch_id || b.display_name || uid;
      const sourceBranch: string = b.status?.source_branch || b.source_branch || '';
      const sourceBranchId = sourceBranch.split('/branches/').pop() || '';
      return {
        uid,
        name: fullName,
        branchId,
        state: b.status?.current_state || 'UNKNOWN',
        isDefault: b.status?.default === true || b.is_default === true,
        sourceBranch: sourceBranch || undefined,
        sourceBranchId: sourceBranchId || undefined,
        endpointHost: undefined,
        endpointState: undefined,
      };
    });
  }

  async getDefaultBranch(): Promise<LakebaseBranch | undefined> {
    const branches = await this.listBranches();
    return branches.find(b => b.isDefault);
  }

  async getBranchByName(name: string): Promise<LakebaseBranch | undefined> {
    const branches = await this.listBranches();
    const sanitized = sanitizeBranchName(name);
    return branches.find(b =>
      b.branchId === sanitized ||
      b.branchId === name ||
      b.uid === sanitized ||
      b.uid === name ||
      b.name.endsWith(`/branches/${sanitized}`) ||
      b.name.endsWith(`/branches/${name}`)
    );
  }

  /** Resolve a branchId, uid, or name to the full resource path */
  private async resolveBranchPath(branchNameOrUid: string): Promise<string | undefined> {
    // If it already looks like a full path, use it directly
    if (branchNameOrUid.startsWith('projects/')) {
      return branchNameOrUid;
    }
    const branches = await this.listBranches();
    const branch = branches.find(b =>
      b.branchId === branchNameOrUid ||
      b.uid === branchNameOrUid ||
      b.name.endsWith(`/${branchNameOrUid}`)
    );
    return branch?.name;
  }

  async createBranch(gitBranch: string, baseBranchOverride?: string): Promise<LakebaseBranch | undefined> {
    const projPath = this.projectPath();
    const branchName = sanitizeBranchName(gitBranch);

    const existing = await this.getBranchByName(branchName);
    if (existing) {
      return existing;
    }

    // Resolve the source (parent) Lakebase branch. Precedence:
    //   1. Explicit `baseBranchOverride` arg (caller-supplied, e.g. for a
    //      one-off "branch from prod" hotfix even when config says staging).
    //   2. `LAKEBASE_BASE_BRANCH` from .env / `lakebaseSync.baseBranch` VS Code
    //      setting — a project-wide "features ALWAYS fork from here" pin.
    //   3. The Lakebase branch the user is currently on (LAKEBASE_BRANCH_ID
    //      from .env) — git-like "fork from current" semantics. Mirrors the
    //      post-checkout hook's default. Skipped when the current-branch id
    //      equals the target (edge case — user recreating the same branch).
    //   4. Project default Lakebase branch (usually `production`).
    let sourceBranch: string;
    const configuredBase = baseBranchOverride || getConfig().baseBranch;
    if (configuredBase) {
      sourceBranch = `${projPath}/branches/${configuredBase}`;
    } else {
      const prevBranchId = (getEnvConfig().LAKEBASE_BRANCH_ID || '').trim();
      let prevResolved: LakebaseBranch | undefined;
      if (prevBranchId && prevBranchId !== branchName) {
        try {
          prevResolved = await this.getBranchByName(prevBranchId);
        } catch { /* fall through to default */ }
      }
      if (prevResolved) {
        sourceBranch = prevResolved.name;
      } else {
        const defaultBranch = await this.getDefaultBranch();
        if (!defaultBranch) {
          throw new Error('Could not find default Lakebase branch');
        }
        sourceBranch = defaultBranch.name;
      }
    }

    const spec = JSON.stringify({
      spec: { source_branch: sourceBranch, no_expiry: true },
    });

    await this.dbcli(
      `postgres create-branch "${projPath}" "${branchName}" --json '${spec}'`
    );

    return this.waitForBranchReady(branchName);
  }

  async waitForBranchReady(branchName: string, maxAttempts = 24): Promise<LakebaseBranch | undefined> {
    const sanitized = sanitizeBranchName(branchName);
    for (let i = 0; i < maxAttempts; i++) {
      const branch = await this.getBranchByName(sanitized);
      if (branch && branch.state === 'READY') {
        return branch;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    return undefined;
  }

  async deleteBranch(branchNameOrUid: string): Promise<void> {
    // The CLI expects the full resource name (projects/.../branches/...), not the uid.
    // Look up the branch to get its full name.
    const branches = await this.listBranches();
    const branch = branches.find(b =>
      b.uid === branchNameOrUid ||
      b.name.endsWith(`/${branchNameOrUid}`) ||
      b.name === branchNameOrUid
    );

    if (!branch || !branch.name) {
      throw new Error(`Branch "${branchNameOrUid}" not found`);
    }

    await this.dbcli(`postgres delete-branch "${branch.name}"`);
  }

  async getEndpoint(branchNameOrUid: string): Promise<{ host: string; state: string } | undefined> {
    // Resolve to the full resource name path
    const branchPath = await this.resolveBranchPath(branchNameOrUid);
    if (!branchPath) {
      return undefined;
    }
    try {
      const raw = await this.dbcli(`postgres list-endpoints "${branchPath}" -o json`);
      const endpoints = JSON.parse(raw);
      if (Array.isArray(endpoints) && endpoints.length > 0) {
        const ep = endpoints[0];
        return {
          host: ep.status?.hosts?.host || '',
          state: ep.status?.current_state || 'UNKNOWN',
        };
      }
    } catch {
      // No endpoints
    }
    return undefined;
  }

  async getCredential(branchNameOrUid: string): Promise<LakebaseCredential> {
    const branchPath = await this.resolveBranchPath(branchNameOrUid);
    if (!branchPath) {
      throw new Error(`Branch "${branchNameOrUid}" not found`);
    }
    const endpointPath = `${branchPath}/endpoints/primary`;

    const tokenRaw = await this.dbcli(
      `postgres generate-database-credential "${endpointPath}" -o json`
    );
    const token = JSON.parse(tokenRaw).token || '';

    const userRaw = await this.dbcli('current-user me -o json');
    const userParsed = JSON.parse(userRaw);
    const email = userParsed.userName || userParsed.emails?.[0]?.value || '';

    return { token, email };
  }

  async enrichWithEndpoints(branches: LakebaseBranch[]): Promise<LakebaseBranch[]> {
    const enriched = await Promise.all(
      branches.map(async (b) => {
        try {
          const ep = await this.getEndpoint(b.uid);
          return { ...b, endpointHost: ep?.host, endpointState: ep?.state };
        } catch {
          return b;
        }
      })
    );
    return enriched;
  }

  /**
   * Sync connection for a branch: get endpoint, get credential, update .env.
   * Encapsulates the 3-step pattern used in 7 places across extension.ts.
   * Retries up to 30s waiting for the endpoint to become available (newly
   * created branches have a delay between branch READY and endpoint ACTIVE).
   * @returns Connection info, or undefined if endpoint never became available.
   */
  async syncConnection(branchId: string): Promise<{ host: string; branchId: string; username: string; password: string } | undefined> {
    const vscode = require('vscode');
    const { updateEnvConnection } = require('../utils/config');
    // Immediately point .env at this branch with empty credentials.
    // This ensures .env never remains pointed at production.
    const failTimestamp = new Date().toISOString();
    updateEnvConnection({ host: '', branchId, username: '', password: '', comment: `# Connection pending at ${failTimestamp}. If this persists, run: git checkout - && git checkout <branch>` });

    let ep = await this.getEndpoint(branchId);
    if (!ep?.host) {
      // Endpoint may still be provisioning — retry up to 30s
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 5000));
        ep = await this.getEndpoint(branchId);
        if (ep?.host) { break; }
      }
    }
    if (!ep?.host) {
      const action = await vscode.window.showWarningMessage(
        `Lakebase endpoint for branch "${branchId}" is not available. Credentials in .env are empty.`,
        'Retry'
      );
      if (action === 'Retry') {
        return this.syncConnection(branchId);
      }
      return undefined;
    }
    const cred = await this.getCredential(branchId);
    updateEnvConnection({ host: ep.host, branchId, username: cred.email, password: cred.token });
    return { host: ep.host, branchId, username: cred.email, password: cred.token };
  }

  /**
   * Query the actual tables on a Lakebase branch database (names only).
   * @param branchNameOrUid - Branch uid, branchId, or full resource name
   * @returns Array of table names in the public schema, or empty if unavailable
   */
  async queryBranchTables(branchNameOrUid: string): Promise<string[]> {
    const schema = await this.queryBranchSchema(branchNameOrUid);
    return schema.map(t => t.name);
  }

  /**
   * Query the actual tables and their columns on a Lakebase branch database.
   * Connects via the branch endpoint and queries information_schema.
   *
   * Two execution paths:
   *   1. `psql` shell-out (primary). Fast, zero node-side dependencies, but
   *      requires the `psql` binary on PATH — not installed by default on
   *      macOS, and the reason the schema tree used to silently render empty
   *      for users without libpq.
   *   2. `pg` node client (fallback). Bundled with the extension, so it
   *      always works regardless of the user's PATH. Slightly slower on
   *      first connect because it opens a fresh TCP+TLS session.
   *
   * Errors in the psql path fall through to pg. Errors in pg surface to the
   * console (not silently swallowed).
   *
   * @param branchNameOrUid - Branch uid, branchId, or full resource name
   * @returns Array of { name, columns[] } for each table in the public schema
   */
  async queryBranchSchema(branchNameOrUid: string): Promise<Array<{ name: string; columns: Array<{ name: string; dataType: string }> }>> {
    const ep = await this.getEndpoint(branchNameOrUid);
    if (!ep?.host) { return []; }
    const cred = await this.getCredential(branchNameOrUid);
    const dbName = getProjectDatabase();

    // Single source of truth for the query — keeps psql + pg paths identical.
    const sql =
      "SELECT c.table_name, c.column_name, c.data_type " +
      "FROM information_schema.columns c " +
      "JOIN pg_tables t ON c.table_name = t.tablename " +
      "WHERE c.table_schema='public' AND t.schemaname='public' " +
      "ORDER BY c.table_name, c.ordinal_position";

    const rowsToTables = (rows: Array<{ table_name: string; column_name: string; data_type: string }>) => {
      const tables = new Map<string, Array<{ name: string; dataType: string }>>();
      for (const r of rows) {
        if (!r.table_name) { continue; }
        if (!tables.has(r.table_name)) { tables.set(r.table_name, []); }
        tables.get(r.table_name)!.push({ name: r.column_name, dataType: r.data_type });
      }
      return Array.from(tables.entries()).map(([name, columns]) => ({ name, columns }));
    };

    // ── Path 1: psql ────────────────────────────────────────────────
    try {
      const connStr = `host=${ep.host} port=5432 dbname=${dbName} user=${cred.email} password=${cred.token} sslmode=require`;
      const { execSync } = require('child_process');
      const raw: string = execSync(
        `psql "${connStr}" -t -A -c "${sql};"`,
        { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
      ).toString().trim();
      if (!raw) { return []; }
      const rows = raw
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [table_name, column_name, data_type] = line.split('|');
          return { table_name, column_name, data_type };
        });
      return rowsToTables(rows);
    } catch (psqlErr: any) {
      // psql not on PATH, or a connection error. Fall through to pg.
      console.warn(`[lakebase-scm] psql unavailable (${psqlErr?.code || psqlErr?.message || 'unknown'}); falling back to pg client.`);
    }

    // ── Path 2: pg node client (bundled, no PATH deps) ──────────────
    let Client: any;
    try {
      // Lazy require so the extension still activates if the bundle
      // somehow fails to include pg (unusual but defensive).
      ({ Client } = require('pg'));
    } catch (requireErr: any) {
      console.error(`[lakebase-scm] Could not load 'pg' fallback: ${requireErr?.message || requireErr}. Schema tree will be empty.`);
      return [];
    }

    const client = new Client({
      host: ep.host,
      port: 5432,
      database: dbName,
      user: cred.email,
      password: cred.token,
      ssl: { rejectUnauthorized: false }, // Lakebase uses a managed cert; match psql's sslmode=require
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
    });

    try {
      await client.connect();
      const result = await client.query(sql);
      return rowsToTables(result.rows as Array<{ table_name: string; column_name: string; data_type: string }>);
    } catch (pgErr: any) {
      console.error(`[lakebase-scm] pg fallback also failed: ${pgErr?.message || pgErr}`);
      return [];
    } finally {
      try { await client.end(); } catch { /* noop */ }
    }
  }

  /**
   * Create a new Lakebase project. Long-running — waits for completion by default.
   * @param projectId - Project ID (1-63 chars, lowercase, letters/numbers/hyphens, starts with letter)
   * @returns The created project metadata
   */
  async createProject(projectId: string): Promise<{ uid: string; name: string; state: string }> {
    const raw = await this.dbcli(`postgres create-project "${projectId}" -o json`);
    const parsed = JSON.parse(raw);
    // The CLI returns the operation result; extract project info
    const result = parsed.response || parsed.result || parsed;
    return {
      uid: result.uid || projectId,
      name: result.name || `projects/${projectId}`,
      state: result.status?.current_state || result.state || 'READY',
    };
  }

  /**
   * Delete a Lakebase project. Long-running — waits for completion by default.
   * @param projectId - Project ID (e.g. "my-app")
   */
  async deleteProject(projectId: string): Promise<void> {
    const name = projectId.startsWith('projects/') ? projectId : `projects/${projectId}`;
    await this.dbcli(`postgres delete-project "${name}" -o json`);
  }

  sanitizeBranchName(name: string): string {
    return sanitizeBranchName(name);
  }

  /** Resolve the project UUID from list-projects (the console URL uses UUID, not project name) */
  async getProjectUid(): Promise<string | undefined> {
    try {
      const raw = await this.dbcli('postgres list-projects -o json');
      const parsed = JSON.parse(raw);
      const projects = Array.isArray(parsed) ? parsed : parsed.projects || [];
      const projPath = this.projectPath();
      const proj = projects.find((p: any) =>
        p.uid === projPath.replace('projects/', '') ||
        p.name === projPath ||
        (p.name && p.name.endsWith(`/${projPath.replace('projects/', '')}`))
      );
      return proj?.uid;
    } catch {
      return undefined;
    }
  }

  /** Build the Databricks console URL for a Lakebase project or branch */
  async getConsoleUrl(branchUid?: string): Promise<string> {
    const host = this.getEffectiveHost().replace(/\/+$/, '');
    if (!host) { return ''; }
    const projectUid = await this.getProjectUid();
    if (!projectUid) { return ''; }
    let url = `${host}/lakebase/projects/${projectUid}`;
    if (branchUid) {
      url += `/branches/${branchUid}`;
    }
    return url;
  }
}
