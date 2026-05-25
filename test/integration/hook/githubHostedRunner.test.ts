/**
 * Small repro for the github-hosted runner path in patchWorkflowsForRunnerType.
 *
 * The ecom integration test forces runnerType=self-hosted and starts an
 * ephemeral local runner per run. The github-hosted YAML path was never
 * exercised: templates ship with `runs-on: self-hosted` everywhere, and
 * pre-FEIP-7121 the patch function was a no-op for github-hosted, so
 * users choosing github-hosted got jobs that sat queued forever waiting
 * on a self-hosted runner.
 *
 * Substrate v0.3.0-alpha.17 (FEIP-7121) fixed the patch to swap
 * `runs-on: self-hosted` → `runs-on: ubuntu-latest` for github-hosted.
 * This test pins both modes:
 *
 *   - github-hosted: `runs-on: ubuntu-latest` everywhere, `actions/setup-java@v4`
 *     present (no swap to local-JDK shim).
 *   - self-hosted: `runs-on: self-hosted` preserved, `actions/setup-java@v4`
 *     replaced with the local-JDK detection step.
 *
 * Pure-substrate test against temp dirs - no Lakebase project, no GitHub
 * repo, no hooks. Runs in <2s.
 *
 * Pre-flight: none.
 *
 * Run: npm run test:integration -- --grep "github-hosted runner"
 */

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deployWorkflows,
  patchWorkflowsForRunnerType,
} from '@databricks-solutions/lakebase-app-dev-kit';

describe('github-hosted runner patch (small repro)', function () {
  this.timeout(30000);

  const tmpRoot = path.join(os.tmpdir(), `lb-runner-${Date.now().toString(36)}`);
  const githubHostedDir = path.join(tmpRoot, 'github-hosted');
  const selfHostedDir = path.join(tmpRoot, 'self-hosted');

  before(async () => {
    fs.mkdirSync(githubHostedDir, { recursive: true });
    fs.mkdirSync(selfHostedDir, { recursive: true });

    // Deploy the canonical workflow templates into each target. Both
    // start identical - patch is what differentiates them.
    await deployWorkflows(githubHostedDir);
    await deployWorkflows(selfHostedDir);

    console.log(`\n  Temp root: ${tmpRoot}\n`);
  });

  it('github-hosted: rewrites runs-on to ubuntu-latest, keeps setup-java', async function () {
    await patchWorkflowsForRunnerType(githubHostedDir, 'github-hosted');

    const workflowDir = path.join(githubHostedDir, '.github', 'workflows');
    const ymls = fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml'));
    assert.ok(ymls.length > 0, 'precondition: deployWorkflows must produce at least one .yml');

    for (const file of ymls) {
      const content = fs.readFileSync(path.join(workflowDir, file), 'utf-8');
      assert.ok(
        !/runs-on: self-hosted/.test(content),
        `${file} should not retain runs-on: self-hosted after github-hosted patch`,
      );
      // Every original `runs-on: self-hosted` should now be ubuntu-latest.
      assert.match(
        content,
        /runs-on: ubuntu-latest/,
        `${file} should have runs-on: ubuntu-latest after github-hosted patch`,
      );
    }

    // The Java-using workflows (pr.yml, merge.yml) must retain
    // actions/setup-java@v4 — github-hosted runners want the online
    // setup-java step (the self-hosted path replaces it with a local-JDK
    // shim, which would be wrong on a github-hosted runner that has no
    // pre-installed JDK).
    const prYml = fs.readFileSync(path.join(workflowDir, 'pr.yml'), 'utf-8');
    assert.match(prYml, /actions\/setup-java@v4/, 'github-hosted pr.yml must keep actions/setup-java@v4');
  });

  it('self-hosted: keeps runs-on: self-hosted, swaps setup-java for local-JDK shim', async function () {
    await patchWorkflowsForRunnerType(selfHostedDir, 'self-hosted');

    const workflowDir = path.join(selfHostedDir, '.github', 'workflows');
    const prYml = fs.readFileSync(path.join(workflowDir, 'pr.yml'), 'utf-8');

    assert.match(prYml, /runs-on: self-hosted/, 'self-hosted pr.yml should keep runs-on: self-hosted');
    assert.ok(
      !/actions\/setup-java@v4/.test(prYml),
      'self-hosted pr.yml should have setup-java@v4 replaced with the local-JDK shim',
    );
    assert.match(prYml, /Set up JDK \(local\)/, 'self-hosted pr.yml must have the local-JDK shim');
  });

  after(() => {
    if (process.env.LB_RUNNER_NO_TEARDOWN === '1') {
      console.log(`  [teardown] skipped (LB_RUNNER_NO_TEARDOWN=1). Preserved: ${tmpRoot}`);
      return;
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
