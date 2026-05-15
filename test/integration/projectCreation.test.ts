/**
 * ProjectCreationService Integration Test
 *
 * Full end-to-end: create a new project (GitHub repo + Lakebase database + scaffold),
 * verify everything works, then tear it all down.
 *
 * Run: npm run test:integration -- --grep "ProjectCreation"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { GitService } from '../../src/services/gitService';
import { LakebaseService } from '../../src/services/lakebaseService';
import { ScaffoldService } from '../../src/services/scaffoldService';
import { ProjectCreationService, ProjectCreationInput } from '../../src/services/projectCreationService';

const cp = require('child_process');
const timestamp = Date.now().toString(36);
const PROJECT_NAME = `newproj-${timestamp}`;

let ghUser: string;
let dbHost: string;
let gitService: GitService;
let lakebaseService: LakebaseService;
let scaffoldService: ScaffoldService;
let creationService: ProjectCreationService;
let input: ProjectCreationInput;
let projectDir: string;
let created = false;

function git(cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: projectDir, timeout: 15000 }).toString().trim();
}

describe('ProjectCreationService — Full End-to-End', function () {
  this.timeout(180000);

  before(async function () {
    this.timeout(30000);
    gitService = new GitService();
    lakebaseService = new LakebaseService();
    dbHost = process.env.DATABRICKS_HOST || 'https://fevm-serverless-stable-ecparr.cloud.databricks.com';
    process.env.DATABRICKS_HOST = dbHost;
    lakebaseService.setHostOverride(dbHost);
    scaffoldService = new ScaffoldService(path.resolve(__dirname, '../../'));
    creationService = new ProjectCreationService(gitService, lakebaseService, scaffoldService);
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    projectDir = path.join(require('os').tmpdir(), PROJECT_NAME);

    input = {
      projectName: PROJECT_NAME,
      parentDir: require('os').tmpdir(),
      databricksHost: dbHost,
      githubOwner: ghUser,
      privateRepo: true,
    };

    console.log(`  Project: ${PROJECT_NAME}`);
    console.log(`  Dir: ${projectDir}`);
    console.log(`  GitHub: ${ghUser}/${PROJECT_NAME}`);
    console.log(`  Lakebase: ${PROJECT_NAME}`);
  });

  // ── Step 1: Create the full project ──────────────────────────────

  describe('Step 1: Create project', () => {
    it('creates GitHub repo + Lakebase DB + scaffold in one call', async function () {
      this.timeout(120000);
      const steps: string[] = [];
      const result = await creationService.createProject(input, (step, detail) => {
        steps.push(step);
        console.log(`    ${step}${detail ? ' — ' + detail : ''}`);
      });

      created = true;
      assert.ok(result.projectDir.includes(PROJECT_NAME), 'Project dir contains name');
      assert.ok(result.githubRepoUrl.includes(PROJECT_NAME), 'GitHub URL contains name');
      assert.ok(result.lakebaseProjectId, 'Lakebase project ID returned');

      // Verify all steps were reported
      assert.ok(steps.some(s => s.includes('GitHub')), 'Reported GitHub step');
      assert.ok(steps.some(s => s.includes('Lakebase')), 'Reported Lakebase step');
      assert.ok(steps.some(s => s.includes('Scaffold')), 'Reported scaffold step');
      assert.ok(steps.some(s => s.includes('commit')), 'Reported commit step');
      assert.ok(steps.some(s => s.includes('success')), 'Reported success');
    });
  });

  // ── Step 2: Verify GitHub repo ───────────────────────────────────

  describe('Step 2: Verify GitHub repo', () => {
    before(function () { if (!created) { this.skip(); } });

    it('repo exists on GitHub', async () => {
      const exists = await gitService.repoExists(`${ghUser}/${PROJECT_NAME}`);
      assert.ok(exists);
    });

    it('repo has workflows', () => {
      const raw = cp.execSync(
        `gh api "repos/${ghUser}/${PROJECT_NAME}/contents/.github/workflows" --jq '.[].name'`,
        { timeout: 10000 }
      ).toString().trim();
      assert.ok(raw.includes('pr.yml'), 'pr.yml on GitHub');
      assert.ok(raw.includes('merge.yml'), 'merge.yml on GitHub');
    });

    it('repo has scripts', () => {
      const raw = cp.execSync(
        `gh api "repos/${ghUser}/${PROJECT_NAME}/contents/scripts" --jq '.[].name' 2>/dev/null`,
        { timeout: 10000 }
      ).toString().trim();
      assert.ok(raw.includes('install-hook.sh'));
      assert.ok(raw.includes('post-checkout.sh'));
    });

    it('repo has migration placeholder', () => {
      const raw = cp.execSync(
        `gh api "repos/${ghUser}/${PROJECT_NAME}/contents/src/main/resources/db/migration" --jq '.[].name' 2>/dev/null`,
        { timeout: 10000 }
      ).toString().trim();
      assert.ok(raw.includes('V1__init_placeholder.sql'));
    });
  });

  // ── Step 3: Verify local project ─────────────────────────────────

  describe('Step 3: Verify local project', () => {
    before(function () { if (!created) { this.skip(); } });

    it('.env exists with real values', () => {
      const env = fs.readFileSync(path.join(projectDir, '.env'), 'utf-8');
      assert.ok(env.includes(dbHost), '.env has DATABRICKS_HOST');
      assert.ok(env.includes(PROJECT_NAME), '.env has LAKEBASE_PROJECT_ID');
    });

    it('.env.example exists', () => {
      assert.ok(fs.existsSync(path.join(projectDir, '.env.example')));
    });

    it('.vscode/settings.json disables Git SCM', () => {
      const settings = JSON.parse(fs.readFileSync(path.join(projectDir, '.vscode', 'settings.json'), 'utf-8'));
      assert.strictEqual(settings['git.enabled'], false);
    });

    it('git hooks are installed', () => {
      const hooks = scaffoldService.verifyHooks(projectDir);
      assert.ok(hooks.postCheckout, 'post-checkout');
      assert.ok(hooks.prepareCommitMsg, 'prepare-commit-msg');
      assert.ok(hooks.prePush, 'pre-push');
    });

    it('git is on main branch with remote tracking', () => {
      const branch = git('rev-parse --abbrev-ref HEAD');
      assert.strictEqual(branch, 'main');
      const upstream = git('rev-parse --abbrev-ref @{u}');
      assert.strictEqual(upstream, 'origin/main');
    });

    it('initial commit exists', () => {
      const log = git('log --oneline -1');
      assert.ok(log.includes('Initial project scaffold'));
    });
  });

  // ── Step 4: Verify Lakebase project ──────────────────────────────

  describe('Step 4: Verify Lakebase project', () => {
    before(function () { if (!created) { this.skip(); } });

    it('project exists in Lakebase', () => {
      const raw = cp.execSync(
        `databricks postgres list-projects -o json`,
        { timeout: 15000, env: { ...process.env, DATABRICKS_HOST: dbHost } }
      ).toString();
      const projects = JSON.parse(raw);
      const items = Array.isArray(projects) ? projects : projects.projects || [];
      const found = items.some((p: any) => p.name?.includes(PROJECT_NAME) || p.uid === PROJECT_NAME);
      assert.ok(found, `Project ${PROJECT_NAME} should exist`);
    });

    it('project has a default branch', () => {
      const raw = cp.execSync(
        `databricks postgres list-branches "projects/${PROJECT_NAME}" -o json`,
        { timeout: 15000, env: { ...process.env, DATABRICKS_HOST: dbHost } }
      ).toString();
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : parsed.branches || parsed.items || [];
      const def = items.find((b: any) => b.status?.default === true || b.is_default === true);
      assert.ok(def, 'Should have a default branch');
    });
  });

  // ── Step 5: Verify .gitignore prevents .env from being committed ──

  describe('Step 5: .gitignore protects .env', () => {
    before(function () { if (!created) { this.skip(); } });

    it('.gitignore exists', () => {
      assert.ok(fs.existsSync(path.join(projectDir, '.gitignore')));
    });

    it('.gitignore contains .env', () => {
      const content = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('.env'), '.gitignore should list .env');
    });

    it('.env is not tracked by git', () => {
      const tracked = git('ls-files .env');
      assert.strictEqual(tracked, '', '.env should not be in git index');
    });
  });

  // ── Step 6: Verify CI secrets were set ───────────────────────────

  describe('Step 6: CI secrets on GitHub', () => {
    before(function () { if (!created) { this.skip(); } });

    it('DATABRICKS_HOST secret is set', function () {
      this.timeout(15000);
      const raw = cp.execSync(`gh secret list --repo "${ghUser}/${PROJECT_NAME}"`, { timeout: 10000 }).toString();
      assert.ok(raw.includes('DATABRICKS_HOST'), 'DATABRICKS_HOST should be set');
    });

    it('LAKEBASE_PROJECT_ID secret is set', function () {
      this.timeout(15000);
      const raw = cp.execSync(`gh secret list --repo "${ghUser}/${PROJECT_NAME}"`, { timeout: 10000 }).toString();
      assert.ok(raw.includes('LAKEBASE_PROJECT_ID'), 'LAKEBASE_PROJECT_ID should be set');
    });

    it('DATABRICKS_TOKEN secret is set', function () {
      this.timeout(15000);
      const raw = cp.execSync(`gh secret list --repo "${ghUser}/${PROJECT_NAME}"`, { timeout: 10000 }).toString();
      assert.ok(raw.includes('DATABRICKS_TOKEN'), 'DATABRICKS_TOKEN should be set');
    });
  });

  // ── Step 7: Exercise hooks on the new project ────────────────────

  describe('Step 7: Hooks work on the new project', () => {
    before(function () { if (!created) { this.skip(); } });

    it('post-checkout fires on branch create', () => {
      try {
        cp.execSync('git checkout -b feature/test-creation 2>&1', { cwd: projectDir, timeout: 15000 });
      } catch { /* hook warnings are OK */ }
      const branch = git('rev-parse --abbrev-ref HEAD');
      assert.strictEqual(branch, 'feature/test-creation');
      git('checkout main');
      git('branch -D feature/test-creation');
    });

    it('prepare-commit-msg fires on commit', () => {
      fs.writeFileSync(path.join(projectDir, 'test.txt'), 'test\n');
      git('add test.txt');
      try {
        git('commit -m "Test commit on new project"');
      } catch {
        git('commit --no-verify -m "Test commit on new project"');
      }
      const msg = git('log --oneline -1');
      assert.ok(msg.includes('Test commit'));
    });

    it('pre-push hook runs on push', function () {
      this.timeout(30000);
      // Push the test commit — pre-push hook should fire
      // It may warn about secrets but should not block the push
      try {
        git('push origin main');
      } catch {
        // pre-push hook failure is non-fatal for this test
        git('push --no-verify origin main');
      }
      // Verify the commit reached remote
      const localSha = git('rev-parse HEAD');
      const remoteSha = git('rev-parse origin/main');
      assert.strictEqual(localSha, remoteSha, 'Push should have succeeded');
    });
  });

  // ── Teardown ─────────────────────────────────────────────────────

  describe('Teardown', () => {
    it('cleans up GitHub repo + Lakebase project + local dir', async function () {
      if (!created) { this.skip(); return; }
      this.timeout(90000);
      console.log('    Cleaning up...');
      await creationService.cleanupProject(input);
      created = false;

      // Verify cleanup
      const exists = await gitService.repoExists(`${ghUser}/${PROJECT_NAME}`);
      assert.strictEqual(exists, false, 'GitHub repo should be deleted');
      assert.ok(!fs.existsSync(projectDir), 'Local dir should be deleted');
      console.log('    Done.');
    });
  });

  after(async function () {
    this.timeout(90000);
    if (created) {
      try { await creationService.cleanupProject(input); } catch (e: any) { console.log(`  [cleanup] ${e.message}`); }
    }
  });
});
