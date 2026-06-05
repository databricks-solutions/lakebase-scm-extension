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
 *   that branch – and ONLY that branch – paired with the default Lakebase
 *   branch. The monorepo's shared `main` branch should NOT also pair with
 *   your project's default Lakebase branch.
 * - When no alias is set, falls back to the conventional `main`/`master`.
 */
/**
 * Conventional long-running tier / trunk branch names, used as a
 * FALLBACK when the auto-discovered tier cache ({@link isTierBranch}) is
 * empty (e.g. before the first listBranches of a session). Single source
 * of truth: previously duplicated as `KNOWN_TIERS` in schemaDiffService
 * and `KNOWN_TIER_FALLBACK` in branchTreeProvider, which could drift if
 * one list gained a name the other lacked.
 */
export const TIER_FALLBACK_NAMES: ReadonlySet<string> = new Set([
  'main', 'master', 'staging', 'uat', 'perf',
]);

export function isMainBranch(name: string, trunkAlias?: string): boolean {
  if (trunkAlias && trunkAlias.length > 0) {
    return name === trunkAlias;
  }
  return name === 'main' || name === 'master';
}

/**
 * Module-level cache of long-running tier names (the non-default Lakebase
 * branches the architect has cut: staging / uat / perf / dev / ...).
 * LakebaseService refreshes it on every listBranches() call. The cache
 * powers {@link isTierBranch} so call sites can ask "is this a tier?"
 * synchronously, without threading a branch list through every helper.
 *
 * Empty until the first successful listBranches() of the session. Call
 * sites that need to behave correctly before any list call has happened
 * (e.g. activation-time gates) should treat an empty cache as "tier
 * status unknown" rather than "no tiers exist".
 */
const tierNamesCache: Set<string> = new Set();

/** LakebaseService entry point. Replaces the cached set in-place. */
export function setKnownTierNames(names: readonly string[]): void {
  tierNamesCache.clear();
  for (const n of names) {
    if (n) { tierNamesCache.add(n); }
  }
}

/** Sync snapshot of the current cache. Stable across the call. */
export function getKnownTierNames(): string[] {
  return Array.from(tierNamesCache);
}

/**
 * Returns true iff `name` exactly matches a long-running tier the
 * Lakebase project currently has cut. Driven by the substrate-side
 * auto-discovery model (FEIP-7098): a tier is any non-default Lakebase
 * branch. The cache is refreshed on every LakebaseService.listBranches.
 *
 * Sync because some call sites (VS Code input validators, status-bar
 * refresh) run inside synchronous contexts. Returns false when the
 * cache is empty, which matches the conservative "feature mode unless
 * we know otherwise" default the post-checkout hook also takes.
 */
export function isTierBranch(name: string): boolean {
  if (!name) { return false; }
  return tierNamesCache.has(name);
}
