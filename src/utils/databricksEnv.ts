// Shared DATABRICKS_HOST (+ optional DATABRICKS_CONFIG_PROFILE) env
// save / mutate / restore around a substrate CLI call. The kit's
// `databricks` CLI shellouts read these from process.env, so callers
// mutate them for the duration of one call and restore the prior values
// (including "unset") afterward, even on throw.
//
// Single source of truth for what was hand-rolled three times:
// LakebaseService.withHost (host + resolved profile),
// SchemaMigrationService.withEffectiveHost (host only), and the inline
// block in SchemaDiffService.compareBranchSchemas (host only).

export async function withDatabricksHostEnv<T>(
  host: string | undefined,
  fn: () => Promise<T>,
  opts: { profile?: string } = {},
): Promise<T> {
  if (!host) { return fn(); }
  const priorHost = process.env.DATABRICKS_HOST;
  const priorProfile = process.env.DATABRICKS_CONFIG_PROFILE;
  process.env.DATABRICKS_HOST = host;
  if (opts.profile) { process.env.DATABRICKS_CONFIG_PROFILE = opts.profile; }
  try {
    return await fn();
  } finally {
    if (priorHost === undefined) { delete process.env.DATABRICKS_HOST; }
    else { process.env.DATABRICKS_HOST = priorHost; }
    if (priorProfile === undefined) { delete process.env.DATABRICKS_CONFIG_PROFILE; }
    else { process.env.DATABRICKS_CONFIG_PROFILE = priorProfile; }
  }
}
