import * as fs from 'fs';
import * as path from 'path';
import { GitService } from './gitService';
import { GitHubService } from './githubService';
import { LakebaseService } from './lakebaseService';
import { ScaffoldService } from './scaffoldService';
import { RunnerService } from './runnerService';
import { exec } from '../utils/exec';
import { syncCiSecrets } from '../utils/ciSecrets';
import { delay } from '../utils/delay';

/**
 * Input collected from UI prompts before project creation begins.
 */
export interface ProjectCreationInput {
  /** Project name (Lakebase project id and local directory name) */
  projectName: string;
  /** Parent directory where the project folder will be created */
  parentDir: string;
  /** Databricks workspace host URL */
  databricksHost: string;
  /** GitHub owner (user or org) — required when createGithubRepo is true */
  githubOwner?: string;
  /** Whether to create a GitHub repository (default: true) */
  createGithubRepo?: boolean;
  /** Whether to make the GitHub repo private (default: true) */
  privateRepo?: boolean;
  /** Project language stack (default: 'java') */
  language?: 'java' | 'kotlin' | 'python' | 'nodejs';
  /** CI runner type (default: 'self-hosted') */
  runnerType?: 'self-hosted' | 'github-hosted';
}

/**
 * Result of project creation.
 */
export interface ProjectCreationResult {
  projectDir: string;
  githubRepoUrl?: string;
  lakebaseProjectId: string;
  lakebaseDefaultBranch: string;
}

/**
 * Progress callback for each step.
 */
export type ProgressCallback = (step: string, detail?: string) => void;

/**
 * UI prompt definitions — the caller (extension command) collects these
 * from the user before calling createProject.
 */
export const PROJECT_CREATION_PROMPTS = {
  projectName: {
    prompt: 'Project name',
    placeHolder: 'my-lakebase-app',
    validateInput: (value: string) => {
      if (!value.trim()) { return 'Project name is required'; }
      if (!/^[a-z][a-z0-9-]*$/.test(value)) { return 'Must start with lowercase letter, contain only lowercase letters, numbers, and hyphens'; }
      if (value.length > 63) { return 'Must be 63 characters or less'; }
      return undefined;
    },
  },
  parentDir: {
    title: 'Select parent directory for the new project',
    openLabel: 'Select Folder',
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
  },
  databricksHost: {
    prompt: 'Databricks workspace URL',
    placeHolder: 'https://your-workspace.cloud.databricks.com',
    validateInput: (value: string) => {
      if (!value.startsWith('https://')) { return 'URL must start with https://'; }
      return undefined;
    },
  },
};

/**
 * Orchestrates the full creation of a new Lakebase project:
 * GitHub repo + Lakebase database + scaffold + hooks + secrets + initial commit.
 */
export class ProjectCreationService {
  constructor(
    private gitService: GitService,
    private githubService: GitHubService,
    private lakebaseService: LakebaseService,
    private scaffoldService: ScaffoldService,
  ) {}

  /**
   * Create a complete new project. Each step reports progress.
   * On failure, partial resources are preserved (caller can retry or clean up).
   */
  async createProject(input: ProjectCreationInput, progress?: ProgressCallback): Promise<ProjectCreationResult> {
    const report = progress || (() => {});
    const projectDir = path.join(input.parentDir, input.projectName);
    const lakebaseProjectId = input.projectName;
    const host = input.databricksHost.replace(/\/+$/, '');
    const useGithub = input.createGithubRepo !== false;

    if (useGithub && !input.githubOwner) {
      throw new Error('GitHub owner is required when creating a GitHub repository');
    }

    const fullRepoName = input.githubOwner ? `${input.githubOwner}/${input.projectName}` : '';

    if (useGithub) {
      // Step 1: Create GitHub repo
      report('Creating GitHub repository...', fullRepoName);
      await this.githubService.createRepo(fullRepoName, {
        private: input.privateRepo !== false,
        description: `Lakebase project: ${input.projectName}`,
      });

      // Step 2: Clone the repo. createRepo() succeeds at the REST layer,
      // but GET/clone can 404 briefly in some orgs (SAML SSO / propagation delays).
      // Backoff 1s, 2s, 3s, 5s, 8s — total ~19s max.
      report('Waiting for GitHub repo to be visible...', fullRepoName);
      const probeDelays = [1000, 2000, 3000, 5000, 8000];
      let probeErr = '';
      let visible = false;
      for (const waitMs of probeDelays) {
        try {
          await this.githubService.getRepoFullName(fullRepoName);
          visible = true;
          break;
        } catch (err: any) {
          probeErr = (err.message || '').toString();
          await delay(waitMs);
        }
      }
      if (!visible) {
        let activeUser = '';
        try { activeUser = await this.githubService.getCurrentUser(); } catch { /* ignore */ }
        const samlHint = /SAML|scope does not match|sso/i.test(probeErr)
          ? `\n\nThe error mentions SAML — re-sign in to GitHub in VS Code and authorize SSO for this org.`
          : '';
        const userHint = activeUser && activeUser !== input.githubOwner
          ? `\n\nNote: signed in as "${activeUser}", but the repo was created under "${input.githubOwner}".`
          : '';
        throw new Error(
          `GitHub repo "${fullRepoName}" was created but isn't visible after ~19s of polling.${samlHint}${userHint}\n\nLast probe error:\n  ${probeErr.split('\n')[0].slice(0, 200)}`
        );
      }
      report('Cloning repository...', projectDir);
      await this.gitService.cloneRepo(`https://github.com/${fullRepoName}.git`, projectDir);
    } else {
      report('Creating local project directory...', projectDir);
      if (fs.existsSync(projectDir)) {
        throw new Error(`Directory already exists: ${projectDir}`);
      }
      fs.mkdirSync(projectDir, { recursive: true });
      await exec('git init -b main', { cwd: projectDir, timeout: 15000 });
    }

    // Step 3: Create Lakebase project
    report('Creating Lakebase database...', lakebaseProjectId);
    this.lakebaseService.setHostOverride(host);
    const lbProject = await this.lakebaseService.createProject(lakebaseProjectId);

    // Step 4: Get default branch info
    report('Resolving database endpoint...');
    let defaultBranchId = '';
    try {
      const branches = await exec(
        `databricks postgres list-branches "projects/${lakebaseProjectId}" -o json`,
        { env: { DATABRICKS_HOST: host }, timeout: 15000 }
      );
      const parsed = JSON.parse(branches);
      const items = Array.isArray(parsed) ? parsed : parsed.branches || parsed.items || [];
      const def = items.find((b: any) => b.status?.default === true || b.is_default === true);
      if (def) {
        defaultBranchId = def.uid || def.name?.split('/branches/').pop() || '';
      }
    } catch { /* default branch may not be ready yet */ }

    // Step 5: Scaffold all template files
    report('Scaffolding project files...');
    await this.scaffoldService.scaffoldAll(projectDir, {
      databricksHost: host,
      lakebaseProjectId,
      language: input.language || 'java',
      runnerType: input.runnerType || 'self-hosted',
      report: (message, detail) => report(message, detail),
    });

    // Step 6: Write .env with real connection values
    report('Writing .env configuration...');
    this.writeEnvFile(projectDir, host, lakebaseProjectId);

    // Step 7: Deploy .gitignore (ensure .env is ignored, merged with language-specific ignores)
    const language = input.language || 'java';
    await this.scaffoldService.deployGitignore(projectDir, language);

    // Step 8: Set up CI auth (GitHub only)
    if (useGithub) {
      report('Setting up CI auth (service principal)...');
      try {
        await syncCiSecrets(projectDir, 'GitHub Actions CI', 86400, this.githubService, this.gitService);
      } catch (err: any) {
        report(`Warning: CI auth setup failed (${err.message}). Run ./scripts/setup-ci-auth.sh manually.`);
      }
    } else {
      report('Skipping CI auth (no GitHub repository).');
    }

    // Step 9: Deploy runner (self-hosted + GitHub only)
    const runnerType = input.runnerType || 'self-hosted';
    if (useGithub && runnerType === 'self-hosted') {
      report('Setting up self-hosted runner...');
      const runnerService = new RunnerService(this.githubService);
      try {
        await runnerService.setupRunner(fullRepoName, lakebaseProjectId, (msg) => report(msg));
      } catch (err: any) {
        report(`Warning: runner setup failed (${err.message}). CI workflows will queue until a runner is available.`);
      }
    } else if (useGithub) {
      report('Using GitHub-hosted runners — no local runner needed.');
    } else {
      report('Skipping runner setup (no GitHub repository).');
    }

    // Step 10: Initial commit (+ push when GitHub is configured).
    // Pushing any .github/workflows/* file requires the `workflow` OAuth scope
    // on the VS Code GitHub token (see GITHUB_SCOPES). Re-sign in if push is
    // rejected with "workflow scope" — the raw remote message is opaque otherwise.
    const langLabels: Record<string, string> = {
      java: 'Java/Spring Boot',
      kotlin: 'Kotlin/Spring Boot',
      python: 'Python/FastAPI',
      nodejs: 'Node.js/Express',
    };
    const langLabel = langLabels[language] || language;
    report('Creating initial commit...');
    await exec('git add -A', { cwd: projectDir });
    await exec(`git commit -m "Initial project scaffold (${langLabel} + Lakebase)"`, { cwd: projectDir, timeout: 30000 });

    if (useGithub) {
      try {
        await exec('git push -u origin main', { cwd: projectDir, timeout: 30000 });
      } catch (err: any) {
        const msg = (err.stderr || err.stdout || err.message || '').toString();
        if (/without `?workflow`? scope|workflow scope/i.test(msg)) {
          throw new Error(
            `Push rejected: GitHub token lacks the \`workflow\` OAuth scope required for commits touching \`.github/workflows/*\`. The project on disk is fine; only the initial push failed.\n\n` +
            `To finish:\n` +
            `  1. Re-sign in to GitHub in VS Code and grant the workflow scope\n` +
            `  2. Then from the project dir:  cd ${projectDir} && git push -u origin main`
          );
        }
        throw err;
      }
    }

    // Step 11: Run health check (verify everything is in place)
    report('Verifying project...');
    const hooks = this.scaffoldService.verifyHooks(projectDir);
    const workflows = this.scaffoldService.verifyWorkflows(projectDir);
    if (!hooks.postCheckout || !hooks.prepareCommitMsg || !hooks.prePush) {
      report('Warning: some hooks not installed. Re-run scaffold or recreate the project.');
    }
    if (!workflows.pr || !workflows.merge) {
      report('Warning: some workflows missing.');
    }

    report('Project created successfully!');
    return {
      projectDir,
      githubRepoUrl: useGithub ? `https://github.com/${fullRepoName}` : undefined,
      lakebaseProjectId,
      lakebaseDefaultBranch: defaultBranchId,
    };
  }

  /**
   * Clean up a partially created project (for error recovery).
   */
  async cleanupProject(input: ProjectCreationInput): Promise<void> {
    const useGithub = input.createGithubRepo !== false && !!input.githubOwner;
    const fullRepoName = input.githubOwner ? `${input.githubOwner}/${input.projectName}` : '';
    const projectDir = path.join(input.parentDir, input.projectName);

    if (useGithub && fullRepoName) {
      try { await this.githubService.deleteRepo(fullRepoName); } catch {}
      try { await new RunnerService(this.githubService).removeRunner(fullRepoName, input.projectName); } catch {}
    }
    try { await this.lakebaseService.deleteProject(input.projectName); } catch {}
    try { if (fs.existsSync(projectDir)) { fs.rmSync(projectDir, { recursive: true, force: true }); } } catch {}
  }

  // ── Private ──────────────────────────────────────────────────────

  private writeEnvFile(projectDir: string, host: string, lakebaseProjectId: string): void {
    const envContent = [
      '# Lakebase project configuration',
      '# Created by Lakebase SCM Extension',
      '',
      `DATABRICKS_HOST=${host}`,
      `LAKEBASE_PROJECT_ID=${lakebaseProjectId}`,
      '',
      '# Connection (auto-populated on branch switch)',
      '# DATABASE_URL=',
      '# DB_USERNAME=',
      '# DB_PASSWORD=',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(projectDir, '.env'), envContent);
  }
}
