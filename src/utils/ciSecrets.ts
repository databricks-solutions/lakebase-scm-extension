import * as fs from 'fs';
import * as path from 'path';
import { exec } from './exec';

/**
 * Sync CI secrets (DATABRICKS_HOST, LAKEBASE_PROJECT_ID, DATABRICKS_TOKEN)
 * to the GitHub repo for the current workspace.
 *
 * @param root - Workspace root directory (must contain .env)
 * @param comment - Token comment (e.g. "GitHub Actions CI" or "CI merge")
 * @param lifetimeSeconds - Token lifetime (e.g. 86400 for PR, 3600 for merge)
 */
export async function syncCiSecrets(root: string, comment: string, lifetimeSeconds: number): Promise<void> {
  const envContent = fs.readFileSync(path.join(root, '.env'), 'utf-8');
  const getEnvVal = (key: string): string => {
    const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return match ? match[1].trim() : '';
  };

  const host = getEnvVal('DATABRICKS_HOST');
  const projectId = getEnvVal('LAKEBASE_PROJECT_ID');

  if (host) {
    await exec(`gh secret set DATABRICKS_HOST --body "${host}"`, { cwd: root, timeout: 30000 });
  }
  if (projectId) {
    await exec(`gh secret set LAKEBASE_PROJECT_ID --body "${projectId}"`, { cwd: root, timeout: 30000 });
  }

  // Generate a fresh Databricks token for CI
  try {
    const tokenRaw = await exec(
      `databricks tokens create --comment "${comment}" --lifetime-seconds ${lifetimeSeconds} -o json`,
      { cwd: root, timeout: 30000, env: { DATABRICKS_HOST: host } }
    );
    const token = JSON.parse(tokenRaw).token_value || JSON.parse(tokenRaw).token || '';
    if (token) {
      await exec(`gh secret set DATABRICKS_TOKEN --body "${token}"`, { cwd: root, timeout: 30000 });
    }
  } catch {
    // Token creation may fail — fall back to existing token from .env
    const existingToken = getEnvVal('DATABRICKS_TOKEN');
    if (existingToken) {
      await exec(`gh secret set DATABRICKS_TOKEN --body "${existingToken}"`, { cwd: root, timeout: 30000 });
    }
  }
}
