/**
 * Shared retry-aware resource cleanup primitives.
 *
 * Wraps substrate's deleteLakebaseProject / deleteRepo with explicit retry
 * + verify. These exist because ProjectCreationService.cleanupProject()
 * silently swallows delete errors via bare `try { ... } catch {}`,
 * causing tests to leak Lakebase projects + GitHub repos when the API
 * returns transient failures.
 */

import {
  deleteLakebaseProject as substrateDeleteLakebaseProject,
  deleteRepo as substrateDeleteRepo,
} from '@databricks-solutions/lakebase-app-dev-kit';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { delay } from './github';

/**
 * Save every failed GitHub Actions run's log for the given test repo
 * to /tmp/lakebase-ci-runs-<repo>-<timestamp>/ before the repo is deleted.
 *
 * Pure diagnostic side-effect: never throws (so it never blocks the
 * cleanup path it precedes). When the repo is gone or gh is missing
 * the function logs and returns. Safe to call with an empty repoName
 * (no-op).
 */
export async function saveFailedCiRunLogs(repoName: string): Promise<void> {
  if (!repoName) return;
  const outDir = path.join(
    os.tmpdir(),
    `lakebase-ci-runs-${repoName.replace(/[^a-zA-Z0-9._-]/g, '_')}-${Date.now()}`
  );
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e: any) {
    console.log(`  [ci-logs] could not create ${outDir}: ${e?.message || e}`);
    return;
  }

  let runsJson: string;
  try {
    runsJson = cp
      .execSync(
        `gh run list --repo ${repoName} --limit 50 --json databaseId,name,workflowName,headBranch,status,conclusion,displayTitle`,
        { timeout: 30_000 }
      )
      .toString();
  } catch (e: any) {
    console.log(`  [ci-logs] gh run list failed for ${repoName}: ${e?.message || e}`);
    return;
  }

  let runs: Array<{ databaseId: number; conclusion?: string; status?: string; workflowName?: string; headBranch?: string; displayTitle?: string }> = [];
  try {
    runs = JSON.parse(runsJson);
  } catch (e: any) {
    console.log(`  [ci-logs] gh run list returned unparseable JSON: ${e?.message || e}`);
    return;
  }

  const failed = runs.filter((r) => r.conclusion === 'failure' || r.status === 'failure');
  if (failed.length === 0) {
    console.log(`  [ci-logs] no failed runs to save for ${repoName}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    return;
  }

  fs.writeFileSync(path.join(outDir, '_runs.json'), JSON.stringify(runs, null, 2));
  console.log(`  [ci-logs] saving ${failed.length} failed run(s) for ${repoName} → ${outDir}`);

  for (const run of failed) {
    const file = path.join(outDir, `run-${run.databaseId}-${(run.workflowName ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')}.log`);
    try {
      const logs = cp
        .execSync(`gh run view ${run.databaseId} --repo ${repoName} --log`, { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 })
        .toString();
      fs.writeFileSync(file, logs);
    } catch (e: any) {
      const stdout = e?.stdout?.toString?.() ?? '';
      const stderr = e?.stderr?.toString?.() ?? '';
      fs.writeFileSync(file, `# gh run view exited non-zero\n# err: ${e?.message || e}\n\n# --- stdout ---\n${stdout}\n\n# --- stderr ---\n${stderr}\n`);
    }
  }
  console.log(`  [ci-logs] saved to ${outDir}`);
}

export async function lakebaseProjectStillVisible(projectName: string): Promise<boolean> {
  try {
    const raw = cp.execSync('databricks postgres list-projects -o json', { timeout: 15_000 }).toString();
    const list = JSON.parse(raw) as Array<{ name?: string }>;
    return list.some((p) => (p.name || '').endsWith(`/${projectName}`));
  } catch { return true; /* err on side of "still there" */ }
}

/** Delete a Lakebase project, verify gone, retry up to N attempts. */
export async function forceDeleteLakebaseProject(
  projectName: string,
  opts: { attempts?: number; verifyTimeoutMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 180_000;
  for (let i = 1; i <= attempts; i++) {
    try {
      await substrateDeleteLakebaseProject({ projectId: projectName });
      console.log(`  [cleanup:lakebase] delete attempt ${i} returned`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (/not.*found|no such project/i.test(msg)) {
        console.log(`  [cleanup:lakebase] already gone`);
        return true;
      }
      console.log(`  [cleanup:lakebase] delete attempt ${i} threw: ${msg.split('\n')[0]}`);
    }
    const start = Date.now();
    while (Date.now() - start < verifyTimeoutMs) {
      if (!(await lakebaseProjectStillVisible(projectName))) {
        console.log(`  [cleanup:lakebase] verified ${projectName} is gone`);
        return true;
      }
      await delay(5000);
    }
    console.log(`  [cleanup:lakebase] still visible after attempt ${i} (waited ${verifyTimeoutMs / 1000}s); retrying`);
  }
  console.log(`  [cleanup:lakebase] GAVE UP on ${projectName} after ${attempts} attempts – manual delete required`);
  return false;
}

/** Delete a GitHub repo with retry. */
export async function forceDeleteGithubRepo(
  fullRepoName: string,
  opts: { attempts?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      await substrateDeleteRepo(fullRepoName);
      console.log(`  [cleanup:github] deleted ${fullRepoName} (attempt ${i})`);
      return true;
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (/not.*found|404/i.test(msg)) {
        console.log(`  [cleanup:github] already gone`);
        return true;
      }
      console.log(`  [cleanup:github] attempt ${i} failed: ${msg.split('\n')[0]}`);
      if (i < attempts) await delay(5000);
    }
  }
  console.log(`  [cleanup:github] GAVE UP on ${fullRepoName} after ${attempts} attempts – manual delete required`);
  return false;
}
