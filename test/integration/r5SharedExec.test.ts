/**
 * R5 Integration Test: Shared exec Utility Parity
 *
 * Phase 1: Execute OLD code (3 separate exec wrappers)
 * Phase 2: Execute NEW code (single shared exec)
 * Compare: Results must be identical
 *
 * Run: npm run test:integration -- --grep "R5"
 */

import { strict as assert } from 'assert';
import * as cp from 'child_process';

// ── OLD code: copy of each exec wrapper ────────────────────────────

function oldExecGit(command: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd, timeout: 60000 }, (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(stdout.trim());
    });
  });
}

function oldExecLakebase(command: string, cwd?: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: cp.ExecOptions = { cwd, timeout: 30000 };
    if (env) { options.env = { ...process.env, ...env }; }
    cp.exec(command, options, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message);
        if (msg.includes('project id not found') || msg.includes('not authenticated') ||
            msg.includes('PERMISSION_DENIED') || msg.includes('401') ||
            msg.includes('invalid token') || msg.includes('no configuration')) {
          const authErr = new Error(msg);
          (authErr as any).isAuthError = true;
          reject(authErr); return;
        }
        reject(new Error(`${command}: ${msg}`)); return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function oldExecSchema(command: string, cwd?: string, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: cp.ExecOptions = { cwd, timeout: 60000 };
    if (env) { options.env = { ...process.env, ...env }; }
    cp.exec(command, options, (err, stdout, stderr) => {
      if (err) { reject(new Error(String(stderr || err.message))); return; }
      resolve(String(stdout).trim());
    });
  });
}

// ── NEW code: unified exec ─────────────────────────────────────────

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  tagAuthErrors?: boolean;
}

function newExec(command: string, opts?: ExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: cp.ExecOptions = {
      cwd: opts?.cwd,
      timeout: opts?.timeout || 60000,
    };
    if (opts?.env) { options.env = { ...process.env, ...opts.env }; }
    cp.exec(command, options, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message);
        if (opts?.tagAuthErrors) {
          if (msg.includes('project id not found') || msg.includes('not authenticated') ||
              msg.includes('PERMISSION_DENIED') || msg.includes('401') ||
              msg.includes('invalid token') || msg.includes('no configuration')) {
            const authErr = new Error(msg);
            (authErr as any).isAuthError = true;
            reject(authErr); return;
          }
        }
        reject(new Error(`${command}: ${msg}`)); return;
      }
      resolve(String(stdout).trim());
    });
  });
}

describe('R5 Shared exec Utility — Parity Test', function () {
  this.timeout(30000);
  const cwd = process.cwd();

  // ── Phase 1: OLD code ────────────────────────────────────────────

  describe('Phase 1: OLD exec wrappers', () => {
    it('gitService exec: basic command', async () => {
      const result = await oldExecGit('echo "hello-git"', cwd);
      assert.strictEqual(result, 'hello-git');
    });

    it('gitService exec: git command', async () => {
      const result = await oldExecGit('git rev-parse --short HEAD', cwd);
      assert.ok(result.length >= 7, 'Should return short SHA');
    });

    it('gitService exec: error throws', async () => {
      await assert.rejects(() => oldExecGit('false', cwd));
    });

    it('lakebaseService exec: basic command', async () => {
      const result = await oldExecLakebase('echo "hello-lb"', cwd);
      assert.strictEqual(result, 'hello-lb');
    });

    it('lakebaseService exec: env injection', async () => {
      const result = await oldExecLakebase('echo $TEST_R5_VAR', cwd, { TEST_R5_VAR: 'lb-value' });
      assert.strictEqual(result, 'lb-value');
    });

    it('lakebaseService exec: auth error tagging', async () => {
      try {
        await oldExecLakebase('echo "project id not found" >&2 && false', cwd);
        assert.fail('Should throw');
      } catch (err: any) {
        assert.ok(err.isAuthError, 'Should be tagged as auth error');
      }
    });

    it('schemaDiffService exec: basic command', async () => {
      const result = await oldExecSchema('echo "hello-sd"', cwd);
      assert.strictEqual(result, 'hello-sd');
    });

    it('schemaDiffService exec: env injection', async () => {
      const result = await oldExecSchema('echo $TEST_R5_SD', cwd, { TEST_R5_SD: 'sd-value' });
      assert.strictEqual(result, 'sd-value');
    });

    it('schemaDiffService exec: error includes stderr', async () => {
      try {
        await oldExecSchema('echo "bad stuff" >&2 && false', cwd);
        assert.fail('Should throw');
      } catch (err: any) {
        assert.ok(err.message.includes('bad stuff'), 'Error should contain stderr');
      }
    });
  });

  // ── Phase 2: NEW unified exec ────────────────────────────────────

  describe('Phase 2: NEW unified exec', () => {
    it('basic command (git-style)', async () => {
      const result = await newExec('echo "hello-git"', { cwd });
      assert.strictEqual(result, 'hello-git');
    });

    it('git command', async () => {
      const result = await newExec('git rev-parse --short HEAD', { cwd });
      assert.ok(result.length >= 7);
    });

    it('error throws', async () => {
      await assert.rejects(() => newExec('false', { cwd }));
    });

    it('basic command (lakebase-style)', async () => {
      const result = await newExec('echo "hello-lb"', { cwd });
      assert.strictEqual(result, 'hello-lb');
    });

    it('env injection', async () => {
      const result = await newExec('echo $TEST_R5_VAR', { cwd, env: { TEST_R5_VAR: 'lb-value' } });
      assert.strictEqual(result, 'lb-value');
    });

    it('auth error tagging when enabled', async () => {
      try {
        await newExec('echo "project id not found" >&2 && false', { cwd, tagAuthErrors: true });
        assert.fail('Should throw');
      } catch (err: any) {
        assert.ok(err.isAuthError, 'Should be tagged as auth error');
      }
    });

    it('no auth tagging when disabled', async () => {
      try {
        await newExec('echo "project id not found" >&2 && false', { cwd });
        assert.fail('Should throw');
      } catch (err: any) {
        assert.ok(!err.isAuthError, 'Should NOT be tagged as auth error');
      }
    });

    it('basic command (schema-style)', async () => {
      const result = await newExec('echo "hello-sd"', { cwd });
      assert.strictEqual(result, 'hello-sd');
    });

    it('error includes stderr', async () => {
      try {
        await newExec('echo "bad stuff" >&2 && false', { cwd });
        assert.fail('Should throw');
      } catch (err: any) {
        assert.ok(err.message.includes('bad stuff'));
      }
    });

    it('custom timeout', async () => {
      const result = await newExec('echo "fast"', { cwd, timeout: 5000 });
      assert.strictEqual(result, 'fast');
    });
  });

  // ── Phase 3: Parity Comparison ───────────────────────────────────

  describe('Phase 3: Parity Comparison', () => {
    it('same output for git commands', async () => {
      const old = await oldExecGit('git rev-parse HEAD', cwd);
      const nw = await newExec('git rev-parse HEAD', { cwd });
      assert.strictEqual(old, nw);
    });

    it('same output with env injection', async () => {
      const old = await oldExecLakebase('echo $PARITY_VAR', cwd, { PARITY_VAR: 'test123' });
      const nw = await newExec('echo $PARITY_VAR', { cwd, env: { PARITY_VAR: 'test123' } });
      assert.strictEqual(old, nw);
    });

    it('same auth error tagging behavior', async () => {
      let oldErr: any, newErr: any;
      try { await oldExecLakebase('echo "not authenticated" >&2 && false', cwd); } catch (e) { oldErr = e; }
      try { await newExec('echo "not authenticated" >&2 && false', { cwd, tagAuthErrors: true }); } catch (e) { newErr = e; }
      assert.ok(oldErr.isAuthError, 'Old tags auth error');
      assert.ok(newErr.isAuthError, 'New tags auth error');
    });

    it('same stderr in error message', async () => {
      let oldErr: any, newErr: any;
      try { await oldExecSchema('echo "stderr-content" >&2 && false', cwd); } catch (e) { oldErr = e; }
      try { await newExec('echo "stderr-content" >&2 && false', { cwd }); } catch (e) { newErr = e; }
      assert.ok(oldErr.message.includes('stderr-content'));
      assert.ok(newErr.message.includes('stderr-content'));
    });
  });
});
