/**
 * Shared test-lifecycle primitives.
 *
 * `installSignalHandlers` wires up SIGINT/SIGTERM/uncaughtException so
 * that ctrl-c, kill, or an unhandled throw still triggers cleanup before
 * the process exits. Mocha's after-hooks only fire on natural completion;
 * without these handlers, resources leak.
 *
 * `reapOrphanProjects` is a startup safety net that deletes Lakebase
 * projects matching a given prefix that are older than a cutoff. Catches
 * leakage from any prior runs whose cleanup failed.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const dbcli = (cmd: string, dbHost: string, timeoutMs = 30_000): string =>
  cp.execSync(cmd, { timeout: timeoutMs, env: { ...process.env, DATABRICKS_HOST: dbHost } }).toString();

let signalHandlersInstalled = false;

/**
 * Acquire an exclusive single-run lock for an integration test suite. Refuse
 * to start if another instance is already running. The lock file holds the
 * running mocha's pid; if the file is stale (pid no longer alive), the lock
 * is reclaimed.
 *
 * Required because each integration suite creates real cloud resources
 * (Lakebase project, GitHub repo, self-hosted runner) under a timestamp-
 * derived name. Parallel runs from a botched relaunch produce orphaned
 * project pairs and interleaved logs.
 *
 * @param suiteName — identifies the lock file (e.g. "ecom", "pydev").
 *                    Final lock path: $TMPDIR/lakebase-test-${suiteName}.lock
 *
 * Throws on collision; caller should let the throw propagate out of `before()`
 * so mocha fails fast instead of creating any resources.
 */
export function acquireSingleRunLock(suiteName: string): void {
  const lockPath = path.join(os.tmpdir(), `lakebase-test-${suiteName}.lock`);
  if (fs.existsSync(lockPath)) {
    const raw = fs.readFileSync(lockPath, 'utf-8').trim();
    const otherPid = parseInt(raw, 10);
    if (Number.isFinite(otherPid) && otherPid > 0) {
      // process.kill(pid, 0) throws on both ESRCH (process gone) AND EPERM
      // (process exists but we can't signal it — e.g. owned by another user).
      // Treat EPERM as alive so we don't reclaim a lock held by an unrelated
      // process that just happens to have that pid.
      let alive = false;
      try { process.kill(otherPid, 0); alive = true; }
      catch (e: any) { alive = (e?.code === 'EPERM'); }
      if (alive) {
        throw new Error(
          `Refusing to start: another ${suiteName} integration run is already in progress (pid ${otherPid}). ` +
          `Lock at ${lockPath}. Wait for it to finish, or run \`kill -9 ${otherPid}\` and \`rm ${lockPath}\` if it's stuck.`,
        );
      }
      // Stale lock — process gone.
      console.log(`  [lock] reclaiming stale ${suiteName} lock (pid ${otherPid} no longer alive)`);
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  // Release on natural exit AND when fullCleanup runs. Belt + suspenders.
  const release = () => {
    try {
      const owned = fs.existsSync(lockPath) && parseInt(fs.readFileSync(lockPath, 'utf-8'), 10) === process.pid;
      if (owned) fs.unlinkSync(lockPath);
    } catch { /* best-effort */ }
  };
  process.on('exit', release);
}

export interface CleanupOptions {
  /** Whether cleanup is already in flight (set by caller's re-entrancy guard). */
  inFlight: () => boolean;
  setInFlight: (v: boolean) => void;
  /** Runs cleanup; should be idempotent. */
  run: (reason: string) => Promise<void>;
}

export function installSignalHandlers(cleanup: CleanupOptions): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const fire = (reason: string, exitCode: number) => {
    if (cleanup.inFlight()) return;
    console.log(`\n  [signal:${reason}] cleanup starting...`);
    cleanup.run(reason).finally(() => process.exit(exitCode));
  };
  process.on('SIGINT', () => fire('SIGINT', 130));
  process.on('SIGTERM', () => fire('SIGTERM', 130));
  process.on('uncaughtException', (e) => {
    console.log(`\n  [uncaught] ${e?.message || e}\n  cleanup starting...`);
    cleanup.run('uncaught').finally(() => process.exit(1));
  });
}

/**
 * Delete Lakebase projects matching a given prefix that were created
 * more than `olderThanMs` ago. Best-effort; logs each reap/skip/fail.
 */
export async function reapOrphanProjects(
  prefix: string,
  dbHost: string,
  olderThanMs = 3_600_000,
): Promise<void> {
  const cutoff = Date.now() - olderThanMs;
  let list: Array<{ name?: string; create_time?: string }>;
  try {
    list = JSON.parse(dbcli('databricks postgres list-projects -o json', dbHost));
  } catch (e: any) {
    console.log(`  [reaper] could not list-projects: ${e?.message || e}`);
    return;
  }
  const stale = list.filter((p) => {
    const name = (p.name || '').split('/').pop() || '';
    if (!name.startsWith(prefix)) return false;
    const created = new Date(p.create_time || 0).getTime();
    return created > 0 && created < cutoff;
  });
  if (stale.length === 0) {
    console.log(`  [reaper] no stale ${prefix}* projects to reap`);
    return;
  }
  for (const p of stale) {
    const name = (p.name || '').split('/').pop()!;
    console.log(`  [reaper] deleting stale Lakebase project ${name} (created ${p.create_time})`);
    try {
      dbcli(`databricks postgres delete-project "projects/${name}"`, dbHost, 120_000);
      console.log(`  [reaper] deleted ${name}`);
    } catch (e: any) {
      console.log(`  [reaper] FAILED to delete ${name}: ${e?.message || e}`);
    }
  }
}
