import * as fs from 'fs';
import * as path from 'path';
import { exec } from './exec';
import { GitHubService } from '../services/githubService';
import { GitService } from '../services/gitService';

/**
 * Sync CI secrets (DATABRICKS_HOST, LAKEBASE_PROJECT_ID, DATABRICKS_TOKEN)
 * to the GitHub repo for the current workspace via Octokit
 * ({@link GitHubService.setRepoSecrets}).
 *
 * Creates a fresh Databricks PAT when possible; falls back to `.env` token.
 */
export async function syncCiSecrets(
  root: string,
  comment: string,
  lifetimeSeconds: number,
  githubService: GitHubService,
  gitService: GitService,
): Promise<void> {
  const ownerRepo = await gitService.getOwnerRepo(root);
  if (!ownerRepo) {
    throw new Error('Could not resolve GitHub repository from git remote');
  }

  const envContent = fs.readFileSync(path.join(root, '.env'), 'utf-8');
  const getEnvVal = (key: string): string => {
    const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match ? match[1].trim() : '';
  };

  const host = getEnvVal('DATABRICKS_HOST');
  const projectId = getEnvVal('LAKEBASE_PROJECT_ID');
  const secrets: Record<string, string> = {};

  if (host) { secrets.DATABRICKS_HOST = host; }
  if (projectId) { secrets.LAKEBASE_PROJECT_ID = projectId; }

  try {
    const tokenRaw = await exec(
      `databricks tokens create --comment "${comment}" --lifetime-seconds ${lifetimeSeconds} -o json`,
      { cwd: root, timeout: 30000, env: { DATABRICKS_HOST: host } }
    );
    const token = JSON.parse(tokenRaw).token_value || JSON.parse(tokenRaw).token || '';
    if (token) {
      secrets.DATABRICKS_TOKEN = token;
    }
  } catch {
    const existingToken = getEnvVal('DATABRICKS_TOKEN');
    if (existingToken) {
      secrets.DATABRICKS_TOKEN = existingToken;
    }
  }

  if (Object.keys(secrets).length > 0) {
    await githubService.setRepoSecrets(ownerRepo, secrets);
  }
}
