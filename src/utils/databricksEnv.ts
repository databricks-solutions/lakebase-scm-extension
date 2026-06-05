// Shared DATABRICKS_HOST (+ resolved DATABRICKS_CONFIG_PROFILE) env applied
// around a substrate CLI call. The kit's `databricks` shellouts read these
// from process.env, so we mutate them for the duration of a call and
// restore afterward, even on throw.
//
// Single source of truth for what was hand-rolled across LakebaseService
// (host + profile), SchemaMigrationService, and SchemaDiffService.
//
// Concurrency: process.env is GLOBAL, so naive save/mutate/restore races.
// If call A saves "no profile", sets host+profile, and a concurrent call B
// (or A's own finally) restores "no profile" while A's child databricks is
// still spawning, the child sees a bare host and fails with "Unable to load
// OAuth Config". To avoid that, this is REF-COUNTED: concurrent calls that
// want the SAME (host, profile) share one mutation (save on 0->1, restore
// on 1->0). A call wanting a DIFFERENT env waits until the current one
// fully unwinds, so two workspaces never interleave their env.

interface AppliedEnv {
  host: string;
  profile?: string;
}

let depth = 0;
let applied: AppliedEnv | undefined;
let savedHost: string | undefined;
let savedProfile: string | undefined;
// Resolves when depth returns to 0; conflicting callers await it.
let idle: Promise<void> = Promise.resolve();
let signalIdle: () => void = () => {};

function sameEnv(a: AppliedEnv | undefined, host: string, profile?: string): boolean {
  return !!a && a.host === host && a.profile === profile;
}

export async function withDatabricksHostEnv<T>(
  host: string | undefined,
  fn: () => Promise<T>,
  opts: { profile?: string } = {},
): Promise<T> {
  if (!host) { return fn(); }
  const profile = opts.profile;

  // A different (host, profile) is currently applied: wait for it to fully
  // unwind before we mutate, so two distinct envs never overlap.
  while (depth > 0 && !sameEnv(applied, host, profile)) {
    await idle;
  }

  if (depth === 0) {
    savedHost = process.env.DATABRICKS_HOST;
    savedProfile = process.env.DATABRICKS_CONFIG_PROFILE;
    process.env.DATABRICKS_HOST = host;
    if (profile) {
      process.env.DATABRICKS_CONFIG_PROFILE = profile;
    } else {
      // No resolved profile: clear any stale ambient profile (which may
      // point at a different workspace) rather than leaving a mismatch.
      delete process.env.DATABRICKS_CONFIG_PROFILE;
    }
    applied = { host, profile };
    idle = new Promise<void>((resolve) => { signalIdle = resolve; });
  }
  depth++;

  try {
    return await fn();
  } finally {
    depth--;
    if (depth === 0) {
      if (savedHost === undefined) { delete process.env.DATABRICKS_HOST; }
      else { process.env.DATABRICKS_HOST = savedHost; }
      if (savedProfile === undefined) { delete process.env.DATABRICKS_CONFIG_PROFILE; }
      else { process.env.DATABRICKS_CONFIG_PROFILE = savedProfile; }
      applied = undefined;
      const wake = signalIdle;
      signalIdle = () => {};
      wake();
    }
  }
}
