// Protected long-running tier classification for the extension.
//
// SOURCE OF TRUTH: the kit (@databricks-solutions/lakebase-app-dev-kit). The
// default protected name set (main/master/staging/dev), the union/normalize
// rule, and the "named AND long-running" predicate all come from the kit. The
// extension does NOT reimplement any of that; it only supplies this project's
// OVERRIDE DATA (the configured trunk/staging/base + lakebaseSync.tierNames)
// and feeds it to the kit's resolver. That is the one place a project/person
// legitimately deviates from the substrate default.

import {
  resolveProtectedTierNames,
} from '@databricks-solutions/lakebase-app-dev-kit';
import { getConfig } from './config';
import { normalizeBranchName } from './branchParsing';
import { isTierBranch, getKnownTierNames, isMainBranch } from './theme';

/**
 * This project's protected tier-name set: the kit's default UNION this project's
 * override names (configured trunkBranch/stagingBranch/baseBranch +
 * lakebaseSync.tierNames). The set computation + default come from the kit.
 */
export function projectProtectedTierNames(): Set<string> {
  const cfg = getConfig();
  return resolveProtectedTierNames(
    [cfg.trunkBranch, cfg.stagingBranch, cfg.baseBranch, ...cfg.tierNames].filter(Boolean),
  );
}

/**
 * True iff `branchName` is a PROTECTED long-running tier: its name is in the
 * project's protected set AND it is actually long-running (present in the
 * substrate-discovered cache, which the kit filters to long-running + named).
 * Before the first listBranches of a session (empty cache) fall back to the
 * name check so activation-time gates still classify the obvious tiers. An
 * off-convention long-running branch (name not in the set) is an ordinary
 * branch , the pre-tier behavior.
 */
export function isLongRunningTier(branchName: string): boolean {
  if (!branchName) { return false; }
  // The trunk (main/master, or the configured trunkBranch) pairs with the
  // Lakebase DEFAULT branch (e.g. `production`) , the production / top tier.
  // It is ALWAYS a protected tier, and is intentionally NOT in the long-running
  // tier cache (the kit's tierBranchNames excludes the default branch), so it
  // must be classified by name here, not by cache membership.
  if (isMainBranch(branchName, getConfig().trunkBranch)) { return true; }
  if (!projectProtectedTierNames().has(normalizeBranchName(branchName))) { return false; }
  return isTierBranch(branchName) || getKnownTierNames().length === 0;
}
