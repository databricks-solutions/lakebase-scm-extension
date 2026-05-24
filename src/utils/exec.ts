// Extension exec – thin wrapper over substrate's `exec` that adds
// Databricks auth-error tagging (lakebaseService uses this to surface
// "you're not signed in" diagnostics on auth failures).
//
// Substrate's `exec` handles cwd/env/timeout + wraps errors as
// `${command}: ${msg}`. We catch its rejection, inspect the message for
// Databricks auth signatures, and tag the thrown Error so call sites
// can route to a sign-in prompt instead of a generic failure.
//
// FEIP-7089: collapses the previous duplicate exec implementation in
// the extension. The only behavior beyond substrate is the auth-tagging.

import { exec as substrateExec } from "@databricks-solutions/lakebase-app-dev-kit";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  tagAuthErrors?: boolean;
}

const AUTH_ERROR_SIGNATURES = [
  "project id not found",
  "not authenticated",
  "PERMISSION_DENIED",
  "401",
  "invalid token",
  "no configuration",
  "cannot configure default credentials",
];

export function exec(command: string, opts?: ExecOptions): Promise<string>;
export function exec(command: string, cwd?: string, env?: Record<string, string>): Promise<string>;
export async function exec(
  command: string,
  cwdOrOpts?: string | ExecOptions,
  env?: Record<string, string>
): Promise<string> {
  const opts: ExecOptions =
    typeof cwdOrOpts === "string" ? { cwd: cwdOrOpts, env } : cwdOrOpts || {};

  try {
    return await substrateExec(command, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout,
    });
  } catch (err) {
    if (opts.tagAuthErrors) {
      const msg = err instanceof Error ? err.message : String(err);
      if (AUTH_ERROR_SIGNATURES.some((sig) => msg.includes(sig))) {
        const authErr = new Error(msg);
        (authErr as Error & { isAuthError?: boolean }).isAuthError = true;
        throw authErr;
      }
    }
    throw err;
  }
}
