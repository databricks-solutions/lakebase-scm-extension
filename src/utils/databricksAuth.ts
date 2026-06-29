// Single source of truth for classifying Databricks CLI auth-failure
// messages. Previously these matchers were hand-rolled in three places
// that had drifted: exec.ts (AUTH_ERROR_SIGNATURES, used to tag generic
// auth errors), lakebaseService.ts (isAuthStorageCacheError /
// isRefreshTokenInvalidError), and runnerService.ts (an inline regex for
// the re-auth hint). A disagreement between them means the same CLI
// error is classified differently depending on which path hit it.

/**
 * Generic auth-failure substrings used to TAG an exec error as an auth
 * error (so call sites can route to a sign-in prompt). Distinct from the
 * remediation-specific predicates below.
 */
export const AUTH_ERROR_SIGNATURES: readonly string[] = [
  "project id not found",
  "not authenticated",
  "PERMISSION_DENIED",
  "401",
  "invalid token",
  "no configuration",
  "cannot configure default credentials",
  // Any message whose remediation is `databricks auth login` is, by
  // definition, an auth error , including the create-flow auth precondition's
  // "Databricks authentication is required ... Run: databricks auth login".
  "databricks auth login",
];

/** True when `message` contains any generic auth-failure signature. */
export function isTaggableAuthError(message: string): boolean {
  return AUTH_ERROR_SIGNATURES.some((sig) => message.includes(sig));
}

/**
 * New-CLI-rejects-old-keyring-cache class: the upgraded `databricks`
 * binary refuses credentials saved by an older version. Remediation is a
 * clean re-login or DATABRICKS_AUTH_STORAGE=plaintext.
 */
export function isAuthStorageCacheError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /stored credentials from older CLI versions/i.test(msg);
}

/**
 * OAuth refresh / access token expired, invalid, or revoked. The only
 * remedy is an interactive re-auth. This is the UNION of the matchers
 * previously hand-rolled in lakebaseService (`refresh token is invalid`
 * / `access token could not be retrieved`) and runnerService (`cannot
 * get access token` / `unauthenticated`), so neither caller loses a case
 * it used to catch.
 */
export function isRefreshTokenInvalidError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /refresh token is invalid/i.test(msg) ||
    /access token could not be retrieved/i.test(msg) ||
    /cannot get access token/i.test(msg) ||
    /unauthenticated/i.test(msg);
}
