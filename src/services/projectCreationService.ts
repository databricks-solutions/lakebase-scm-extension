import * as fs from 'fs';
import * as path from 'path';
import { GitService } from './gitService';
import { LakebaseService } from './lakebaseService';
import { ScaffoldService } from './scaffoldService';
import { RunnerService } from './runnerService';
import { exec } from '../utils/exec';
import { syncCiSecrets } from '../utils/ciSecrets';

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
      await this.gitService.createRepo(fullRepoName, {
        private: input.privateRepo !== false,
        clone: false,
        description: `Lakebase project: ${input.projectName}`,
      });

      // Step 2: Clone the repo. Two failure modes we've seen in practice:
      //   (a) propagation delay — `gh repo create` returned 201 but the repo
      //       isn't yet readable via the API/clone (EMU orgs with SAML can take
      //       10–20s, sometimes more)
      //   (b) SAML SSO authorization gap — gh token has scope to create in the
      //       org but hasn't been SSO-authorized for reads
      // Poll the API for visibility first (exposes both failure modes with the
      // real error), then clone. Backoff 1s, 2s, 3s, 5s, 8s — total ~19s max.
      report('Waiting for GitHub repo to be visible...', fullRepoName);
      const probeDelays = [1000, 2000, 3000, 5000, 8000];
      let probeErr = '';
      let visible = false;
      for (const delay of probeDelays) {
        try {
          await exec(`gh api repos/${fullRepoName} --jq '.full_name'`, { timeout: 8000 });
          visible = true;
          break;
        } catch (err: any) {
          probeErr = (err.stderr || err.message || '').toString();
          await new Promise(r => setTimeout(r, delay));
        }
      }
      if (!visible) {
        let activeUser = '';
        try { activeUser = (await exec(`gh api user --jq '.login'`, { timeout: 5000 })).trim(); } catch { /* ignore */ }
        const samlHint = /SAML|scope does not match|sso/i.test(probeErr)
          ? `\n\nThe error mentions SAML — your gh token may need SSO authorization for this org:\n    gh auth refresh -h github.com -s repo\n  (then click Authorize for the org during the SSO redirect)`
          : '';
        const userHint = activeUser && activeUser !== input.githubOwner
          ? `\n\nNote: gh is logged in as "${activeUser}", but the repo was created under "${input.githubOwner}". If those are different identities, the repo may have landed elsewhere — check with: gh repo list ${input.githubOwner} --limit 5`
          : '';
        throw new Error(
          `GitHub repo "${fullRepoName}" was created but isn't visible to the gh token after ~19s of polling. Project creation paused here.${samlHint}${userHint}\n\nLast probe error:\n  ${probeErr.split('\n')[0].slice(0, 200)}`
        );
      }
      report('Cloning repository...', projectDir);
      await exec(`gh repo clone "${fullRepoName}" "${projectDir}"`, { timeout: 30000 });
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
        await syncCiSecrets(projectDir, 'GitHub Actions CI', 86400);
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
      const runnerService = new RunnerService();
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
    // on whatever token gh/git is using. Default `gh auth login` doesn't grant
    // it. Preflight + clear error message — the raw "remote rejected ...
    // without `workflow` scope" output is opaque if you haven't seen it before.
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
        const ghStatus = await exec('gh auth status 2>&1', { timeout: 5_000 }).catch(() => '');
        if (ghStatus && !/Token scopes:[^\n]*\bworkflow\b/.test(ghStatus)) {
          report('⚠ gh CLI is missing the `workflow` OAuth scope; the upcoming push will be rejected because we scaffolded GitHub Actions workflows. Adding it now requires re-auth — best to run `gh auth refresh -s workflow` in a separate terminal, then retry the push from the project directory.');
        }
      } catch { /* preflight best-effort */ }

      try {
        await exec('git push -u origin main', { cwd: projectDir, timeout: 30000 });
      } catch (err: any) {
        const msg = (err.stderr || err.stdout || err.message || '').toString();
        if (/without `?workflow`? scope|workflow scope/i.test(msg)) {
          throw new Error(
            `Push rejected: gh CLI lacks the \`workflow\` OAuth scope, which GitHub requires for any commit that touches \`.github/workflows/*\`. The project on disk is fine; only the initial push failed.\n\n` +
            `To finish:\n` +
            `  1. Run in a terminal:  gh auth refresh -s workflow\n` +
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
      report('Warning: some hooks not installed. Run scripts/install-hook.sh');
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
      try { await this.gitService.deleteRepo(fullRepoName); } catch {}
      try { await new RunnerService().removeRunner(fullRepoName, input.projectName); } catch {}
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
