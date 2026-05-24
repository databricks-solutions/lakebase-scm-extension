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

/** Run a SQL query on the production database via substrate pg.Pool. */
export async function queryProduction(projectName: string, sql: string): Promise<string> {
  const def = await getDefaultBranch({ instance: projectName });
  if (!def) { throw new Error('No default Lakebase branch found'); }
  // getDefaultBranch.uid is the system ID (br-foo-xxx); getConnection's
  // `branch` arg is the human-readable branch name (the path tail of
  // .name, e.g. "production"). Passing uid causes "branch id not found".
  const branchName = def.name.split('/').pop()!;
  const pool = await getConnection({ instance: projectName, branch: branchName, output: 'pool' });
  try {
    const result = await pool.query(sql);
    return formatPsqlCompatRows(result.rows, result.fields as Array<{ name: string }>);
  } finally {
    await pool.end();
  }
}
