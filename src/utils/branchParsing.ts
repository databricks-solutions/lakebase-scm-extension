// Branch-name / Lakebase-resource-path parsing , one home for logic that was
// copy-pasted across the extension (extension.ts, lakebaseService.ts). The
// short-name normalizer delegates to the kit's normalizeTierName (the single
// source of truth) but is null-safe, which is what prevents the
// "name.trim is not a function" crash when a branch records its parent only as
// a resource path with empty short-name fields.

import { normalizeTierName } from '@databricks-solutions/lakebase-app-dev-kit';

/**
 * Extract the short branch id from a Lakebase resource path
 * (`projects/<p>/branches/<id>`). Returns the input unchanged when it has no
 * `/branches/` segment, and `undefined` for empty/undefined input. Replaces the
 * scattered `value.split('/branches/').pop()` parse.
 */
export function parseBranchResourcePath(resourcePath?: string | null): string | undefined {
  if (!resourcePath) {
    return undefined;
  }
  const tail = resourcePath.split('/branches/').pop();
  return tail || undefined;
}

/**
 * Null-safe branch-name normalizer. Delegates to the kit's `normalizeTierName`
 * (trim + lowercase) when given a non-empty string, and returns `''` for
 * undefined / null / empty / non-string input instead of throwing
 * `name.trim is not a function`. Use this everywhere a branch or parent name
 * (which can be undefined when only a resource path is recorded) is normalized.
 */
export function normalizeBranchName(name?: string | null): string {
  return typeof name === 'string' && name.length > 0 ? normalizeTierName(name) : '';
}
