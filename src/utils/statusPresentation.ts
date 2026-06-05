// Single source of truth for status -> icon/color/label presentation,
// organized BY DOMAIN. Previously each provider hand-rolled its own
// icon/color records; the CI quad in particular was duplicated verbatim
// between pullRequestTree and schemaScmProvider and could drift.
//
// This module is intentionally vscode-free: it exports plain data plus a
// pure resolver, so it is unit-testable without the editor host. Call
// sites wrap the resolved `{icon, color}` in `vscode.ThemeIcon` /
// `vscode.ThemeColor` themselves (and the status bar uses the `$(...)`
// codicon-in-text form). Key sets differ per domain on purpose: a PR
// review decision is not the same vocabulary as a check conclusion.

export interface StatusStyle {
  /** Codicon name (or `$(name)` text form for the status bar). */
  icon: string;
  /** ThemeColor id. Omitted for domains that do not colorize (status bar). */
  color?: string;
  /** Optional human label for the domain's description text. */
  label?: string;
}

/** PR head CI status. Shared by pullRequestTree + schemaScmProvider. */
export const CI_STATUS: Record<string, StatusStyle> = {
  pending: { icon: 'loading~spin', color: 'charts.yellow', label: 'CI running...' },
  success: { icon: 'pass-filled', color: 'charts.green', label: 'CI passed' },
  failure: { icon: 'error', color: 'charts.red', label: 'CI failed' },
  unknown: { icon: 'question', color: 'foreground', label: 'CI status unknown' },
};

/** Individual check-run conclusion (GitHub check conclusions). */
export const CHECK_CONCLUSION: Record<string, StatusStyle> = {
  SUCCESS: { icon: 'pass-filled', color: 'charts.green' },
  NEUTRAL: { icon: 'pass', color: 'foreground' },
  SKIPPED: { icon: 'debug-step-over', color: 'disabledForeground' },
  FAILURE: { icon: 'error', color: 'charts.red' },
  ERROR: { icon: 'error', color: 'charts.red' },
  ACTION_REQUIRED: { icon: 'warning', color: 'charts.yellow' },
};

/** PR-level review decision (reviewDecision field). */
export const REVIEW_DECISION: Record<string, StatusStyle> = {
  APPROVED: { icon: 'pass-filled', color: 'charts.green' },
  CHANGES_REQUESTED: { icon: 'error', color: 'charts.red' },
  REVIEW_REQUIRED: { icon: 'request-changes', color: 'charts.yellow' },
};

/** Individual review state (one reviewer's verdict). */
export const REVIEW_STATE: Record<string, StatusStyle> = {
  APPROVED: { icon: 'pass-filled', color: 'charts.green', label: 'approved' },
  CHANGES_REQUESTED: { icon: 'error', color: 'charts.red', label: 'changes requested' },
  COMMENTED: { icon: 'comment', color: 'foreground', label: 'commented' },
  PENDING: { icon: 'loading~spin', color: 'charts.yellow', label: 'pending' },
  DISMISSED: { icon: 'circle-slash', color: 'disabledForeground', label: 'dismissed' },
};

/** Lakebase sync state for the status bar (icons are `$(...)` text form). */
export const SYNC_STATE: Record<string, StatusStyle> = {
  synced: { icon: '$(database)', label: 'Synced' },
  pending: { icon: '$(loading~spin)', label: 'Pending' },
  error: { icon: '$(warning)', label: 'No DB Branch' },
  loading: { icon: '$(loading~spin)', label: 'Loading...' },
  unavailable: { icon: '$(circle-slash)', label: 'N/A' },
  auth_error: { icon: '$(key)', label: 'Login Required' },
};

/**
 * GitHub workflow-run presentation. Unlike the flat maps above this is a
 * function because the icon depends on `status` (with the completed icon
 * keyed off `conclusion`) while the color is keyed off `conclusion`.
 * Preserves runnerTreeProvider's exact prior behavior.
 */
export function workflowRunStyle(status: string, conclusion: string | undefined): StatusStyle {
  const icon =
    status === 'completed'
      ? (conclusion === 'success' ? 'pass' : conclusion === 'failure' ? 'error' : 'warning')
      : status === 'in_progress' ? 'loading~spin'
      : status === 'queued' ? 'clock'
      : 'circle-outline';
  const colorByConclusion: Record<string, string> = {
    success: 'charts.green',
    failure: 'charts.red',
    cancelled: 'charts.yellow',
  };
  return { icon, color: colorByConclusion[conclusion || ''] || 'foreground' };
}

/**
 * Resolve a status key against a domain map, returning the fallback when
 * the key is missing/undefined. Pure; the caller wraps the result in a
 * vscode.ThemeIcon.
 */
export function resolveStatusStyle(
  map: Record<string, StatusStyle>,
  key: string | undefined,
  fallback: StatusStyle,
): StatusStyle {
  return (key && map[key]) || fallback;
}
