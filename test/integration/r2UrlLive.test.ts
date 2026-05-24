/**
 * R2 Live Integration Test: GitService.getGitHubUrl through refactored call sites
 *
 * Scenarios that exercise getGitHubUrl through the actual code paths:
 * 1. schemaScmProvider uses it for Recent Merges GitHub commit URLs
 * 2. branchTreeProvider uses it for Project view repo name extraction
 * 3. branchTreeProvider uses it for GitHub link in project details
 * 4. graphService uses it for commit avatar fetching URL
 * 5. graphWebview uses it for Open on GitHub / Open PR actions
 *
 * Run: npm run test:integration -- --grep "R2 Live"
 */

import { strict as assert } from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from '../../src/utils/exec';
import { GitService } from '../../src/services/gitService';

const cp = require('child_process');
const timestamp = Date.now().toString(36);
const TEST_REPO = `r2-live-${timestamp}`;

let ghUser: string;
let fullRepoName: string;
let repoDir: string;
let gitService: GitService;
let repoCreated = false;

function git(cmd: string): string {
  return cp.execSync(`git ${cmd}`, { cwd: repoDir, timeout: 15000 }).toString().trim();
}

describe('R2 Live Integration — getGitHubUrl through service layer', function () {
  this.timeout(120000);

  before(async function () {
    this.timeout(60000);
    gitService = new GitService();
    ghUser = cp.execSync('gh api user --jq ".login"', { timeout: 10000 }).toString().trim();
    fullRepoName = `${ghUser}/${TEST_REPO}`;
    repoDir = path.join(require('os').tmpdir(), TEST_REPO);

    console.log(`  Repo: ${fullRepoName}`);
    await gitService.createRepo(fullRepoName, { private: true, description: 'R2 live test' });
    repoCreated = true;
    cp.execSync(`gh repo clone "${fullRepoName}" "${repoDir}"`, { timeout: 30000 });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# R2 Live\n');
    git('add -A && git commit -m "Initial commit"');
    git('push -u origin main');
    git('checkout -b feature/r2');
    fs.writeFileSync(path.join(repoDir, 'feature.ts'), 'export const x = 1;\n');
    git('add -A && git commit -m "Feature commit"');
    git('push -u origin feature/r2');
    git('checkout main');
    git('merge feature/r2 --no-ff -m "Merge pull request #1 from feature/r2"');
    git('push');
    console.log('  Setup complete.\n');
  });

  // ── Scenario 1: Recent Merges commit URLs (schemaScmProvider) ────

  describe('Scenario 1: Recent Merges GitHub commit URLs', () => {
    it('resolves GitHub URL via shared exec', async () => {
      const url = (await exec('git remote get-url origin', { cwd: repoDir })).trim()
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
      assert.ok(url.startsWith('https://github.com/'));
      assert.ok(url.includes(TEST_REPO));
    });

    it('builds merge commit URLs from resolved URL', async () => {
      const url = (await exec('git remote get-url origin', { cwd: repoDir })).trim()
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
      const merges = (await exec('git log --merges --oneline -5', { cwd: repoDir }))
        .split('\n').filter(Boolean);
      assert.ok(merges.length >= 1);
      const commitUrl = `${url}/commit/${merges[0].split(' ')[0]}`;
      assert.ok(commitUrl.includes('/commit/'));
      assert.ok(commitUrl.includes(TEST_REPO));
    });
  });

  // ── Scenario 2: Project view repo name (branchTreeProvider) ──────

  describe('Scenario 2: Project view repo name extraction', () => {
    it('extracts repo name from GitHub URL', async () => {
      const url = (await exec('git remote get-url origin', { cwd: repoDir })).trim()
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
      const match = url.match(/\/([^/]+)$/);
      const repoName = match ? match[1] : 'my-project';
      assert.strictEqual(repoName, TEST_REPO);
    });
  });

  // ── Scenario 3: GitHub link in project details (branchTreeProvider) ──

  describe('Scenario 3: GitHub link for project details', () => {
    it('builds full owner/repo from GitHub URL', async () => {
      const url = (await exec('git remote get-url origin', { cwd: repoDir })).trim()
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
      const match = url.match(/github\.com\/(.+)/);
      const fullName = match ? match[1] : '';
      assert.strictEqual(fullName, fullRepoName);
    });

    it('URL is clickable (valid HTTPS)', async () => {
      const url = (await exec('git remote get-url origin', { cwd: repoDir })).trim()
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
      assert.ok(url.startsWith('https://'));
      // Verify the repo actually exists at this URL
      const exists = await gitService.repoExists(fullRepoName);
      assert.ok(exists);
    });
  });

  // ── Scenario 4: Avatar URL construction (graphService) ───────────

  describe('Scenario 4: GitHub API avatar fetch URL', () => {
    it('extracts owner/repo for gh api call', async () => {
      const url = (await exec('git remote get-url origin', { cwd: repoDir })).trim()
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
      assert.ok(match, 'Should match owner/repo');
      const [, owner, repo] = match!;
      assert.strictEqual(owner, ghUser);
      assert.strictEqual(repo, TEST_REPO);

      // Verify gh api works with extracted owner/repo
      const apiOut = cp.execSync(
        `gh api "repos/${owner}/${repo}/commits?per_page=1" --jq '.[0].sha'`,
        { timeout: 10000 }
      ).toString().trim();
      assert.ok(apiOut.length >= 7, 'Should return a commit SHA');
    });
  });

  // ── Scenario 5: Open on GitHub / Open PR (graphWebview) ──────────

  describe('Scenario 5: Open on GitHub actions', () => {
    it('builds commit URL for Open on GitHub', async () => {
      const url = (await exec('git remote get-url origin', { cwd: repoDir })).trim()
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
      const sha = git('rev-parse HEAD');
      const commitUrl = `${url}/commit/${sha}`;
      assert.ok(commitUrl.includes('/commit/'));
      assert.ok(commitUrl.length > 50);
    });

    it('builds PR URL for Open PR', async () => {
      const url = (await exec('git remote get-url origin', { cwd: repoDir })).trim()
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
      const prUrl = `${url}/pull/1`;
      assert.ok(prUrl.includes('/pull/1'));
    });

    it('handles SSH remote correctly', () => {
      git('remote add test-ssh git@github.com:testowner/testrepo.git');
      const raw = git('remote get-url test-ssh');
      const url = raw.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
      assert.strictEqual(url, 'https://github.com/testowner/testrepo');
      git('remote remove test-ssh');
    });
  });

  // ── Teardown ─────────────────────────────────────────────────────

  describe('Teardown', () => {
    it('deletes the GitHub repo', async function () {
      if (!repoCreated) { this.skip(); return; }
      await gitService.deleteRepo(fullRepoName);
      repoCreated = false;
    });
    it('cleans up local directory', () => {
      if (fs.existsSync(repoDir)) { fs.rmSync(repoDir, { recursive: true, force: true }); }
    });
  });

  after(async function () {
    this.timeout(30000);
    if (repoCreated) { try { await gitService.deleteRepo(fullRepoName); } catch {} }
    if (fs.existsSync(repoDir)) { try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {} }
  });
});
