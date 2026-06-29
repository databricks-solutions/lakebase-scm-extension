// Shared scaffolding for SCM command handlers , collapses the repeated
// "withProgress + try/catch + toast + refresh" shape that was copy-pasted
// across ~13 git-op handlers (commit/push/sync/pull/publish/fetch...) and the
// 40+ ad-hoc withProgress sites. The fixes for panel-truthfulness route every
// git op through here so success/failure reporting + view refresh are decided
// in ONE place and stay consistent.

import * as vscode from 'vscode';
import { classifyGitError, type GitErrorCode } from './errorClassification';

/** Run `fn` under a notification progress bar. The single home for the
 *  `vscode.window.withProgress({ location: Notification, title })` boilerplate. */
export function runWithProgress<T>(
  title: string,
  fn: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>,
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    fn,
  );
}

export interface RunScmOpOptions {
  /** When set, the op runs under a progress notification with this title. */
  progressTitle?: string;
  /** Refresh views after a successful (or in-sync) outcome. */
  onSuccess?: () => void | Promise<void>;
  /** Toast on success. Omit to stay silent. */
  successMessage?: string;
  /**
   * Map a classified error to a user message + severity. Return `undefined` to
   * suppress (e.g. treat as benign). Defaults to an error toast `"<label>
   * failed: <message>"`, except `in-sync` which is treated as success.
   */
  onError?: (code: GitErrorCode, message: string) => { text: string; severity: 'error' | 'warning' | 'info' } | undefined;
}

/**
 * Run an SCM op with consistent outcome handling: optional progress bar, a
 * single post-success refresh, classification-aware messaging, and
 * "in-sync is success, not failure" semantics. Returns the op result on
 * success, or `undefined` when it failed (after showing the message) , so the
 * panel never reports a failure that did not happen.
 */
export async function runScmOp<T>(
  label: string,
  op: () => Promise<T>,
  opts: RunScmOpOptions = {},
): Promise<T | undefined> {
  const succeed = async (result?: T): Promise<T | undefined> => {
    if (opts.onSuccess) { await opts.onSuccess(); }
    if (opts.successMessage) { void vscode.window.showInformationMessage(opts.successMessage); }
    return result;
  };
  try {
    const result = opts.progressTitle
      ? await runWithProgress(opts.progressTitle, () => op())
      : await op();
    return await succeed(result);
  } catch (err) {
    const { code, message } = classifyGitError(err);
    // "Everything up-to-date" is a successful no-op, not a push failure.
    if (code === 'in-sync') {
      return await succeed(undefined);
    }
    const mapped = opts.onError
      ? opts.onError(code, message)
      : { text: `${label} failed: ${message}`, severity: 'error' as const };
    if (mapped) {
      if (mapped.severity === 'warning') { void vscode.window.showWarningMessage(mapped.text); }
      else if (mapped.severity === 'info') { void vscode.window.showInformationMessage(mapped.text); }
      else { void vscode.window.showErrorMessage(mapped.text); }
    }
    return undefined;
  }
}
