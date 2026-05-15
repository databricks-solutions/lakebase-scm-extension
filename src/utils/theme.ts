/**
 * Shared status icon and color mappings.
 * Used by schemaScmProvider, branchTreeProvider, pullRequestTree, changesTreeProvider.
 */

/** Maps file/schema status to VS Code codicon names */
export const STATUS_ICONS: Record<string, string> = {
  added: 'diff-added',
  modified: 'diff-modified',
  deleted: 'diff-removed',
  renamed: 'diff-renamed',
  created: 'diff-added',
  removed: 'diff-removed',
};

/** Maps file/schema status to VS Code ThemeColor identifiers */
export const STATUS_COLORS: Record<string, string> = {
  added: 'charts.green',
  modified: 'charts.yellow',
  deleted: 'charts.red',
  renamed: 'charts.blue',
  created: 'charts.green',
  removed: 'charts.red',
};

/**
 * Check if a branch name should be treated as the trunk (default) branch.
 *
 * - When `trunkAlias` is provided and non-empty, it REPLACES `main`/`master`
 *   as the trunk for this project. This is critical in monorepos: if you
 *   opted in with `LAKEBASE_TRUNK_BRANCH=user/project-demo`, you want
 *   that branch — and ONLY that branch — paired with the default Lakebase
 *   branch. The monorepo's shared `main` branch should NOT also pair with
 *   your project's default Lakebase branch.
 * - When no alias is set, falls back to the conventional `main`/`master`.
 */
export function isMainBranch(name: string, trunkAlias?: string): boolean {
  if (trunkAlias && trunkAlias.length > 0) {
    return name === trunkAlias;
  }
  return name === 'main' || name === 'master';
}

/**
 * Check if a branch name should be treated as the staging branch.
 * Returns true only if stagingAlias is set and matches. There is no
 * default (e.g. "staging"-named) fallback — staging requires opt-in.
 */
export function isStagingBranch(name: string, stagingAlias?: string): boolean {
  return !!stagingAlias && stagingAlias.length > 0 && name === stagingAlias;
}
