#!/usr/bin/env ts-node
/**
 * Manual teardown for integration test resources.
 *
 * The integration suites never auto-teardown (see preserve-on-failure.ts).
 * After inspecting a run's GitHub repo, Lakebase project, and CI logs,
 * the operator invokes this CLI to delete them.
 *
 * Every destructive step prints what it is about to do and waits for
 * an interactive `y` confirmation on stdin. There is no `--yes` flag
 * by design: the whole point of having a separate CLI is that a human
 * stops, reads, and approves each deletion.
 *
 * Usage:
 *
 *   npx ts-node test/integration/lib/cleanup-cli.ts \
 *     --repo kevin-hartman/ecom-abc123 \
 *     --project ecom-abc123 \
 *     --host https://fevm-serverless-stable-ecparr.cloud.databricks.com \
 *     --dir /Users/foo/ecom-abc123
 *
 * Any subset of flags is fine - omit `--dir` and the local directory
 * is left alone; omit `--project` and only the GitHub repo is touched;
 * etc.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as readline from 'readline';
import { forceDeleteGithubRepo, forceDeleteLakebaseProject } from './cleanup';

interface Args {
  repo?: string;
  project?: string;
  host?: string;
  dir?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--repo': out.repo = argv[++i]; break;
      case '--project': out.project = argv[++i]; break;
      case '--host': out.host = argv[++i]; break;
      case '--dir': out.dir = argv[++i]; break;
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        process.exit(0);
        // unreachable
        break;
      default:
        process.stderr.write(`Unknown arg: ${a}\n`);
        process.stderr.write(HELP);
        process.exit(2);
    }
  }
  return out;
}

const HELP = `cleanup-cli — interactive teardown for integration test resources

Flags (all optional; omit a flag to leave that resource alone):
  --repo <owner>/<name>    GitHub repo created by the suite
  --project <id>           Lakebase project name (e.g. ecom-abc123)
  --host <url>             Databricks workspace URL (default: DATABRICKS_TEST_HOST)
  --dir <path>             Local scaffolded project directory

Every destructive step prompts y/N before running. There is no batch
mode. Re-run with the same flags if a step fails partway.
`;

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(label: string, detail: string): Promise<boolean> {
  process.stdout.write(`\n${label}\n  ${detail}\n`);
  const ans = await prompt('  Delete? [y/N] ');
  return ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo && !args.project && !args.dir) {
    process.stderr.write(
      'Nothing to clean up: pass at least one of --repo, --project, --dir.\n\n' +
        HELP,
    );
    process.exit(2);
  }

  const host =
    args.host || (process.env.DATABRICKS_TEST_HOST || '').trim() || undefined;
  if (args.project && !host) {
    process.stderr.write(
      'Lakebase teardown needs a workspace URL. Pass --host or set DATABRICKS_TEST_HOST.\n',
    );
    process.exit(2);
  }

  // Verify CLI auth up-front when we'll need it; better to fail before
  // the operator approves a delete than to surface "auth failed" mid-run.
  if (args.project && host) {
    try {
      execFileSync('databricks', ['auth', 'token', '--host', host], {
        stdio: 'pipe',
        timeout: 10_000,
      });
    } catch (e: any) {
      process.stderr.write(
        `databricks auth check failed for ${host}: ${e?.message || e}\n` +
          `Run: databricks auth login --host "${host}"\n`,
      );
      process.exit(1);
    }
  }

  if (args.repo) {
    if (await confirm('GitHub repo', `https://github.com/${args.repo}`)) {
      try {
        await forceDeleteGithubRepo(args.repo);
        process.stdout.write('  GitHub repo deleted.\n');
      } catch (e: any) {
        process.stderr.write(`  GitHub delete failed: ${e?.message || e}\n`);
      }
    } else {
      process.stdout.write('  GitHub repo preserved.\n');
    }
  }

  if (args.project && host) {
    process.env.DATABRICKS_HOST = host;
    if (
      await confirm('Lakebase project', `${args.project} on ${host}`)
    ) {
      try {
        await forceDeleteLakebaseProject(args.project);
        process.stdout.write('  Lakebase project deleted.\n');
      } catch (e: any) {
        process.stderr.write(`  Lakebase delete failed: ${e?.message || e}\n`);
      }
    } else {
      process.stdout.write('  Lakebase project preserved.\n');
    }
  }

  if (args.dir) {
    if (await confirm('Local directory', args.dir)) {
      try {
        if (fs.existsSync(args.dir)) {
          fs.rmSync(args.dir, { recursive: true, force: true });
          process.stdout.write('  Local dir removed.\n');
        } else {
          process.stdout.write('  Local dir already gone.\n');
        }
      } catch (e: any) {
        process.stderr.write(`  Local dir remove failed: ${e?.message || e}\n`);
      }
    } else {
      process.stdout.write('  Local dir preserved.\n');
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
