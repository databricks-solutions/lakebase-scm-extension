/**
 * Default: NEVER auto-teardown integration test resources.
 *
 * Destructive integration suites (ecom, python-devloop) create real
 * Lakebase projects + GitHub repos. The historic default — mocha's
 * after-hook runs teardown regardless of test outcomes — destroyed
 * cloud state before a human could inspect it. CI logs went cold,
 * failed-run debugging required re-running the suite, and even on a
 * green pass the operator lost the chance to manually verify the
 * resources mid-run.
 *
 * The rule is now hard-coded: tests preserve everything. Teardown is
 * a SEPARATE operator action invoked deliberately via the CLI helper
 * exposed in `cleanup-cli.ts`. There is intentionally no env-var
 * override - "I'll just set the flag this once" is exactly the
 * mistake this module prevents.
 *
 * Usage in a suite:
 *
 *   import { installFailureTracker, preservedResourcesBanner } from '../lib';
 *
 *   describe('My destructive suite', () => {
 *     installFailureTracker();   // tracks failures for the summary
 *
 *     after(() => {
 *       console.log(preservedResourcesBanner({
 *         githubRepo: ctx.fullRepoName,
 *         lakebaseProject: ctx.projectName,
 *         projectDir: ctx.projectDir,
 *       }));
 *     });
 *   });
 *
 * To cleanup after a run, the operator runs:
 *
 *   npx ts-node test/integration/lib/cleanup-cli.ts \
 *     --repo <owner>/<name> --project <id> --dir <path>
 *
 * That CLI prompts for confirmation before each delete; suite code
 * never calls forceDelete* directly.
 */

let failureCount = 0;
const failedTestTitles: string[] = [];

/** Record a failed test. Called from mocha's afterEach hook. */
export function markTestFailed(title: string): void {
  failureCount += 1;
  failedTestTitles.push(title);
}

/** Did any test in this process fail? */
export function didAnyTestFail(): boolean {
  return failureCount > 0;
}

/** Titles of all tests that failed in this process. */
export function getFailedTestTitles(): readonly string[] {
  return failedTestTitles;
}

/**
 * Mount an `afterEach` hook on the enclosing mocha suite that records
 * each failed test. Must be called inside a `describe()` body.
 */
export function installFailureTracker(): void {
  // mocha's `afterEach` is a global available inside describe blocks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const afterEach = (globalThis as any).afterEach as (
    fn: (this: { currentTest?: { state?: string; title?: string } }) => void,
  ) => void;
  if (typeof afterEach !== 'function') {
    throw new Error(
      'installFailureTracker(): mocha afterEach not available. Call inside a describe() body.',
    );
  }
  afterEach(function () {
    const t = this.currentTest;
    if (t && t.state === 'failed') {
      markTestFailed(t.title ?? '<unknown>');
    }
  });
}

export interface PreservedResources {
  githubRepo?: string;
  lakebaseProject?: string;
  projectDir?: string;
  databricksHost?: string;
}

/**
 * Build a multi-line banner naming every resource the suite created
 * and the exact command to clean each one up later. Call from the
 * top-level `after()` hook.
 *
 * Centralising the format here means every suite logs cleanup
 * instructions the same way, and the format is the single source of
 * truth that cleanup-cli.ts validates against in its prompt text.
 */
export function preservedResourcesBanner(res: PreservedResources): string {
  const lines: string[] = [];
  const status = didAnyTestFail()
    ? `${failureCount} test failure(s) - resources preserved for debugging`
    : 'green run - resources preserved (this is the default behaviour)';
  lines.push('');
  lines.push('  ╭─ PRESERVED INTEGRATION RESOURCES ──────────────────');
  lines.push(`  │ ${status}`);
  if (failedTestTitles.length) {
    for (const title of failedTestTitles.slice(0, 10)) {
      lines.push(`  │   ✗ ${title}`);
    }
    if (failedTestTitles.length > 10) {
      lines.push(`  │   ...and ${failedTestTitles.length - 10} more`);
    }
  }
  lines.push('  │');
  if (res.githubRepo) {
    lines.push(`  │ GitHub repo:     https://github.com/${res.githubRepo}`);
  }
  if (res.lakebaseProject) {
    const host = res.databricksHost ?? '<DATABRICKS_TEST_HOST>';
    lines.push(`  │ Lakebase project: ${res.lakebaseProject}`);
    lines.push(`  │ Workspace:        ${host}`);
  }
  if (res.projectDir) {
    lines.push(`  │ Local dir:        ${res.projectDir}`);
  }
  lines.push('  │');
  lines.push('  │ To teardown when you are done debugging, run:');
  const args: string[] = [];
  if (res.githubRepo) args.push(`--repo ${res.githubRepo}`);
  if (res.lakebaseProject) args.push(`--project ${res.lakebaseProject}`);
  if (res.databricksHost) args.push(`--host ${res.databricksHost}`);
  if (res.projectDir) args.push(`--dir ${res.projectDir}`);
  lines.push(
    `  │   npx ts-node test/integration/lib/cleanup-cli.ts ${args.join(' ')}`,
  );
  lines.push('  ╰────────────────────────────────────────────────────');
  lines.push('');
  return lines.join('\n');
}
