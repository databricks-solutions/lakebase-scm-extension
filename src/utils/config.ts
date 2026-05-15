import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type ProjectLanguage = 'java' | 'python' | 'nodejs' | 'unknown';

export interface LakebaseConfig {
  databricksHost: string;
  lakebaseProjectId: string;
  autoCreateBranch: boolean;
  autoRefreshCredentials: boolean;
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
   * `staging` branch (which must already exist — this hook does NOT
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
   * String prefix that scopes the branch-tree view to this project's git
   * branches. Only branches whose name starts with this prefix are listed
   * in the sidebar (the current branch is always shown regardless). Useful
   * in monorepos where the repo contains unrelated branches from other
   * projects/users. Empty = show all branches (original behavior).
   */
  gitBranchPrefix: string;
}

export interface EnvConfig {
  DATABRICKS_HOST?: string;
  DATABRICKS_TOKEN?: string;
  LAKEBASE_PROJECT_ID?: string;
  LAKEBASE_HOST?: string;
  LAKEBASE_BRANCH_ID?: string;
  DATABASE_URL?: string;
  DB_USERNAME?: string;
  DB_PASSWORD?: string;
  LAKEBASE_TRUNK_BRANCH?: string;
  LAKEBASE_STAGING_BRANCH?: string;
  LAKEBASE_BASE_BRANCH?: string;
  LAKEBASE_GIT_BRANCH_PREFIX?: string;
  // Legacy — kept for backward compat with existing Java projects
  SPRING_DATASOURCE_URL?: string;
  SPRING_DATASOURCE_USERNAME?: string;
  SPRING_DATASOURCE_PASSWORD?: string;
}

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
    const value = trimmed.substring(eqIdx + 1).trim();
    config[key] = value;
  }
  return config as EnvConfig;
}

/** Detect project language from marker files in workspace root */
export function detectLanguage(root?: string): ProjectLanguage {
  if (!root) { return 'unknown'; }
  if (fs.existsSync(path.join(root, 'pom.xml'))) { return 'java'; }
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) { return 'python'; }
  if (fs.existsSync(path.join(root, 'package.json')) && !fs.existsSync(path.join(root, 'pom.xml'))) { return 'nodejs'; }
  return 'unknown';
}

const MIGRATION_DEFAULTS: Record<ProjectLanguage, { path: string; pattern: RegExp; glob: string }> = {
  java:    { path: 'src/main/resources/db/migration', pattern: /^V\d+.*\.sql$/i,  glob: '*.sql' },
  python:  { path: 'alembic/versions',                pattern: /^[0-9a-f][\w]*.*\.py$/i, glob: '*.py' },
  nodejs:  { path: 'migrations',                      pattern: /^\d+.*\.(js|ts)$/i,   glob: '*.{js,ts}' },
  unknown: { path: 'src/main/resources/db/migration', pattern: /^V\d+.*\.sql$/i,  glob: '*.sql' },
};

export function getConfig(): LakebaseConfig {
  const wsConfig = vscode.workspace.getConfiguration('lakebaseSync');
  const root = getWorkspaceRoot();

  let envConfig: EnvConfig = {};
  if (root) {
    const envPath = path.join(root, '.env');
    envConfig = parseEnvFile(envPath);
  }

  const language = detectLanguage(root);
  const defaults = MIGRATION_DEFAULTS[language];
  const migrationPath = wsConfig.get('migrationPath', '') || defaults.path;

  return {
    databricksHost: wsConfig.get('databricksHost', '') || envConfig.DATABRICKS_HOST || '',
    lakebaseProjectId: wsConfig.get('lakebaseProjectId', '') || envConfig.LAKEBASE_PROJECT_ID || '',
    autoCreateBranch: wsConfig.get('autoCreateBranch', true),
    autoRefreshCredentials: wsConfig.get('autoRefreshCredentials', true),
    migrationPath,
    migrationPattern: defaults.pattern,
    migrationGlob: defaults.glob,
    language,
    showUnifiedRepo: wsConfig.get('showUnifiedRepo', true),
    productionReadOnly: wsConfig.get('productionReadOnly', true),
    trunkBranch: wsConfig.get('trunkBranch', '') || envConfig.LAKEBASE_TRUNK_BRANCH || '',
    stagingBranch: wsConfig.get('stagingBranch', '') || envConfig.LAKEBASE_STAGING_BRANCH || '',
    baseBranch: wsConfig.get('baseBranch', '') || envConfig.LAKEBASE_BASE_BRANCH || '',
    gitBranchPrefix: wsConfig.get('gitBranchPrefix', '') || envConfig.LAKEBASE_GIT_BRANCH_PREFIX || '',
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
  const url = (env ?? getEnvConfig()).DATABASE_URL;
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

  // Build both URL formats
  const pgUrl = opts.host
    ? `postgresql://${encodeURIComponent(opts.username)}:${encodeURIComponent(opts.password)}@${opts.host}:5432/${dbName}?sslmode=require`
    : '# ENDPOINT_NOT_READY — run Refresh Credentials';
  const jdbcUrl = opts.host
    ? `jdbc:postgresql://${opts.host}:5432/${dbName}?sslmode=require`
    : '# ENDPOINT_NOT_READY — run Refresh Credentials';

  const keysToReplace = new Set([
    'LAKEBASE_HOST', 'LAKEBASE_BRANCH_ID',
    'DATABASE_URL', 'DB_USERNAME', 'DB_PASSWORD',
    // Legacy keys — remove if present so .env stays clean
    'SPRING_DATASOURCE_URL', 'SPRING_DATASOURCE_USERNAME', 'SPRING_DATASOURCE_PASSWORD',
  ]);

  let lines: string[] = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf-8').split('\n')
      .filter(l => {
        const key = l.trim().split('=')[0]?.trim();
        return !keysToReplace.has(key);
      });
  }

  // Remove trailing empty lines then add our block
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  // Generic names — all languages read these
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
