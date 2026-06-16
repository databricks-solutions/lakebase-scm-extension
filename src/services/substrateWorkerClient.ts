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

export class SubstrateWorkerClient {
  private worker: Worker | undefined;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (this.worker) { return this.worker; }
    // substrateWorker.js is emitted next to this bundle (dist/) by webpack.
    const w = new Worker(path.join(__dirname, 'substrateWorker.js'));
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
    w.on('error', failAll);
    w.on('exit', (code) => {
      if (code !== 0) { failAll(new Error(`substrate worker exited with code ${code}`)); }
      else { this.worker = undefined; }
    });
    this.worker = w;
    return w;
  }

  /**
   * Run a kit substrate function (by its exported name) in the worker thread.
   * `env` is applied to the worker's process.env around the call (host/profile
   * for the databricks CLI); undefined values are deleted in the worker.
   */
  call<T>(fn: string, args: unknown[], env: Record<string, string | undefined>): Promise<T> {
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, fn, args, env });
    });
  }

  dispose(): void {
    if (this.worker) { void this.worker.terminate(); this.worker = undefined; }
    for (const p of this.pending.values()) { p.reject(new Error('substrate worker disposed')); }
    this.pending.clear();
  }
}
