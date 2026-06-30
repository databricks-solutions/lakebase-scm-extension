import * as vscode from 'vscode';
import { getEnvConfig } from './config';

export const GITHUB_SCOPES = ['repo', 'workflow', 'delete_repo'] as const;

/**
 * GitHub authentication for Octokit.
 *
 * Primary: VS Code `authentication.getSession('github', …)` – uses whichever
 * GitHub account is signed into the editor.
 *
 * Fallback: `lakebaseSync.githubToken` setting or `GITHUB_TOKEN` env var
 * (headless tests, automation).
 */

/**
 * Optional PAT / integration-test token when VS Code GitHub sign-in is
 * unavailable, OR when the editor session is the wrong identity (e.g. a private
 * EMU repo the signed-in personal account cannot see). Resolution order:
 *   1. `lakebaseSync.githubToken` setting
 *   2. `GITHUB_TOKEN` process env (headless / automation)
 *   3. project `.env` GITHUB_TOKEN , the extension host does NOT inherit the
 *      user's shell env, so a token exported in a terminal never reaches us;
 *      a `.env` pin is how a project supplies an EMU PAT.
 */
export function getConfiguredGitHubToken(): string | undefined {
  const fromSetting = vscode.workspace.getConfiguration('lakebaseSync').get<string>('githubToken')?.trim();
  if (fromSetting) { return fromSetting; }
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) { return fromEnv; }
  try {
    const fromDotenv = getEnvConfig().GITHUB_TOKEN?.trim();
    return fromDotenv || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a GitHub token: VS Code session first, then setting/env fallback. */
export async function getGitHubToken(
  scopes: readonly string[] = GITHUB_SCOPES,
  createIfNone = false,
): Promise<string> {
  const fallback = getConfiguredGitHubToken();
  try {
    const session = await vscode.authentication.getSession(
      'github',
      [...scopes],
      { createIfNone: createIfNone && !fallback },
    );
    if (session?.accessToken) {
      return session.accessToken;
    }
  } catch {
    // Fall through to PAT when VS Code auth is unavailable (tests, headless).
  }
  if (fallback) {
    return fallback;
  }
  throw new Error('Not authenticated to GitHub. Sign in via VS Code or set lakebaseSync.githubToken.');
}

/** Prompt VS Code GitHub sign-in (or validate PAT). Returns authenticated login. */
export async function ensureGitHubAuth(): Promise<string> {
  const token = await getGitHubToken(GITHUB_SCOPES, true);
  const { Octokit } = await import('octokit');
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.rest.users.getAuthenticated();
  return data.login;
}
