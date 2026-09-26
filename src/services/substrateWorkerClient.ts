// Client side of the substrate worker. Owns a single long-lived worker thread
// and exposes call(fn, args, env) as a Promise. Used by LakebaseService to run
// the kit's synchronous-CLI substrate functions off the extension host's main
// thread so a slow `databricks` call can't freeze the UI / command dispatch.
//
// The worker is spawned lazily on first call (so unit tests that stub
// LakebaseService never start it) and respawned if it errors/exits.

import * as path from 'path';
import { Worker } from 'worker_threads';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * A failure of the WORKER itself (crash / non-zero exit / a dead-worker
 * postMessage), NOT a substrate call's own error. The single shared worker
 * serves both the branch-tree refresh's many calls AND an interactive schema-diff
 * click; when a concurrent refresh call crashes/exits the worker, `failAll`
 * rejects EVERY in-flight call as collateral — including the click. That is the
 * "schema diff works only when the tree isn't refreshing" symptom. Because a
 * lifecycle fault is transient (the next call respawns a fresh worker), `call`
 * retries it ONCE. Genuine kit errors (a real message like "… command not found")
 * are ordinary Errors and are never retried.
 */
class WorkerLifecycleError extends Error {}

/** The slice of `worker_threads.Worker` this client uses (DI seam for tests). */
export interface WorkerLike {
  postMessage(value: unknown): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'message' | 'error' | 'exit', listener: (arg: any) => void): void;
  terminate(): Promise<number> | number | void;
}

export class SubstrateWorkerClient {
  private worker: WorkerLike | undefined;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly makeWorker: () => WorkerLike;

  constructor(makeWorker?: () => WorkerLike) {
    // substrateWorker.js is emitted next to this bundle (dist/) by webpack.
    this.makeWorker =
      makeWorker ?? (() => new Worker(path.join(__dirname, 'substrateWorker.js')) as unknown as WorkerLike);
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) { return this.worker; }
    const w = this.makeWorker();
    w.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) { return; }
      this.pending.delete(msg.id);
      if (msg.ok) { p.resolve(msg.result); }
      else { p.reject(new Error(msg.error || 'substrate worker call failed')); }
    });
    const failAll = (err: Error) => {
      for (const p of this.pending.values()) { p.reject(err); }
      this.pending.clear();
      this.worker = undefined; // allow a fresh spawn on the next call
    };
    w.on('error', (err: Error) => failAll(new WorkerLifecycleError(`substrate worker error: ${err.message}`)));
    w.on('exit', (code: number) => {
      if (code !== 0) { failAll(new WorkerLifecycleError(`substrate worker exited with code ${code}`)); }
      else { this.worker = undefined; }
    });
    this.worker = w;
    return w;
  }

  /** One attempt: post to the (spawned-if-needed) worker and await its reply. */
  private dispatch<T>(fn: string, args: unknown[], env: Record<string, string | undefined>): Promise<T> {
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        worker.postMessage({ id, fn, args, env });
      } catch (e) {
        // The worker was torn down between ensureWorker() and postMessage.
        this.pending.delete(id);
        this.worker = undefined;
        reject(new WorkerLifecycleError(`substrate worker unavailable: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /**
   * Run a kit substrate function (by its exported name) in the worker thread.
   * `env` is applied to the worker's process.env around the call (host/profile
   * for the databricks CLI); undefined values are deleted in the worker.
   *
   * Retries ONCE on a {@link WorkerLifecycleError}: a concurrent call crashing the
   * shared worker must not fail an unrelated in-flight call (the refresh-vs-click
   * collateral race). A real kit error is surfaced immediately, unretried.
   */
  async call<T>(fn: string, args: unknown[], env: Record<string, string | undefined>): Promise<T> {
    try {
      return await this.dispatch<T>(fn, args, env);
    } catch (err) {
      if (err instanceof WorkerLifecycleError) {
        return await this.dispatch<T>(fn, args, env);
      }
      throw err;
    }
  }

  dispose(): void {
    if (this.worker) { void this.worker.terminate(); this.worker = undefined; }
    // Plain Error (not WorkerLifecycleError): a dispose is intentional shutdown,
    // so an in-flight call must NOT respawn a worker by retrying.
    for (const p of this.pending.values()) { p.reject(new Error('substrate worker disposed')); }
    this.pending.clear();
  }
}
