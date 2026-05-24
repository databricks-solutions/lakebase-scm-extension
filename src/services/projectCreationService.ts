import * as fs from 'fs';
import * as path from 'path';
import { GitService } from './gitService';
import { GitHubService } from './githubService';
import { LakebaseService } from './lakebaseService';
import { ScaffoldService } from './scaffoldService';
import { RunnerService } from './runnerService';
// The orchestrator now delegates to the substrate's createProject. Substrate
// is the single source of truth and the other services (already routed) are
// no longer reached through this DI graph. Constructor signature is preserved
// for caller compat. FEIP-7065.
import { createProject as substrateCreateProject } from '@databricks-solutions/lakebase-app-dev-kit';

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
  /** GitHub owner (user or org) – required when createGithubRepo is true */
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
 * UI prompt definitions – the caller (extension command) collects these
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
   *
   * Routes to substrate.createProject – the canonical 11-step orchestrator.
   * The class-level DI'd services (gitService, githubService, lakebaseService,
   * scaffoldService) are no longer reached through this method; the substrate
   * uses its own internal pieces, all of which the other services now also
   * delegate to. Behavior is identical.
   */
  async createProject(input: ProjectCreationInput, progress?: ProgressCallback): Promise<ProjectCreationResult> {
    const result = await substrateCreateProject(
      {
        projectName: input.projectName,
        parentDir: input.parentDir,
        databricksHost: input.databricksHost,
        githubOwner: input.githubOwner,
        createGithubRepo: input.createGithubRepo,
        privateRepo: input.privateRepo,
        language: input.language,
        runnerType: input.runnerType,
      },
      progress
    );
    return {
      projectDir: result.projectDir,
      githubRepoUrl: result.githubRepoUrl,
      lakebaseProjectId: result.lakebaseProjectId,
      lakebaseDefaultBranch: result.lakebaseDefaultBranch,
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

  // (`writeEnvFile` removed: superseded by substrate option 3. Substrate's
  // createProject no longer writes .env at all – only .env.example ships, and
  // the post-checkout hook bootstraps .env on first switch. Reintroducing a
  // local .env writer here would re-open the path that gitleaks correctly
  // rejected: tracked .env + JWT rewrite on checkout → staged credential.)
}
