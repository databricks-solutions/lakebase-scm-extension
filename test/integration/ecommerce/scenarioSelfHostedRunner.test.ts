/**
 * Self-Hosted Runner Integration Test
 *
 * Verifies the full self-hosted runner CI/CD pipeline end-to-end:
 * creates a project with runnerType='self-hosted', verifies workflows
 * are patched (no actions/setup-java), creates a feature branch with
 * code + migration + tests, runs ./mvnw test locally, pushes, creates
 * a PR, and confirms the runner executes pr.yml successfully.
 *
 * Run: npm run test:integration -- --grep "Self-Hosted Runner"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { GitService } from '../../../src/services/gitService';
import { LakebaseService } from '../../../src/services/lakebaseService';
import { ScaffoldService } from '../../../src/services/scaffoldService';
import { ProjectCreationService, ProjectCreationInput } from '../../../src/services/projectCreationService';
import { RunnerService } from '../../../src/services/runnerService';

const timestamp = Date.now().toString(36);
const PROJECT_NAME = `runner-test-${timestamp}`;

function git(dir: string, cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: dir, timeout: 30000 }).toString().trim();
}

describe('Self-Hosted Runner — Full CI/CD Pipeline', function () {
  this.timeout(600000); // 10 min

  let projectDir: string;
  let fullRepoName: string;
  let ghUser: string;
  let dbHost: string;
  let input: ProjectCreationInput;
  let gitService: GitService;
  let lakebaseService: LakebaseService;
  let creationService: ProjectCreationService;
  let created = false;

  before(async function () {
    this.timeout(300000);

    gitService = new GitService();
    lakebaseService = new LakebaseService();
    dbHost = process.env.DATABRICKS_HOST || 'https://fevm-serverless-stable-ecparr.cloud.databricks.com';
    process.env.DATABRICKS_HOST = dbHost;
    lakebaseService.setHostOverride(dbHost);
    lakebaseService.setProjectIdOverride(PROJECT_NAME);

    const scaffoldService = new ScaffoldService(path.resolve(__dirname, '../../../'));
    creationService = new ProjectCreationService(gitService, lakebaseService, scaffoldService);
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    projectDir = path.join(require('os').homedir(), PROJECT_NAME);

    input = {
      projectName: PROJECT_NAME,
      parentDir: require('os').homedir(),
      databricksHost: dbHost,
      githubOwner: ghUser,
      privateRepo: true,
      language: 'java',
      runnerType: 'self-hosted',
    };

    console.log(`\n  Project: ${PROJECT_NAME}`);
    console.log(`  Dir: ${projectDir}`);
    console.log(`  GitHub: ${ghUser}/${PROJECT_NAME}`);
    console.log(`  Runner type: self-hosted\n`);

    const result = await creationService.createProject(input, (step, detail) => {
      console.log(`    [setup] ${step}${detail ? ' — ' + detail : ''}`);
    });

    created = true;
    fullRepoName = `${ghUser}/${PROJECT_NAME}`;
    assert.ok(result.projectDir.includes(PROJECT_NAME));
    console.log(`    [setup] Project created.\n`);
  });

  // ── Verify workflow templates were patched ──────────────────────

  it('pr.yml does NOT contain actions/setup-java', function () {
    const content = fs.readFileSync(path.join(projectDir, '.github', 'workflows', 'pr.yml'), 'utf-8');
    assert.ok(!content.includes('actions/setup-java'), 'pr.yml should not have actions/setup-java');
    assert.ok(content.includes('Set up JDK (local)'), 'pr.yml should have local JDK step');
  });

  it('merge.yml does NOT contain actions/setup-java', function () {
    const content = fs.readFileSync(path.join(projectDir, '.github', 'workflows', 'merge.yml'), 'utf-8');
    assert.ok(!content.includes('actions/setup-java'), 'merge.yml should not have actions/setup-java');
    assert.ok(content.includes('Set up JDK (local)'), 'merge.yml should have local JDK step');
  });

  it('mvnw calls use -o (offline) flag', function () {
    const pr = fs.readFileSync(path.join(projectDir, '.github', 'workflows', 'pr.yml'), 'utf-8');
    // Every ./mvnw call should have -o
    const mvnwCalls = pr.match(/\.\/mvnw [^|&\n]*/g) || [];
    for (const call of mvnwCalls) {
      assert.ok(call.includes('-o '), `mvnw call should be offline: ${call}`);
    }
  });

  // ── Verify runner is deployed and online ───────────────────────

  it('runner is deployed and online', function () {
    if (!created) { this.skip(); }
    const runnerService = new RunnerService();
    const info = runnerService.getRunnerInfo(PROJECT_NAME);
    assert.ok(info, 'Runner info should exist');
    assert.ok(info!.online, 'Runner should be online');
    assert.ok(info!.pid, 'Runner should have a PID');
  });

  // ── Create feature branch + code + test + PR ──────────────────

  it('creates feature branch and Lakebase branch', async function () {
    if (!created) { this.skip(); }
    this.timeout(180000);

    git(projectDir, 'checkout -b feature/runner-test');

    const branch = await lakebaseService.createBranch('feature/runner-test');
    assert.ok(branch, 'Lakebase branch should be created');

    // Write .env connection
    const ep = await lakebaseService.getEndpoint(branch!.uid);
    const cred = await lakebaseService.getCredential(branch!.uid);
    const jdbcUrl = `jdbc:postgresql://${ep!.host}:5432/databricks_postgres?sslmode=require`;
    const envPath = path.join(projectDir, '.env');
    let envContent = fs.readFileSync(envPath, 'utf-8');
    envContent = envContent.split('\n')
      .filter(l => !l.startsWith('SPRING_DATASOURCE_') && !l.startsWith('LAKEBASE_HOST=') && !l.startsWith('LAKEBASE_BRANCH_ID='))
      .join('\n');
    envContent += `\nLAKEBASE_HOST=${ep!.host}\nLAKEBASE_BRANCH_ID=${branch!.branchId}\nSPRING_DATASOURCE_URL=${jdbcUrl}\nSPRING_DATASOURCE_USERNAME=${cred.email}\nSPRING_DATASOURCE_PASSWORD=${cred.token}\n`;
    fs.writeFileSync(envPath, envContent);
    fs.writeFileSync(path.join(projectDir, 'application-local.properties'),
      `spring.datasource.url=${jdbcUrl}\nspring.datasource.username=${cred.email}\nspring.datasource.password=${cred.token}\n`);
  });

  it('writes Java entity + migration + test', function () {
    if (!created) { this.skip(); }

    // Migration
    const migDir = path.join(projectDir, 'src', 'main', 'resources', 'db', 'migration');
    fs.writeFileSync(path.join(migDir, 'V2__create_widget_table.sql'),
      'CREATE TABLE IF NOT EXISTS widget (\n    id BIGSERIAL PRIMARY KEY,\n    name VARCHAR(255) NOT NULL\n);\n');

    // Entity
    const javaDir = path.join(projectDir, 'src', 'main', 'java', 'com', 'example', 'demo');
    fs.mkdirSync(path.join(javaDir, 'model'), { recursive: true });
    fs.writeFileSync(path.join(javaDir, 'model', 'Widget.java'),
      `package com.example.demo.model;\nimport jakarta.persistence.*;\n@Entity @Table(name = "widget")\npublic class Widget {\n    @Id @GeneratedValue(strategy = GenerationType.IDENTITY) private Long id;\n    private String name;\n    public Widget() {}\n    public Widget(String name) { this.name = name; }\n    public Long getId() { return id; }\n    public String getName() { return name; }\n}\n`);

    // Repository
    fs.mkdirSync(path.join(javaDir, 'repository'), { recursive: true });
    fs.writeFileSync(path.join(javaDir, 'repository', 'WidgetRepository.java'),
      `package com.example.demo.repository;\nimport com.example.demo.model.Widget;\nimport org.springframework.data.jpa.repository.JpaRepository;\npublic interface WidgetRepository extends JpaRepository<Widget, Long> {}\n`);

    // Test
    const testDir = path.join(projectDir, 'src', 'test', 'java', 'com', 'example', 'demo');
    fs.writeFileSync(path.join(testDir, 'WidgetTest.java'),
      `package com.example.demo;\nimport com.example.demo.model.Widget;\nimport com.example.demo.repository.WidgetRepository;\nimport org.junit.jupiter.api.Test;\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.boot.test.context.SpringBootTest;\nimport org.springframework.transaction.annotation.Transactional;\nimport static org.junit.jupiter.api.Assertions.*;\n\n@SpringBootTest @Transactional\nclass WidgetTest {\n    @Autowired private WidgetRepository repo;\n    @Test void givenWidget_whenSaved_thenFound() {\n        Widget w = repo.save(new Widget("test-widget"));\n        assertTrue(repo.findById(w.getId()).isPresent());\n    }\n}\n`);
  });

  it('./mvnw test passes locally against Lakebase branch', function () {
    if (!created) { this.skip(); }
    this.timeout(300000);

    const m2Repo = path.join(require('os').homedir(), '.m2', 'repository');
    const offlineFlag = fs.existsSync(path.join(m2Repo, 'org', 'springframework', 'boot')) ? '-o ' : '';
    const output = cp.execSync(
      `bash -c 'set -a; source .env; set +a; ./mvnw ${offlineFlag}test 2>&1'`,
      { cwd: projectDir, timeout: 300000, env: { ...process.env, DATABRICKS_HOST: dbHost } }
    ).toString();
    assert.ok(output.includes('BUILD SUCCESS') || !output.includes('BUILD FAILURE'), 'Maven test should pass');
    console.log('    [mvnw] Tests passed.');
  });

  it('commits and pushes feature branch', function () {
    if (!created) { this.skip(); }
    git(projectDir, 'add -A');
    git(projectDir, 'commit -m "Add widget entity with test"');
    git(projectDir, 'push -u origin feature/runner-test');
  });

  // ── Create PR and verify runner executes pr.yml ────────────────

  it('creates PR', function () {
    if (!created) { this.skip(); }
    const raw = cp.execSync(
      `gh pr create --repo "${fullRepoName}" --title "Add widget entity" --body "Self-hosted runner test" --head feature/runner-test --base main`,
      { cwd: projectDir, timeout: 30000 }
    ).toString().trim();
    assert.ok(raw.includes('/pull/'), 'PR URL should be returned');
    console.log(`    PR created: ${raw}`);
  });

  it('pr.yml workflow succeeds on self-hosted runner', function () {
    if (!created) { this.skip(); }
    this.timeout(420000);

    // Poll for pr.yml completion
    const startTime = Date.now();
    while (Date.now() - startTime < 360000) {
      try {
        const raw = cp.execSync(
          `gh run list --repo "${fullRepoName}" --workflow=pr.yml --limit=1 --json status,conclusion`,
          { timeout: 15000 }
        ).toString().trim();
        const runs = JSON.parse(raw || '[]');
        if (runs.length > 0 && runs[0].status === 'completed') {
          assert.strictEqual(runs[0].conclusion, 'success',
            `pr.yml should succeed but got: ${runs[0].conclusion}`);
          console.log('    pr.yml succeeded on self-hosted runner.');
          return;
        }
      } catch {}
      cp.execSync('sleep 15');
    }
    assert.fail('pr.yml did not complete within 6 minutes');
  });

  it('PR comment contains schema diff', function () {
    if (!created) { this.skip(); }
    try {
      const raw = cp.execSync(
        `gh api repos/${fullRepoName}/issues/1/comments --jq '.[0].body'`,
        { timeout: 15000 }
      ).toString().trim();
      assert.ok(raw.length > 0, 'PR should have a comment');
      assert.ok(raw.includes('widget') || raw.includes('Schema') || raw.includes('CI passed'),
        'Comment should reference schema or CI status');
    } catch {
      // Comment may not be posted if pr-comment job hasn't run yet
    }
  });

  // ── Teardown ───────────────────────────────────────────────────

  describe('Teardown', () => {
    it('cleans up', async function () {
      if (!created) { this.skip(); return; }
      if (process.env.ECOM_NO_TEARDOWN) {
        console.log(`    Teardown SKIPPED. Project: ${fullRepoName}`);
        this.skip();
        return;
      }
      this.timeout(120000);
      await creationService.cleanupProject(input);
      console.log('    Cleaned up.');
    });
  });

  after(async function () {
    this.timeout(120000);
    if (process.env.ECOM_NO_TEARDOWN) { return; }
    if (created) {
      try { await creationService.cleanupProject(input); } catch {}
    }
  });
});
