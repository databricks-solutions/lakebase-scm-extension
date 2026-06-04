// Shared text helpers. Single source of truth for input sanitization
// used across the project-creation prompts and every workspace-URL
// input box. Previously these were inlined (and drifted) in
// projectCreationService.ts, extension.ts createProject, and
// extension.ts connectWorkspace.

/**
 * Strip leading/trailing whitespace AND common invisible characters
 * that sneak in when a URL is pasted from Slack, email, a Google Doc,
 * or a chat client: NBSP (U+00A0), zero-width space (U+200B),
 * zero-width non-joiner (U+200C), and BOM (U+FEFF). A raw
 * `value.startsWith('https://')` check fails on these because the
 * invisible prefix sorts before the visible text, leaving the user
 * staring at a URL that "looks right" but is rejected.
 */
export function stripInvisibles(value: string): string {
  return value.replace(/^[\s ​‌﻿]+|[\s ​‌﻿]+$/g, "");
}

/**
 * Validate a Databricks workspace URL entered in an input box. Returns
 * an error string when invalid, or undefined when acceptable (including
 * the empty case, so the error does not flash while the user is still
 * typing the first character). Tolerates invisible-prefixed paste via
 * stripInvisibles.
 */
export function validateDatabricksHostInput(value: string): string | undefined {
  const v = stripInvisibles(value);
  if (!v) { return undefined; }
  if (!/^https:\/\//i.test(v)) { return "URL must start with https://"; }
  return undefined;
}
