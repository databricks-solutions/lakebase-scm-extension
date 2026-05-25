#!/usr/bin/env ts-node
/**
 * Launch an integration suite in the background WITH startup verification.
 *
 * Wraps `npm run test:integration -- --grep "<pattern>"`. After spawning,
 * polls the log file for known refusal / crash markers (single-run lock,
 * IntegrationSetupError, "before all" hook failure, immediate "1 failing")
 * up to the timeout. If any are found, the launched process is killed
 * and the CLI exits non-zero with the matched lines printed to stderr -
 * the operator sees the refusal instead of silently waiting on a poll
 * that will never have anything new to report.
 *
 * Why a CLI instead of a memory rule: launches are easy to fire-and-forget
 * and the failure mode (silent wait + lost cloud resources) is expensive.
 * Encoding the check in code means every operator + agent gets the same
 * safety net for free.
 *
 * Usage:
 *
 *   npx ts-node test/integration/lib/launch-cli.ts \
 *     --grep "E-Commerce" \
 *     [--log-dir /tmp/two-tier-runs] \
 *     [--timeout-seconds 20]
 *
 * Exit codes:
 *   0  launch verified - early success markers visible, no failure markers
 *   1  launch refused or crashed within the timeout window
 *   2  ambiguous - neither success nor failure markers within the timeout
 *
 * Requires: DATABRICKS_TEST_HOST + authenticated databricks/gh CLIs
 * (just like the test:integration script itself). This wrapper does not
 * re-validate auth - that's the integration suite's own pre-flight.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface Args {
  grep?: string;
  logDir: string;
  timeoutSeconds: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { logDir: '/tmp/two-tier-runs', timeoutSeconds: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--grep') { out.grep = argv[++i]; }
    else if (a === '--log-dir') { out.logDir = argv[++i]; }
    else if (a === '--timeout-seconds') { out.timeoutSeconds = parseInt(argv[++i], 10); }
  }
  return out;
}

// Slugify a grep pattern for the log filename ("E-Commerce" -> "e-commerce").
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'suite';
}

// Patterns that indicate the suite refused to start, crashed in setup,
// or reported a test failure within the verification window. Keep this
// list narrow and high-signal - false positives would block legitimate
// launches.
const FAILURE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'single-run lock', re: /Refusing to start: another .* integration run is already in progress/ },
  { name: 'before-all hook', re: /"before all" hook in /  },
  { name: 'integration setup error', re: /IntegrationSetupError/ },
  { name: 'failing tests', re: /^\s*\d+ failing\b/m },
  { name: 'uncaught error', re: /^(?:TypeError|ReferenceError|SyntaxError):/m },
  { name: 'module not found', re: /Error: Cannot find module/ },
];

// Patterns that confirm the suite has cleared its pre-flight checks and
// is actively setting up cloud resources. Seeing any of these means the
// launch succeeded (even if the suite later fails for a different reason -
// that's not this CLI's concern).
const SUCCESS_PATTERNS: RegExp[] = [
  /^\s*\[reaper\] /m,
  /^\s*Project: /m,
  /^\s*\[setup\] Creating GitHub repository/m,
];

function matchFailure(log: string): { pattern: string; line: string } | null {
  for (const p of FAILURE_PATTERNS) {
    const m = log.match(p.re);
    if (m) {
      // Find the matched line in context.
      const lineStart = log.lastIndexOf('\n', m.index ?? 0) + 1;
      const lineEnd = log.indexOf('\n', m.index ?? 0);
      const line = log.substring(lineStart, lineEnd === -1 ? log.length : lineEnd);
      return { pattern: p.name, line: line.trim() };
    }
  }
  return null;
}

function matchSuccess(log: string): boolean {
  return SUCCESS_PATTERNS.some((re) => re.test(log));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.grep) {
    console.error('usage: launch-cli.ts --grep "<pattern>" [--log-dir <dir>] [--timeout-seconds N]');
    return 1;
  }

  fs.mkdirSync(args.logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const logPath = path.join(args.logDir, `${slugify(args.grep)}-${timestamp}.log`);
  const logFd = fs.openSync(logPath, 'w');

  // Detached background launch. The wrapped command is the same as if the
  // operator had typed `npm run test:integration -- --grep "..."` themselves.
  const child = spawn(
    'npm',
    ['run', 'test:integration', '--', '--grep', args.grep],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    },
  );
  child.unref();
  fs.closeSync(logFd);
  const pid = child.pid;

  console.log(`Launched: pid=${pid}`);
  console.log(`Log: ${logPath}`);
  console.log(`Verifying startup (timeout: ${args.timeoutSeconds}s)…`);

  const deadline = Date.now() + args.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(logPath)) {
      const log = fs.readFileSync(logPath, 'utf-8');
      const failure = matchFailure(log);
      if (failure) {
        // Try to clean up the dead process; if it already exited, fine.
        try { if (pid) { process.kill(pid); } } catch { /* gone */ }
        console.error('');
        console.error(`ERROR: launch refused or crashed (matched: ${failure.pattern})`);
        console.error(`  > ${failure.line}`);
        console.error('');
        console.error(`Inspect full log at: ${logPath}`);
        return 1;
      }
      if (matchSuccess(log)) {
        console.log('');
        console.log('OK: launch confirmed (setup phase actively running)');
        console.log(`Tail with: tail -f ${logPath}`);
        return 0;
      }
    }
    await sleep(1000);
  }

  // Timed out without either marker. Could be a very slow scaffold step
  // (rare) or a silent hang. Surface the last lines so the operator can
  // decide whether to wait or kill.
  console.error('');
  console.error(`WARN: neither success nor failure markers observed within ${args.timeoutSeconds}s`);
  console.error('Last 20 log lines:');
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').slice(-20).join('\n');
    console.error(lines);
  }
  console.error('');
  console.error(`Process still alive? ${pid && (() => { try { process.kill(pid, 0); return 'yes'; } catch { return 'no'; } })()}`);
  console.error(`Full log: ${logPath}`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('launch-cli failed:', err);
    process.exit(3);
  },
);
