// Substrate worker: runs the kit's substrate functions OFF the extension
// host's main thread.
//
// The kit resolves Lakebase endpoints/credentials/branches by spawning the
// `databricks` CLI SYNCHRONOUSLY (execFileSync). Run in-process that freezes
// the extension host's event loop for the seconds the CLI takes, so a tree
// refresh blocks command dispatch ("command not found" on a click mid-refresh)
// until it finishes. Running the same calls here, in a worker thread, keeps
// the host's loop free while the CLI work happens on this thread.
//
// Requests are SERIALIZED (one at a time): each call mutates process.env for
// the target host/profile around the kit call, and the kit's CLI spawn reads
// process.env, so overlapping calls must not interleave their env.

import { parentPort } from 'worker_threads';

// The kit is externalized in webpack (commonjs require at runtime from the
// vsix-shipped node_modules), exactly as the main bundle requires it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const kit: Record<string, unknown> = require('@databricks-solutions/lakebase-app-dev-kit');

interface SubstrateRequest {
  id: number;
  fn: string;
  args: unknown[];
  env: Record<string, string | undefined>;
}

const queue: SubstrateRequest[] = [];
let running = false;

async function drain(): Promise<void> {
  if (running) { return; }
  running = true;
  try {
    while (queue.length > 0) {
      const req = queue.shift()!;
      const envKeys = Object.keys(req.env || {});
      const saved: Record<string, string | undefined> = {};
      for (const k of envKeys) {
        saved[k] = process.env[k];
        if (req.env[k] === undefined) { delete process.env[k]; }
        else { process.env[k] = req.env[k]; }
      }
      try {
        const fn = kit[req.fn];
        if (typeof fn !== 'function') {
          throw new Error(`unknown substrate function: ${req.fn}`);
        }
        const result = await (fn as (...a: unknown[]) => unknown)(...req.args);
        parentPort!.postMessage({ id: req.id, ok: true, result });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        parentPort!.postMessage({ id: req.id, ok: false, error: message });
      } finally {
        for (const k of envKeys) {
          if (saved[k] === undefined) { delete process.env[k]; }
          else { process.env[k] = saved[k]; }
        }
      }
    }
  } finally {
    running = false;
  }
}

parentPort!.on('message', (req: SubstrateRequest) => {
  queue.push(req);
  void drain();
});
