import * as cp from 'child_process';

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  tagAuthErrors?: boolean;
}

/**
 * Shared async exec wrapper. Replaces the 3 module-level exec functions
 * in gitService, lakebaseService, and schemaDiffService.
 */
export function exec(command: string, opts?: ExecOptions): Promise<string>;
export function exec(command: string, cwd?: string, env?: Record<string, string>): Promise<string>;
export function exec(command: string, cwdOrOpts?: string | ExecOptions, env?: Record<string, string>): Promise<string> {
  const opts: ExecOptions = typeof cwdOrOpts === 'string'
    ? { cwd: cwdOrOpts, env }
    : cwdOrOpts || {};

  return new Promise((resolve, reject) => {
    const options: cp.ExecOptions = {
      cwd: opts.cwd,
      timeout: opts.timeout || 60000,
    };
    if (opts.env) {
      options.env = { ...process.env, ...opts.env };
    }
    cp.exec(command, options, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message);
        if (opts.tagAuthErrors) {
          if (msg.includes('project id not found') || msg.includes('not authenticated') ||
              msg.includes('PERMISSION_DENIED') || msg.includes('401') ||
              msg.includes('invalid token') || msg.includes('no configuration') ||
              msg.includes('cannot configure default credentials')) {
            const authErr = new Error(msg);
            (authErr as any).isAuthError = true;
            reject(authErr);
            return;
          }
        }
        reject(new Error(`${command}: ${msg}`));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}
