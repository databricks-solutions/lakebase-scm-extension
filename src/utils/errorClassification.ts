// One place to turn a git/substrate error into a coarse, UI-routable category.
// Auth detection reuses the canonical AUTH_ERROR_SIGNATURES (databricksAuth.ts)
// so the ad-hoc `err.message.includes('401')` checks that had drifted across
// extension.ts + statusBarProvider.ts converge here. The push-outcome codes
// (in-sync / rejected) are what lets the SCM panel stop reporting
// "Sync failed: failed to push some refs" when the branch was actually in sync.

import { isTaggableAuthError } from './databricksAuth';

export type GitErrorCode =
  | 'auth'       // stale/absent Databricks auth , route to sign-in
  | 'in-sync'    // "Everything up-to-date" , NOT a failure
  | 'rejected'   // real non-fast-forward / refs rejected
  | 'network'    // host unreachable / connection refused / timeout
  | 'conflict'   // merge conflict
  | 'unknown';

export interface ClassifiedGitError {
  code: GitErrorCode;
  message: string;
}

/**
 * Classify a thrown error (or any value) from a git/substrate op. The raw
 * message is preserved for display; `code` lets callers choose distinct UI
 * (sign-in prompt vs "already up to date" vs a real rejection) instead of one
 * generic "failed" toast.
 */
export function classifyGitError(err: unknown): ClassifiedGitError {
  const message = err instanceof Error ? err.message : String(err ?? '');
  // Auth: match against the original (some signatures are case-sensitive).
  if (isTaggableAuthError(message)) {
    return { code: 'auth', message };
  }
  const m = message.toLowerCase();
  if (m.includes('everything up-to-date') || m.includes('everything up to date')) {
    return { code: 'in-sync', message };
  }
  if (
    m.includes('failed to push some refs') ||
    m.includes('[rejected]') ||
    m.includes('non-fast-forward') ||
    m.includes('fetch first') ||
    m.includes('updates were rejected')
  ) {
    return { code: 'rejected', message };
  }
  if (
    m.includes('could not resolve host') ||
    m.includes('connection refused') ||
    m.includes('connection timed out') ||
    m.includes('timed out') ||
    m.includes('network is unreachable')
  ) {
    return { code: 'network', message };
  }
  if (m.includes('conflict')) {
    return { code: 'conflict', message };
  }
  return { code: 'unknown', message };
}
