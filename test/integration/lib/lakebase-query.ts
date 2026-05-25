/**
 * Shared Lakebase production-database query primitives.
 *
 * `queryProduction` connects to the default ("production") branch of a
 * Lakebase project via substrate's getConnection() and returns rows
 * formatted to match psql's `-t -A` output – so existing callers that
 * compare against literal 't' / 'f' / number strings keep working
 * without changes.
 */

import { getConnection, getDefaultBranch } from '@databricks-solutions/lakebase-app-dev-kit';

export function formatPsqlCompatRows(rows: Array<Record<string, unknown>>, fields: Array<{ name: string }>): string {
  return rows
    .map((row) =>
      fields
        .map((f) => {
          const v = row[f.name];
          if (v === null || v === undefined) return '';
          if (v === true) return 't';
          if (v === false) return 'f';
          return String(v);
        })
        .join('|'),
    )
    .join('\n')
    .trim();
}

/**
 * Run a SQL query against a named Lakebase branch via substrate's pg.Pool.
 * The branchName 'default' (or '__default__') resolves to the project's
 * default (prod) branch dynamically; otherwise the branch is passed
 * through to getConnection as-is.
 *
 * The two-tier integration flow uses this to query 'staging' after a
 * scenario merge, and to query the resolved-default after a Step E
 * staging → main promotion.
 */
export async function queryBranch(projectName: string, branchName: string, sql: string): Promise<string> {
  let resolved = branchName;
  if (branchName === 'default' || branchName === '__default__') {
    const def = await getDefaultBranch({ instance: projectName });
    if (!def) { throw new Error('No default Lakebase branch found'); }
    // getDefaultBranch.uid is the system ID (br-foo-xxx); getConnection's
    // `branch` arg is the human-readable branch name (the path tail of
    // .name, e.g. "production"). Passing uid causes "branch id not found".
    resolved = def.name.split('/').pop()!;
  }
  const pool = await getConnection({ instance: projectName, branch: resolved, output: 'pool' });
  try {
    const result = await pool.query(sql);
    return formatPsqlCompatRows(result.rows, result.fields as Array<{ name: string }>);
  } finally {
    await pool.end();
  }
}

/**
 * Back-compat wrapper: query the default (prod) branch. New callers
 * should prefer `queryBranch` and name their target explicitly.
 */
export async function queryProduction(projectName: string, sql: string): Promise<string> {
  return queryBranch(projectName, 'default', sql);
}
