// Preload MUST be the first import: it sets substrate kit timeout env
// vars before any service module pulls in the substrate (which freezes
// timeout values at module-load time).
import './preload-env';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { GitService } from './services/gitService';
import { LakebaseService, getAuthStorageRuntime, isAuthStorageCacheError, isMissingProjectError, isRefreshTokenInvalidError, onAuthStorageRuntimeChange, setAuthStorageRuntime } from './services/lakebaseService';
import { SchemaMigrationService } from './services/schemaMigrationService';
import { SchemaDiffService } from './services/schemaDiffService';
import { StatusBarProvider } from './providers/statusBarProvider';
import { BranchTreeProvider, BranchItem, isLongRunningTier } from './providers/branchTreeProvider';
import { SchemaDiffProvider } from './providers/schemaDiffProvider';
import { SchemaScmProvider } from './providers/schemaScmProvider';
import { SchemaContentProvider } from './providers/schemaContentProvider';
import { ChangesTreeProvider } from './providers/changesTreeProvider';
import { MigrationsTreeProvider } from './providers/migrationsTree';
import { PullRequestTreeProvider } from './providers/pullRequestTree';
import { MergesTreeProvider } from './providers/mergesTree';
import { GraphWebviewProvider } from './providers/graphWebview';
import { getConfig, getWorkspaceRoot, detectLanguage } from './utils/config';
import { stripInvisibles } from './utils/text';
import { isMainBranch, isTierBranch } from './utils/theme';
import { buildDiffTuples, DiffTuple } from './utils/diffBuilder';
import { ProjectCreationService, PROJECT_CREATION_PROMPTS } from './services/projectCreationService';
import { ScaffoldService } from './services/scaffoldService';
import { DeployService, DeployTarget, DeployTargetsConfig } from './services/deployService';
import { RunnerTreeProvider } from './providers/runnerTreeProvider';
import { GitHubService } from './services/githubService';
import { RunnerService } from './services/runnerService';
import { ensureGitHubAuth } from './utils/githubAuth';

let gitService: GitService;
let githubService: GitHubService;
let lakebaseService: LakebaseService;
let migrationService: SchemaMigrationService;
let schemaDiffService: SchemaDiffService;
let statusBarProvider: StatusBarProvider;
let branchTreeProvider: BranchTreeProvider;
let schemaDiffProvider: SchemaDiffProvider;
let schemaScmProvider: SchemaScmProvider;

/** Set in activate(); used by handleAuthError to persist the auth-
 *  storage override to globalState without threading context through
 *  every call site. */
let extensionContext: vscode.ExtensionContext | undefined;
const AUTH_STORAGE_STATE_KEY = 'lakebaseSync.authStorageOverride';

/**
 * Output channel for setup + auth diagnostics. Surface every meaningful
 * step (auth-check result, connect outcome, recovery branch taken) here
 * so the user can `View > Output > Lakebase SCM` if the wizard ends in
 * a state they didn't expect. Previously, anything between the auth
 * toast and the welcome-view flip happened silently; users were left
 * staring at an unchanged UI with no signal about where it stopped.
 */
let output: vscode.OutputChannel | undefined;
function log(msg: string): void {
  if (!output) { return; }
  const ts = new Date().toISOString();
  output.appendLine(`[${ts}] ${msg}`);
}

/**
 * Run `databricks auth login` as a hidden background child process.
 * The CLI opens the system browser itself, so the user just sees a
 * progress notification + the browser tab. No terminal pane gets
 * planted in their workspace.
 *
 * Shared by connectWorkspace (initial connect) and handleAuthError's
 * refresh-token-invalid branch (token-expired recovery). Both need the
 * same exact UX: click a button, browser opens, sign in, done. The
 * previous terminal-based flow forced the user to find the spawned
 * terminal, watch the CLI output, and close it manually -- and worse,
 * tempted them to run the command in their own terminal instead, which
 * left the extension's wait-promise hanging forever.
 *
 * Returns the final AuthStatus. Caller decides messaging.
 */
async function runDatabricksLoginInBackground(
  lakebaseService: LakebaseService,
  host: string,
  profile: string | null,
): Promise<{ authenticated: boolean; error?: string }> {
  const storageOverride = getAuthStorageRuntime();
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (storageOverride) {
    childEnv.DATABRICKS_AUTH_STORAGE = storageOverride;
  }
  // Resolve --profile so the CLI does not block on
  // "Databricks profile name [...]:" prompt. Prefer the caller-supplied
  // profile; fall back to host-derived if none.
  const resolvedProfile =
    profile ||
    (await lakebaseService.resolveProfileForHost(host).catch(() => null)) ||
    (() => {
      try { return new URL(host).hostname.replace(/\./g, '_'); }
      catch { return 'default'; }
    })();

  lakebaseService.invalidateProfileCache();

  // Pre-check: if the resolved profile ALREADY has a valid token, do not
  // launch a login at all. Spawning `databricks auth login` and then
  // killing it the moment a (cached) token check passes was the cause
  // of "localhost:8020 cannot be reached": we tore down the CLI's OAuth
  // callback server before the browser redirected back to it.
  const pre = await lakebaseService.checkAuth();
  if (pre.authenticated) { return { authenticated: true }; }

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Sign in to ${host} in your browser...`,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: 'opening browser, complete sign-in there...' });
      const { spawn } = await import('child_process');
      const child = spawn(
        'databricks',
        ['auth', 'login', '--host', host, '--profile', resolvedProfile],
        { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.stdout?.on('data', () => { /* drain */ });

      // Wait for the CLI to exit ON ITS OWN. The OAuth U2M flow runs a
      // local callback server (http://localhost:8020) that must stay
      // alive until the browser redirects back with the code. We must
      // NOT kill the process while it is running (that breaks the
      // redirect). The CLI exits 0 after a successful callback, non-zero
      // on failure. Cancel and a 5-minute deadline are the only paths
      // that terminate it early.
      const exitCode: number | null = await new Promise<number | null>((resolve) => {
        let settled = false;
        const done = (code: number | null) => { if (!settled) { settled = true; resolve(code); } };
        child.on('exit', (code) => done(code));
        child.on('error', () => done(-1));
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch { /* best-effort */ }
          done(-2); // timeout sentinel
        }, 5 * 60 * 1000);
        token.onCancellationRequested(() => {
          try { child.kill('SIGTERM'); } catch { /* best-effort */ }
          done(-3); // cancel sentinel
        });
        // clear the timer once settled
        child.on('exit', () => clearTimeout(timer));
        child.on('error', () => clearTimeout(timer));
      });

      if (token.isCancellationRequested || exitCode === -3) {
        return { authenticated: false, error: 'sign-in cancelled' };
      }
      if (exitCode === -2) {
        return { authenticated: false, error: 'sign-in timed out' };
      }

      // Login process finished; now verify the session reads back.
      progress.report({ message: 'verifying...' });
      let after = await lakebaseService.checkAuth();
      if (after.authenticated) { return { authenticated: true }; }

      // Auth-storage mismatch autocorrect: login may have written to a
      // different store than the runtime override forces reads from.
      if (storageOverride) {
        setAuthStorageRuntime('');
        after = await lakebaseService.checkAuth();
        if (after.authenticated) {
          if (extensionContext) {
            await extensionContext.globalState.update(AUTH_STORAGE_STATE_KEY, undefined);
          }
          return { authenticated: true };
        }
        setAuthStorageRuntime(storageOverride);
      }

      return {
        authenticated: false,
        error:
          exitCode === 0
            ? `sign-in completed but the session does not read back as authenticated (${after.error || 'unknown'})`
            : `databricks auth login failed: ${stderr.trim() || `exit ${exitCode}`}`,
      };
    },
  );
}

/**
 * Single source of truth for the language picker. Both the greenfield
 * wizard and the adopt path used to inline-duplicate this list, which
 * meant adding a language (or fixing a label) required edits in two
 * places and risked drift. The `title` arg lets each caller supply the
 * step-numbered title appropriate to its flow.
 */
type LakebaseLanguage = 'java' | 'kotlin' | 'python' | 'nodejs';
async function pickLakebaseLanguage(title: string): Promise<LakebaseLanguage | undefined> {
  const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { value: LakebaseLanguage }>(
    [
      { label: '$(symbol-class) Java / Spring Boot', description: 'Maven, Flyway, JPA', value: 'java' },
      { label: '$(symbol-class) Kotlin / Spring Boot', description: 'Maven, Flyway, JPA', value: 'kotlin' },
      { label: '$(symbol-method) Python / FastAPI', description: 'Alembic, SQLAlchemy, pytest', value: 'python' },
      { label: '$(symbol-variable) Node.js / Express', description: 'Knex, pg, Jest', value: 'nodejs' },
    ],
    { title, placeHolder: 'Choose project language and framework' },
  );
  return pick?.value;
}

/**
 * Single source of truth for the CI runner picker. Same rationale as
 * pickLakebaseLanguage: was duplicated across the greenfield wizard
 * and the adopt path.
 */
type LakebaseRunner = 'self-hosted' | 'github-hosted';
async function pickLakebaseRunner(title: string): Promise<LakebaseRunner | undefined> {
  const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { value: LakebaseRunner }>(
    [
      { label: '$(vm) Self-hosted runner (local)', description: 'Runs CI on your machine. No internet needed for builds.', value: 'self-hosted' },
      { label: '$(cloud) GitHub-hosted runner', description: 'Runs CI on GitHub infrastructure. Requires internet access.', value: 'github-hosted' },
    ],
    { title, placeHolder: 'How should CI/CD workflows run?' },
  );
  return pick?.value;
}

/**
 * Single source of truth for "pick a Databricks workspace and make sure
 * we are authenticated to it." Previously this exact flow (list profiles
 * -> build quick-pick -> optional new-workspace URL input -> setHostOverride
 * -> background login) was copy-pasted into createProject (greenfield),
 * connectWorkspace, and partially into createLakebaseProject (adopt). A
 * fix to one copy left the others broken, which is exactly how the
 * "stuck auth loop" kept resurfacing in untouched flows.
 *
 * Returns the chosen host (trailing slashes stripped) plus whether the
 * session was already authenticated to it (so callers can short-circuit
 * the "Connected" toast), or undefined if the user cancelled or auth
 * failed (the helper surfaces the failure toast itself).
 */
interface WorkspaceSelection { host: string; alreadyConnected: boolean; }
async function selectAndAuthenticateWorkspace(
  lakebaseService: LakebaseService,
  opts: { title: string; includeCurrentWorkspace?: boolean },
): Promise<WorkspaceSelection | undefined> {
  const effectiveHost = lakebaseService.getEffectiveHost().replace(/\/+$/, '');
  const authStatus = await lakebaseService.checkAuth();

  interface WsItem extends vscode.QuickPickItem { host: string; valid: boolean; action?: 'new'; }
  const items: WsItem[] = [];

  if (opts.includeCurrentWorkspace && effectiveHost) {
    items.push({
      label: `${authStatus.authenticated ? '$(check)' : '$(plug)'} Project workspace`,
      description: effectiveHost,
      detail: authStatus.authenticated ? 'Connected' : 'Not authenticated – select to connect',
      host: effectiveHost,
      valid: authStatus.authenticated,
    });
  }

  const profiles = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Discovering Lakebase workspaces...' },
    () => lakebaseService.listLakebaseProfiles(),
  );
  const otherProfiles = opts.includeCurrentWorkspace
    ? profiles.filter((p) => p.host.replace(/\/+$/, '') !== effectiveHost)
    : profiles;
  if (otherProfiles.length > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, host: '', valid: false });
    for (const p of otherProfiles) {
      const count = p.lakebaseProjects?.length || 0;
      const names = p.lakebaseProjects?.map((pr) => pr.displayName).join(', ') || '';
      items.push({
        label: `$(database) ${p.name}`,
        description: `${p.host} (${p.cloud})`,
        detail: `${count} Lakebase project${count !== 1 ? 's' : ''}${names ? ': ' + names : ''}`,
        host: p.host,
        valid: p.valid,
      });
    }
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, host: '', valid: false });
  items.push({
    label: '$(add) Connect to a new workspace...',
    detail: 'Enter a workspace URL and authenticate',
    host: '', valid: false, action: 'new',
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: opts.title,
    placeHolder: authStatus.authenticated && effectiveHost
      ? `Connected to ${effectiveHost}`
      : 'Choose a Databricks workspace with Lakebase',
  });
  if (!pick) { return undefined; }

  let targetHost: string;
  if (pick.action === 'new') {
    const input = await vscode.window.showInputBox({
      prompt: PROJECT_CREATION_PROMPTS.databricksHost.prompt,
      placeHolder: PROJECT_CREATION_PROMPTS.databricksHost.placeHolder,
      validateInput: PROJECT_CREATION_PROMPTS.databricksHost.validateInput,
    });
    if (!input) { return undefined; }
    targetHost = stripInvisibles(input).replace(/\/+$/, '');
  } else {
    targetHost = pick.host.replace(/\/+$/, '');
  }

  lakebaseService.setHostOverride(targetHost);

  // Already authenticated to exactly this host -> no login needed.
  if (pick.valid && targetHost === effectiveHost && authStatus.authenticated) {
    return { host: targetHost, alreadyConnected: true };
  }

  const result = await runDatabricksLoginInBackground(lakebaseService, targetHost, null);
  if (!result.authenticated) {
    vscode.window.showErrorMessage(
      `Databricks sign-in did not complete: ${result.error || 'timed out'}. ` +
        `See "View > Output > Lakebase SCM" for details.`,
    );
    return undefined;
  }
  return { host: targetHost, alreadyConnected: false };
}

/**
 * Ensure the current folder has a GitHub `origin` remote, offering to
 * create a repo or connect an existing one. Shared by the adopt setup
 * flow (and available to any caller that needs a remote before CI runner
 * setup). Returns the resolved `owner/repo` once a remote exists, or
 * undefined if the user skipped / cancelled / it failed.
 *
 * UI orchestration only; the actual work (createRepo, addRemote, commit,
 * push) is delegated to GitHubService / GitService.
 */
async function setUpGitHubRemoteForFolder(
  gitService: GitService,
  githubService: GitHubService,
  opts: { defaultRepoName: string },
): Promise<string | undefined> {
  // Already has a remote? Nothing to do.
  const existingRepo = await gitService.getOwnerRepo().catch(() => '');
  if (existingRepo) { log(`GitHub: origin already set (${existingRepo})`); return existingRepo; }

  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(github) Create a GitHub repository', description: 'Create a new repo, set origin, and push', value: 'create' as const },
      { label: '$(plug) Connect an existing remote', description: 'Paste a GitHub repo URL to use as origin', value: 'connect' as const },
      { label: '$(circle-slash) Skip', description: 'Stay local-only; add a remote later', value: 'skip' as const },
    ],
    { title: 'Lakebase: GitHub', placeHolder: 'This folder has no GitHub remote. Set one up?' },
  );
  log(`GitHub step -> "${choice?.value ?? 'dismissed'}"`);
  if (!choice || choice.value === 'skip') { return undefined; }

  // Shared create flow: auth -> repo name + visibility -> create repo ->
  // set origin -> commit + push. Used by the explicit "create" choice
  // AND by the "connect" path when the pasted URL points at a repo that
  // does not exist yet (so the user is not left with a dangling remote
  // and "no project").
  const createRepoFlow = async (defaultName: string): Promise<string | undefined> => {
    try {
      await ensureGitHubAuth();
    } catch {
      vscode.window.showErrorMessage('GitHub authentication failed. Sign in via VS Code or set lakebaseSync.githubToken.');
      return undefined;
    }
    const repoName = await vscode.window.showInputBox({
      prompt: 'New GitHub repository name',
      value: defaultName,
      placeHolder: defaultName,
      validateInput: (v) => {
        const t = stripInvisibles(v);
        if (!t) { return 'Repository name is required'; }
        if (!/^[a-zA-Z0-9._-]+$/.test(t)) { return 'Invalid characters in repo name'; }
        return undefined;
      },
    });
    if (!repoName) { return undefined; }
    const visibility = await vscode.window.showQuickPick(
      [
        { label: '$(lock) Private', value: true },
        { label: '$(globe) Public', value: false },
      ],
      { title: 'Lakebase: Repository Visibility', placeHolder: 'Choose repository visibility' },
    );
    if (!visibility) { return undefined; }
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating GitHub repo ${stripInvisibles(repoName)}...`, cancellable: false },
        async (progress) => {
          const name = stripInvisibles(repoName);
          progress.report({ message: 'creating repository...' });
          const url = await githubService.createRepo(name, { private: visibility.value });
          log(`GitHub: created repo ${url}`);
          await gitService.addRemote('origin', url);
          progress.report({ message: 'committing scaffold...' });
          try { await gitService.commitAll('Initial Lakebase scaffold'); }
          catch (e: any) { log(`GitHub: commitAll skipped (${e?.message || e})`); }
          progress.report({ message: 'pushing...' });
          await gitService.publishBranch();
          const resolved = await gitService.getOwnerRepo().catch(() => '');
          vscode.window.showInformationMessage(`Created and pushed to ${resolved || url}.`);
          return resolved || undefined;
        },
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(`GitHub repo setup failed: ${err?.message || err}`);
      return undefined;
    }
  };

  if (choice.value === 'connect') {
    const url = await vscode.window.showInputBox({
      prompt: 'GitHub repository URL (origin)',
      placeHolder: 'https://github.com/owner/repo',
      validateInput: (v) => {
        const t = stripInvisibles(v);
        if (!t) { return 'Enter a repository URL'; }
        // Require BOTH owner and repo segments. A bare account/org URL
        // (github.com/owner) is not a repository and would leave the
        // folder with an origin that has no project behind it.
        if (!/github\.com[:/][^/\s]+\/[^/\s]+/i.test(t)) {
          return 'Enter a full repository URL: https://github.com/owner/repo';
        }
        return undefined;
      },
    });
    if (!url) { return undefined; }
    const cleanUrl = stripInvisibles(url).replace(/\.git$/, '').replace(/\/+$/, '');

    // Verify the repository actually exists before wiring it as origin.
    let exists = false;
    try { exists = await githubService.repoExists(cleanUrl); }
    catch (e: any) { log(`GitHub: repoExists check failed (${e?.message || e})`); }
    if (!exists) {
      const repoSeg = cleanUrl.split('/').pop() || opts.defaultRepoName;
      const make = await vscode.window.showWarningMessage(
        `No GitHub repository found at ${cleanUrl}. Create a new repository instead?`,
        'Create repository', 'Cancel',
      );
      log(`GitHub: connect target missing -> "${make ?? 'dismissed'}"`);
      if (make !== 'Create repository') { return undefined; }
      return await createRepoFlow(repoSeg);
    }

    try {
      await gitService.addRemote('origin', cleanUrl);
      const resolved = await gitService.getOwnerRepo().catch(() => '');
      log(`GitHub: connected origin -> ${resolved || '<unresolved>'}`);
      // Push current branch so the (possibly empty) remote has the scaffold.
      try { await gitService.commitAll('Initial Lakebase scaffold'); }
      catch (e: any) { log(`GitHub: commitAll skipped (${e?.message || e})`); }
      try { await gitService.publishBranch(); }
      catch (e: any) { log(`GitHub: publishBranch skipped (${e?.message || e})`); }
      return resolved || undefined;
    } catch (err: any) {
      vscode.window.showErrorMessage(`Could not set origin remote: ${err?.message || err}`);
      return undefined;
    }
  }

  // create
  return await createRepoFlow(opts.defaultRepoName);
}

/**
 * Refresh the `lakebaseSync.hasGitRemote` context key so the
 * "Attach GitHub Repository" tree affordance shows only when the folder
 * has no origin remote. Cheap; safe to call after any flow that may
 * change the remote.
 */
async function setGitRemoteContext(gitService: GitService): Promise<boolean> {
  const repo = await gitService.getOwnerRepo().catch(() => '');
  await vscode.commands.executeCommand('setContext', 'lakebaseSync.hasGitRemote', !!repo);
  return !!repo;
}

/** Prompt user to login when auth errors are detected */
async function handleAuthError(lakebaseService: LakebaseService, err: any): Promise<boolean> {
  // Special-case: CLI upgraded past a credential-storage break. The new
  // `databricks` binary refuses to read the old file-cached credentials
  // ("stored credentials from older CLI versions are no longer used").
  // Generic "Login" doesn't help here because the user may have already
  // re-logged in: the real remediation is either a clean re-auth that
  // overwrites the cache or an explicit DATABRICKS_AUTH_STORAGE=plaintext
  // opt-in. Surface BOTH as one-click actions.
  //
  // The "Use plaintext storage" path persists to globalState (NOT to
  // .env). Writing to .env leaks the override into every shell script
  // that sources it (post-checkout hook, refresh-token.sh, etc.) and
  // those scripts then force plaintext when the user's actual auth has
  // migrated back to the keyring – surfacing as "auth failed" messages
  // in unrelated tools. globalState keeps the override extension-only.
  if (isAuthStorageCacheError(err)) {
    const choice = await vscode.window.showErrorMessage(
      'Databricks CLI rejected its stored credentials (credential-storage format changed in a newer CLI version). ' +
        'Either re-authenticate to refresh the cache, or fall back to plaintext storage.',
      'Re-authenticate',
      'Use plaintext storage',
    );
    if (choice === 'Re-authenticate') {
      vscode.commands.executeCommand('lakebaseSync.connectWorkspace');
    } else if (choice === 'Use plaintext storage') {
      setAuthStorageRuntime('plaintext');
      if (extensionContext) {
        await extensionContext.globalState.update(AUTH_STORAGE_STATE_KEY, 'plaintext');
      }
      vscode.window.showInformationMessage(
        'Lakebase SCM: using plaintext auth storage for this session and persisting the choice. ' +
          'Shell scripts in this project will continue to use your default storage.',
      );
    }
    return true;
  }

  // Special-case: the OAuth refresh token in the keyring / config cache
  // is expired or invalid (CLI emits "refresh token is invalid" or
  // "access token could not be retrieved"). Generic "Login" works but
  // requires the user to pick the right profile by hand. Surface a
  // one-click recovery that pre-fills the right --profile by matching
  // the project's expected host against ~/.databrickscfg entries, runs
  // the login in a real terminal, and on success invalidates the cache
  // and signals the caller to retry.
  if (isRefreshTokenInvalidError(err)) {
    const authStatus = await lakebaseService.checkAuth().catch(() => null);
    const expectedHost = authStatus?.expectedHost ?? '';
    const profileName = expectedHost
      ? await lakebaseService.resolveProfileForHost(expectedHost).catch(() => null)
      : null;
    const detail = profileName
      ? `Profile "${profileName}" for ${expectedHost}.`
      : expectedHost
        ? `Project expects ${expectedHost}.`
        : '';
    const choice = await vscode.window.showErrorMessage(
      `Databricks CLI refresh token is invalid. Re-authenticate to continue. ${detail}`.trim(),
      'Re-authenticate',
    );
    if (choice === 'Re-authenticate') {
      // Reuse the background-spawn auth flow (no terminal pane). If
      // we know the host, drive the login against it; otherwise we
      // cannot spawn a non-interactive login (the CLI would prompt
      // for host on stdin), so we surface a one-time fallback message
      // pointing the user to "Lakebase: Connect to Workspace".
      if (expectedHost) {
        const result = await runDatabricksLoginInBackground(
          lakebaseService,
          expectedHost,
          profileName,
        );
        if (result.authenticated) {
          vscode.window.showInformationMessage(`Re-authenticated to ${expectedHost}.`);
        } else {
          vscode.window.showWarningMessage(
            `Re-authentication did not complete: ${result.error || 'unknown'}. ` +
              `Run "Lakebase: Connect to Workspace" to retry.`,
          );
        }
      } else {
        vscode.window.showInformationMessage(
          'Run "Lakebase: Connect to Workspace" to pick a workspace and re-authenticate.',
        );
      }
    }
    return true;
  }

  const isAuth = (err as any).isAuthError === true ||
    err.message?.includes('project id not found') ||
    err.message?.includes('not authenticated') ||
    err.message?.includes('401');

  if (!isAuth) {
    return false;
  }

  const authStatus = await lakebaseService.checkAuth();
  let msg: string;

  if (authStatus.mismatch) {
    msg = `Workspace mismatch: CLI is authenticated to ${authStatus.currentHost}, but this project requires ${authStatus.expectedHost}.`;
  } else if (!authStatus.authenticated) {
    msg = `Not authenticated to Databricks. Login required for ${authStatus.expectedHost}.`;
  } else {
    msg = `Auth error: ${err.message}`;
  }

  const action = await vscode.window.showErrorMessage(msg, 'Login', 'Select Workspace');
  if (action === 'Login') {
    vscode.commands.executeCommand('lakebaseSync.connectWorkspace');
  } else if (action === 'Select Workspace') {
    vscode.commands.executeCommand('lakebaseSync.connectWorkspace');
  }
  return true;
}

/**
 * Catch the typed `MissingProjectError` thrown by lakebaseService when
 * an extension command is invoked without a configured project id, and
 * route the user to the onboarding command instead of surfacing a raw
 * substrate error. Returns true when the error was handled so the
 * caller can short-circuit its own catch logic; returns false when the
 * error is unrelated.
 */
async function handleMissingProjectError(err: unknown): Promise<boolean> {
  if (!isMissingProjectError(err)) {
    return false;
  }
  const action = await vscode.window.showWarningMessage(
    "No LAKEBASE_PROJECT_ID configured for this workspace. Set up Lakebase to enable branch + database operations.",
    "Set Up Lakebase",
    "Dismiss",
  );
  if (action === "Set Up Lakebase") {
    void vscode.commands.executeCommand("lakebaseSync.createLakebaseProject");
  }
  return true;
}

/** Update or append key=value pairs in .env content, preserving comments/order. */
function upsertEnvKeys(content: string, updates: Record<string, string>): string {
  const lines = content ? content.split('\n') : [];
  const seen = new Set<string>();
  const out = lines.map(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/i);
    if (m && updates[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  const toAppend = Object.entries(updates).filter(([k]) => !seen.has(k));
  if (toAppend.length > 0) {
    if (out.length > 0 && out[out.length - 1].trim() !== '') { out.push(''); }
    for (const [k, v] of toAppend) { out.push(`${k}=${v}`); }
    out.push('');
  }
  return out.join('\n');
}

/**
 * Offer to set missing GitHub Actions secrets (DATABRICKS_HOST,
 * DATABRICKS_TOKEN, LAKEBASE_PROJECT_ID) on the given repo. If everything
 * is already set, returns silently. Prompts only for values that are
 * missing or that the caller did not provide.
 */
async function offerCiSecretsSetup(
  fullRepoName: string,
  defaults: { host: string; projectId: string },
  opts: { force?: boolean } = {},
): Promise<void> {
  const runnerService = new RunnerService(githubService, lakebaseService);

  const { missing, present } = await runnerService.checkCiSecrets(fullRepoName);
  if (!opts.force && missing.length === 0) {
    return;
  }

  if (!opts.force) {
    const missingList = missing.join(', ');
    const choice = await vscode.window.showInformationMessage(
      `CI workflow needs these repo secrets: ${missingList}. Set them now?`,
      'Set secrets', 'Skip'
    );
    if (choice !== 'Set secrets') { return; }
  }

  const host = defaults.host || await vscode.window.showInputBox({
    prompt: 'DATABRICKS_HOST',
    value: defaults.host,
    ignoreFocusOut: true,
  }) || '';
  if (!host) { return; }

  const projectId = defaults.projectId || await vscode.window.showInputBox({
    prompt: 'LAKEBASE_PROJECT_ID',
    value: defaults.projectId,
    ignoreFocusOut: true,
  }) || '';
  if (!projectId) { return; }

  const tokenHint = `Generate at ${host.replace(/\/+$/, '')}/settings/user/developer/access-tokens`;
  const token = await vscode.window.showInputBox({
    prompt: 'DATABRICKS_TOKEN (Personal Access Token)',
    placeHolder: tokenHint,
    password: true,
    ignoreFocusOut: true,
    validateInput: v => v && v.trim().length > 0 ? undefined : 'Token is required',
  });
  if (!token) { return; }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Setting CI secrets on ${fullRepoName}`, cancellable: false },
      async (progress) => {
        await runnerService.setupCiSecrets(
          fullRepoName,
          { DATABRICKS_HOST: host, DATABRICKS_TOKEN: token, LAKEBASE_PROJECT_ID: projectId },
          (msg: string) => progress.report({ message: msg }),
        );
      }
    );
    const already = present.length > 0 ? ` (replaced ${present.join(', ')})` : '';
    vscode.window.showInformationMessage(`CI secrets set on ${fullRepoName}${already}.`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to set CI secrets: ${err.message}`);
  }
}

/**
 * Auto-remove older install directories of THIS extension sitting in
 * the same extensions root. VS Code / Cursor normally activate the
 * highest version, but a `--force` install of a new vsix can leave the
 * older version's directory + manifest behind. The older dir is dead
 * weight and can mask "is the new code actually loaded?" diagnostics.
 *
 * No user prompt: leaving stale install dirs is never desired. Errors
 * are logged + non-fatal (activation completes regardless). Returns
 * the list of removed dirs so the post-install notification can name
 * them.
 */
async function autoRemoveOlderInstalls(context: vscode.ExtensionContext): Promise<string[]> {
  try {
    const myPath = context.extensionPath;
    const myDir = path.basename(myPath);
    const parent = path.dirname(myPath);
    const id = context.extension.id; // e.g. kevin-hartman.lakebase-scm-extension

    if (!fs.existsSync(parent)) { return []; }
    const entries = fs.readdirSync(parent);
    const stale = entries.filter((e) => {
      if (e === myDir) { return false; }
      if (!e.startsWith(`${id}-`)) { return false; }
      try {
        return fs.statSync(path.join(parent, e)).isDirectory();
      } catch {
        return false;
      }
    });
    if (stale.length === 0) { return []; }

    const removed: string[] = [];
    for (const s of stale) {
      try {
        fs.rmSync(path.join(parent, s), { recursive: true, force: true });
        removed.push(s);
      } catch (err) {
        console.warn(`Could not remove stale extension dir ${s}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return removed;
  } catch (err) {
    console.warn('autoRemoveOlderInstalls skipped:', err);
    return [];
  }
}

/**
 * macOS-aware "quit + relaunch" of the host editor. VS Code's
 * `workbench.action.quit` quits without auto-restart; on Mac we
 * schedule a detached child process that re-opens the app after a
 * brief delay, then issue the quit. On non-Mac platforms we fall back
 * to `reloadWindow` (closest we can do without spawning shell
 * commands the user didn't authorize).
 */
async function restartHostApp(): Promise<void> {
  if (process.platform === 'darwin') {
    const appName = vscode.env.appName || 'Cursor';
    const { spawn } = await import('child_process');
    spawn('sh', ['-c', `sleep 2 && open -a "${appName.replace(/"/g, '\\"')}"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    await vscode.commands.executeCommand('workbench.action.quit');
  } else {
    // Best-effort on Linux / Windows: reload the current window.
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * One-shot post-install handler that runs on every activation but
 * fires the user-visible prompt only when the extension on disk has
 * actually changed since the last activation we recorded.
 *
 * Signal: mtime + size of `<extensionPath>/package.json`. mtime alone
 * would be enough on its own, but pairing it with size gives a cheap
 * second-level sanity check against filesystems with low-resolution
 * mtime (some Docker bind-mounts, FAT, etc.) where a same-second
 * rewrite could land on an identical mtime. Either field differing
 * means the install dir was rewritten, which is what we care about.
 *
 * Why not version string: a rebuilt same-version vsix is a real
 * install event the user needs to know about (their bits changed)
 * but version comparison would silently swallow it. mtime catches it.
 *
 * Two responsibilities:
 *   1. Uninstall prior-version dirs on disk (silent, no prompt).
 *   2. Tell the user the host editor needs a restart, with a single
 *      "Restart Cursor" action that quits + relaunches automatically.
 */
async function handlePostInstall(context: vscode.ExtensionContext): Promise<void> {
  try {
    const currentVersion =
      (context.extension.packageJSON as { version?: string }).version || 'unknown';

    // Install-event fingerprint: mtime + size of package.json inside the
    // current extension dir. Either field changing means the dir was
    // rewritten since our last activation.
    let stamp = '';
    try {
      const st = fs.statSync(path.join(context.extensionPath, 'package.json'));
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      // package.json missing is recoverable; fall back to extensionPath
      // mtime so we still get a stamp from somewhere.
      try {
        const st = fs.statSync(context.extensionPath);
        stamp = `${st.mtimeMs}:0`;
      } catch {
        stamp = '';
      }
    }
    if (!stamp) { return; } // nothing to compare; bail rather than spam

    const stampKey = 'lakebaseSync.lastInstallStamp';
    const versionKey = 'lakebaseSync.lastActivatedVersion';
    const lastStamp = context.globalState.get<string>(stampKey);
    const lastVersion = context.globalState.get<string>(versionKey);
    if (lastStamp === stamp) { return; }

    // 1. Auto-cleanup.
    const removed = await autoRemoveOlderInstalls(context);

    // Persist BEFORE prompting so dismissing the prompt doesn't
    // re-trigger on the next reload before the user can decide.
    await context.globalState.update(stampKey, stamp);
    await context.globalState.update(versionKey, currentVersion);

    // 2. Restart prompt. Fires whenever the install fingerprint
    // changed, including the rebuilt-same-version case.
    const isVersionChange = !!lastVersion && lastVersion !== currentVersion;
    const verb = isVersionChange
      ? `updated from ${lastVersion} to ${currentVersion}`
      : lastVersion
        ? `reinstalled (${currentVersion}, new build)`
        : `installed (${currentVersion})`;
    const cleanupNote = removed.length > 0
      ? ` Removed ${removed.length} stale install ${removed.length === 1 ? 'directory' : 'directories'}: ${removed.join(', ')}.`
      : '';
    const hostName = vscode.env.appName || 'the host editor';
    const action = await vscode.window.showInformationMessage(
      `Lakebase SCM ${verb}.${cleanupNote} ${hostName} needs to restart so the new extension code activates.`,
      { modal: false },
      `Restart ${hostName}`,
    );
    if (action && action.startsWith('Restart')) {
      await restartHostApp();
    }
  } catch (err) {
    console.warn('handlePostInstall skipped:', err);
  }
}

/**
 * Watch for a newer copy of THIS extension being installed while the
 * current (older) version is still the running activation. Without
 * this, the only signal the user gets that they need to reload is
 * Cursor's CLI output, which most users miss. `vscode.extensions.onDidChange`
 * fires on install / uninstall / enable / disable; we filter to "a
 * version of ME with a higher semver showed up on disk" and surface a
 * one-click "Reload Window" prompt so the new code activates.
 *
 * Note: this can only ever help on the install AFTER this code ships
 * (e.g. 0.5.8 → 0.5.9). The 0.5.7 → 0.5.8 transition has no choice
 * but to rely on the user knowing to reload, because 0.5.7 does not
 * carry this listener.
 */
function watchForOwnInstall(context: vscode.ExtensionContext): void {
  const myId = context.extension.id;
  const myVersion = (context.extension.packageJSON as { version?: string }).version || '0.0.0';
  const cmp = (a: string, b: string): number => {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) { return (pa[i] || 0) - (pb[i] || 0); }
    }
    return 0;
  };
  // Install-event fingerprint of THIS running extension's on-disk
  // package.json. Captured at activation so we can detect a same-version
  // reinstall (rebuilt VSIX with identical manifest version) by noticing
  // the mtime/size of the manifest file changes underneath us. Without
  // this, a same-version reinstall replaces the bytes on disk but the
  // running extension host stays on the cached pre-install copy, no
  // activate() re-fires, and the user never sees a restart prompt.
  const fingerprint = (extPath: string): string => {
    try {
      const st = fs.statSync(path.join(extPath, 'package.json'));
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  };
  const myFingerprint = fingerprint(context.extensionPath);
  let prompted = false;
  const sub = vscode.extensions.onDidChange(() => {
    if (prompted) { return; }
    const seen = vscode.extensions.getExtension(myId);
    const seenVersion = (seen?.packageJSON as { version?: string } | undefined)?.version;
    if (!seenVersion) { return; }
    const seenExtPath = seen?.extensionPath;
    const seenFingerprint = seenExtPath ? fingerprint(seenExtPath) : '';
    // Trigger the prompt on either:
    //   1. a higher-version install, OR
    //   2. a same-or-different version install whose package.json mtime+size
    //      differs from what we fingerprinted at activation (rebuilt VSIX,
    //      hot reinstall, etc.).
    const isUpgrade = cmp(seenVersion, myVersion) > 0;
    const isRebuild =
      !!myFingerprint && !!seenFingerprint && myFingerprint !== seenFingerprint;
    if (!isUpgrade && !isRebuild) { return; }
    prompted = true;
    const verb = isUpgrade
      ? `${seenVersion} was just installed`
      : `${seenVersion} was just reinstalled (rebuilt bits)`;
    void vscode.window.showInformationMessage(
      `Lakebase SCM ${verb}. The running session is still on ${myVersion}; reload the window so the new code activates.`,
      { modal: false },
      'Reload Window',
    ).then((choice) => {
      if (choice === 'Reload Window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  });
  context.subscriptions.push(sub);
}

export async function activate(context: vscode.ExtensionContext) {
  // Stash on a module-level ref so helpers (handleAuthError etc) can
  // reach globalState without threading context through every call.
  extensionContext = context;

  // Fire-and-forget post-install: auto-clean stale older install dirs
  // on disk (silent), then prompt the user to restart the host editor
  // (Cursor / VS Code) when this is an upgrade or a stale-clean event.
  // Failures inside the handler are swallowed and logged.
  void handlePostInstall(context);

  // Detect future in-place upgrades while this session is still active,
  // so the user gets a "reload window" prompt without needing to know
  // to do it themselves.
  watchForOwnInstall(context);

  // Output channel for setup + auth diagnostics. Stored module-level so
  // the helper `log()` can write without threading context through every
  // call site. Visible via View > Output > Lakebase SCM.
  output = vscode.window.createOutputChannel('Lakebase SCM');
  context.subscriptions.push(output);
  log(`activated v${(context.extension.packageJSON as { version?: string }).version || '?'} at ${context.extensionPath}`);

  const config = getConfig();

  if (!config.lakebaseProjectId) {
    // The bare warning toast (no action button) used to be the user's
    // first signal that something was off. It left them to discover
    // the palette command on their own. Surface the onboarding path
    // directly as a button, and gate the prompt on a globalState
    // dismissal stamp so existing users don't re-see it every
    // activation.
    const ONBOARDING_DISMISSED_KEY = 'lakebaseSync.onboarding.dismissedAt';
    const dismissedAt = context.globalState.get<string>(ONBOARDING_DISMISSED_KEY);
    if (!dismissedAt) {
      void vscode.window.showWarningMessage(
        'Lakebase Sync: this workspace has no LAKEBASE_PROJECT_ID. Set up Lakebase to enable branch + database operations.',
        'Set Up Lakebase',
        'Connect to Existing',
        'Dismiss',
      ).then((action) => {
        if (action === 'Set Up Lakebase') {
          void vscode.commands.executeCommand('lakebaseSync.createLakebaseProject');
        } else if (action === 'Connect to Existing') {
          void vscode.commands.executeCommand('lakebaseSync.connectWorkspace');
        } else if (action === 'Dismiss') {
          void context.globalState.update(ONBOARDING_DISMISSED_KEY, new Date().toISOString());
        }
      });
    }
  }

  // Initialize services
  gitService = new GitService();
  githubService = new GitHubService();
  lakebaseService = new LakebaseService();

  // Persist the auth-storage override to globalState (NOT to .env) when
  // the runtime auto-retry discovers that plaintext works for the
  // extension's own CLI calls. Persisting to .env poisoned every shell
  // script in the project that sourced .env (post-checkout hook,
  // refresh-token.sh, etc.) – those scripts then forced plaintext when
  // the user's actual auth had migrated back to the keyring, surfacing
  // as spurious "Databricks CLI auth failed" messages. The runtime
  // override is extension-internal; shells should NOT inherit it.
  const persistedStorage = context.globalState.get<string>(AUTH_STORAGE_STATE_KEY);
  if (persistedStorage) {
    setAuthStorageRuntime(persistedStorage);
  }
  onAuthStorageRuntimeChange((value) => {
    void context.globalState.update(AUTH_STORAGE_STATE_KEY, value);
  });
  migrationService = new SchemaMigrationService(lakebaseService);
  schemaDiffService = new SchemaDiffService(lakebaseService);
  schemaDiffProvider = new SchemaDiffProvider(schemaDiffService, gitService, migrationService);

  await gitService.initialize();

  const cliAvailable = await lakebaseService.isAvailable();
  if (!cliAvailable) {
    vscode.window.showWarningMessage(
      'Lakebase Sync: Databricks CLI not found. Install it and run "databricks auth login".'
    );
  }

  // Check auth on startup
  if (cliAvailable && config.lakebaseProjectId) {
    const authStatus = await lakebaseService.checkAuth();
    if (!authStatus.authenticated) {
      // Special-case: CLI upgraded past a credential-storage break.
      // Re-route through handleAuthError so the user gets the same
      // two-action notification (Re-authenticate / Use plaintext) they
      // would see from any other CLI call that hits this error class.
      if (authStatus.error && isAuthStorageCacheError(new Error(authStatus.error))) {
        await handleAuthError(lakebaseService, new Error(authStatus.error));
      } else {
        const action = await vscode.window.showWarningMessage(
          `Lakebase Sync: Not connected to ${authStatus.expectedHost}.`,
          'Connect'
        );
        if (action === 'Connect') {
          vscode.commands.executeCommand('lakebaseSync.connectWorkspace');
        }
      }
    }
  }

  // Initialize providers
  statusBarProvider = new StatusBarProvider(gitService, lakebaseService, migrationService);
  branchTreeProvider = new BranchTreeProvider(gitService, lakebaseService, migrationService, schemaDiffService);

  // Initialize SCM provider – compares actual Lakebase branch schemas
  schemaScmProvider = new SchemaScmProvider(gitService, migrationService, schemaDiffService, lakebaseService, githubService);

  // Register schema DDL content provider for multi-diff editor
  const schemaContentProvider = vscode.workspace.registerTextDocumentContentProvider(
    'lakebase-schema-content',
    new SchemaContentProvider(schemaDiffService, migrationService)
  );

  // Register commit content provider for graph review diffs
  const commitContentProvider = vscode.workspace.registerTextDocumentContentProvider(
    'lakebase-commit',
    {
      async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const ref = uri.authority; // e.g., "abc1234" or "abc1234~1"
        const filePath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        try {
          return await gitService.getFileAtRef(ref, filePath);
        } catch {
          return '';
        }
      }
    }
  );

  // Register tree view
  const treeView = vscode.window.createTreeView('lakebaseBranches', {
    treeDataProvider: branchTreeProvider,
    showCollapseAll: true,
  });


  // Register sidebar tree views (Phases A-G)
  const changesTreeProvider = new ChangesTreeProvider(schemaScmProvider);
  const migrationsTreeProvider = new MigrationsTreeProvider(schemaScmProvider);
  const pullRequestTreeProvider = new PullRequestTreeProvider(schemaScmProvider, gitService, githubService);
  const mergesTreeProvider = new MergesTreeProvider(schemaScmProvider);

  const changesView = vscode.window.createTreeView('lakebaseChanges', {
    treeDataProvider: changesTreeProvider,
    showCollapseAll: true,
  });
  const migrationsView = vscode.window.createTreeView('lakebaseMigrations', {
    treeDataProvider: migrationsTreeProvider,
  });
  const prView = vscode.window.createTreeView('lakebasePR', {
    treeDataProvider: pullRequestTreeProvider,
  });
  const runnerTreeProvider = new RunnerTreeProvider(gitService, githubService);
  const runnerView = vscode.window.createTreeView('lakebaseRunner', {
    treeDataProvider: runnerTreeProvider,
  });

  // FEIP-7480: auto-refresh the runner pane when projects are scaffolded
  // / removed externally (e.g. via lakebase-create-project on the CLI)
  // or when the open workspace's .env changes (projectId switch). Two
  // watchers, both fire runnerTreeProvider.refresh().
  const runnersRoot = path.join(os.homedir(), '.lakebase', 'runners');
  try {
    if (fs.existsSync(runnersRoot)) {
      const runnersWatcher = fs.watch(
        runnersRoot,
        { persistent: false },
        () => runnerTreeProvider.refresh(),
      );
      context.subscriptions.push({ dispose: () => runnersWatcher.close() });
    }
  } catch {
    // best-effort; fs.watch on macOS sometimes throws on freshly-created dirs
  }
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot) {
    const envWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(wsRoot, '.env'),
    );
    envWatcher.onDidCreate(() => runnerTreeProvider.refresh());
    envWatcher.onDidChange(() => runnerTreeProvider.refresh());
    envWatcher.onDidDelete(() => runnerTreeProvider.refresh());
    context.subscriptions.push(envWatcher);
  }
  const mergesView = vscode.window.createTreeView('lakebaseMerges', {
    treeDataProvider: mergesTreeProvider,
  });

  // Graph webview
  const graphWebviewProvider = new GraphWebviewProvider(context.extensionUri, lakebaseService, gitService, githubService);
  const graphView = vscode.window.registerWebviewViewProvider('lakebaseGraph', graphWebviewProvider);

  // Badge count on the activity bar icon (uses the Changes view)
  const updateBadge = () => {
    const count = changesTreeProvider.getChangeCount();
    changesView.badge = count > 0
      ? { value: count, tooltip: `Lakebase SCM Extension – ${count} pending changes` }
      : undefined;
  };
  schemaScmProvider.onDidRefresh(() => {
    updateBadge();
    branchTreeProvider.refresh();
    graphWebviewProvider.refresh();
    statusBarProvider.refresh();
    // Second refresh after a short delay to catch async Lakebase data
    setTimeout(() => {
      branchTreeProvider.refresh();
      statusBarProvider.refresh();
    }, 2000);
  });
  updateBadge();

  // Watch migration files for status bar + tree updates
  // (SCM provider has its own migration watcher – don't duplicate)
  const migrationWatcher = migrationService.watchMigrations(() => {
    statusBarProvider.refresh();
    branchTreeProvider.refresh();
  });

  // Set initial branch context
  const initialBranch = await gitService.getCurrentBranch();
  const initialTrunk = getConfig().trunkBranch;
  const isFeature = !!initialBranch
    && !isMainBranch(initialBranch, initialTrunk)
    && !isTierBranch(initialBranch);
  vscode.commands.executeCommand('setContext', 'lakebaseSync.onFeatureBranch', isFeature);
  vscode.commands.executeCommand('setContext', 'lakebaseSync.isRebasing', await gitService.isRebasing());
  // Drives the viewsWelcome contributions for `lakebaseBranches` /
  // `lakebaseChanges` in package.json: when this is false the views
  // render an onboarding button rather than silently rendering an
  // empty list.
  vscode.commands.executeCommand('setContext', 'lakebaseSync.hasProjectId', !!getConfig().lakebaseProjectId);
  // Drive the "Attach GitHub Repository" tree affordance: show it only
  // when the folder has no origin remote.
  void setGitRemoteContext(gitService);

  // Sync .env connection on git branch change, optionally auto-create Lakebase branch
  const autoBranchDisposable = gitService.onBranchChanged(async (newBranch: string) => {
    const trunkAlias = getConfig().trunkBranch;
    const onFeature = !!newBranch
      && !isMainBranch(newBranch, trunkAlias)
      && !isTierBranch(newBranch);
    vscode.commands.executeCommand('setContext', 'lakebaseSync.onFeatureBranch', onFeature);
    vscode.commands.executeCommand('setContext', 'lakebaseSync.isRebasing', await gitService.isRebasing());

    if (!newBranch || isMainBranch(newBranch, trunkAlias) || isTierBranch(newBranch)) { return; }

    // Clear schema cache – new branch may have different schema
    schemaDiffService.clearCache();

    const cfg = getConfig();

    try {
      // Always check if Lakebase branch exists and sync .env connection
      const existing = await lakebaseService.getBranchByName(newBranch);
      if (existing) {
        // Branch exists – just refresh credentials and update .env
        const conn = await lakebaseService.syncConnection(existing.branchId);
        if (!conn) {
          vscode.window.showWarningMessage(
            `Switched to "${newBranch}" but endpoint not ready. .env not updated. Click "Refresh Credentials" when the branch is active.`
          );
        }
        return;
      }

      // No existing branch – only create if autoCreateBranch is enabled
      if (!cfg.autoCreateBranch) { return; }

      // Create new Lakebase branch
      const sanitized = lakebaseService.sanitizeBranchName(newBranch);
      const lb = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Creating Lakebase branch: ${sanitized}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Creating branch...' });
          const currentGitBranch = await gitService.getCurrentBranch().catch(() => undefined);
          const branch = await lakebaseService.createBranch(newBranch, undefined, currentGitBranch);
          if (!branch) { return undefined; }

          progress.report({ message: 'Waiting for endpoint...' });
          const conn = await lakebaseService.syncConnection(branch.branchId);
          if (!conn) {
            vscode.window.showWarningMessage(
              `Lakebase branch "${sanitized}" created but endpoint not ready. .env not updated. Click "Refresh Credentials" when the branch is active.`
            );
          }
          return branch;
        }
      );

      if (lb) {
        vscode.window.showInformationMessage(
          `Lakebase branch "${sanitized}" created and connected.`
        );
      }
    } catch (err: any) {
      if (isMissingProjectError(err)) {
        // No Lakebase project configured – the post-checkout hook would
        // normally sync .env here, but the workspace is not yet onboarded.
        // Silently log; the activation prompt + viewsWelcome already
        // surface the onboarding path to the user. Avoid a toast on every
        // checkout to keep the rest of the IDE quiet.
        console.warn(
          `Auto-branch sync skipped for ${newBranch}: workspace has no LAKEBASE_PROJECT_ID.`
        );
      } else if (!await handleAuthError(lakebaseService, err)) {
        // Silently log – don't block the user's checkout
        console.warn(`Auto-branch creation failed for ${newBranch}: ${err.message}`);
      }
    }
  });

  // Register commands
  context.subscriptions.push(
    treeView,
    changesView,
    migrationsView,
    prView,
    mergesView,
    graphView,
    migrationWatcher,
    autoBranchDisposable,

    vscode.commands.registerCommand('lakebaseSync.graphPickRepo', async () => {
      const root = getWorkspaceRoot();
      if (!root) { return; }
      const repoName = require('path').basename(root);
      const items: Array<{label: string; description?: string; action: string}> = [
        { label: '$(sparkle) Auto', description: 'Show graph for the active repository', action: 'auto' },
        { label: `$(repo) ${repoName}`, description: root, action: 'current' },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the repository to view, type to filter all repositories',
      });
      if (pick) { graphWebviewProvider.refresh(); }
    }),
    vscode.commands.registerCommand('lakebaseSync.graphGoToCurrent', () => {
      graphWebviewProvider.goToCurrent();
    }),
    vscode.commands.registerCommand('lakebaseSync.graphPickRef', async () => {
      const root = getWorkspaceRoot();
      if (!root) { return; }
      try {
        // Get local and remote branches
        const localBranches = await gitService.listLocalBranches();
        const remoteBranches = await gitService.listRemoteBranches();
        const locals = localBranches.map(b => b.name);
        const remotes = remoteBranches.map(b => b.name).filter((r: string) => !r.includes('HEAD'));
        const currentBranch = await gitService.getCurrentBranch();

        const filterRefs = graphWebviewProvider.graphFilterRefs;
        const isAll = graphWebviewProvider.showAllRefs && !filterRefs;
        const isAuto = !graphWebviewProvider.showAllRefs && !filterRefs;
        const selectedSet = new Set(filterRefs || []);

        const items: vscode.QuickPickItem[] = [
          { label: '$(star-full) All', description: 'All history item references', picked: isAll },
          { label: '$(sparkle) Auto', description: 'Current history item reference(s)', picked: isAuto },
          { label: '', kind: vscode.QuickPickItemKind.Separator },
        ];
        for (const b of locals) {
          items.push({ label: `$(git-branch) ${b}`, description: b === currentBranch ? '(current)' : '', picked: selectedSet.has(b) });
        }
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        for (const r of remotes) {
          items.push({ label: `$(cloud) ${r}`, picked: selectedSet.has(r) });
        }

        const picks = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select one/more history item references to view, type to filter',
          canPickMany: true,
        });
        if (!picks || picks.length === 0) { return; }

        const hasAll = picks.some(p => p.label.includes('All'));
        const hasAuto = picks.some(p => p.label.includes('Auto'));

        if (hasAll) {
          (graphWebviewProvider as any).showAllRefs = true;
          (graphWebviewProvider as any).graphFilterRefs = null;
        } else if (hasAuto) {
          (graphWebviewProvider as any).showAllRefs = false;
          (graphWebviewProvider as any).graphFilterRefs = null;
        } else {
          // Specific branches selected – show all refs but filter in display
          (graphWebviewProvider as any).showAllRefs = true;
          (graphWebviewProvider as any).graphFilterRefs = picks.map(p =>
            p.label.replace('$(git-branch) ', '').replace('$(cloud) ', '')
          );
        }
        graphWebviewProvider.refresh();
      } catch { /* ignore */ }
    }),
    vscode.commands.registerCommand('lakebaseSync.graphFetchAll', async () => {
      const root = getWorkspaceRoot();
      if (!root) { return; }
      try {
        await gitService.fetchAll();
        vscode.window.showInformationMessage('Fetched from all remotes.');
        graphWebviewProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Fetch failed: ${err.message}`); }
    }),
    vscode.commands.registerCommand('lakebaseSync.graphPull', async () => {
      try {
        await gitService.pull();
        vscode.window.showInformationMessage('Pulled successfully.');
        graphWebviewProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Pull failed: ${err.message}`); }
    }),
    vscode.commands.registerCommand('lakebaseSync.graphPush', async () => {
      try {
        await gitService.push();
        vscode.window.showInformationMessage('Pushed successfully.');
        graphWebviewProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Push failed: ${err.message}`); }
    }),
    vscode.commands.registerCommand('lakebaseSync.graphRefresh', () => {
      graphWebviewProvider.refresh();
    }),

    vscode.commands.registerCommand('lakebaseSync.toggleChangesTree', () => {
      if (!changesTreeProvider.viewAsTree) { changesTreeProvider.toggleViewMode(); }
    }),
    vscode.commands.registerCommand('lakebaseSync.toggleChangesList', () => {
      if (changesTreeProvider.viewAsTree) { changesTreeProvider.toggleViewMode(); }
    }),

    vscode.commands.registerCommand('lakebaseSync.showBranchStatus', async () => {
      const gitBranch = await gitService.getCurrentBranch();
      const lb = statusBarProvider.getCurrentLakebaseBranch();

      if (lb) {
        const version = migrationService.getLatestVersion() || '?';
        vscode.window.showInformationMessage(
          `Git: ${gitBranch} | DB: ${lb.branchId} (${lb.state}) | Migrations: V${version}`
        );
      } else {
        const action = await vscode.window.showWarningMessage(
          `Git: ${gitBranch} | No Lakebase branch found`,
          'Create Branch'
        );
        if (action === 'Create Branch') {
          vscode.commands.executeCommand('lakebaseSync.createBranch');
        }
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.refreshBranches', () => {
      schemaDiffService.clearCache();
      statusBarProvider.refresh();
      branchTreeProvider.refresh();
      schemaScmProvider.refresh();
    }),

    vscode.commands.registerCommand('lakebaseSync.createBranch', async () => {
      const gitBranch = await gitService.getCurrentBranch();
      const cfgCb = getConfig();
      if (!gitBranch || isMainBranch(gitBranch, cfgCb.trunkBranch)) {
        vscode.window.showWarningMessage('Cannot create a Lakebase branch for main/master.');
        return;
      }
      if (isTierBranch(gitBranch)) {
        vscode.window.showWarningMessage(`Cannot create a Lakebase branch for "${gitBranch}" – it's a long-running tier and the Lakebase counterpart already exists.`);
        return;
      }

      const sanitized = lakebaseService.sanitizeBranchName(gitBranch);
      const confirm = await vscode.window.showInformationMessage(
        `Create Lakebase branch "${sanitized}" from default?`,
        'Create',
        'Cancel'
      );

      if (confirm !== 'Create') {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Creating Lakebase branch: ${sanitized}`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Creating branch...' });
          try {
            const currentGitBranch = await gitService.getCurrentBranch().catch(() => undefined);
            const branch = await lakebaseService.createBranch(gitBranch, undefined, currentGitBranch);
            if (branch && branch.state === 'READY') {
              vscode.window.showInformationMessage(
                `Lakebase branch "${sanitized}" is ready.`
              );
            } else {
              vscode.window.showWarningMessage(
                `Lakebase branch "${sanitized}" created but not ready yet (state: ${branch?.state || 'unknown'}).`
              );
            }
            statusBarProvider.refresh();
            branchTreeProvider.refresh();
          } catch (err: any) {
            if (!await handleAuthError(lakebaseService, err)) {
              vscode.window.showErrorMessage(`Failed to create branch: ${err.message}`);
            }
          }
        }
      );
    }),

    vscode.commands.registerCommand('lakebaseSync.createProject', async () => {
      const path = require('path');

      // ── Step 1: Project name + location ──────────────────────────
      const projectName = await vscode.window.showInputBox({
        prompt: PROJECT_CREATION_PROMPTS.projectName.prompt,
        placeHolder: PROJECT_CREATION_PROMPTS.projectName.placeHolder,
        validateInput: PROJECT_CREATION_PROMPTS.projectName.validateInput,
        title: 'Lakebase: Create New Project (1/10)',
      });
      if (!projectName) { return; }

      const folderUri = await vscode.window.showOpenDialog({
        title: PROJECT_CREATION_PROMPTS.parentDir.title,
        openLabel: PROJECT_CREATION_PROMPTS.parentDir.openLabel,
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
      });
      if (!folderUri || folderUri.length === 0) { return; }
      const parentDir = folderUri[0].fsPath;

      // ── Step 2: GitHub (optional) ────────────────────────────────
      const githubPick = await vscode.window.showQuickPick([
        { label: '$(github) Create GitHub repository', description: 'Create repo, push scaffold, and set up CI', value: true },
        { label: '$(folder) Local project only', description: 'Scaffold locally – add GitHub later', value: false },
      ], { title: 'Lakebase: GitHub Repository (2/10)', placeHolder: 'Create a GitHub repo or work locally?' });
      if (!githubPick) { return; }
      const createGithubRepo = githubPick.value;

      let ghUser: string | undefined;
      let privateRepo = true;
      let repoName = projectName;

      if (createGithubRepo) {
        try {
          ghUser = await githubService.getCurrentUser();
        } catch { /* not authenticated */ }

        if (ghUser) {
          const authPick = await vscode.window.showQuickPick([
            { label: `$(check) Authenticated as ${ghUser}`, description: 'Continue with this account', action: 'continue' },
            { label: '$(sign-in) Switch GitHub account...', description: 'Sign in with a different account', action: 'login' },
          ], { title: 'Lakebase: GitHub Authentication (3/10)', placeHolder: `GitHub: ${ghUser}` });
          if (!authPick) { return; }
          if (authPick.action === 'login') { ghUser = undefined; }
        }

        if (!ghUser) {
          const loginPick = await vscode.window.showQuickPick([
            { label: '$(sign-in) Sign in to GitHub', description: 'Uses VS Code GitHub authentication' },
          ], { title: 'Lakebase: GitHub Authentication (3/10)', placeHolder: 'GitHub authentication required' });
          if (!loginPick) { return; }

          try {
            githubService.resetAuth();
            ghUser = await ensureGitHubAuth();
          } catch {
            vscode.window.showErrorMessage('GitHub authentication failed. Sign in via VS Code or set lakebaseSync.githubToken.');
            return;
          }
        }

        const repoNameInput = await vscode.window.showInputBox({
          prompt: 'GitHub repository name',
          value: projectName,
          placeHolder: projectName,
          title: 'Lakebase: GitHub Repository Name (4/10)',
          validateInput: (val) => {
            if (!val.trim()) { return 'Repository name is required'; }
            if (!/^[a-zA-Z0-9._-]+$/.test(val)) { return 'Invalid characters in repo name'; }
            return undefined;
          },
        });
        if (!repoNameInput) { return; }
        repoName = repoNameInput;

        const visibilityPick = await vscode.window.showQuickPick([
          { label: '$(lock) Private', description: 'Only you and collaborators can see this repository', value: true },
          { label: '$(globe) Public', description: 'Anyone on the internet can see this repository', value: false },
        ], { title: 'Lakebase: Repository Visibility (5/10)', placeHolder: 'Choose repository visibility' });
        if (!visibilityPick) { return; }
        privateRepo = visibilityPick.value;
      }

      // ── Language stack ───────────────────────────────────────────
      const languageValue = await pickLakebaseLanguage('Lakebase: Project Language (5/10)');
      if (!languageValue) { return; }

      // ── Step 2c: Runner type ─────────────────────────────────────
      const runnerValue = await pickLakebaseRunner('Lakebase: CI Runner Type (6/10)');
      if (!runnerValue) { return; }

      // ── Step 3: Databricks / Lakebase auth ───────────────────────
      // If already authenticated, offer "use this / switch". Otherwise
      // (or on switch) route through the ONE shared workspace-select +
      // authenticate helper that connectWorkspace also uses.
      let dbHost: string | undefined;
      const authStatus = await lakebaseService.checkAuth();
      if (authStatus.authenticated) {
        const current = lakebaseService.getEffectiveHost();
        const dbPick = await vscode.window.showQuickPick([
          { label: `$(check) Connected to ${current.replace(/^https?:\/\//, '')}`, description: 'Use this workspace', action: 'continue' },
          { label: '$(plug) Connect to a different workspace...', description: 'Choose another Databricks workspace', action: 'switch' },
        ], { title: 'Lakebase: Databricks Workspace (7/10)', placeHolder: 'Databricks workspace' });
        if (!dbPick) { return; }
        if (dbPick.action === 'continue') { dbHost = current; }
      }

      if (!dbHost) {
        const selection = await selectAndAuthenticateWorkspace(lakebaseService, {
          title: 'Lakebase: Select Workspace (7/10)',
        });
        if (!selection) { return; }
        dbHost = selection.host;
      }

      const lakebaseProjectName = await vscode.window.showInputBox({
        prompt: 'Lakebase project name',
        value: repoName,
        placeHolder: repoName,
        title: 'Lakebase: Project Name (9/10)',
        validateInput: PROJECT_CREATION_PROMPTS.projectName.validateInput,
      });
      if (!lakebaseProjectName) { return; }

      // ── Step 4: Execute ──────────────────────────────────────────
      const scaffoldSvc = new ScaffoldService();
      const creationSvc = new ProjectCreationService(gitService, githubService, lakebaseService, scaffoldSvc);
      lakebaseService.setHostOverride(dbHost!);
      lakebaseService.setProjectIdOverride(lakebaseProjectName);

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Creating Lakebase project...',
            cancellable: false,
          },
          async (progress) => {
            // withHostEnv sets the resolved DATABRICKS_CONFIG_PROFILE
            // alongside DATABRICKS_HOST so the substrate's `databricks
            // postgres create-project` shell-out can load OAuth config.
            return lakebaseService.withHostEnv(() => creationSvc.createProject(
              {
                projectName: lakebaseProjectName,
                parentDir,
                databricksHost: dbHost!,
                createGithubRepo,
                githubOwner: ghUser,
                privateRepo,
                language: languageValue,
                runnerType: runnerValue,
              },
              (step, detail) => {
                progress.report({ message: `${step}${detail ? ' – ' + detail : ''}` });
              }
            ));
          }
        );

        const successLines = [
          `Project "${lakebaseProjectName}" created successfully!`,
          result.githubRepoUrl ? `GitHub: ${result.githubRepoUrl}` : 'GitHub: skipped (local project)',
          `Lakebase: ${result.lakebaseProjectId}`,
        ];
        const openAction = await vscode.window.showInformationMessage(
          successLines.join('\n'),
          'Open Project',
          ...(result.githubRepoUrl ? ['Open on GitHub' as const] : []),
        );
        if (openAction === 'Open Project') {
          const projectUri = vscode.Uri.file(result.projectDir);
          await vscode.commands.executeCommand('vscode.openFolder', projectUri, { forceNewWindow: false });
        } else if (openAction === 'Open on GitHub' && result.githubRepoUrl) {
          vscode.env.openExternal(vscode.Uri.parse(result.githubRepoUrl));
        }
      } catch (err: any) {
        const action = await vscode.window.showErrorMessage(
          `Project creation failed: ${err.message}`,
          'Clean Up', 'Dismiss'
        );
        if (action === 'Clean Up') {
          try {
            await creationSvc.cleanupProject({
              projectName: lakebaseProjectName,
              parentDir,
              databricksHost: dbHost!,
              createGithubRepo,
              githubOwner: ghUser,
            });
            vscode.window.showInformationMessage('Partial resources cleaned up.');
          } catch (cleanErr: any) {
            vscode.window.showErrorMessage(`Cleanup failed: ${cleanErr.message}`);
          }
        }
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.createLakebaseProject', async () => {
      log('=== setupExistingProject START ===');
      const path = require('path');
      const { adoptLakebaseProject, assertAdoptionPreflight, deployEnv, deployEnvExample, getDefaultBranchId, scaffoldAll } = require('@databricks-solutions/lakebase-app-dev-kit');

      const root = getWorkspaceRoot();
      log(`workspace root: ${root || '<none>'}`);
      if (!root) {
        vscode.window.showErrorMessage('Open a project folder first.');
        return;
      }

      const defaultName = path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
      const existing = getConfig().lakebaseProjectId;
      log(`existing LAKEBASE_PROJECT_ID=${existing || '<none>'} defaultName=${defaultName}`);

      // Already-configured short circuit: this workspace's .env already
      // declares a project. Re-running full setup on it is a dead end
      // (the user "lands nowhere"). Offer to just (re)connect: refresh
      // the views + flip the welcome context so the SCM tree appears.
      if (existing) {
        log(`workspace already configured for "${existing}" -> offering reconnect`);
        const choice = await vscode.window.showInformationMessage(
          `This workspace is already set up for Lakebase project "${existing}". Reconnect and refresh the views?`,
          'Reconnect', 'Re-run full setup', 'Cancel',
        );
        log(`already-configured prompt -> "${choice ?? 'dismissed'}"`);
        if (!choice || choice === 'Cancel') { return; }
        if (choice === 'Reconnect') {
          await context.workspaceState.update('lakebaseSync.onboarding.completedAt', new Date().toISOString());
          await vscode.commands.executeCommand('setContext', 'lakebaseSync.hasProjectId', true);
          branchTreeProvider.refresh();
          statusBarProvider.refresh();
          schemaScmProvider.refresh();
          vscode.window.showInformationMessage(`Reconnected to Lakebase project "${existing}".`);
          log('=== reconnect DONE ===');
          return;
        }
        // 'Re-run full setup' falls through to the normal flow below.
      }

      log('prompting for project ID');
      const projectId = await vscode.window.showInputBox({
        prompt: 'Lakebase project ID',
        value: existing || defaultName,
        validateInput: PROJECT_CREATION_PROMPTS.projectName.validateInput,
        title: 'Lakebase: Set Up Existing Project',
      });
      if (!projectId) { log('=== ABORT: project ID input dismissed ==='); return; }
      log(`project ID: ${projectId}`);

      // Brownfield pre-flight: refuse fast if the workspace is not a
      // git repo or .env already declares a different LAKEBASE_PROJECT_ID.
      // The kit primitive enforces the same gates but surfacing them
      // before the auth prompt is friendlier (no point asking the user
      // to log in if we are going to refuse anyway).
      //
      // Special-case the "no .git directory yet" gate: a user pointing
      // the wizard at a fresh empty folder will hit this on day one.
      // Offer to `git init` for them; the kit primitive requires a
      // git repo because every paired-branch operation downstream uses
      // git as the gate surface.
      const nodePath = require('path');
      const nodeFs = require('fs');
      const hasGit = nodeFs.existsSync(nodePath.join(root, '.git'));
      log(`git repo present: ${hasGit}`);
      if (!hasGit) {
        const choice = await vscode.window.showInformationMessage(
          `${root} is not a git repository yet. Lakebase pairs every git branch with a database branch, so a git repo is required. Initialize one here now?`,
          'Initialize git repo', 'Cancel',
        );
        if (choice !== 'Initialize git repo') { log('=== ABORT: git init declined ==='); return; }
        try {
          const { execFileSync } = require('child_process');
          execFileSync('git', ['init', '-q'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (initErr: any) {
          vscode.window.showErrorMessage(
            `git init failed: ${initErr?.stderr?.toString() || initErr?.message || initErr}`,
          );
          return;
        }
      }
      // Pick language + runner BEFORE auth so users don't authenticate
      // first only to abandon the wizard at language pick. These drive
      // the scaffoldAll call after .env is wired up; without them, the
      // adopt path leaves an empty folder with just .env, which is not
      // a usable Lakebase project tree.
      const setupLanguageValue = await pickLakebaseLanguage('Lakebase: Project Language');
      if (!setupLanguageValue) { log('=== ABORT: user dismissed language pick ==='); return; }
      log(`language: ${setupLanguageValue}`);

      const setupRunnerValue = await pickLakebaseRunner('Lakebase: CI Runner Type');
      if (!setupRunnerValue) { log('=== ABORT: user dismissed runner pick ==='); return; }
      log(`runner: ${setupRunnerValue}`);

      try {
        assertAdoptionPreflight({ projectDir: root, expectedProjectName: projectId });
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message);
        return;
      }

      log('preflight ok, running checkAuth');
      const authStatus = await lakebaseService.checkAuth();
      log(`checkAuth -> authenticated=${authStatus.authenticated} expectedHost="${authStatus.expectedHost}" error=${authStatus.error || ''}`);
      if (!authStatus.authenticated) {
        // Route through the ONE shared workspace-select + authenticate
        // helper instead of delegating to connectWorkspace and racing a
        // recheck. The helper completes auth (polling current-user me)
        // before it returns, so there is no recheck-too-early window.
        log('not authenticated, invoking selectAndAuthenticateWorkspace');
        const selection = await selectAndAuthenticateWorkspace(lakebaseService, {
          title: 'Lakebase: Connect to Workspace',
          includeCurrentWorkspace: true,
        });
        if (!selection) {
          log('=== ABORT: workspace selection / auth cancelled or failed ===');
          return;
        }
        log(`authenticated via helper: host=${selection.host} alreadyConnected=${selection.alreadyConnected}`);
      }

      const host = lakebaseService.getEffectiveHost().replace(/\/+$/, '');
      log(`effective host: ${host}`);

      log(`starting adoptLakebaseProject(projectName=${projectId}, host=${host})`);
      let result: { defaultBranch?: string; warnings?: string[] };
      try {
        result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Setting up Lakebase: ${projectId}`, cancellable: false },
          async (progress) => {
            progress.report({ message: 'Creating database and writing .env...' });
            // withHostEnv sets DATABRICKS_HOST *and* the resolved
            // DATABRICKS_CONFIG_PROFILE so the kit's `databricks postgres
            // create-project` shell-out can load OAuth config. Without
            // the profile the CLI fails with "Unable to load OAuth Config"
            // even though the wizard's own auth check passed.
            return await lakebaseService.withHostEnv(() => adoptLakebaseProject({
              projectDir: root,
              projectName: projectId,
              databricksHost: host,
            }));
          }
        );
        log(`adoptLakebaseProject ok: defaultBranch=${result.defaultBranch || ''} warnings=${result.warnings?.length || 0}`);
      } catch (err: any) {
        const msg = err?.message || String(err);
        log(`adoptLakebaseProject threw: ${msg}`);
        const alreadyExists = /project with such id already exists/i.test(msg);
        if (!alreadyExists) {
          if (!(await handleAuthError(lakebaseService, err))) {
            vscode.window.showErrorMessage(`Failed to set up Lakebase project: ${msg}. See "View > Output > Lakebase SCM" for details.`);
          }
          log('=== ABORT: adoptLakebaseProject failed (not the already-exists path) ===');
          return;
        }
        log('recovery: server-side project already exists, running local-only adoption');
        // Recovery path: server already has the project. Skip the
        // create + run only steps 2-3 of adoptLakebaseProject.
        try {
          result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Adopting existing Lakebase project: ${projectId}`, cancellable: false },
            async (progress) => {
              progress.report({ message: 'Resolving default branch...' });
              const defaultBranch = await lakebaseService.withHostEnv<string>(
                () => getDefaultBranchId({ projectId, host }));
              progress.report({ message: 'Writing .env...' });
              await deployEnvExample(root, { databricksHost: host, lakebaseProjectId: projectId });
              await deployEnv(root, { databricksHost: host, lakebaseProjectId: projectId });
              return { defaultBranch, warnings: [] };
            }
          );
          vscode.window.showInformationMessage(
            `Adopted existing Lakebase project "${projectId}". A prior setup attempt left it server-side; .env now wired up locally.`,
          );
        } catch (recoveryErr: any) {
          vscode.window.showErrorMessage(
            `Recovery from "already exists" failed: ${recoveryErr?.message || recoveryErr}. ` +
              `You can either delete the server-side project (databricks postgres delete-project ${projectId}) and retry, ` +
              `or pick a different project name.`,
          );
          return;
        }
      }

      // Scaffold the language tree + scripts + workflows + hooks into
      // the workspace so the user has a usable project tree, not just
      // a lone .env file. Errors here are non-fatal: .env is already
      // written and the welcome view flip below still completes; we
      // surface a warning and the user can re-run setup.
      log(`scaffolding language tree (lang=${setupLanguageValue}, runner=${setupRunnerValue})`);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Scaffolding ${setupLanguageValue} project tree...`, cancellable: false },
          async (progress) => {
            await lakebaseService.withHostEnv(() => scaffoldAll({
              targetDir: root,
              databricksHost: host,
              lakebaseProjectId: projectId,
              language: setupLanguageValue,
              runnerType: setupRunnerValue,
              report: (step: string, detail?: string) => {
                progress.report({ message: `${step}${detail ? ' (' + detail + ')' : ''}` });
                log(`scaffold: ${step}${detail ? ' (' + detail + ')' : ''}`);
              },
            }));
          },
        );
        log('scaffold ok');
      } catch (scaffoldErr: any) {
        log(`scaffold FAILED (non-fatal): ${scaffoldErr?.message || scaffoldErr}`);
        vscode.window.showWarningMessage(
          `Lakebase project wired up but scaffolding the ${setupLanguageValue} tree failed: ${scaffoldErr?.message || scaffoldErr}. ` +
            `See "View > Output > Lakebase SCM" for the failing step.`,
        );
      }

      // Persist a completion stamp in workspaceState so the activation
      // prompt does not re-fire on the next window reload, and refresh
      // the hasProjectId context so viewsWelcome flips immediately.
      await context.workspaceState.update('lakebaseSync.onboarding.completedAt', new Date().toISOString());
      await context.workspaceState.update('lakebaseSync.onboarding.defaultBranch', result.defaultBranch);
      await vscode.commands.executeCommand('setContext', 'lakebaseSync.hasProjectId', true);
      branchTreeProvider.refresh();
      statusBarProvider.refresh();
      log('=== setupExistingProject DONE ===');

      if (result.warnings && result.warnings.length > 0) {
        for (const w of result.warnings) {
          void vscode.window.showWarningMessage(w);
        }
      }

      // GitHub step: a fresh folder has no remote. Offer to create a
      // repo (or connect an existing one) so the project is backed by
      // GitHub and the CI runner step below has a remote to attach to.
      // No-op + returns the existing repo if origin is already set.
      log('GitHub remote step');
      const runnerRepo = await setUpGitHubRemoteForFolder(gitService, githubService, {
        defaultRepoName: projectId,
      });
      log(`runner setup: origin repo = ${runnerRepo || '<none>'}`);
      if (!runnerRepo) {
        vscode.window.showInformationMessage(
          `Lakebase project "${projectId}" is set up. CI runner setup is available once this repo has a GitHub remote: push to GitHub, then run "Lakebase: Start CI Runner".`,
        );
      } else {
        const runnerChoice = await vscode.window.showInformationMessage(
          `Lakebase project "${projectId}" created. Set up self-hosted CI runner for ${runnerRepo} now?`,
          'Set up runner', 'Skip'
        );
        if (runnerChoice === 'Set up runner') {
          try {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `Setting up runner for ${runnerRepo}`, cancellable: false },
              async (progress) => {
                const runnerService = new RunnerService(githubService, lakebaseService);
                await runnerService.setupRunner(runnerRepo, projectId, (msg: string) => progress.report({ message: msg }));
              }
            );
            vscode.window.showInformationMessage(`Runner started for ${projectId}.`);
            runnerTreeProvider.refresh();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Runner setup failed: ${err.message}`);
          }
          await offerCiSecretsSetup(runnerRepo, { host, projectId });
        }
      }

      await setGitRemoteContext(gitService);
      statusBarProvider.refresh();
      branchTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('lakebaseSync.createUnifiedBranch', async () => {
      // Pre-check: refuse to create a git branch when no Lakebase
      // project is configured, otherwise the user lands on a dangling
      // local branch after `git checkout -b` succeeds and the Lakebase
      // side fails with a cryptic "instance not found" error. The
      // onboarding path is one button away.
      if (!getConfig().lakebaseProjectId) {
        const action = await vscode.window.showWarningMessage(
          "No LAKEBASE_PROJECT_ID configured for this workspace. Set up Lakebase first; otherwise the git branch would be created without a matching database branch.",
          "Set Up Lakebase",
          "Cancel",
        );
        if (action === "Set Up Lakebase") {
          void vscode.commands.executeCommand("lakebaseSync.createLakebaseProject");
        }
        return;
      }

      const branchName = await vscode.window.showInputBox({
        prompt: 'New branch name',
        placeHolder: 'feature/my-feature',
        validateInput: (val) => {
          if (!val.trim()) { return 'Branch name is required'; }
          const cfgV = getConfig();
          if (isMainBranch(val, cfgV.trunkBranch)) { return 'Cannot branch from main/master with this name'; }
          if (isTierBranch(val)) { return `Cannot branch with the name of a long-running tier ("${val}")`; }
          return undefined;
        },
      });

      if (!branchName) { return; }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Creating branch: ${branchName}`,
          cancellable: false,
        },
        async (progress) => {
          try {
            // Capture the branch we're forking from BEFORE the git checkout,
            // since after `git checkout -b` HEAD is the new branch and the
            // parent is no longer trivially observable. This is the value
            // we want Lakebase to fork from (and the value the service uses
            // for drift detection against .env's LAKEBASE_BRANCH_ID).
            const parentGitBranch = await gitService.getCurrentBranch().catch(() => undefined);

            // 1. Create git branch
            progress.report({ message: 'Creating code branch...' });
            await gitService.checkoutBranch(branchName, true);

            // 2. Create Lakebase branch
            const sanitized = lakebaseService.sanitizeBranchName(branchName);
            progress.report({ message: `Creating database branch: ${sanitized}...` });
            const lb = await lakebaseService.createBranch(branchName, undefined, parentGitBranch);

            if (!lb) {
              vscode.window.showWarningMessage(
                `Git branch "${branchName}" created. Lakebase branch creation failed.`
              );
              return;
            }

            // 3. Get endpoint and credentials
            progress.report({ message: 'Waiting for endpoint...' });
            const conn = await lakebaseService.syncConnection(lb.branchId);

            if (conn) {
              vscode.window.showInformationMessage(
                `Branch "${branchName}" created – code + database ready.`
              );
            } else {
              vscode.window.showWarningMessage(
                `Branch "${branchName}" created but endpoint not ready. ` +
                `.env still points to the previous branch. ` +
                `Click "Refresh Credentials" once the branch is active.`
              );
            }
          } catch (err: any) {
            if (await handleMissingProjectError(err)) {
              // Friendly toast already surfaced + onboarding offered.
            } else if (!await handleAuthError(lakebaseService, err)) {
              vscode.window.showErrorMessage(`Failed to create branch: ${err.message}`);
            }
          } finally {
            statusBarProvider.refresh();
            branchTreeProvider.refresh();
            schemaScmProvider.refresh();
            // Safety net: the JS createBranch path may have errored, OR
            // it may have succeeded just before the Lakebase API indexed
            // the new branch. Meanwhile post-checkout.sh runs synchronously
            // during the git checkout and may create the branch with
            // no_expiry: true (the path that survives workspace TTL caps).
            // Stagger a few delayed refreshes so the status bar / sidebar
            // catch the branch once it's queryable, without forcing the
            // user to invoke "Lakebase: Refresh" manually.
            const lateRefresh = () => {
              void statusBarProvider.refresh();
              branchTreeProvider.refresh();
            };
            setTimeout(lateRefresh, 5_000);
            setTimeout(lateRefresh, 15_000);
            setTimeout(lateRefresh, 45_000);
          }
        }
      );
    }),

    // FEIP-7097: cut a long-running tier (staging/uat/perf/custom).
    // Delegates to substrate's createLongRunningBranch, which forks both
    // the Lakebase branch and the git branch in one call and pushes the
    // git branch to origin. Unlike createUnifiedBranch (which is for
    // feature work and uses no_expiry: false), tiers are explicit user
    // gestures that release PRs target.
    vscode.commands.registerCommand('lakebaseSync.cutLongRunningBranch', async () => {
      const CUSTOM_TIER = '$(edit) Custom tier name...';
      const tierPick = await vscode.window.showQuickPick(
        ['staging', 'uat', 'perf', CUSTOM_TIER],
        {
          placeHolder: 'Tier name (release PRs target this branch)',
          ignoreFocusOut: true,
        },
      );
      if (!tierPick) { return; }

      let tier = tierPick;
      if (tierPick === CUSTOM_TIER) {
        const custom = await vscode.window.showInputBox({
          prompt: 'Custom tier name',
          placeHolder: 'dev, qa, ...',
          validateInput: (v) => {
            if (!v.trim()) { return 'Tier name is required'; }
            if (!/^[a-z0-9-]+$/i.test(v)) { return 'Use letters, digits, and hyphens only'; }
            return undefined;
          },
        });
        if (!custom) { return; }
        tier = custom.trim();
      }

      const currentBranch = await gitService.getCurrentBranch().catch(() => undefined);
      const localBranches = await gitService.listLocalBranches().catch(() => []);
      const branchNames = localBranches.map((b) => b.name);
      const forkPickItems: string[] = [];
      if (currentBranch) { forkPickItems.push(currentBranch); }
      for (const name of branchNames) {
        if (name !== currentBranch) { forkPickItems.push(name); }
      }
      const forkPick = await vscode.window.showQuickPick(forkPickItems, {
        placeHolder: `Fork "${tier}" from which branch?`,
        ignoreFocusOut: true,
      });
      if (!forkPick) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Cut tier "${tier}" forked from "${forkPick}"?`,
        {
          modal: true,
          detail:
            `This creates both a Lakebase branch and a matching git branch that release PRs target. ` +
            `The Lakebase branch is created with no_expiry so the tier does not get garbage-collected ` +
            `like feature branches do. The git branch is pushed to origin.`,
        },
        'Cut Tier',
      );
      if (confirm !== 'Cut Tier') { return; }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cutting tier: ${tier}`,
          cancellable: false,
        },
        async (progress) => {
          try {
            progress.report({ message: `Forking from ${forkPick}...` });
            const workTreeDir = await gitService.getRepoRoot();
            const result = await lakebaseService.createLongRunningBranch({
              name: tier,
              forkFromBranch: forkPick,
              workTreeDir,
            });
            vscode.window.showInformationMessage(
              `Tier "${tier}" cut: ${result.lakebaseBranchName} + git branch pushed to origin.`,
            );
          } catch (err: any) {
            if (!(await handleAuthError(lakebaseService, err))) {
              vscode.window.showErrorMessage(`Failed to cut tier: ${err.message}`);
            }
          } finally {
            statusBarProvider.refresh();
            branchTreeProvider.refresh();
          }
        },
      );
    }),

    vscode.commands.registerCommand('lakebaseSync.deleteBranch', async (item?: any) => {
      let branchName: string;

      if (item?.lakebaseBranch) {
        if (item.lakebaseBranch.isDefault && getConfig().productionReadOnly) {
          vscode.window.showWarningMessage('Cannot delete the production branch (productionReadOnly is enabled).');
          return;
        }
        branchName = item.lakebaseBranch.branchId;
      } else {
        let branches;
        try {
          branches = await lakebaseService.listBranches();
        } catch (err: any) {
          await handleAuthError(lakebaseService, err);
          return;
        }
        const nonDefault = branches.filter(b => !b.isDefault);
        const pick = await vscode.window.showQuickPick(
          nonDefault.map(b => ({ label: b.branchId, description: b.state, branch: b })),
          { placeHolder: 'Select Lakebase branch to delete' }
        );
        if (!pick) {
          return;
        }
        branchName = pick.label;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Delete Lakebase branch "${branchName}"? This cannot be undone.`,
        { modal: true },
        'Delete'
      );

      if (confirm !== 'Delete') {
        return;
      }

      try {
        await lakebaseService.deleteBranch(branchName);
        vscode.window.showInformationMessage(`Deleted Lakebase branch: ${branchName}`);
        branchTreeProvider.refresh();
        statusBarProvider.refresh();
      } catch (err: any) {
        if (!await handleAuthError(lakebaseService, err)) {
          vscode.window.showErrorMessage(`Failed to delete branch: ${err.message}`);
        }
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.deleteBranchEverywhere', async (item?: any) => {
      const branchName: string | undefined = item?.gitBranch?.name ?? item?.lakebaseBranch?.branchId;
      if (!branchName) {
        vscode.window.showErrorMessage('No branch selected.');
        return;
      }

      const cfg = getConfig();
      if (isMainBranch(branchName, cfg.trunkBranch)) {
        vscode.window.showWarningMessage(`Refusing to delete trunk branch "${branchName}".`);
        return;
      }
      if (isTierBranch(branchName)) {
        vscode.window.showWarningMessage(`Refusing to delete long-running tier "${branchName}".`);
        return;
      }

      const currentBranch = await gitService.getCurrentBranch();
      const isCurrent = currentBranch === branchName;

      // If deleting the current branch, we need to check out a parent first.
      // Parent = trunk alias if set, else whichever of `main`/`master` exists.
      let parentBranch: string | undefined;
      if (isCurrent) {
        const candidates = [cfg.trunkBranch, 'main', 'master'].filter(Boolean) as string[];
        const localBranches = new Set((await gitService.listLocalBranches()).map(b => b.name));
        parentBranch = candidates.find(c => localBranches.has(c));
        if (!parentBranch) {
          vscode.window.showErrorMessage(
            `Cannot delete current branch: no parent branch (tried ${candidates.join(', ')}) exists locally. Check one out first.`
          );
          return;
        }

        if (await gitService.isDirty()) {
          vscode.window.showWarningMessage(
            `Cannot delete current branch: uncommitted changes in "${branchName}". Commit or stash first.`
          );
          return;
        }
      }

      const hasLocal = !!item?.gitBranch;
      const lbBranchId: string | undefined = item?.lakebaseBranch?.branchId;
      const hasRemote = hasLocal ? await gitService.hasRemoteBranch(branchName) : false;

      const targets: string[] = [];
      if (isCurrent && parentBranch) { targets.push(`• Switch to "${parentBranch}" first`); }
      if (hasLocal) { targets.push(`• Local git branch "${branchName}"`); }
      if (hasRemote) { targets.push(`• Remote branch "origin/${branchName}"`); }
      if (lbBranchId) { targets.push(`• Lakebase branch "${lbBranchId}"`); }
      if (targets.length === 0) {
        vscode.window.showWarningMessage(`Nothing to delete for "${branchName}".`);
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Delete "${branchName}" everywhere?\n\nThis will:\n${targets.join('\n')}\n\nThis cannot be undone.`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') { return; }

      const errors: string[] = [];

      if (isCurrent && parentBranch) {
        try {
          await gitService.checkoutBranch(parentBranch);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Could not check out "${parentBranch}": ${err.message}. Aborted – nothing deleted.`);
          return;
        }
      }

      if (lbBranchId) {
        try {
          await lakebaseService.deleteBranch(lbBranchId);
        } catch (err: any) {
          if (!await handleAuthError(lakebaseService, err)) {
            errors.push(`Lakebase: ${err.message}`);
          }
        }
      }

      if (hasRemote) {
        try {
          await gitService.deleteRemoteBranch(branchName);
        } catch (err: any) {
          errors.push(`origin/${branchName}: ${err.message}`);
        }
      }

      if (hasLocal) {
        try {
          await gitService.deleteBranch(branchName, true);
        } catch (err: any) {
          errors.push(`local ${branchName}: ${err.message}`);
        }
      }

      branchTreeProvider.refresh();
      statusBarProvider.refresh();

      if (errors.length > 0) {
        vscode.window.showErrorMessage(`Deleted with errors:\n${errors.join('\n')}`);
      } else {
        const suffix = isCurrent && parentBranch ? ` Switched to "${parentBranch}".` : '';
        vscode.window.showInformationMessage(`Deleted "${branchName}" everywhere.${suffix}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.refreshCredentials', async () => {
      const gitBranch = await gitService.getCurrentBranch();
      const cfgRc = getConfig();
      const lb = await lakebaseService.resolveBranchForGitBranch(gitBranch, cfgRc.trunkBranch);
      if (!lb) {
        vscode.window.showErrorMessage(
          isMainBranch(gitBranch, cfgRc.trunkBranch)
            ? 'No default Lakebase branch found.'
            : `No Lakebase branch for "${gitBranch}".`,
        );
        return;
      }
      const branchId = lb.branchId;

      try {
        const cred = await lakebaseService.getCredential(branchId);
        vscode.window.showInformationMessage(
          `Credentials refreshed for ${branchId} (user: ${cred.email})`
        );
      } catch (err: any) {
        if (!await handleAuthError(lakebaseService, err)) {
          vscode.window.showErrorMessage(`Failed to refresh credentials: ${err.message}`);
        }
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.startRunner', async () => {
      const config = getConfig();
      if (!config.lakebaseProjectId) {
        vscode.window.showWarningMessage('No LAKEBASE_PROJECT_ID configured. Set it in .env first.');
        return;
      }
      try {
        const runnerService = new RunnerService(githubService, lakebaseService);

        // Get GitHub repo name
        const fullRepoName = await gitService.getOwnerRepo();
        if (!fullRepoName) {
          vscode.window.showErrorMessage('Could not determine GitHub repo from remote.');
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Starting CI runner...' },
          async (progress) => {
            await runnerService.setupRunner(fullRepoName, config.lakebaseProjectId, (msg: string) => {
              progress.report({ message: msg });
            });
          }
        );
        vscode.window.showInformationMessage(`Runner started for ${config.lakebaseProjectId}`);
        runnerTreeProvider.refresh();

        await offerCiSecretsSetup(fullRepoName, {
          host: config.databricksHost,
          projectId: config.lakebaseProjectId,
        });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to start runner: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.setupCiSecrets', async () => {
      const config = getConfig();
      const fullRepoName = await gitService.getOwnerRepo();
      if (!fullRepoName) {
        vscode.window.showErrorMessage('Could not determine GitHub repo from remote.');
        return;
      }
      await offerCiSecretsSetup(
        fullRepoName,
        { host: config.databricksHost, projectId: config.lakebaseProjectId },
        { force: true },
      );
    }),

    vscode.commands.registerCommand('lakebaseSync.installPlaywrightConfig', async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }
      const clientDir = path.join(root, 'client');
      if (!fs.existsSync(clientDir)) {
        vscode.window.showWarningMessage(
          'No client/ directory found. This command installs a Playwright config tuned for full-stack projects where client/ holds the frontend.'
        );
        return;
      }
      // FEIP-7435: read the reference Playwright config from the kit's
      // bundled templates dir (shipped via the kit's npm package), not
      // from a duplicate inside the extension. Resolves the kit package
      // root via require.resolve, then walks down to the template file.
      let src: string;
      try {
        const kitPkgPath = require.resolve('@databricks-solutions/lakebase-app-dev-kit/package.json');
        src = path.join(path.dirname(kitPkgPath), 'templates', 'project', 'common', 'client-reference', 'playwright.config.ts');
      } catch {
        vscode.window.showErrorMessage('Could not resolve the lakebase-app-dev-kit package (templates source).');
        return;
      }
      if (!fs.existsSync(src)) {
        vscode.window.showErrorMessage('Reference Playwright config missing from the kit package (client-reference/playwright.config.ts).');
        return;
      }
      const dest = path.join(clientDir, 'playwright.config.ts');
      if (fs.existsSync(dest)) {
        const choice = await vscode.window.showWarningMessage(
          `client/playwright.config.ts already exists. Overwrite with the reference version (boots both backend and Vite)?`,
          { modal: true },
          'Overwrite'
        );
        if (choice !== 'Overwrite') { return; }
      }
      try {
        fs.copyFileSync(src, dest);
        const openChoice = await vscode.window.showInformationMessage(
          `Installed reference Playwright config at client/playwright.config.ts. Adapt the backend webServer entry to your stack (FastAPI / Spring / Node).`,
          'Open File'
        );
        if (openChoice === 'Open File') {
          const doc = await vscode.workspace.openTextDocument(dest);
          await vscode.window.showTextDocument(doc);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to copy Playwright config: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.refreshRunner', () => {
      runnerTreeProvider.refresh();
    }),

    vscode.commands.registerCommand('lakebaseSync.stopRunner', async () => {
      const config = getConfig();
      if (!config.lakebaseProjectId) { return; }
      try {
        const runnerService = new RunnerService(githubService, lakebaseService);
        runnerService.stopRunner(config.lakebaseProjectId);
        vscode.window.showInformationMessage(`Runner stopped for ${config.lakebaseProjectId}`);
        runnerTreeProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to stop runner: ${err.message}`);
      }
    }),

    // FEIP-7480: remove a self-hosted runner from any paired project the tree
    // surfaces, not just the open workspace. Args (projectName, ownerRepo)
    // come from the tree item's command.arguments; if absent, falls back to
    // the current workspace (matches stopRunner / startRunner shape). Confirms
    // before stopping + deregistering + deleting on-disk dir since the action
    // is destructive.
    vscode.commands.registerCommand(
      'lakebaseSync.removeRunner',
      async (projectName?: string, ownerRepo?: string) => {
        let resolvedProject = projectName ?? '';
        let resolvedRepo = ownerRepo ?? '';
        if (!resolvedProject) {
          const config = getConfig();
          resolvedProject = config.lakebaseProjectId;
        }
        if (!resolvedProject) {
          vscode.window.showErrorMessage('Remove Runner: no project selected.');
          return;
        }
        if (!resolvedRepo) {
          try {
            const ownerRepo = await gitService.getOwnerRepo();
            if (ownerRepo) { resolvedRepo = ownerRepo; }
          } catch {}
        }
        const choice = await vscode.window.showWarningMessage(
          `Remove runner for "${resolvedProject}"?\n\n` +
            'This will stop the running process, deregister it from GitHub' +
            (resolvedRepo ? ` (${resolvedRepo})` : ''),
          { modal: true, detail: 'On-disk runner dir under ~/.lakebase/runners/ will also be deleted.' },
          'Remove Runner',
        );
        if (choice !== 'Remove Runner') { return; }
        try {
          const runnerService = new RunnerService(githubService, lakebaseService);
          await runnerService.removeRunner(resolvedRepo, resolvedProject);
          vscode.window.showInformationMessage(`Runner removed for ${resolvedProject}.`);
          runnerTreeProvider.refresh();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to remove runner: ${err.message}`);
        }
      },
    ),

    vscode.commands.registerCommand('lakebaseSync.connectWorkspace', async () => {
      log('=== connectWorkspace START ===');
      const selection = await selectAndAuthenticateWorkspace(lakebaseService, {
        title: 'Lakebase: Connect to Workspace',
        includeCurrentWorkspace: true,
      });
      if (!selection) { log('=== ABORT: workspace selection cancelled/failed ==='); return; }
      log(`connected host=${selection.host} alreadyConnected=${selection.alreadyConnected}`);
      vscode.window.showInformationMessage(
        selection.alreadyConnected
          ? `Already connected to ${selection.host}`
          : `Connected to ${selection.host}`,
      );
      statusBarProvider.refresh();
      branchTreeProvider.refresh();

      // Connecting a WORKSPACE only sets host + auth. The current folder
      // is bound to a Lakebase project separately, via .env's
      // LAKEBASE_PROJECT_ID. If this folder has no project yet, the
      // connect succeeds but the user sees nothing change ("connected
      // and nothing"). Nudge them straight into project setup rather
      // than dead-ending. If the folder IS already bound, flip the
      // welcome context so the tree surfaces.
      const boundProject = getConfig().lakebaseProjectId;
      log(`folder bound project: ${boundProject || '<none>'}`);
      if (boundProject) {
        await vscode.commands.executeCommand('setContext', 'lakebaseSync.hasProjectId', true);
        schemaScmProvider.refresh();
        log('=== connectWorkspace DONE (folder already bound) ===');
        return;
      }
      const next = await vscode.window.showInformationMessage(
        `Connected to ${selection.host}, but this folder is not yet linked to a Lakebase project. Set one up now?`,
        'Set Up Lakebase', 'Later',
      );
      log(`post-connect setup prompt -> "${next ?? 'dismissed'}"`);
      if (next === 'Set Up Lakebase') {
        await vscode.commands.executeCommand('lakebaseSync.createLakebaseProject');
      }
      log('=== connectWorkspace DONE ===');
    }),

    // Tree-view recovery affordance: attach a GitHub repo to a folder
    // that has none (e.g. setup was skipped or the user tabbed away from
    // the GitHub step). Uses the SAME shared helper as the setup flow, so
    // the create/connect UX is identical everywhere (unified process).
    vscode.commands.registerCommand('lakebaseSync.attachGitHubRepo', async () => {
      log('=== attachGitHubRepo START ===');
      const root = getWorkspaceRoot();
      if (!root) { vscode.window.showErrorMessage('Open a project folder first.'); return; }
      const path = require('path');
      const repo = await setUpGitHubRemoteForFolder(gitService, githubService, {
        defaultRepoName: getConfig().lakebaseProjectId || path.basename(root),
      });
      await setGitRemoteContext(gitService);
      branchTreeProvider.refresh();
      statusBarProvider.refresh();
      if (repo) {
        // Offer CI runner setup now that a remote exists.
        const setUp = await vscode.window.showInformationMessage(
          `GitHub remote set to ${repo}. Set up the CI runner now?`, 'Set up runner', 'Later',
        );
        if (setUp === 'Set up runner') {
          await vscode.commands.executeCommand('lakebaseSync.startRunner');
        }
      }
      log(`=== attachGitHubRepo DONE (repo=${repo || '<none>'}) ===`);
    }),

    vscode.commands.registerCommand('lakebaseSync.runMigrate', async () => {
      schemaDiffService.clearCache();
      const root = getWorkspaceRoot();
      const lang = detectLanguage(root);
      const { name, cmd } = migrationService.buildMigrateCommand(lang);
      const terminal = vscode.window.createTerminal(name);
      terminal.show();
      terminal.sendText(cmd);
    }),

    vscode.commands.registerCommand('lakebaseSync.runTests', async () => {
      const terminal = vscode.window.createTerminal('Run Tests');
      terminal.show();
      terminal.sendText('./scripts/refresh-token.sh ./scripts/run-tests.sh');
    }),

    vscode.commands.registerCommand('lakebaseSync.showMigrationHistory', async () => {
      const migrations = migrationService.listMigrations();
      if (migrations.length === 0) {
        vscode.window.showInformationMessage('No migration files found.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        migrations.map(m => ({
          label: `V${m.version}`,
          description: m.description,
          detail: m.filename,
          migration: m,
        })),
        { placeHolder: 'Migration history (select to open)' }
      );

      if (pick) {
        const doc = await vscode.workspace.openTextDocument(pick.migration.fullPath);
        vscode.window.showTextDocument(doc);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.openBranchTableDiff', async (tableName: string, changeType: 'new' | 'modified' | 'removed') => {
      // Force a live compare so SchemaContentProvider reads fresh data for both
      // sides. Without this, a stale cache entry can cause the two
      // URIs to fall back to the same branchTables entry → empty diff.
      let diff;
      try {
        diff = await schemaDiffService.compareBranchSchemas(undefined, true);
      } catch (err: any) {
        if (!await handleAuthError(lakebaseService, err)) {
          vscode.window.showErrorMessage(`Schema refresh failed: ${err.message}`);
          return;
        }
      }
      const branchUri = vscode.Uri.parse(`lakebase-schema-content://branch/${tableName}`);
      // URI authority stays `production` for SchemaContentProvider routing
      // (it's a routing key, not a user-visible name). The LABEL uses the
      // resolved comparison branch (e.g. `staging` when forking from staging
      // on a 3-tier setup) so the diff title matches Branch Diff Summary.
      const prodUri = vscode.Uri.parse(`lakebase-schema-content://production/${tableName}`);
      const parentName = diff?.comparisonBranchName?.split('/branches/').pop() || diff?.comparisonBranchName || 'parent';
      const labels: Record<string, string> = {
        new: `${tableName} (new on branch)`,
        modified: `${tableName} (${parentName} ↔ branch)`,
        removed: `${tableName} (removed on branch)`,
      };
      await vscode.commands.executeCommand('vscode.diff', prodUri, branchUri, labels[changeType]);
    }),

    vscode.commands.registerCommand('lakebaseSync.showTableDiff', async (tableName?: string, diffType?: string, branchName?: string) => {
      if (!tableName || !diffType) {
        return;
      }
      try {
        // Pass branchName so the diff is computed for the tree row's branch
        // rather than whichever branch happens to be active in .env. Drops
        // through to .env's LAKEBASE_BRANCH_ID when undefined (call sites
        // without branch context).
        await schemaDiffProvider.showTableDiff(
          tableName,
          diffType as 'created' | 'modified' | 'removed' | 'unchanged',
          undefined,
          branchName,
        );
      } catch (err: any) {
        if (!await handleAuthError(lakebaseService, err)) {
          vscode.window.showErrorMessage(`Schema diff failed: ${err.message}`);
        }
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.moreActions', async () => {
      interface ActionItem extends vscode.QuickPickItem { command: string }
      const items: ActionItem[] = [
        { label: 'Pull', command: 'lakebaseSync.pull' },
        { label: 'Push', command: 'lakebaseSync.push' },
        { label: 'Clone', command: 'lakebaseSync.clone' },
        { label: 'Fetch', command: 'lakebaseSync.fetch' },
        { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
        { label: 'Commit', command: 'lakebaseSync.commit' },
        { label: 'Commit Staged', command: 'lakebaseSync.commitStaged' },
        { label: 'Commit All', command: 'lakebaseSync.commitAll' },
        { label: 'Undo Last Commit', command: 'lakebaseSync.undoLastCommit' },
        { label: 'Amend Last Commit', command: 'lakebaseSync.commitAmend' },
        { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
        { label: 'Pull (Rebase)', command: 'lakebaseSync.pullRebase' },
        { label: 'Sync', command: 'lakebaseSync.sync' },
        { label: 'Fetch (Prune)', command: 'lakebaseSync.fetchPrune' },
        { label: 'Fetch From All Remotes', command: 'lakebaseSync.fetchAll' },
        { label: 'Publish Branch', command: 'lakebaseSync.publishBranch' },
        { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
        { label: 'Create Branch...', command: 'lakebaseSync.createUnifiedBranch' },
        { label: 'Create Branch From...', command: 'lakebaseSync.createUnifiedBranchFrom' },
        { label: 'Cut Long-Running Tier...', command: 'lakebaseSync.cutLongRunningBranch' },
        { label: 'Rename Branch...', command: 'lakebaseSync.renameBranch' },
        { label: 'Delete Branch...', command: 'lakebaseSync.deleteBranch' },
        { label: 'Merge Branch...', command: 'lakebaseSync.mergeBranch' },
        { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
        { label: 'Stash', command: 'lakebaseSync.stash' },
        { label: 'Stash (Include Untracked)', command: 'lakebaseSync.stashIncludeUntracked' },
        { label: 'Apply Latest Stash', command: 'lakebaseSync.stashApply' },
        { label: 'Pop Latest Stash', command: 'lakebaseSync.stashPop' },
        { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
        { label: 'Create Tag...', command: 'lakebaseSync.createTag' },
        { label: 'Delete Tag...', command: 'lakebaseSync.deleteTag' },
        { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
        { label: 'Refresh Credentials', command: 'lakebaseSync.refreshCredentials' },
        { label: 'Run Migrations', command: 'lakebaseSync.runMigrate' },
        { label: 'Run Tests', command: 'lakebaseSync.runTests' },
        { label: 'Branch Diff Summary', command: 'lakebaseSync.showBranchDiff' },
        { label: 'Connect Workspace...', command: 'lakebaseSync.connectWorkspace' },
        { label: 'Health Check', command: 'lakebaseSync.healthCheck' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'More Actions...' });
      if (pick?.command) { vscode.commands.executeCommand(pick.command); }
    }),

    vscode.commands.registerCommand('lakebaseSync.showBranchDiff', async (item?: BranchItem) => {
      try {
        // If invoked on main/production, there's nothing to diff
        if (item?.lakebaseBranch?.isDefault || (item?.gitBranch && isMainBranch(item.gitBranch.name, getConfig().trunkBranch))) {
          vscode.window.showInformationMessage('This is the production branch – no diff to show.');
          return;
        }
        const fileChanges = await gitService.getChangedFiles();
        const branchId = item?.lakebaseBranch?.branchId;
        await schemaDiffProvider.showDiff(false, fileChanges, branchId);
      } catch (err: any) {
        if (!await handleAuthError(lakebaseService, err)) {
          vscode.window.showErrorMessage(`Branch diff failed: ${err.message}`);
        }
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.showCachedBranchDiff', async () => {
      try {
        const fileChanges = await gitService.getChangedFiles();
        await schemaDiffProvider.showDiff(false, fileChanges);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Branch diff failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.openInConsole', async (item?: BranchItem) => {
      let branchUid = item?.lakebaseBranch?.uid;
      // If no branch item provided, resolve current branch or fall back to default
      if (!branchUid) {
        try {
          const gitBranch = await gitService.getCurrentBranch();
          const cfgOc = getConfig();
          // Trunk → default; tier/feature → name-match; fall back to
          // default when the named branch is missing.
          const lb = await lakebaseService.resolveBranchForGitBranch(
            gitBranch, cfgOc.trunkBranch, { fallbackToDefault: true });
          branchUid = lb?.uid;
        } catch {
          // Fall through – url will be project-level
        }
      }
      const url = await lakebaseService.getConsoleUrl(branchUid);
      if (!url) {
        vscode.window.showWarningMessage('Cannot build console URL. Check DATABRICKS_HOST and LAKEBASE_PROJECT_ID in .env.');
        return;
      }
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand('lakebaseSync.switchBranch', async (item?: any) => {
      if (!item?.gitBranch) {
        return;
      }

      const targetGitBranch = item.gitBranch.name;
      const cfgSb = getConfig();
      const isMain = isMainBranch(targetGitBranch, cfgSb.trunkBranch);
      const isTier = !isMain && isTierBranch(targetGitBranch);

      // Proactive dirty-tree check: git silently carries non-conflicting uncommitted
      // edits across a checkout, which produces the confusing "same code on the new
      // branch" experience. Force the user to decide up front.
      if (await gitService.isDirty()) {
        const action = await vscode.window.showWarningMessage(
          `You have uncommitted changes. Switching to "${targetGitBranch}" will carry them with you unless you stash or commit first.`,
          { modal: true },
          'Stash & Switch', 'Commit First'
        );
        if (action === 'Commit First') {
          vscode.commands.executeCommand('lakebaseSync.commit');
          return;
        }
        if (action === 'Stash & Switch') {
          try {
            await gitService.stashIncludeUntracked(`Auto-stash before switching to ${targetGitBranch}`);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to stash: ${err.message}`);
            return;
          }
        } else {
          // Dismissed / Cancel – abort.
          return;
        }
      }

      // Suppress automatic refreshes until the full switch completes
      statusBarProvider.suppressRefresh = true;
      branchTreeProvider.suppressRefresh = true;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Switching to ${targetGitBranch}`,
          cancellable: false,
        },
        async (progress) => {
          try {
            // Capture pre-switch branch so we can fork Lakebase off of it if
            // the target is brand new. After the checkout below, .env's
            // LAKEBASE_BRANCH_ID may already reflect the *new* branch (the
            // post-checkout hook fires during checkout), so .env is unreliable
            // as a parent-of-record at the create-branch step.
            const parentGitBranch = await gitService.getCurrentBranch().catch(() => undefined);

            // 1. Checkout git branch
            progress.report({ message: 'Checking out code branch...' });
            await gitService.checkoutBranch(targetGitBranch);

            // 2. Find or create Lakebase branch
            progress.report({ message: 'Finding database branch...' });
            // Trunk → default; tier/feature → name-match (substrate
            // sanitizes at entry, so a git slash still resolves).
            let lb = await lakebaseService.resolveBranchForGitBranch(targetGitBranch, cfgSb.trunkBranch);

            if (!lb && !isMain && !isTier) {
              progress.report({ message: 'Creating database branch...' });
              try {
                lb = await lakebaseService.createBranch(targetGitBranch, undefined, parentGitBranch);
              } catch (err: any) {
                if (!await handleAuthError(lakebaseService, err)) {
                  vscode.window.showWarningMessage(
                    `Switched to ${targetGitBranch} (code only). DB branch creation failed: ${err.message}`
                  );
                }
                statusBarProvider.refresh();
                branchTreeProvider.refresh();
                return;
              }
            }

            if (!lb) {
              vscode.window.showWarningMessage(
                `Switched to ${targetGitBranch} (code only). No database branch available.`
              );
              statusBarProvider.refresh();
              branchTreeProvider.refresh();
              return;
            }

            // 3-5. Sync connection (endpoint + credential + .env)
            progress.report({ message: 'Syncing connection...' });
            const conn = await lakebaseService.syncConnection(lb.branchId);
            if (!conn) {
              vscode.window.showWarningMessage(
                `Switched to ${targetGitBranch}. DB branch exists but no endpoint available.`
              );
              statusBarProvider.refresh();
              branchTreeProvider.refresh();
              return;
            }

            // 6. Run migrations (language-aware)
            progress.report({ message: 'Applying migrations...' });
            schemaDiffService.clearCache();
            const migrationCount = migrationService.getMigrationCount();
            if (migrationCount > 0) {
              const switchLang = detectLanguage(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
              const migCmd = migrationService.buildMigrateCommand(switchLang, { branchLabel: targetGitBranch });
              const terminal = vscode.window.createTerminal({
                name: migCmd.name,
                cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
              });
              terminal.show(true);
              terminal.sendText(migCmd.cmd);
            }

            vscode.window.showInformationMessage(
              `Switched to ${targetGitBranch} → DB: ${lb.branchId} (${lb.state})` +
              (migrationCount > 0 ? ` | ${migrationCount} migration(s) applying...` : '')
            );
          } catch (err: any) {
            const msg = err.message || '';
            if (msg.includes('local changes') && msg.includes('overwritten by checkout')) {
              const action = await vscode.window.showWarningMessage(
                `Cannot switch to ${targetGitBranch} – you have uncommitted changes that would be overwritten.`,
                'Stash & Switch', 'Commit First', 'Cancel'
              );
              if (action === 'Stash & Switch') {
                try {
                  await gitService.stashIncludeUntracked(`Auto-stash before switching to ${targetGitBranch}`);
                  vscode.window.showInformationMessage('Changes stashed. Retrying checkout...');
                  vscode.commands.executeCommand('lakebaseSync.switchBranch', item);
                } catch (stashErr: any) {
                  vscode.window.showErrorMessage(`Failed to stash: ${stashErr.message}`);
                }
              } else if (action === 'Commit First') {
                vscode.commands.executeCommand('lakebaseSync.commit');
              }
            } else if (!await handleAuthError(lakebaseService, err)) {
              vscode.window.showErrorMessage(`Failed to switch branch: ${msg}`);
            }
          } finally {
            // Re-enable and force a single refresh with final state
            statusBarProvider.suppressRefresh = false;
            branchTreeProvider.suppressRefresh = false;
            statusBarProvider.refresh();
            branchTreeProvider.refresh();
            schemaScmProvider.refresh();
            // Re-render the Branch Diff panel if it's open
            schemaDiffProvider.refresh();
          }
        }
      );
    })
  );

  // SCM git operations
  context.subscriptions.push(
    vscode.commands.registerCommand('lakebaseSync.reviewBranch', async () => {
      try {
        const root = getWorkspaceRoot();
        const currentBranch = await gitService.getCurrentBranch();
        const title = `Branch Review: ${currentBranch}`;

        // vscode.changes expects [labelUri, originalUri, modifiedUri][] – 3-element tuples
        const changes: DiffTuple[] = [];

        // Collect code diffs
        const fileChanges = await gitService.getChangedFiles();

        for (const file of fileChanges) {
          const filePath = root ? `${root}/${file.path}` : file.path;
          const modified = vscode.Uri.file(filePath);
          const diffPath = file.status === 'renamed' && file.oldPath ? file.oldPath : file.path;
          const original = vscode.Uri.parse(`lakebase-git-base://merge-base/${diffPath}`);

          if (file.status === 'added') {
            changes.push([modified, undefined, modified]);
          } else if (file.status === 'deleted') {
            changes.push([original, original, undefined]);
          } else {
            changes.push([modified, original, modified]);
          }
        }

        // Collect schema diffs
        const diff = schemaDiffService.getCachedDiff() || await schemaDiffService.compareBranchSchemas();
        if (diff && !diff.error) {
          for (const obj of [...diff.created, ...diff.modified, ...diff.removed]) {
            const label = vscode.Uri.parse(`lakebase-schema-content://branch/${obj.name}`);
            const original = vscode.Uri.parse(`lakebase-schema-content://production/${obj.name}`);
            const modified = vscode.Uri.parse(`lakebase-schema-content://branch/${obj.name}`);
            changes.push([label, original, modified]);
          }
        }

        // Migration file fallback if pg_dump found nothing
        if (diff && diff.inSync && !diff.error) {
          try {
            const config = getConfig();
            const mainMigrations = await gitService.listMigrationsOnBranch(config.trunkBranch || 'main', config.migrationPath);
            const mainSet = new Set(mainMigrations);
            const branchMigrations = migrationService.listMigrations();
            const newMigrations = branchMigrations.filter(m => !mainSet.has(m.filename));
            if (newMigrations.length > 0) {
              const schemaChanges = migrationService.parseMigrationSchemaChanges(newMigrations);
              const seen = new Set<string>();
              for (const change of schemaChanges) {
                if (seen.has(change.tableName)) { continue; }
                seen.add(change.tableName);
                const label = vscode.Uri.parse(`lakebase-schema-content://branch/${change.tableName}`);
                const original = vscode.Uri.parse(`lakebase-schema-content://production/${change.tableName}`);
                const modified = vscode.Uri.parse(`lakebase-schema-content://branch/${change.tableName}`);
                changes.push([label, original, modified]);
              }
            }
          } catch { /* ignore */ }
        }

        if (changes.length === 0) {
          vscode.window.showInformationMessage('No changes to review.');
          return;
        }

        await vscode.commands.executeCommand('vscode.changes', title, changes);
      } catch (err: any) {
        if (!await handleAuthError(lakebaseService, err)) {
          vscode.window.showErrorMessage(`Review failed: ${err.message}`);
        }
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.stageFile', async (resourceState: any) => {
      const filePath = resourceState?.resourceUri?.fsPath;
      if (!filePath) { return; }
      const root = getWorkspaceRoot();
      const relative = root ? filePath.replace(root + '/', '') : filePath;
      try {
        await gitService.stageFile(relative);
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to stage: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.unstageFile', async (resourceState: any) => {
      const filePath = resourceState?.resourceUri?.fsPath;
      if (!filePath) { return; }
      const root = getWorkspaceRoot();
      const relative = root ? filePath.replace(root + '/', '') : filePath;
      try {
        await gitService.unstageFile(relative);
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to unstage: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.discardChanges', async (resourceState: any) => {
      const filePath = resourceState?.resourceUri?.fsPath;
      if (!filePath) { return; }
      const root = getWorkspaceRoot();
      const relative = root ? filePath.replace(root + '/', '') : filePath;
      const confirm = await vscode.window.showWarningMessage(
        `Discard changes to "${relative}"? This cannot be undone.`,
        { modal: true },
        'Discard'
      );
      if (confirm !== 'Discard') { return; }
      try {
        await gitService.discardFile(relative);
        // Clear schema cache if a migration file was discarded
        const cfg = getConfig();
        if (cfg.migrationPattern.test(relative.split('/').pop() || relative)) { schemaDiffService.clearCache(); }
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to discard: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.stageAll', async () => {
      const root = getWorkspaceRoot();
      if (!root) { return; }
      try {
        await gitService.stageFile('.');
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to stage all: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.unstageAll', async () => {
      const root = getWorkspaceRoot();
      if (!root) { return; }
      try {
        await gitService.unstageFile('.');
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to unstage all: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.commit', async () => {
      const scm = schemaScmProvider.getScm();
      let message = scm?.inputBox.value || '';
      if (!message.trim()) {
        // Prompt for message when SCM input box is empty (e.g. committing from sidebar)
        const input = await vscode.window.showInputBox({
          prompt: 'Commit message',
          placeHolder: 'Describe your changes...',
          validateInput: (val) => val.trim() ? undefined : 'Commit message is required',
        });
        if (!input) { return; }
        message = input;
      }
      try {
        // If nothing is staged, stage all changes first (like Git SCM behavior)
        const staged = await gitService.getStagedChanges();
        if (staged.length === 0) {
          await gitService.stageFile('.');
        }
        await gitService.commit(message);
        if (scm) { scm.inputBox.value = ''; }
        vscode.window.showInformationMessage('Committed successfully.');
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Commit failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.commitStaged', async () => {
      // Same as commit – commits whatever is staged
      vscode.commands.executeCommand('lakebaseSync.commit');
    }),

    vscode.commands.registerCommand('lakebaseSync.commitAll', async () => {
      const scm = schemaScmProvider.getScm();
      let message = scm?.inputBox.value || '';
      if (!message.trim()) {
        const input = await vscode.window.showInputBox({
          prompt: 'Commit message',
          placeHolder: 'Describe your changes...',
          validateInput: (val) => val.trim() ? undefined : 'Commit message is required',
        });
        if (!input) { return; }
        message = input;
      }
      try {
        await gitService.commitAll(message);
        if (scm) { scm.inputBox.value = ''; }
        vscode.window.showInformationMessage('All changes committed.');
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Commit all failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.undoLastCommit', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Undo last commit? Changes will be kept as staged.',
        { modal: true },
        'Undo'
      );
      if (confirm !== 'Undo') { return; }
      try {
        await gitService.undoLastCommit();
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Last commit undone. Changes are staged.');
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Undo failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.commitAmend', async () => {
      const scm = schemaScmProvider.getScm();
      if (!scm) { return; }
      const message = scm.inputBox.value;
      try {
        if (message.trim()) {
          await gitService.commitAmendMessage(message);
          scm.inputBox.value = '';
        } else {
          await gitService.commitAmend();
        }
        vscode.window.showInformationMessage('Commit amended.');
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Amend failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.commitStagedAmend', async () => {
      vscode.commands.executeCommand('lakebaseSync.commitAmend');
    }),

    vscode.commands.registerCommand('lakebaseSync.commitAllAmend', async () => {
      try {
        await gitService.stageFile('.');
        vscode.commands.executeCommand('lakebaseSync.commitAmend');
      } catch (err: any) {
        vscode.window.showErrorMessage(`Commit all amend failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.discardAllChanges', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Discard ALL changes? This cannot be undone.',
        { modal: true },
        'Discard All'
      );
      if (confirm !== 'Discard All') { return; }
      try {
        await gitService.discardAllChanges();
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('All changes discarded.');
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Discard failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.renameBranch', async () => {
      const oldBranch = await gitService.getCurrentBranch();
      const newName = await vscode.window.showInputBox({
        prompt: 'New branch name',
        placeHolder: 'feature/new-name',
      });
      if (!newName) { return; }
      try {
        await gitService.renameBranch(newName);
        // Delete old Lakebase branch (new one will be auto-created by onBranchChanged)
        if (oldBranch && !isLongRunningTier(oldBranch)) {
          try {
            const oldLb = await lakebaseService.getBranchByName(oldBranch);
            if (oldLb) {
              await lakebaseService.deleteBranch(oldLb.branchId);
            }
          } catch { /* Lakebase cleanup is optional */ }
        }
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage(`Branch renamed to ${newName}. Lakebase branch will be recreated.`);
        statusBarProvider.refresh();
        branchTreeProvider.refresh();
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Rename failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.mergeBranch', async () => {
      const branches = await gitService.listLocalBranches();
      const currentBranch = await gitService.getCurrentBranch();
      const otherBranches = branches.filter(b => b.name !== currentBranch);

      const pick = await vscode.window.showQuickPick(
        otherBranches.map(b => ({ label: b.name })),
        { placeHolder: 'Select branch to merge into current branch' }
      );
      if (!pick) { return; }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Merging ${pick.label}...` },
          () => gitService.mergeBranch(pick.label)
        );
        schemaDiffService.clearCache();
        // Offer to clean up the merged branch's Lakebase branch
        if (!isLongRunningTier(pick.label)) {
          try {
            const mergedLb = await lakebaseService.getBranchByName(pick.label);
            if (mergedLb) {
              const cleanup = await vscode.window.showInformationMessage(
                `Merged ${pick.label}. Delete its Lakebase branch "${mergedLb.branchId}"?`,
                'Delete', 'Keep'
              );
              if (cleanup === 'Delete') {
                await lakebaseService.deleteBranch(mergedLb.branchId);
              }
            } else {
              vscode.window.showInformationMessage(`Merged ${pick.label} into ${currentBranch}.`);
            }
          } catch {
            vscode.window.showInformationMessage(`Merged ${pick.label} into ${currentBranch}.`);
          }
        } else {
          vscode.window.showInformationMessage(`Merged ${pick.label} into ${currentBranch}.`);
        }
        schemaScmProvider.refresh();
        statusBarProvider.refresh();
        branchTreeProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Merge failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.push', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Pushing...' },
          () => gitService.push()
        );
        vscode.window.showInformationMessage('Pushed successfully.');
        statusBarProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Push failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.pull', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Pulling...' },
          () => gitService.pull()
        );
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Pulled successfully.');
        schemaScmProvider.refresh();
        statusBarProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Pull failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.switchBranchPicker', async () => {
      try {
        const currentBranch = await gitService.getCurrentBranch();

        // Fetch git branches (local + remote) and lakebase branches in parallel
        const [gitBranches, remoteBranches, lakebaseBranches] = await Promise.all([
          gitService.listLocalBranches(),
          gitService.listRemoteBranches(),
          lakebaseService.listBranches().catch(() => [] as any[]),
        ]);

        // Build a map of lakebase branches by sanitized name
        const lbMap = new Map<string, string>();
        for (const lb of lakebaseBranches) {
          lbMap.set(lb.branchId, `${lb.branchId} (${lb.state})`);
        }
        const defaultLb = lakebaseBranches.find((b: any) => b.isDefault);

        interface BranchPickItem extends vscode.QuickPickItem {
          action?: 'create' | 'create-from' | 'cut-tier' | 'detach';
          branchName?: string;
          isRemote?: boolean;
        }

        const cfgPicker = getConfig();
        const trunkAliasForLookup = cfgPicker.trunkBranch;
        function getLakebaseInfo(branchName: string): string {
          const isMain = isMainBranch(branchName, trunkAliasForLookup);
          if (isMain) {
            return defaultLb ? `→ ${defaultLb.branchId} (default)` : '→ no Lakebase';
          }
          // Tier OR feature: pair by sanitized branchId. lbMap is keyed
          // on branchId; the lookup hits tiers (staging, uat, ...) and
          // features uniformly.
          const sanitized = lakebaseService.sanitizeBranchName(branchName);
          return lbMap.has(sanitized) ? `→ ${lbMap.get(sanitized)}` : '→ no Lakebase branch';
        }

        const items: BranchPickItem[] = [];

        // Actions section
        items.push({ label: 'Actions', kind: vscode.QuickPickItemKind.Separator } as any);
        items.push({
          label: '$(add) Create New Branch...',
          description: 'from current branch',
          action: 'create',
        });
        items.push({
          label: '$(git-branch) Create New Branch From...',
          description: 'select a base branch',
          action: 'create-from',
        });
        // Long-running tiers get a purple `$(versions)` icon as a leading
        // ThemeIcon plus a `[tier]` tag in the description. Two channels
        // (color + text) so colorblind / screen-reader users get the
        // signal too.
        const tierIcon = new vscode.ThemeIcon('versions', new vscode.ThemeColor('charts.purple'));
        // FEIP-7098 tier-aware: the auto-discovered cache wins; static
        // methodology names + configured trunkBranch are a fallback for
        // sessions where listBranches hasn't run yet.
        const fallbackTiers = new Set(['staging', 'uat', 'perf']);
        const cfgFallbackTier = getConfig().stagingBranch;
        const isLongRunningTier = (name: string): boolean =>
          isTierBranch(name) ||
          fallbackTiers.has(name) ||
          (!!cfgFallbackTier && name === cfgFallbackTier);

        items.push({
          label: 'Cut Long-Running Tier...',
          iconPath: tierIcon,
          description: 'staging / uat / perf / custom (no_expiry; release PRs target it)',
          action: 'cut-tier',
        });
        items.push({
          label: '$(debug-disconnect) Checkout Detached...',
          description: 'detach HEAD at a commit',
          action: 'detach',
        });

        // Local branches section
        items.push({ label: 'Local Branches', kind: vscode.QuickPickItemKind.Separator } as any);

        for (const gb of gitBranches) {
          const isCurrent = gb.name === currentBranch;
          const isTier = isLongRunningTier(gb.name);
          const lakebaseInfo = getLakebaseInfo(gb.name);
          // Tier rows get THREE visual signals (overkill is fine, Cursor /
          // VS Code differ on whether they render iconPath color):
          //   1. Leading purple ThemeIcon via iconPath
          //   2. Inline $(versions) codicon in the label (always visible)
          //   3. Bracketed `[tier]` tag in the description (text fallback)
          items.push({
            label: `${isCurrent ? '$(check) ' : ''}${isTier ? '$(versions) ' : ''}${gb.name}`,
            iconPath: isTier ? tierIcon : undefined,
            description: isTier ? `${lakebaseInfo}  [tier]` : lakebaseInfo,
            detail: gb.tracking ? `tracking: ${gb.tracking}` : undefined,
            branchName: gb.name,
          });
        }

        // Remote branches section
        if (remoteBranches.length > 0) {
          items.push({ label: 'Remote Branches', kind: vscode.QuickPickItemKind.Separator } as any);

          for (const rb of remoteBranches) {
            const isTier = isLongRunningTier(rb.name);
            const lakebaseInfo = getLakebaseInfo(rb.name);
            items.push({
              label: `${isTier ? '$(versions)' : '$(cloud)'} ${rb.name}`,
              iconPath: isTier ? tierIcon : undefined,
              description: isTier ? `${lakebaseInfo}  [tier]` : lakebaseInfo,
              detail: `remote: ${rb.tracking}`,
              branchName: rb.name,
              isRemote: true,
            });
          }
        }

        const pick = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a branch or tag to checkout',
          title: 'Branches (Code + Database)',
        });

        if (!pick) { return; }

        if (pick.action === 'create') {
          // Delegate to the unified branch creation command
          vscode.commands.executeCommand('lakebaseSync.createUnifiedBranch');
          return;
        }

        if (pick.action === 'cut-tier') {
          vscode.commands.executeCommand('lakebaseSync.cutLongRunningBranch');
          return;
        }

        if (pick.action === 'create-from') {
          // Pick a base branch first
          const basePick = await vscode.window.showQuickPick(
            gitBranches.map(gb => ({
              label: gb.name,
              description: gb.name === currentBranch ? '(current)' : undefined,
            })),
            { placeHolder: 'Select base branch' }
          );
          if (!basePick) { return; }

          const branchName = await vscode.window.showInputBox({
            prompt: `New branch name (from ${basePick.label})`,
            placeHolder: 'feature/my-feature',
          });
          if (!branchName) { return; }

          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Creating ${branchName} from ${basePick.label}...` },
            async (progress) => {
              // Checkout the chosen base first so HEAD reflects the right point.
              progress.report({ message: 'Checking out base...' });
              await gitService.checkoutBranch(basePick.label);
              // Pre-create the Lakebase branch with the explicit base. Without
              // this, the new branch's Lakebase fork source depends on the
              // freshness of .git/hooks/post-checkout AND on whether the
              // onBranchChanged listener races with the hook – neither of
              // which is reliable across machines. Doing it here makes the
              // user's choice authoritative; the post-checkout hook will see
              // the existing Lakebase branch and just connect.
              progress.report({ message: `Pre-creating Lakebase branch from ${basePick.label}...` });
              try {
                await lakebaseService.createBranch(branchName, basePick.label);
              } catch (err: any) {
                if (!await handleAuthError(lakebaseService, err)) {
                  vscode.window.showWarningMessage(
                    `Lakebase pre-create failed: ${err.message}. The post-checkout hook may create the branch from a fallback source.`
                  );
                }
              }
              progress.report({ message: 'Creating git branch...' });
              await gitService.checkoutBranch(branchName, true);
            }
          );
          return;
        }

        if (pick.action === 'detach') {
          const ref = await vscode.window.showInputBox({
            prompt: 'Commit SHA, tag, or ref to detach at',
            placeHolder: 'HEAD~1, v1.0, abc1234',
          });
          if (!ref) { return; }
          const root = getWorkspaceRoot();
          if (root) {
            await gitService.checkoutDetached(ref);
            vscode.window.showInformationMessage(`Detached HEAD at ${ref}`);
            statusBarProvider.refresh();
            branchTreeProvider.refresh();
          }
          return;
        }

        // Switch to selected branch
        if (pick.branchName && pick.branchName !== currentBranch) {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Switching to ${pick.branchName}...` },
            async (progress) => {
              if (pick.isRemote) {
                // Checkout remote branch – creates a local tracking branch
                progress.report({ message: `Checking out remote branch ${pick.branchName}...` });
                await gitService.checkoutBranch(pick.branchName!, true, 'origin/' + pick.branchName!);
              } else {
                progress.report({ message: 'Checking out...' });
                await gitService.checkoutBranch(pick.branchName!);
              }
              // The onBranchChanged listener handles .env sync and Lakebase connection
            }
          );
        }
      } catch (err: any) {
        const msg = err.message || '';
        if (msg.includes('local changes') && msg.includes('overwritten by checkout')) {
          const action = await vscode.window.showWarningMessage(
            'Cannot switch branch – you have uncommitted changes that would be overwritten.',
            'Stash & Switch', 'Commit First', 'Cancel'
          );
          if (action === 'Stash & Switch') {
            try {
              await gitService.stashIncludeUntracked('Auto-stash before branch switch');
              vscode.window.showInformationMessage('Changes stashed. Please try switching again.');
            } catch (stashErr: any) {
              vscode.window.showErrorMessage(`Failed to stash: ${stashErr.message}`);
            }
          } else if (action === 'Commit First') {
            vscode.commands.executeCommand('lakebaseSync.commit');
          }
        } else {
          vscode.window.showErrorMessage(`Branch switch failed: ${msg}`);
        }
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.showPrSchemaDiff', async () => {
      try {
        const pr = schemaScmProvider.getLastPrInfo();
        if (!pr) {
          vscode.window.showInformationMessage('No open PR for current branch.');
          return;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Fetching PR schema diff...' },
          async () => {
            const ownerRepo = await gitService.getOwnerRepo();
            const comments = ownerRepo
              ? await githubService.getPullRequestComments(ownerRepo, pr.number)
              : [];
            let schemaDiffComment = comments.find(c =>
              c.body.includes('Schema') && (c.body.includes('CREATED') || c.body.includes('MODIFIED') ||
              c.body.includes('REMOVED') || c.body.includes('No schema changes') || c.body.includes('schema diff'))
            );

            if (!schemaDiffComment) {
              // No comment – try live pg_dump against the CI branch
              const ciBranchName = `ci-pr-${pr.number}`;
              let liveDiff: any;
              try {
                liveDiff = await schemaDiffService.compareBranchSchemas(ciBranchName, true);
              } catch { /* ignore */ }

              if (liveDiff && !liveDiff.error && (liveDiff.created.length > 0 || liveDiff.modified.length > 0 || liveDiff.removed.length > 0)) {
                // Build schema diff text from live pg_dump
                const lines: string[] = [];
                for (const t of liveDiff.created) {
                  lines.push(`+ TABLE ${t.name} (CREATED)`);
                  if (t.columns) { t.columns.forEach((c: any) => lines.push(`    ${c.name} ${c.dataType}`)); }
                }
                for (const t of liveDiff.modified) {
                  lines.push(`~ TABLE ${t.name} (MODIFIED)`);
                  if (t.addedColumns) { t.addedColumns.forEach((c: any) => lines.push(`  + ${c.name} ${c.dataType}`)); }
                  if (t.removedColumns) { t.removedColumns.forEach((c: any) => lines.push(`  - ${c.name} ${c.dataType}`)); }
                }
                for (const t of liveDiff.removed) { lines.push(`- TABLE ${t.name} (REMOVED)`); }

                schemaDiffComment = { author: 'live pg_dump', body: lines.join('\n') };
              } else {
                const ciMsg = pr.ciStatus === 'pending'
                  ? `PR #${pr.number}: CI is still running. Schema diff will be available when CI completes.`
                  : `PR #${pr.number}: No schema changes detected on ci-pr-${pr.number}.`;
                vscode.window.showInformationMessage(ciMsg, 'Open PR').then(action => {
                  if (action === 'Open PR') { vscode.env.openExternal(vscode.Uri.parse(pr.url)); }
                });
                return;
              }
            }

            const panel = vscode.window.createWebviewPanel(
              'prSchemaDiff',
              `PR #${pr.number} Schema Diff`,
              vscode.ViewColumn.Active,
              { enableScripts: false }
            );

            const ciBranch = `ci-pr-${pr.number}`;
            panel.webview.html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  h1 { font-size: 1.3em; margin: 0 0 4px; }
  .meta { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.85em; font-weight: 600; }
  .status.success { background: rgba(76,175,80,0.15); color: #4caf50; }
  .status.failure { background: rgba(244,67,54,0.15); color: #f44336; }
  .status.pending { background: rgba(255,152,0,0.15); color: #ff9800; }
  pre { background: var(--vscode-textBlockQuote-background); padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 0.9em; white-space: pre-wrap; }
  a { color: var(--vscode-textLink-foreground); }
</style></head><body>
  <h1>PR #${pr.number}: ${pr.title.replace(/</g, '&lt;')}</h1>
  <div class="meta">
    <span class="status ${pr.ciStatus}">${pr.ciStatus.toUpperCase()}</span>
    CI branch: <strong>${ciBranch}</strong> |
    <a href="${pr.url}">Open on GitHub</a>
  </div>
  <h2>Schema Diff from CI</h2>
  <pre>${schemaDiffComment.body.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body></html>`;
          }
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to fetch PR schema diff: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.mergePullRequest', async () => {
      try {
        const pr = schemaScmProvider.getLastPrInfo();
        if (!pr) {
          vscode.window.showInformationMessage('No open PR for current branch.');
          return;
        }

        // Pick merge method
        const method = await vscode.window.showQuickPick(
          [
            { label: '$(git-merge) Merge', description: 'Create a merge commit', value: 'merge' as const },
            { label: '$(git-commit) Squash and Merge', description: 'Squash all commits into one', value: 'squash' as const },
            { label: '$(git-branch) Rebase and Merge', description: 'Rebase commits onto base', value: 'rebase' as const },
          ],
          { placeHolder: `Merge PR #${pr.number}: ${pr.title}` }
        );
        if (!method) { return; }

        const confirm = await vscode.window.showWarningMessage(
          `${method.label.replace(/\$\([^)]+\)\s*/, '')} PR #${pr.number} into ${pr.baseBranch}? The remote branch will be deleted.`,
          { modal: true },
          'Merge'
        );
        if (confirm !== 'Merge') { return; }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Merging PR #${pr.number}...` },
          async (progress) => {
            // Refresh CI secrets before merge so the merge workflow has a fresh token
            progress.report({ message: 'Syncing CI secrets...' });
            const root = getWorkspaceRoot();
            if (root) {
              try {
                const { syncCiSecrets } = require('@databricks-solutions/lakebase-app-dev-kit');
                const cfg = getConfig();
                await syncCiSecrets({
                  projectDir: root,
                  databricksHost: cfg.databricksHost,
                  lakebaseProjectId: cfg.lakebaseProjectId,
                  comment: 'CI merge',
                  lifetimeSeconds: 3600,
                });
              } catch { /* non-fatal */ }
            }

            progress.report({ message: 'Merging...' });
            const ownerRepo = await gitService.getOwnerRepo();
            if (!ownerRepo) {
              throw new Error('Could not determine GitHub repository');
            }
            await githubService.mergePullRequest(ownerRepo, pr.number, method.value, true);

            progress.report({ message: `Switching to ${pr.baseBranch}...` });
            await gitService.checkoutBranch(pr.baseBranch);

            progress.report({ message: 'Pulling latest...' });
            await gitService.pull();
          }
        );

        schemaDiffService.clearCache();

        const msg = `PR #${pr.number} merged into ${pr.baseBranch}. CI will apply migrations to the ${pr.baseBranch} Lakebase branch and clean up the CI branches.`;
        const action = await vscode.window.showInformationMessage(msg, 'Open PR');
        if (action === 'Open PR') {
          vscode.env.openExternal(vscode.Uri.parse(pr.url));
        }

        statusBarProvider.refresh();
        branchTreeProvider.refresh();
        schemaScmProvider.refresh();

        // Poll for Lakebase branch cleanup by CI workflow
        const ciBranch = `ci-pr-${pr.number}`;
        const featureBranch = lakebaseService.sanitizeBranchName(pr.headBranch);
        let pollCount = 0;
        const maxPolls = 8; // ~2 minutes at 15s intervals
        const pollTimer = setInterval(async () => {
          pollCount++;
          try {
            const branches = await lakebaseService.listBranches();
            const branchIds = new Set(branches.map(b => b.branchId));
            const ciGone = !branchIds.has(ciBranch);
            const featureGone = !branchIds.has(featureBranch);
            if (ciGone && featureGone) {
              clearInterval(pollTimer);
              branchTreeProvider.refresh();
            } else if (pollCount >= maxPolls) {
              clearInterval(pollTimer);
              branchTreeProvider.refresh(); // Final refresh with whatever state exists
            } else if (ciGone || featureGone) {
              branchTreeProvider.refresh(); // Partial cleanup, update the tree
            }
          } catch {
            // Lakebase API error – skip this poll
            if (pollCount >= maxPolls) { clearInterval(pollTimer); }
          }
        }, 15_000);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Merge failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.refreshPrStatus', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Refreshing PR status...' },
          async () => {
            const ownerRepo = await gitService.getOwnerRepo();
            const branch = await gitService.getCurrentBranch();
            const pr = ownerRepo && branch
              ? await githubService.getPullRequest(ownerRepo, branch)
              : undefined;
            if (pr) {
              vscode.window.showInformationMessage(
                `PR #${pr.number}: ${pr.ciStatus === 'success' ? 'CI passed' : pr.ciStatus === 'failure' ? 'CI failed' : 'CI running...'}`
              );
            } else {
              vscode.window.showInformationMessage('No open PR for current branch.');
            }
          }
        );
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to refresh PR status: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.healthCheck', async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }

      const fs = require('fs');
      const path = require('path');

      const results: { label: string; ok: boolean; detail: string }[] = [];

      // 1. Check CI workflows
      const prYml = path.join(root, '.github/workflows/pr.yml');
      const mergeYml = path.join(root, '.github/workflows/merge.yml');
      results.push({
        label: 'PR workflow (pr.yml)',
        ok: fs.existsSync(prYml),
        detail: fs.existsSync(prYml) ? 'Found' : 'Missing – CI will not create Lakebase branches on PR',
      });
      results.push({
        label: 'Merge workflow (merge.yml)',
        ok: fs.existsSync(mergeYml),
        detail: fs.existsSync(mergeYml) ? 'Found' : 'Missing – production migrations and branch cleanup will not run on merge',
      });

      // 2. Check .env
      const envPath = path.join(root, '.env');
      const envExists = fs.existsSync(envPath);
      const envConfig = envExists ? require('fs').readFileSync(envPath, 'utf-8') : '';
      results.push({
        label: 'LAKEBASE_PROJECT_ID in .env',
        ok: envConfig.includes('LAKEBASE_PROJECT_ID=') && !envConfig.includes('LAKEBASE_PROJECT_ID=\n'),
        detail: envConfig.includes('LAKEBASE_PROJECT_ID=') ? 'Set' : 'Missing – extension cannot connect to Lakebase',
      });
      results.push({
        label: 'DATABRICKS_HOST in .env',
        ok: envConfig.includes('DATABRICKS_HOST=') && !envConfig.includes('DATABRICKS_HOST=\n'),
        detail: envConfig.includes('DATABRICKS_HOST=') ? 'Set' : 'Missing – extension cannot connect to workspace',
      });

      // 3. Check Databricks CLI
      const commandExists = require('command-exists');
      let cliOk = false;
      try {
        cliOk = await commandExists('databricks');
      } catch { /* ignore */ }
      results.push({
        label: 'Databricks CLI',
        ok: cliOk,
        detail: cliOk ? 'Installed' : 'Not found – install and run "databricks auth login"',
      });

      // 4. Check CLI auth
      let authOk = false;
      if (cliOk) {
        try {
          const authStatus = await lakebaseService.checkAuth();
          authOk = authStatus.authenticated;
        } catch { /* ignore */ }
      }
      results.push({
        label: 'Databricks auth',
        ok: authOk,
        detail: authOk ? 'Authenticated' : 'Not authenticated – run "databricks auth login"',
      });

      // 5. Check GitHub authentication
      let ghOk = false;
      let ghUser = '';
      try {
        githubService.resetAuth();
        ghUser = await githubService.getCurrentUser();
        ghOk = true;
      } catch { /* ignore */ }
      results.push({
        label: 'GitHub authentication',
        ok: ghOk,
        detail: ghOk
          ? `Signed in as ${ghUser}`
          : 'Not signed in – use VS Code GitHub sign-in or set lakebaseSync.githubToken',
      });

      // 6. Check GitHub secrets (requires auth + repo access)
      let secretsChecked = false;
      const missingSecrets: string[] = [];
      if (ghOk) {
        try {
          const ownerRepo = await gitService.getOwnerRepo(root);
          if (ownerRepo) {
            secretsChecked = true;
            const names = await githubService.listSecretNames(ownerRepo);
            for (const name of ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'LAKEBASE_PROJECT_ID']) {
              if (!names.includes(name)) {
                missingSecrets.push(name);
              }
            }
          }
        } catch { /* no repo access */ }
      }
      if (secretsChecked) {
        results.push({
          label: 'GitHub repo secrets',
          ok: missingSecrets.length === 0,
          detail: missingSecrets.length === 0
            ? 'DATABRICKS_HOST, DATABRICKS_TOKEN, LAKEBASE_PROJECT_ID all set'
            : `Missing: ${missingSecrets.join(', ')} – CI workflows will fail`,
        });
      }

      // 7. Check migration directory
      const config = getConfig();
      const migDir = path.join(root, config.migrationPath);
      results.push({
        label: 'Migration directory',
        ok: fs.existsSync(migDir),
        detail: fs.existsSync(migDir) ? `Found: ${config.migrationPath}` : `Missing: ${config.migrationPath}`,
      });

      // 8. Check git hooks
      const hookPath = path.join(root, '.git/hooks/post-checkout');
      results.push({
        label: 'Post-checkout hook',
        ok: fs.existsSync(hookPath),
        detail: fs.existsSync(hookPath) ? 'Installed' : 'Missing – re-open project or run scaffold hook install',
      });

      // Display results
      const passed = results.filter(r => r.ok).length;
      const total = results.length;
      const allOk = passed === total;

      const lines = results.map(r =>
        `${r.ok ? '✅' : '❌'} **${r.label}** – ${r.detail}`
      );

      const panel = vscode.window.createWebviewPanel(
        'lakebaseHealthCheck',
        'Lakebase Health Check',
        vscode.ViewColumn.Active,
        { enableScripts: false }
      );

      const statusColor = allOk ? '#4caf50' : '#ff9800';
      const statusText = allOk ? 'All checks passed' : `${passed}/${total} checks passed`;

      panel.webview.html = `<!DOCTYPE html>
<html><head><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .status { color: ${statusColor}; font-weight: 600; margin-bottom: 16px; }
  .item { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .ok { color: var(--vscode-testing-iconPassed, #4caf50); }
  .fail { color: var(--vscode-errorForeground, #f44336); }
  .label { font-weight: 600; }
  .detail { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
</style></head><body>
  <h1>Lakebase Health Check</h1>
  <div class="status">${statusText}</div>
  ${results.map(r => `
    <div class="item">
      <span class="${r.ok ? 'ok' : 'fail'}">${r.ok ? '✅' : '❌'}</span>
      <span class="label">${r.label}</span>
      <div class="detail">${r.detail}</div>
    </div>
  `).join('')}
</body></html>`;
    }),

    vscode.commands.registerCommand('lakebaseSync.createPullRequest', async () => {
      try {
        const currentBranch = await gitService.getCurrentBranch();
        if (!currentBranch || isMainBranch(currentBranch, getConfig().trunkBranch)) {
          vscode.window.showWarningMessage('Cannot create a PR from main/master.');
          return;
        }

        // ── Pre-PR checks: uncommitted changes → commit, then verify before continuing ──

        // Step 1: Check for uncommitted changes
        const uncommitted = (await gitService.getStagedChanges()).length + (await gitService.getUnstagedChanges()).length;
        if (uncommitted > 0) {
          const action = await vscode.window.showWarningMessage(
            `You have ${uncommitted} uncommitted change${uncommitted !== 1 ? 's' : ''}. Commit before creating a PR?`,
            'Commit & Continue', 'Cancel'
          );
          if (action !== 'Commit & Continue') {
            vscode.window.showInformationMessage('PR creation cancelled.');
            return;
          }
          await vscode.commands.executeCommand('lakebaseSync.commit');

          // Verify the commit actually succeeded before continuing
          const stillUncommitted = (await gitService.getStagedChanges()).length + (await gitService.getUnstagedChanges()).length;
          if (stillUncommitted > 0) {
            vscode.window.showWarningMessage('Commit was not completed. PR creation cancelled.');
            return;
          }
        }

        // Pick PR base branch. In 3-tier projects the parent is often `staging`,
        // not `main`, and creating a PR without an explicit base silently targets the
        // repo's default branch (usually main) – so a feature branched from staging
        // ends up PR'd against main without the user noticing.
        // Candidates: trunk, staging, and other local branches; default = the
        // candidate whose merge-base with HEAD is most recent (= the nearest
        // ancestor in branch history).
        const cfgPr = getConfig();
        let prBase: string | undefined;
        try {
          const { exec: execUtil } = require('./utils/exec');
          const root = getWorkspaceRoot();
          const trunk = cfgPr.trunkBranch || 'main';
          const staging = cfgPr.stagingBranch || 'staging';
          const rawCandidates = Array.from(new Set([trunk, 'master', staging, cfgPr.baseBranch].filter(Boolean) as string[]));
          const locals = new Set((await gitService.listLocalBranches()).map(b => b.name));
          const existing = rawCandidates.filter(c => locals.has(c) && c !== currentBranch);
          const ranked: Array<{ branch: string; ts: number }> = [];
          if (root) {
            for (const c of existing) {
              try {
                // Substrate-routed merge-base (replaces inline `git merge-base` exec).
                const base = await gitService.getMergeBaseFor(c);
                if (base) {
                  const ts = parseInt((await execUtil(`git log -1 --format=%at "${base}"`, root)).trim(), 10) || 0;
                  ranked.push({ branch: c, ts });
                }
              } catch { /* ignore */ }
            }
          }
          ranked.sort((a, b) => b.ts - a.ts);
          const defaultBase = ranked[0]?.branch || trunk;
          const items = ranked.length > 0
            ? ranked.map(r => ({
                label: r.branch,
                description: r.branch === defaultBase ? '(nearest parent – default)' : undefined,
              }))
            : [{ label: trunk, description: '(fallback)' }];
          const pick = await vscode.window.showQuickPick(items, {
            placeHolder: `Base branch for PR (where ${currentBranch} will be merged)`,
          });
          if (!pick) {
            vscode.window.showInformationMessage('PR creation cancelled.');
            return;
          }
          prBase = pick.label;
        } catch {
          prBase = cfgPr.trunkBranch || 'main';
        }

        // Step 2: Check if branch has any commits vs the selected base
        try {
          const root = getWorkspaceRoot();
          if (root) {
            const { exec: execUtil } = require('./utils/exec');
            const count = (await execUtil(`git rev-list --count ${prBase}..HEAD`, root)).trim();
            if (parseInt(count, 10) === 0) {
              vscode.window.showWarningMessage(`No commits between ${prBase} and this branch. Nothing to create a PR for.`);
              return;
            }
          }
        } catch { /* ignore – branch may not have diverged from base yet */ }

        // Step 3: Push + create PR via GitHubService (pushCurrentBranchForPr below).
        // Just inform the user if the branch hasn't been pushed yet.
        const hasUpstream = await gitService.hasUpstream();
        if (!hasUpstream) {
          vscode.window.showInformationMessage(`Branch "${currentBranch}" will be pushed to GitHub as part of PR creation.`);
        }

        // Pre-flight: sync CI secrets in the background (non-blocking – never prevents PR creation)
        const root = getWorkspaceRoot();
        if (root) {
          try {
            const { syncCiSecrets } = require('@databricks-solutions/lakebase-app-dev-kit');
            const cfg = getConfig();
            await syncCiSecrets({
              projectDir: root,
              databricksHost: cfg.databricksHost,
              lakebaseProjectId: cfg.lakebaseProjectId,
              comment: 'GitHub Actions CI',
              lifetimeSeconds: 86400,
            });
          } catch {
            // Non-fatal – CI may still work with existing secrets
          }
        }

        const title = await vscode.window.showInputBox({
          prompt: 'Pull request title',
          value: currentBranch.replace(/[-_/]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        });
        if (!title) { return; }

        const body = await vscode.window.showInputBox({
          prompt: 'Pull request description (optional)',
          placeHolder: 'Describe your changes...',
        });

        // Find the Lakebase branch name for context
        let lakebaseBranchId: string | undefined;
        try {
          const lb = await lakebaseService.getBranchByName(currentBranch);
          lakebaseBranchId = lb?.branchId;
        } catch { /* ignore */ }

        // Build PR body with Lakebase context
        const prBody = [
          body || '',
          '',
          '---',
          `**Lakebase branch:** ${lakebaseBranchId || 'none'}`,
          `> CI will automatically create a \`ci-pr-<N>\` Lakebase branch for testing.`,
        ].join('\n');

        // Step 3: Push branch, then create PR via GitHub API
        const prUrl = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Creating pull request → ${prBase}...` },
          async (progress) => {
            progress.report({ message: 'Pushing branch...' });
            await gitService.pushCurrentBranchForPr();
            const ownerRepo = await gitService.getOwnerRepo();
            if (!ownerRepo) {
              throw new Error('Could not determine GitHub repository');
            }
            progress.report({ message: 'Creating pull request...' });
            return githubService.createPullRequest(ownerRepo, currentBranch, title, prBody, prBase);
          }
        );

        // Refresh immediately so PR view appears
        statusBarProvider.refresh();
        branchTreeProvider.refresh();
        schemaScmProvider.refresh();
        await pullRequestTreeProvider.forceRefresh();

        const ciMsg = lakebaseBranchId
          ? `PR created → CI will create ci-pr-<N> Lakebase branch. Dev branch: ${lakebaseBranchId}`
          : 'PR created → CI will create ci-pr-<N> Lakebase branch.';

        const action = await vscode.window.showInformationMessage(
          ciMsg,
          'Open PR'
        );
        if (action === 'Open PR' && prUrl) {
          vscode.env.openExternal(vscode.Uri.parse(prUrl));
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Create PR failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.publishBranch', async () => {
      try {
        const currentBranch = await gitService.getCurrentBranch();
        let lakebaseBranchId: string | undefined;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Publishing ${currentBranch}...` },
          async (progress) => {
            progress.report({ message: 'Pushing to remote...' });
            await gitService.publishBranch();

            // Sync Lakebase connection if branch exists. Skip when on the
            // trunk (configured trunkBranch / main / master) – trunk has no
            // paired Lakebase branch under the conventional setup.
            if (currentBranch && !isMainBranch(currentBranch, getConfig().trunkBranch)) {
              try {
                progress.report({ message: 'Syncing Lakebase...' });
                const lb = await lakebaseService.getBranchByName(currentBranch);
                if (lb) {
                  lakebaseBranchId = lb.branchId;
                  await lakebaseService.syncConnection(lb.branchId);
                }
              } catch { /* Lakebase sync is optional */ }
            }
          }
        );

        const msg = lakebaseBranchId
          ? `Published ${currentBranch} → Lakebase: ${lakebaseBranchId}`
          : `Published ${currentBranch} (no Lakebase branch)`;
        vscode.window.showInformationMessage(msg);
        statusBarProvider.refresh();
        branchTreeProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Publish failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.sync', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Syncing...' },
          async () => {
            await gitService.sync();
            // Refresh Lakebase credentials after sync
            const currentBranch = await gitService.getCurrentBranch();
            if (currentBranch && !isMainBranch(currentBranch, getConfig().trunkBranch)) {
              try {
                const lb = await lakebaseService.getBranchByName(currentBranch);
                if (lb) { await lakebaseService.syncConnection(lb.branchId); }
              } catch { /* Lakebase sync is optional */ }
            }
          }
        );
        vscode.window.showInformationMessage('Synced successfully.');
        schemaScmProvider.refresh();
        statusBarProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Sync failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.fetch', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Fetching...' },
          () => gitService.fetch()
        );
        vscode.window.showInformationMessage('Fetched successfully.');
        branchTreeProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Fetch failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.fetchPrune', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Fetching (prune)...' },
          () => gitService.fetchPrune()
        );
        vscode.window.showInformationMessage('Fetched (pruned).');
        branchTreeProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Fetch failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.fetchAll', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Fetching from all remotes...' },
          () => gitService.fetchAll()
        );
        vscode.window.showInformationMessage('Fetched from all remotes.');
        branchTreeProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Fetch failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.pullRebase', async () => {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Pulling (rebase)...' },
          () => gitService.pullRebase()
        );
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Pulled (rebase).');
        schemaScmProvider.refresh();
        statusBarProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Pull (rebase) failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.pullFrom', async () => {
      const remotes = await gitService.listRemotes();
      if (remotes.length === 0) { vscode.window.showWarningMessage('No remotes configured.'); return; }
      const remote = remotes.length === 1 ? remotes[0] :
        (await vscode.window.showQuickPick(remotes, { placeHolder: 'Select remote' }));
      if (!remote) { return; }
      const branch = await vscode.window.showInputBox({ prompt: `Branch to pull from ${remote}`, placeHolder: getConfig().trunkBranch || 'main' });
      if (!branch) { return; }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Pulling from ${remote}/${branch}...` },
          () => gitService.pullFrom(remote, branch)
        );
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage(`Pulled from ${remote}/${branch}.`);
        schemaScmProvider.refresh();
        statusBarProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Pull failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.pushTo', async () => {
      const remotes = await gitService.listRemotes();
      if (remotes.length === 0) { vscode.window.showWarningMessage('No remotes configured.'); return; }
      const remote = remotes.length === 1 ? remotes[0] :
        (await vscode.window.showQuickPick(remotes, { placeHolder: 'Select remote' }));
      if (!remote) { return; }
      const currentBranch = await gitService.getCurrentBranch();
      const branch = await vscode.window.showInputBox({ prompt: `Branch to push to ${remote}`, value: currentBranch });
      if (!branch) { return; }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Pushing to ${remote}/${branch}...` },
          () => gitService.pushTo(remote, branch)
        );
        vscode.window.showInformationMessage(`Pushed to ${remote}/${branch}.`);
        statusBarProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Push failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.stash', async () => {
      const message = await vscode.window.showInputBox({
        prompt: 'Stash message (optional)',
        placeHolder: 'WIP: description',
      });
      // undefined = cancelled, empty string = no message (both are valid)
      if (message === undefined) { return; }
      try {
        await gitService.stash(message || undefined);
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Changes stashed.');
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Stash failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.stashPop', async () => {
      try {
        await gitService.stashPop();
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Stash popped.');
        schemaScmProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Pop stash failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.commitSignedOff', async () => {
      const scm = schemaScmProvider.getScm();
      if (!scm) { return; }
      const message = scm.inputBox.value;
      if (!message.trim()) { vscode.window.showWarningMessage('Enter a commit message.'); return; }
      try {
        await gitService.commitSignedOff(message);
        scm.inputBox.value = '';
        vscode.window.showInformationMessage('Committed (signed off).');
        schemaScmProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Commit failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.commitStagedSignedOff', async () => {
      vscode.commands.executeCommand('lakebaseSync.commitSignedOff');
    }),

    vscode.commands.registerCommand('lakebaseSync.commitAllSignedOff', async () => {
      const scm = schemaScmProvider.getScm();
      if (!scm) { return; }
      const message = scm.inputBox.value;
      if (!message.trim()) { vscode.window.showWarningMessage('Enter a commit message.'); return; }
      try {
        await gitService.commitAllSignedOff(message);
        scm.inputBox.value = '';
        vscode.window.showInformationMessage('All changes committed (signed off).');
        schemaScmProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Commit failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.viewStash', async () => {
      const stashes = await gitService.stashList();
      if (stashes.length === 0) { vscode.window.showInformationMessage('No stash entries.'); return; }
      const pick = await vscode.window.showQuickPick(
        stashes.map(s => ({ label: s })),
        { placeHolder: 'Select stash to view' }
      );
      if (!pick) { return; }
      // Extract stash index from label (e.g. "stash@{0}: ...")
      const match = pick.label.match(/stash@\{(\d+)\}/);
      const index = match ? match[1] : '0';
      const root = getWorkspaceRoot();
      if (root) {
        const terminal = vscode.window.createTerminal('Stash View');
        terminal.show();
        terminal.sendText(`git stash show -p stash@{${index}}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.createTag', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Tag name', placeHolder: 'v1.0.0' });
      if (!name) { return; }
      const message = await vscode.window.showInputBox({ prompt: 'Tag message (optional)', placeHolder: 'Release v1.0.0' });
      try {
        await gitService.createTag(name, message || undefined);
        vscode.window.showInformationMessage(`Tag "${name}" created.`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Create tag failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.deleteTag', async () => {
      const tags = await gitService.listTags();
      if (tags.length === 0) {
        vscode.window.showInformationMessage('No tags found.');
        return;
      }
      const pick = await vscode.window.showQuickPick(tags, { placeHolder: 'Select tag to delete' });
      if (!pick) { return; }
      const confirm = await vscode.window.showWarningMessage(`Delete tag "${pick}"?`, { modal: true }, 'Delete');
      if (confirm !== 'Delete') { return; }
      try {
        await gitService.deleteTag(pick);
        vscode.window.showInformationMessage(`Tag "${pick}" deleted.`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Delete tag failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.deleteRemoteTag', async () => {
      const tags = await gitService.listTags();
      if (tags.length === 0) { vscode.window.showInformationMessage('No tags found.'); return; }
      const pick = await vscode.window.showQuickPick(tags, { placeHolder: 'Select tag to delete from remote' });
      if (!pick) { return; }
      const confirm = await vscode.window.showWarningMessage(`Delete remote tag "${pick}"? This cannot be undone.`, { modal: true }, 'Delete');
      if (confirm !== 'Delete') { return; }
      try {
        await gitService.deleteRemoteTag(pick);
        vscode.window.showInformationMessage(`Remote tag "${pick}" deleted.`);
      } catch (err: any) { vscode.window.showErrorMessage(`Delete remote tag failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.stashStaged', async () => {
      const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)', placeHolder: 'WIP' });
      if (message === undefined) { return; }
      try {
        await gitService.stashStaged(message || undefined);
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Staged changes stashed.');
        schemaScmProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Stash failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.stashIncludeUntracked', async () => {
      const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)', placeHolder: 'WIP' });
      if (message === undefined) { return; }
      try {
        await gitService.stashIncludeUntracked(message || undefined);
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Changes stashed (including untracked).');
        schemaScmProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Stash failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.stashApply', async () => {
      const stashes = await gitService.stashList();
      if (stashes.length === 0) { vscode.window.showInformationMessage('No stash entries.'); return; }
      const pick = await vscode.window.showQuickPick(
        stashes.map((s, i) => ({ label: s, index: i })),
        { placeHolder: 'Select stash to apply' }
      );
      if (!pick) { return; }
      try {
        await gitService.stashApply((pick as any).index);
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Stash applied.');
        schemaScmProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Apply stash failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.stashApplyLatest', async () => {
      try {
        await gitService.stashApply(0);
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Latest stash applied.');
        schemaScmProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Apply stash failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.stashPopLatest', async () => {
      try {
        await gitService.stashPop();
        schemaDiffService.clearCache();
        vscode.window.showInformationMessage('Latest stash popped.');
        schemaScmProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Pop stash failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.stashDrop', async () => {
      const stashes = await gitService.stashList();
      if (stashes.length === 0) { vscode.window.showInformationMessage('No stash entries.'); return; }
      const pick = await vscode.window.showQuickPick(
        stashes.map((s, i) => ({ label: s, index: i })),
        { placeHolder: 'Select stash to drop' }
      );
      if (!pick) { return; }
      const confirm = await vscode.window.showWarningMessage(`Drop "${pick.label}"?`, { modal: true }, 'Drop');
      if (confirm !== 'Drop') { return; }
      try {
        await gitService.stashDrop((pick as any).index);
        vscode.window.showInformationMessage('Stash dropped.');
      } catch (err: any) { vscode.window.showErrorMessage(`Drop stash failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.stashDropAll', async () => {
      const confirm = await vscode.window.showWarningMessage('Drop ALL stashes? This cannot be undone.', { modal: true }, 'Drop All');
      if (confirm !== 'Drop All') { return; }
      try {
        await gitService.stashDropAll();
        vscode.window.showInformationMessage('All stashes dropped.');
      } catch (err: any) { vscode.window.showErrorMessage(`Drop all failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.createWorktree', async () => {
      const branchName = await vscode.window.showInputBox({
        prompt: 'New branch name for worktree',
        placeHolder: 'feature/worktree-branch',
      });
      if (!branchName) { return; }
      const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        title: 'Select parent directory for worktree',
      });
      if (!folders || folders.length === 0) { return; }
      const worktreePath = `${folders[0].fsPath}/${branchName.replace(/\//g, '-')}`;
      try {
        await gitService.createWorktree(worktreePath, branchName);
        const action = await vscode.window.showInformationMessage(
          `Worktree created at ${worktreePath}`, 'Open Folder'
        );
        if (action === 'Open Folder') {
          vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), true);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Create worktree failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.listWorktrees', async () => {
      const worktrees = await gitService.listWorktrees();
      if (worktrees.length === 0) {
        vscode.window.showInformationMessage('No worktrees found.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        worktrees.map(w => ({ label: w })),
        { placeHolder: 'Worktrees' }
      );
      if (pick) {
        const path = pick.label.split(/\s+/)[0];
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), true);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.removeWorktree', async () => {
      const worktrees = await gitService.listWorktrees();
      // First entry is the main worktree – skip it
      const removable = worktrees.slice(1);
      if (removable.length === 0) {
        vscode.window.showInformationMessage('No removable worktrees.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        removable.map(w => ({ label: w })),
        { placeHolder: 'Select worktree to remove' }
      );
      if (!pick) { return; }
      const path = pick.label.split(/\s+/)[0];
      const confirm = await vscode.window.showWarningMessage(`Remove worktree at ${path}?`, { modal: true }, 'Remove');
      if (confirm !== 'Remove') { return; }
      try {
        await gitService.removeWorktree(path);
        vscode.window.showInformationMessage(`Worktree removed.`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Remove worktree failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.abortRebase', async () => {
      try {
        await gitService.abortRebase();
        vscode.window.showInformationMessage('Rebase aborted.');
        schemaScmProvider.refresh();
        statusBarProvider.refresh();
        vscode.commands.executeCommand('setContext', 'lakebaseSync.isRebasing', false);
      } catch (err: any) { vscode.window.showErrorMessage(`Abort rebase failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.rebaseBranch', async () => {
      const branches = await gitService.listLocalBranches();
      const currentBranch = await gitService.getCurrentBranch();
      const others = branches.filter(b => b.name !== currentBranch);
      const pick = await vscode.window.showQuickPick(
        others.map(b => ({ label: b.name })),
        { placeHolder: 'Select branch to rebase onto' }
      );
      if (!pick) { return; }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Rebasing onto ${pick.label}...` },
          () => gitService.rebaseBranch(pick.label)
        );
        vscode.window.showInformationMessage(`Rebased onto ${pick.label}.`);
        schemaScmProvider.refresh();
        statusBarProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Rebase failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.createUnifiedBranchFrom', async () => {
      const branches = await gitService.listLocalBranches();
      const currentBranch = await gitService.getCurrentBranch();
      const basePick = await vscode.window.showQuickPick(
        branches.map(b => ({ label: b.name, description: b.name === currentBranch ? '(current)' : undefined })),
        { placeHolder: 'Select base branch' }
      );
      if (!basePick) { return; }
      const branchName = await vscode.window.showInputBox({
        prompt: `New branch name (from ${basePick.label})`,
        placeHolder: 'feature/my-feature',
      });
      if (!branchName) { return; }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Creating ${branchName} from ${basePick.label}...` },
          async (progress) => {
            progress.report({ message: 'Checking out base...' });
            await gitService.checkoutBranch(basePick.label);
            // Pre-create Lakebase branch with the explicit base; see the
            // matching block in the switchBranch picker for rationale.
            progress.report({ message: `Pre-creating Lakebase branch from ${basePick.label}...` });
            try {
              await lakebaseService.createBranch(branchName, basePick.label);
            } catch (err: any) {
              if (!await handleAuthError(lakebaseService, err)) {
                vscode.window.showWarningMessage(
                  `Lakebase pre-create failed: ${err.message}. The post-checkout hook may create the branch from a fallback source.`
                );
              }
            }
            progress.report({ message: 'Creating git branch...' });
            await gitService.checkoutBranch(branchName, true);
          }
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Create branch failed: ${err.message}`);
      } finally {
        // Whether the JS pre-create succeeded, failed, or the post-checkout
        // hook took over: refresh immediately + stagger a few delayed
        // refreshes so the status bar and tree pick up the branch once
        // it's queryable (covers eventual-consistency + hook-side success
        // after a JS error).
        statusBarProvider.refresh();
        branchTreeProvider.refresh();
        schemaScmProvider.refresh();
        const lateRefresh = () => {
          void statusBarProvider.refresh();
          branchTreeProvider.refresh();
        };
        setTimeout(lateRefresh, 5_000);
        setTimeout(lateRefresh, 15_000);
        setTimeout(lateRefresh, 45_000);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.deleteRemoteBranch', async () => {
      const remoteBranches = await gitService.listRemoteBranches();
      if (remoteBranches.length === 0) { vscode.window.showInformationMessage('No remote branches to delete.'); return; }
      const pick = await vscode.window.showQuickPick(
        remoteBranches.map(b => ({ label: b.name, description: b.tracking })),
        { placeHolder: 'Select remote branch to delete' }
      );
      if (!pick) { return; }
      const confirm = await vscode.window.showWarningMessage(`Delete remote branch "${pick.label}"? This cannot be undone.`, { modal: true }, 'Delete');
      if (confirm !== 'Delete') { return; }
      try {
        await gitService.deleteRemoteBranch(pick.label);
        // Also delete Lakebase branch
        try {
          const lb = await lakebaseService.getBranchByName(pick.label);
          if (lb) {
            await lakebaseService.deleteBranch(lb.branchId);
            vscode.window.showInformationMessage(`Remote branch "${pick.label}" and Lakebase branch "${lb.branchId}" deleted.`);
          } else {
            vscode.window.showInformationMessage(`Remote branch "${pick.label}" deleted.`);
          }
        } catch {
          vscode.window.showInformationMessage(`Remote branch "${pick.label}" deleted.`);
        }
        branchTreeProvider.refresh();
      } catch (err: any) { vscode.window.showErrorMessage(`Delete remote branch failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.addRemote', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Remote name', placeHolder: 'upstream' });
      if (!name) { return; }
      const url = await vscode.window.showInputBox({ prompt: 'Remote URL', placeHolder: 'https://github.com/user/repo.git' });
      if (!url) { return; }
      try {
        await gitService.addRemote(name, url);
        vscode.window.showInformationMessage(`Remote "${name}" added.`);
      } catch (err: any) { vscode.window.showErrorMessage(`Add remote failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.removeRemote', async () => {
      const remotes = await gitService.listRemotes();
      if (remotes.length === 0) { vscode.window.showInformationMessage('No remotes configured.'); return; }
      const pick = await vscode.window.showQuickPick(remotes, { placeHolder: 'Select remote to remove' });
      if (!pick) { return; }
      const confirm = await vscode.window.showWarningMessage(`Remove remote "${pick}"?`, { modal: true }, 'Remove');
      if (confirm !== 'Remove') { return; }
      try {
        await gitService.removeRemote(pick);
        vscode.window.showInformationMessage(`Remote "${pick}" removed.`);
      } catch (err: any) { vscode.window.showErrorMessage(`Remove remote failed: ${err.message}`); }
    }),

    vscode.commands.registerCommand('lakebaseSync.clone', async () => {
      const repoUrl = await vscode.window.showInputBox({
        prompt: 'Repository URL',
        placeHolder: 'https://github.com/user/repo.git',
      });
      if (!repoUrl) { return; }
      const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        title: 'Select parent directory to clone into',
      });
      if (!folders || folders.length === 0) { return; }
      const parentDir = folders[0].fsPath;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Cloning repository...' },
          async () => {
            await gitService.cloneRepo(repoUrl, parentDir);
          }
        );
        // Extract repo name from URL
        const repoName = repoUrl.replace(/\.git$/, '').split('/').pop() || 'repo';
        const clonedPath = require('path').join(parentDir, repoName);
        const action = await vscode.window.showInformationMessage(`Cloned ${repoName}`, 'Open Folder');
        if (action === 'Open Folder') {
          vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(clonedPath));
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Clone failed: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('lakebaseSync.showGitOutput', async () => {
      const root = getWorkspaceRoot();
      if (!root) { return; }
      const terminal = vscode.window.createTerminal('Git Output');
      terminal.show();
      terminal.sendText('git log --oneline --graph --decorate -30');
    }),

    // ── Deploy App (multi-step wizard) ─────────────────────────────
    vscode.commands.registerCommand('lakebaseSync.deployApp', async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      // ── Step 1: Pick existing target or create new ──────────────
      const existingConfig = DeployService.readTargets(root);
      const existingTargets = existingConfig?.targets ?? {};
      const targetNames = Object.keys(existingTargets);

      interface TargetPick extends vscode.QuickPickItem { targetName?: string; action: 'deploy' | 'edit' | 'create' }
      const pickItems: TargetPick[] = [];

      for (const name of targetNames) {
        const t = existingTargets[name];
        pickItems.push({
          label: `$(rocket) ${name}`,
          description: `${t.app_name} → ${t.workspace_profile}`,
          detail: `Lakebase: ${t.lakebase_project}/${t.lakebase_branch}  ·  Workspace: ${t.workspace_path}`,
          targetName: name,
          action: 'deploy',
        });
        pickItems.push({
          label: `$(gear) ${name} – Edit configuration`,
          description: 'Re-walk setup for this target',
          targetName: name,
          action: 'edit',
        });
      }

      if (pickItems.length > 0) {
        pickItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator, action: 'create' });
      }
      pickItems.push({
        label: '$(add) Create new deploy target',
        description: 'Set up a new deployment target',
        action: 'create',
      });

      const picked = await vscode.window.showQuickPick(pickItems, {
        title: 'Lakebase: Deploy App',
        placeHolder: targetNames.length > 0 ? 'Deploy to a target or create a new one' : 'No deploy targets yet – create one',
      });
      if (!picked) { return; }

      let targetName: string;
      let target: DeployTarget;

      if (picked.action === 'deploy' && picked.targetName) {
        // ── Direct deploy to existing target ──────────────────────
        targetName = picked.targetName;
        target = existingTargets[targetName];

        const confirm = await vscode.window.showWarningMessage(
          `Deploy to "${targetName}"?\n\nApp: ${target.app_name}\nWorkspace: ${target.workspace_profile}\nLakebase: ${target.lakebase_project}/${target.lakebase_branch}`,
          { modal: true },
          'Deploy'
        );
        if (confirm !== 'Deploy') { return; }

      } else {
        // ── Wizard: create new or edit existing ───────────────────
        const isEdit = picked.action === 'edit' && picked.targetName;
        const defaults = isEdit ? existingTargets[picked.targetName!] : undefined;
        const totalSteps = isEdit ? 8 : 9;
        const wizardTitle = isEdit ? `Lakebase: Edit Target "${picked.targetName}"` : 'Lakebase: New Deploy Target';

        // Step 2a (create only): Target name
        if (isEdit) {
          targetName = picked.targetName!;
        } else {
          const nameInput = await vscode.window.showInputBox({
            title: `${wizardTitle} (1/${totalSteps})`,
            prompt: 'Target name (e.g. prod, staging, dev)',
            placeHolder: 'prod',
            validateInput: (val) => {
              if (!val.trim()) { return 'Target name is required'; }
              if (!/^[a-zA-Z0-9_-]+$/.test(val)) { return 'Use only letters, numbers, hyphens, underscores'; }
              if (!isEdit && existingTargets[val]) { return `Target "${val}" already exists – choose Edit to modify it`; }
              return undefined;
            },
          });
          if (!nameInput) { return; }
          targetName = nameInput;
        }

        // Step 2b: Workspace profile – pick from CLI profiles
        const stepWorkspace = isEdit ? 1 : 2;
        let profileName: string | undefined;

        const profiles = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Discovering Databricks workspaces...' },
          () => lakebaseService.listProfiles()
        );

        if (profiles.length > 0) {
          interface ProfilePick extends vscode.QuickPickItem { profileName: string; action?: string }
          const profileItems: ProfilePick[] = profiles
            .filter(p => p.valid)
            .map(p => ({
              label: `$(database) ${p.name}`,
              description: `${p.host} (${p.cloud})`,
              profileName: p.name,
            }));
          profileItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator, profileName: '' });
          profileItems.push({
            label: '$(edit) Enter profile name manually...',
            profileName: '', action: 'manual',
          });

          const profilePick = await vscode.window.showQuickPick(profileItems, {
            title: `${wizardTitle} (${stepWorkspace}/${totalSteps})`,
            placeHolder: defaults?.workspace_profile
              ? `Current: ${defaults.workspace_profile}  ·  Select workspace profile`
              : 'Select the Databricks CLI profile for this target',
          });
          if (!profilePick) { return; }

          if (profilePick.action === 'manual') {
            profileName = undefined; // fall through to manual input
          } else {
            profileName = profilePick.profileName;
          }
        }

        if (!profileName) {
          const manualProfile = await vscode.window.showInputBox({
            title: `${wizardTitle} (${stepWorkspace}/${totalSteps})`,
            prompt: 'Databricks CLI profile name',
            value: defaults?.workspace_profile ?? '',
            placeHolder: 'fevm-serverless-stable-nd62dj',
            validateInput: (val) => val.trim() ? undefined : 'Profile name is required',
          });
          if (!manualProfile) { return; }
          profileName = manualProfile;
        }

        // Step 3: Workspace path
        const stepPath = isEdit ? 2 : 3;
        const currentUserEmail = await lakebaseService.getCurrentUserEmail();
        const defaultWsPath = defaults?.workspace_path
          ?? (currentUserEmail
              ? `/Workspace/Users/${currentUserEmail}/${require('path').basename(root)}`
              : `/Workspace/Users/you@company.com/${require('path').basename(root)}`);
        const wsPath = await vscode.window.showInputBox({
          title: `${wizardTitle} (${stepPath}/${totalSteps})`,
          prompt: 'Workspace path (where source files are uploaded)',
          value: defaultWsPath,
          placeHolder: '/Workspace/Users/you@company.com/my-app',
          validateInput: (val) => {
            if (!val.trim()) { return 'Workspace path is required'; }
            if (!val.startsWith('/Workspace')) { return 'Path must start with /Workspace'; }
            return undefined;
          },
        });
        if (!wsPath) { return; }

        // Step 4: App name
        const stepApp = isEdit ? 3 : 4;
        const defaultAppName = defaults?.app_name ?? require('path').basename(root);
        const appName = await vscode.window.showInputBox({
          title: `${wizardTitle} (${stepApp}/${totalSteps})`,
          prompt: 'Databricks App name',
          value: defaultAppName,
          placeHolder: 'partner-asset-tracker',
          validateInput: (val) => val.trim() ? undefined : 'App name is required',
        });
        if (!appName) { return; }

        // Step 5: Lakebase project
        const stepLbProject = isEdit ? 4 : 5;
        const defaultLbProject = defaults?.lakebase_project ?? require('path').basename(root);
        const lbProject = await vscode.window.showInputBox({
          title: `${wizardTitle} (${stepLbProject}/${totalSteps})`,
          prompt: 'Lakebase project name',
          value: defaultLbProject,
          placeHolder: 'partner-asset-tracker',
          validateInput: (val) => val.trim() ? undefined : 'Lakebase project name is required',
        });
        if (!lbProject) { return; }

        // Step 6: Lakebase branch
        // Prefer the project's actual default branch (lookup is best-effort
        // since the project may not exist yet for first-time setup); fall
        // back to `production` which is the PSA convention default.
        const stepLbBranch = isEdit ? 5 : 6;
        let projectDefaultBranchId = 'production';
        try {
          const def = await lakebaseService.getDefaultBranch();
          if (def?.branchId) { projectDefaultBranchId = def.branchId; }
        } catch { /* project may not exist yet – fall through to convention */ }
        const defaultLbBranch = defaults?.lakebase_branch ?? projectDefaultBranchId;
        const lbBranch = await vscode.window.showInputBox({
          title: `${wizardTitle} (${stepLbBranch}/${totalSteps})`,
          prompt: 'Lakebase branch for this deploy target',
          value: defaultLbBranch,
          placeHolder: projectDefaultBranchId,
          validateInput: (val) => val.trim() ? undefined : 'Branch name is required',
        });
        if (!lbBranch) { return; }

        // Step 7: UC Catalog (optional – for UC Volumes file storage)
        const stepUcCatalog = isEdit ? 6 : 7;
        const defaultUcCatalog = defaults?.uc_catalog ?? '';
        const ucCatalog = await vscode.window.showInputBox({
          title: `${wizardTitle} (${stepUcCatalog}/${totalSteps})`,
          prompt: 'UC catalog name for file storage (leave blank to skip)',
          value: defaultUcCatalog,
          placeHolder: 'partner_asset_tracker',
        });
        if (ucCatalog === undefined) { return; } // Escape pressed

        // Step 8: UC Schema (if catalog provided)
        let ucSchema = '';
        let ucVolume = '';
        if (ucCatalog) {
          const stepUcSchema = isEdit ? 7 : 8;
          const defaultUcSchema = defaults?.uc_schema ?? ucCatalog;
          const ucSchemaInput = await vscode.window.showInputBox({
            title: `${wizardTitle} (${stepUcSchema}/${totalSteps})`,
            prompt: 'UC schema name',
            value: defaultUcSchema,
            placeHolder: 'partner_asset_tracker',
            validateInput: (val) => val.trim() ? undefined : 'Schema name is required when catalog is set',
          });
          if (!ucSchemaInput) { return; }
          ucSchema = ucSchemaInput;

          // Step 9: UC Volume
          const stepUcVolume = isEdit ? 8 : 9;
          const defaultUcVolume = defaults?.uc_volume ?? 'partner_files';
          const ucVolumeInput = await vscode.window.showInputBox({
            title: `${wizardTitle} (${stepUcVolume}/${totalSteps})`,
            prompt: 'UC volume name for file uploads',
            value: defaultUcVolume,
            placeHolder: 'partner_files',
            validateInput: (val) => val.trim() ? undefined : 'Volume name is required when catalog is set',
          });
          if (!ucVolumeInput) { return; }
          ucVolume = ucVolumeInput;
        }

        // Build target and save
        target = {
          workspace_profile: profileName,
          workspace_path: wsPath,
          app_name: appName,
          lakebase_project: lbProject,
          lakebase_branch: lbBranch,
          ...(ucCatalog ? { uc_catalog: ucCatalog, uc_schema: ucSchema, uc_volume: ucVolume } : {}),
        };

        const updatedConfig: DeployTargetsConfig = {
          targets: { ...existingTargets, [targetName]: target },
        };
        DeployService.writeTargets(updatedConfig, root);

        vscode.window.showInformationMessage(`Deploy target "${targetName}" saved to deploy-targets.yaml`);

        // Ask whether to deploy now
        const deployNow = await vscode.window.showInformationMessage(
          `Target "${targetName}" configured. Deploy now?`,
          'Deploy', 'Not Now'
        );
        if (deployNow !== 'Deploy') { return; }
      }

      // ── Execute deploy ──────────────────────────────────────────
      const appName = target.app_name;
      const workspaceHost = await DeployService.resolveWorkspaceHost(target.workspace_profile);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Deploying to ${targetName}`,
          cancellable: false,
        },
        async (progress) => {
          let deployLinkShown = false;
          const result = await DeployService.deploy(
            targetName,
            root,
            (msg, phase) => {
              progress.report({ message: msg });
              // When the long-running "apps deploy" starts, show a clickable link
              if (phase === 'deploy' && !deployLinkShown) {
                deployLinkShown = true;
                if (workspaceHost) {
                  const consoleUrl = `${workspaceHost}/apps/${encodeURIComponent(appName)}`;
                  // Non-blocking – runs alongside the deploy
                  vscode.window.showInformationMessage(
                    `Deploying ${appName} – this may take a few minutes.`,
                    'View in Databricks'
                  ).then(action => {
                    if (action === 'View in Databricks') {
                      vscode.env.openExternal(vscode.Uri.parse(consoleUrl));
                    }
                  });
                }
              }
            },
          );

          // Handle catalog missing – interactive flow
          if (!result.success && result.error?.startsWith('CATALOG_MISSING:')) {
            const catalogName = result.error.split(':')[1];
            const catalogUrl = result.workspaceHost
              ? DeployService.catalogExplorerUrl(result.workspaceHost)
              : undefined;

            const action = await vscode.window.showWarningMessage(
              `UC catalog "${catalogName}" does not exist on the target workspace. ` +
              `This workspace requires manual catalog creation via the Databricks UI.\n\n` +
              `Steps:\n` +
              `1. Open Catalog Explorer\n` +
              `2. Click "+ Add" → "Create a new catalog"\n` +
              `3. Name: "${catalogName}", Storage: Default Storage\n` +
              `4. Click Create, then come back here`,
              { modal: true },
              ...(catalogUrl ? ['Open Catalog Explorer'] : []),
              'I\'ve Created It',
              'Cancel Deploy',
            );

            if (action === 'Open Catalog Explorer' && catalogUrl) {
              vscode.env.openExternal(vscode.Uri.parse(catalogUrl));
              // Wait for user to come back
              const confirm = await vscode.window.showInformationMessage(
                `Create catalog "${catalogName}" in the Catalog Explorer, then click "I've Created It" to continue.`,
                { modal: true },
                'I\'ve Created It',
                'Cancel Deploy',
              );
              if (confirm !== 'I\'ve Created It') {
                vscode.window.showInformationMessage('Deploy cancelled. You can re-run deploy when ready.');
                return;
              }
            } else if (action === 'I\'ve Created It') {
              // User says they created it – fall through to verify
            } else {
              vscode.window.showInformationMessage('Deploy cancelled. You can re-run deploy when ready.');
              return;
            }

            // Verify the catalog now exists
            progress.report({ message: `Verifying catalog "${catalogName}" exists...` });
            const exists = await DeployService.catalogExists(target.workspace_profile, catalogName);
            if (!exists) {
              vscode.window.showErrorMessage(
                `Catalog "${catalogName}" still not found. Please create it via the Databricks UI, then re-run deploy.`
              );
              return;
            }

            // Catalog confirmed – retry the full deploy
            progress.report({ message: 'Catalog confirmed. Resuming deploy...' });
            const retryResult = await DeployService.deploy(
              targetName,
              root,
              (msg, phase) => {
                progress.report({ message: msg });
                if (phase === 'deploy' && !deployLinkShown) {
                  deployLinkShown = true;
                  if (workspaceHost) {
                    const consoleUrl = `${workspaceHost}/apps/${encodeURIComponent(appName)}`;
                    vscode.window.showInformationMessage(
                      `Deploying ${appName} – this may take a few minutes.`,
                      'View in Databricks'
                    ).then(a => {
                      if (a === 'View in Databricks') {
                        vscode.env.openExternal(vscode.Uri.parse(consoleUrl));
                      }
                    });
                  }
                }
              },
            );

            if (retryResult.success) {
              if (retryResult.appUrl) {
                const a = await vscode.window.showInformationMessage(
                  `Deployed "${appName}" to ${targetName} successfully!`,
                  'Open App', 'Copy URL'
                );
                if (a === 'Open App') {
                  vscode.env.openExternal(vscode.Uri.parse(retryResult.appUrl));
                } else if (a === 'Copy URL') {
                  vscode.env.clipboard.writeText(retryResult.appUrl);
                  vscode.window.showInformationMessage('App URL copied to clipboard');
                }
              } else {
                vscode.window.showInformationMessage(`Deployed "${appName}" to ${targetName} successfully!`);
              }
            } else {
              vscode.window.showErrorMessage(`Deploy failed: ${retryResult.error}`);
            }
            return;
          }

          if (result.success) {
            if (result.appUrl) {
              const action = await vscode.window.showInformationMessage(
                `Deployed "${appName}" to ${targetName} successfully!`,
                'Open App', 'Copy URL'
              );
              if (action === 'Open App') {
                vscode.env.openExternal(vscode.Uri.parse(result.appUrl));
              } else if (action === 'Copy URL') {
                vscode.env.clipboard.writeText(result.appUrl);
                vscode.window.showInformationMessage('App URL copied to clipboard');
              }
            } else {
              vscode.window.showInformationMessage(`Deployed "${appName}" to ${targetName} successfully!`);
            }
          } else {
            vscode.window.showErrorMessage(`Deploy failed: ${result.error}`);
          }
        }
      );
    }),
  );

  // Background credential refresh (every 20 minutes)
  let credentialRefreshTimer: NodeJS.Timeout | undefined;

  function startCredentialRefresh() {
    if (credentialRefreshTimer) { clearInterval(credentialRefreshTimer); }

    const cfg = getConfig();
    if (!cfg.autoRefreshCredentials) { return; }

    const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes (token lifetime ~1h, 15 min buffer)

    credentialRefreshTimer = setInterval(async () => {
      try {
        const currentBranch = await gitService.getCurrentBranch();
        if (!currentBranch) { return; }

        const cfgTimer = getConfig();
        // Trunk → default; everything else (tier OR feature) → name-match.
        const lb = await lakebaseService.resolveBranchForGitBranch(currentBranch, cfgTimer.trunkBranch);

        if (!lb) { return; }

        await lakebaseService.syncConnection(lb.branchId);
      } catch {
        // Silently fail – don't interrupt the user
      }
    }, REFRESH_INTERVAL_MS);
  }

  startCredentialRefresh();

  // Restart credential refresh when setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('lakebaseSync.autoRefreshCredentials')) {
        if (getConfig().autoRefreshCredentials) {
          startCredentialRefresh();
        } else if (credentialRefreshTimer) {
          clearInterval(credentialRefreshTimer);
          credentialRefreshTimer = undefined;
        }
      }
    })
  );

  // Disposables
  context.subscriptions.push(
    { dispose: () => { if (credentialRefreshTimer) { clearInterval(credentialRefreshTimer); } } },
    schemaContentProvider,
    { dispose: () => gitService.dispose() },
    { dispose: () => statusBarProvider.dispose() },
    { dispose: () => branchTreeProvider.dispose() },
    { dispose: () => schemaDiffProvider.dispose() },
    { dispose: () => schemaScmProvider.dispose() }
  );

  // Initial refresh
  statusBarProvider.refresh();
}

export function deactivate() {
  // Cleanup handled by disposables
}
