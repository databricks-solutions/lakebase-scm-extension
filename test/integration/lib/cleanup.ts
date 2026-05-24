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
import { delay } from './github';

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
