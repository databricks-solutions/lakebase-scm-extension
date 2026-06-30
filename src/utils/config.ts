import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveMigrationLayout,
  detectLanguageAt,
  type MigrationLanguage,
} from '@databricks-solutions/lakebase-app-dev-kit';

// The kit (lakebase-app-dev-kit) owns language detection + the per-language
// migration conventions (path / pattern / glob) , see its
// scripts/lakebase/migration-layout.ts. The extension consumes that single
// source of truth so the two never drift. ProjectLanguage stays as an alias of
// the kit type for back-compat with existing imports.
export type ProjectLanguage = MigrationLanguage;

export interface LakebaseConfig {
  databricksHost: string;
  /**
   * ~/.databrickscfg profile to pin for CLI auth. Resolution:
   * `lakebaseSync.databricksProfile` setting, else `.env`
   * DATABRICKS_CONFIG_PROFILE. Empty when neither is set (the extension then
   * falls back to host-matching against ~/.databrickscfg). The explicit pin is
   * the only thing that disambiguates a host that several profiles match.
   */
  databricksProfile: string;
  lakebaseProjectId: string;
  autoCreateBranch: boolean;
  autoRefreshCredentials: boolean;
  /** On connect/refresh, create a local tracking branch for every origin branch
   *  that has no local counterpart, so the tree pairs them with Lakebase. */
  autoCreateLocalBranchesFromOrigin: boolean;
  migrationPath: string;
  /** Regex pattern for migration filenames (auto-detected from project language) */
  migrationPattern: RegExp;
  /** File glob for migration watcher (auto-detected from project language) */
  migrationGlob: string;
  /** Detected project language */
  language: ProjectLanguage;
  showUnifiedRepo: boolean;
  productionReadOnly: boolean;
  /**
   * Optional git branch name (in addition to `main`/`master`) that should be
   * treated as the project trunk. When set and the user is on this branch,
   * `.env` points at the project's default Lakebase branch (production)
   * rather than a feature branch cut from it.
   */
  trunkBranch: string;
  /**
   * Optional git branch name paired with the Lakebase `staging` branch.
   * When set and the user is on this branch, `.env` points at the Lakebase
   * `staging` branch (which must already exist – this hook does NOT
   * auto-create it). Symmetric to `trunkBranch` but targets `staging`
   * instead of the project's default Lakebase branch.
   */
  stagingBranch: string;
  /**
   * Lakebase branch id that new feature branches fork from. Defaults to the
   * project's default Lakebase branch (usually `production`) when empty.
   * Typical multi-tier setup: `LAKEBASE_BASE_BRANCH=staging` so merged
   * feature schema drift accumulates in staging and is rebased to production
   * on release.
   */
  baseBranch: string;
  /**
   * Per-project OVERRIDE: extra protected tier leaf names beyond the kit's
   * default set (main/master/staging/dev) and the configured trunk/staging/base.
   * The default set + the named-AND-long-running matching logic are the kit's
   * (source of truth); this is only the project's deviation data. A branch is a
   * protected tier when long-running AND its name is in the combined set; an
   * off-convention long-running branch is an ordinary branch. Source:
   * `lakebaseSync.tierNames` (array) or `LAKEBASE_TIER_NAMES` (csv in .env).
   */
  tierNames: string[];
  /**
   * String prefix that scopes the branch-tree view to this project's git
   * branches. Only branches whose name starts with this prefix are listed
   * in the sidebar (the current branch is always shown regardless). Useful
   * in monorepos where the repo contains unrelated branches from other
   * projects/users. Empty = show all branches (original behavior).
   */
  gitBranchPrefix: string;
  /**
   * Optional `DATABRICKS_AUTH_STORAGE` override. Honored by
   * `lakebaseExec` (lakebaseService.ts) and propagated as an env var to
   * every spawned `databricks` CLI invocation. When unset, the CLI
   * picks its default backend (keyring on newer versions, file on
   * older). Set to `plaintext` when the CLI rejects keyring credentials
   * from older saved sessions ("stored credentials from older CLI
   * versions are no longer used"): the new CLI then reads + writes
   * the file cache directly, preserving compat with existing logins.
   */
  databricksAuthStorage: string;
}

export interface EnvConfig {
  DATABRICKS_HOST?: string;
  DATABRICKS_CONFIG_PROFILE?: string;
  DATABRICKS_TOKEN?: string;
  DATABRICKS_AUTH_STORAGE?: string;
  /** GitHub PAT pinned in the project .env (e.g. an EMU token). The extension
   * host does not inherit the shell env, so a token exported in a terminal
   * never reaches us; a .env pin is how a project supplies one. */
  GITHUB_TOKEN?: string;
  LAKEBASE_PROJECT_ID?: string;
  LAKEBASE_HOST?: string;
  LAKEBASE_BRANCH_ID?: string;
  DATABASE_URL?: string;
  DB_NAME?: string;
  PGDATABASE?: string;
  DB_USERNAME?: string;
  DB_PASSWORD?: string;
  LAKEBASE_TRUNK_BRANCH?: string;
  LAKEBASE_STAGING_BRANCH?: string;
  LAKEBASE_BASE_BRANCH?: string;
  LAKEBASE_TIER_NAMES?: string;
  LAKEBASE_GIT_BRANCH_PREFIX?: string;
  // Legacy: kept for backward compat with existing Java projects
  SPRING_DATASOURCE_URL?: string;
  SPRING_DATASOURCE_USERNAME?: string;
  SPRING_DATASOURCE_PASSWORD?: string;
}

export function getWorkspaceRoot(): string | undefined {
  // Prefer VS Code's workspace when the extension runs inside an IDE.
  // Fall back to LAKEBASE_PROJECT_DIR so non-VS-Code callers (integration
  // tests, scripts, CLI agents) can point at a project root the same way
  // VS Code's open-folder does. This is a no-op for the IDE path.
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    ?? process.env.LAKEBASE_PROJECT_DIR
    ?? undefined;
}

export function parseEnvFile(filePath: string): EnvConfig {
  const config: Record<string, string> = {};
  if (!fs.existsSync(filePath)) {
    return config;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = trimmed.substring(0, eqIdx).trim();
    // Strip one layer of surrounding single/double quotes: a quoted
    // .env value (DATABRICKS_HOST="https://...") should yield the bare
    // value, not include the quote characters. Every reader benefits;
    // runnerService previously hand-rolled this strip separately.
    const value = trimmed.substring(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    config[key] = value;
  }
  return config as EnvConfig;
}

/**
 * Detect project language from marker files in the workspace root. Thin
 * back-compat wrapper over the kit's single-directory detector (the kit owns
 * the rule). Used by extension.ts for project-type display; the full
 * migration-layout resolution (monorepo descent + overrides) goes through the
 * kit's resolveMigrationLayout in getConfig().
 */
export function detectLanguage(root?: string): ProjectLanguage {
  return root ? detectLanguageAt(root) : 'unknown';
}

export function getConfig(): LakebaseConfig {
  const wsConfig = vscode.workspace.getConfiguration('lakebaseSync');
  const root = getWorkspaceRoot();

  let envConfig: EnvConfig = {};
  if (root) {
    const envPath = path.join(root, '.env');
    envConfig = parseEnvFile(envPath);
  }

  // Resolve the whole migration layout (language + path + pattern + glob) via
  // the kit's single source of truth. It is monorepo-aware (detects from the
  // configured migrationPath's subdir when the root is unmarked) and honors the
  // explicit language / migrationPattern / migrationGlob overrides, each of
  // which wins over the language defaults.
  const { language, migrationPath, migrationPattern, migrationGlob } = resolveMigrationLayout({
    projectDir: root,
    migrationPath: wsConfig.get('migrationPath', ''),
    language: wsConfig.get('language', ''),
    migrationPattern: wsConfig.get('migrationPattern', ''),
    migrationGlob: wsConfig.get('migrationGlob', ''),
  });

  return {
    databricksHost: wsConfig.get('databricksHost', '') || envConfig.DATABRICKS_HOST || '',
    databricksProfile: wsConfig.get('databricksProfile', '') || envConfig.DATABRICKS_CONFIG_PROFILE || '',
    lakebaseProjectId: wsConfig.get('lakebaseProjectId', '') || envConfig.LAKEBASE_PROJECT_ID || '',
    autoCreateBranch: wsConfig.get('autoCreateBranch', true),
    autoRefreshCredentials: wsConfig.get('autoRefreshCredentials', true),
    autoCreateLocalBranchesFromOrigin: wsConfig.get('autoCreateLocalBranchesFromOrigin', true),
    migrationPath,
    migrationPattern,
    migrationGlob,
    language,
    showUnifiedRepo: wsConfig.get('showUnifiedRepo', true),
    productionReadOnly: wsConfig.get('productionReadOnly', true),
    trunkBranch: wsConfig.get('trunkBranch', '') || envConfig.LAKEBASE_TRUNK_BRANCH || '',
    stagingBranch: wsConfig.get('stagingBranch', '') || envConfig.LAKEBASE_STAGING_BRANCH || '',
    baseBranch: wsConfig.get('baseBranch', '') || envConfig.LAKEBASE_BASE_BRANCH || '',
    tierNames: [
      ...wsConfig.get<string[]>('tierNames', []),
      ...(envConfig.LAKEBASE_TIER_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ],
    gitBranchPrefix: wsConfig.get('gitBranchPrefix', '') || envConfig.LAKEBASE_GIT_BRANCH_PREFIX || '',
    databricksAuthStorage:
      wsConfig.get('databricksAuthStorage', '') ||
      envConfig.DATABRICKS_AUTH_STORAGE ||
      process.env.DATABRICKS_AUTH_STORAGE ||
      '',
  };
}

export function getEnvConfig(): EnvConfig {
  const root = getWorkspaceRoot();
  if (!root) {
    return {};
  }
  return parseEnvFile(path.join(root, '.env'));
}

/**
 * Resolve the project's Postgres database name for psql connections.
 * Parses `DATABASE_URL` in `.env` when present; otherwise falls back to
 * `databricks_postgres` (the CLI's default). All branches of a project
 * share the same dbname, so parsing from DATABASE_URL is safe even when
 * connecting to a different branch's endpoint.
 */
export function getProjectDatabase(env?: EnvConfig): string {
  const e = env ?? getEnvConfig();
  // An explicit project database name wins , it is what the app itself connects
  // to (its getPool uses DB_NAME), and it survives the post-checkout hook writing
  // DATABASE_URL with the Lakebase DEFAULT db (databricks_postgres) even when the
  // app's data lives elsewhere (e.g. a `recipe` database). Without this the schema
  // diff queried the empty default db and silently showed no tables.
  if (e.DB_NAME) { return e.DB_NAME; }
  if (e.PGDATABASE) { return e.PGDATABASE; }
  const url = e.DATABASE_URL;
  if (url) {
    const m = url.match(/^[a-z]+:\/\/[^/]+\/([^/?#]+)/i);
    if (m && m[1]) { return decodeURIComponent(m[1]); }
  }
  return 'databricks_postgres';
}

/** Update .env with Lakebase connection info (mirrors post-checkout.sh behavior) */
export function updateEnvConnection(opts: {
  host: string;
  branchId: string;
  username: string;
  password: string;
  comment?: string;
}): void {
  const root = getWorkspaceRoot();
  if (!root) {
    return;
  }

  const envPath = path.join(root, '.env');
  const dbName = getProjectDatabase(parseEnvFile(envPath));

  // Build both URL formats. When the endpoint is not ready (no host) the value
  // MUST stay an empty, source-able assignment ("KEY="), never a "#..." string.
  // A "#..." on the right-hand side is NOT a comment to a shell that sources
  // .env: bash parses `DATABASE_URL=#` as an assignment and then runs the next
  // word as a command (e.g. `ENDPOINT_NOT_READY: command not found`), which
  // aborts any `set -e; source .env` caller (shells, git hooks, tooling). The
  // human breadcrumb lives in the `opts.comment` line above the block instead.
  const pgUrl = opts.host
    ? `postgresql://${encodeURIComponent(opts.username)}:${encodeURIComponent(opts.password)}@${opts.host}:5432/${dbName}?sslmode=require`
    : '';
  const jdbcUrl = opts.host
    ? `jdbc:postgresql://${opts.host}:5432/${dbName}?sslmode=require`
    : '';

  const keysToReplace = new Set([
    'LAKEBASE_HOST', 'LAKEBASE_BRANCH_ID',
    'DATABASE_URL', 'DB_USERNAME', 'DB_PASSWORD',
    // Legacy keys – remove if present so .env stays clean
    'SPRING_DATASOURCE_URL', 'SPRING_DATASOURCE_USERNAME', 'SPRING_DATASOURCE_PASSWORD',
  ]);

  let lines: string[] = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf-8').split('\n')
      .filter(l => {
        // Strip any prior "# Connection pending at ..." breadcrumb so
        // .env doesn't accumulate one per call. The current comment (if
        // any) is re-appended below alongside the fresh connection block.
        if (/^#\s*Connection pending at /.test(l)) { return false; }
        const key = l.trim().split('=')[0]?.trim();
        return !keysToReplace.has(key);
      });
  }

  // Remove trailing empty lines then add our block
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  // Generic names – all languages read these
  if (opts.comment) {
    lines.push(opts.comment);
  }
  lines.push(
    `LAKEBASE_HOST=${opts.host}`,
    `LAKEBASE_BRANCH_ID=${opts.branchId}`,
    `DATABASE_URL=${pgUrl}`,
    `DB_USERNAME=${opts.username}`,
    `DB_PASSWORD=${opts.password}`,
    ''
  );

  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');

  // Java-specific: write application-local.properties for Spring/Flyway
  if (fs.existsSync(path.join(root, 'pom.xml'))) {
    const propsPath = path.join(root, 'application-local.properties');
    const propsContent = [
      `# Auto-generated by Lakebase Sync for branch: ${opts.branchId}`,
      `spring.datasource.url=${jdbcUrl}`,
      `spring.datasource.username=${opts.username}`,
      `spring.datasource.password=${opts.password}`,
      '',
    ].join('\n');
    fs.writeFileSync(propsPath, propsContent, 'utf-8');
  }
}
