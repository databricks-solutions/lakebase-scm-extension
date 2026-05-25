/**
 * Integration-test assertions for the substrate's release flow.
 *
 * The core release primitives - `release({from, to, ...})` and
 * `createLongRunningBranch({name, forkFromBranch, ...})` - live in the
 * substrate (`@databricks-solutions/lakebase-app-dev-kit`). This module
 * re-exports them for convenience, plus adds two integration-test-only
 * assertion helpers that don't belong in the substrate (they shell out
 * to `databricks postgres list-branches` and `psql` for verification).
 *
 *   - `assertBackupSnapshotLifecycle`: verify the pre-migrate snapshot
 *     was created and (on green) cleaned up.
 *   - `assertSchemaContainsOnBranch`: verify migration tables landed
 *     on a specific Lakebase branch via psql.
 */

import { strict as assert } from 'assert';
import * as cp from 'child_process';
import {
  release,
  createLongRunningBranch,
  getDefaultBranch,
} from '@databricks-solutions/lakebase-app-dev-kit';
import { LakebaseService } from '../../../src/services/lakebaseService';

// Re-export substrate primitives so the test files can keep importing
// them from '../lib' (single source of integration-test primitives).
export { release, createLongRunningBranch };

const dbcli = (cmd: string, dbHost: string, timeoutMs = 30_000): string =>
  cp.execSync(cmd, { timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: dbHost } }).toString();

/**
 * Verify the pre-migrate snapshot's lifecycle for a release. The
 * merge.yml snapshot step names backups `pre-migrate-pr-N` where N
 * is the release PR's number. On a green run, the "Clean up or
 * preserve snapshot" step deletes it (we expect the snapshot absent);
 * on any other conclusion the snapshot must remain.
 */
export async function assertBackupSnapshotLifecycle(args: {
  projectName: string;
  databricksHost: string;
  prNumber: number;
  conclusion: string;
}): Promise<void> {
  const raw = dbcli(
    `databricks postgres list-branches projects/${args.projectName} -o json`,
    args.databricksHost,
  );
  const parsed = JSON.parse(raw) as unknown;
  const branches = Array.isArray(parsed)
    ? parsed as Array<{ name?: string }>
    : ((parsed as { branches?: unknown }).branches as Array<{ name?: string }>) ?? [];
  const snapshotMatch = branches.filter((b) =>
    typeof b.name === 'string' && b.name.includes(`pre-migrate-pr-${args.prNumber}`),
  );

  if (args.conclusion === 'success') {
    assert.equal(
      snapshotMatch.length,
      0,
      `Expected pre-migrate-pr-${args.prNumber} snapshot to be cleaned up after a green ` +
        `release; found ${snapshotMatch.length} matching branch(es): ` +
        `${snapshotMatch.map((b) => b.name).join(', ')}`,
    );
  } else {
    assert.ok(
      snapshotMatch.length > 0,
      `Expected pre-migrate-pr-${args.prNumber} snapshot to be PRESERVED after a ` +
        `non-success release (conclusion=${args.conclusion}); none found`,
    );
  }
}

export interface AssertSchemaContainsArgs {
  projectName: string;
  databricksHost: string;
  lakebaseService: LakebaseService;
  /** Lakebase branch to query. Pass the literal branch name (resolved
   *  via the substrate's getDefaultBranch for the prod tier, or the
   *  architect's declared name for intermediate tiers). */
  branchName: string;
  expectedTables: string[];
  unexpectedTables?: string[];
}

/**
 * Verify the `public` schema on a specific Lakebase branch contains
 * (and doesn't contain) the expected tables. Use after a release to
 * confirm migrations landed where they were supposed to.
 *
 * Connects via psql using the branch's credentials. Requires `psql`
 * on PATH.
 */
export async function assertSchemaContainsOnBranch(
  args: AssertSchemaContainsArgs,
): Promise<void> {
  const cred = await args.lakebaseService.getCredential(args.branchName);
  const c = cred as unknown as Record<string, string | number | undefined>;
  const host = String(c.host ?? c.endpoint ?? '');
  const port = String(c.port ?? '5432');
  const db = String(c.database ?? 'databricks_postgres');
  const user = String(c.username ?? c.user ?? '');
  const password = String(c.password ?? '');

  if (!host || !user || !password) {
    throw new Error(
      `Incomplete Lakebase credentials for ${args.projectName}/${args.branchName}: ` +
        `host=${!!host} user=${!!user} password=${password ? '<set>' : '<unset>'}`,
    );
  }

  const tablesRaw = cp.execSync(
    `psql "host=${host} port=${port} dbname=${db} user=${user} sslmode=require" ` +
      `-t -A -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"`,
    {
      env: { ...process.env, PGPASSWORD: password },
      timeout: 30_000,
    },
  ).toString();
  const actualTables = tablesRaw.split('\n').map((s) => s.trim()).filter(Boolean);

  for (const expected of args.expectedTables) {
    assert.ok(
      actualTables.includes(expected),
      `Expected table '${expected}' on Lakebase branch '${args.branchName}' of ` +
        `${args.projectName}; actual tables: [${actualTables.join(', ')}]`,
    );
  }
  for (const unexpected of args.unexpectedTables ?? []) {
    assert.ok(
      !actualTables.includes(unexpected),
      `Table '${unexpected}' should NOT exist on Lakebase branch '${args.branchName}' ` +
        `of ${args.projectName} (still present after a DROP migration?); ` +
        `actual tables: [${actualTables.join(', ')}]`,
    );
  }
}

/**
 * Convenience wrapper that calls the substrate's `getDefaultBranch`
 * and returns just the branch name (last path segment of the resource
 * path). Used by Step E assertions to find "the prod tier" without
 * hardcoding what the project calls it.
 */
export async function resolveDefaultBranchName(args: {
  projectName: string;
  databricksHost: string;
}): Promise<string> {
  // The substrate's getDefaultBranch routes through Databricks CLI.
  // It honors DATABRICKS_HOST from the process env; we set it for the
  // duration of this call to match args.databricksHost.
  const prevHost = process.env.DATABRICKS_HOST;
  process.env.DATABRICKS_HOST = args.databricksHost;
  try {
    const def = await getDefaultBranch({ instance: args.projectName });
    if (!def?.name) {
      throw new Error(`No default Lakebase branch for project ${args.projectName}`);
    }
    return def.name.split('/').pop()!;
  } finally {
    if (prevHost === undefined) {
      delete process.env.DATABRICKS_HOST;
    } else {
      process.env.DATABRICKS_HOST = prevHost;
    }
  }
}
