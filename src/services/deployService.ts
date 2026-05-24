import * as fs from 'fs';
import * as path from 'path';
import { exec } from '../utils/exec';
import { getWorkspaceRoot } from '../utils/config';

export interface DeployTarget {
  workspace_profile: string;
  workspace_path: string;
  app_name: string;
  lakebase_project: string;
  lakebase_branch: string;
  uc_catalog?: string;
  uc_schema?: string;
  uc_volume?: string;
  lakebase_secret_scope?: string;
  lakebase_secret_key?: string;
  ai_model?: string;
}

export interface DeployTargetsConfig {
  targets: Record<string, DeployTarget>;
}

export type DeployPhase = 'build' | 'config' | 'infra' | 'upload' | 'deploy' | 'done';
type ProgressCallback = (message: string, phase?: DeployPhase) => void;

/**
 * Service for deploying applications to Databricks Apps.
 *
 * Workflow:
 * 1. Build frontend (if client/ exists)
 * 2. Generate app.yaml with target's Lakebase + UC + secret config
 * 2.5. Ensure Lakebase project + branch exist
 * 2.6. Ensure UC infrastructure exists (catalog, schema, volume)
 * 3. Upload source files to Databricks workspace (per-file for reliability)
 * 4. Ensure Databricks App exists (create if missing)
 * 4.5. Grant app SP access to Lakebase project + UC catalog
 * 4.6. Set up secret-based Lakebase auth (if target specifies it)
 * 5. Deploy the Databricks App
 * 6. Run seed data (if scripts/seed-data/ exists)
 */
export class DeployService {
  /**
   * Read deploy-targets.yaml from the workspace root.
   * Uses a lightweight YAML parser for the fixed config structure.
   */
  static readTargets(workspaceRoot?: string): DeployTargetsConfig | null {
    const root = workspaceRoot || getWorkspaceRoot();
    if (!root) { return null; }
    const targetsFile = path.join(root, 'deploy-targets.yaml');
    if (!fs.existsSync(targetsFile)) { return null; }
    const content = fs.readFileSync(targetsFile, 'utf-8');
    return DeployService.parseTargetsYaml(content);
  }

  /**
   * Parse deploy-targets.yaml content.
   * Handles the fixed structure: targets → target_name → key: value
   */
  static parseTargetsYaml(content: string): DeployTargetsConfig {
    const targets: Record<string, DeployTarget> = {};
    let currentTarget: string | null = null;
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith('#')) { continue; }

      // Top-level "targets:" — skip
      if (trimmed === 'targets:') { continue; }

      // Target name (2-space indent, ends with colon)
      const targetMatch = trimmed.match(/^  (\S+):$/);
      if (targetMatch) {
        currentTarget = targetMatch[1];
        targets[currentTarget] = {} as DeployTarget;
        continue;
      }

      // Key-value pair (4-space indent)
      const kvMatch = trimmed.match(/^    (\S+):\s*"?([^"]*)"?\s*$/);
      if (kvMatch && currentTarget) {
        const key = kvMatch[1] as keyof DeployTarget;
        targets[currentTarget][key] = kvMatch[2];
      }
    }

    return { targets };
  }

  /**
   * Write deploy-targets.yaml back to the workspace root.
   */
  static writeTargets(config: DeployTargetsConfig, workspaceRoot?: string): void {
    const root = workspaceRoot || getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root found'); }
    const targetsFile = path.join(root, 'deploy-targets.yaml');
    let yaml = 'targets:\n';
    for (const [name, target] of Object.entries(config.targets)) {
      yaml += `  ${name}:\n`;
      yaml += `    workspace_profile: ${target.workspace_profile}\n`;
      yaml += `    workspace_path: ${target.workspace_path}\n`;
      yaml += `    app_name: ${target.app_name}\n`;
      yaml += `    lakebase_project: ${target.lakebase_project}\n`;
      yaml += `    lakebase_branch: ${target.lakebase_branch}\n`;
      if (target.uc_catalog) { yaml += `    uc_catalog: ${target.uc_catalog}\n`; }
      if (target.uc_schema) { yaml += `    uc_schema: ${target.uc_schema}\n`; }
      if (target.uc_volume) { yaml += `    uc_volume: ${target.uc_volume}\n`; }
      if (target.lakebase_secret_scope) { yaml += `    lakebase_secret_scope: ${target.lakebase_secret_scope}\n`; }
      if (target.lakebase_secret_key) { yaml += `    lakebase_secret_key: ${target.lakebase_secret_key}\n`; }
      if (target.ai_model) { yaml += `    ai_model: ${target.ai_model}\n`; }
    }
    fs.writeFileSync(targetsFile, yaml);
  }

  /**
   * Get available target names.
   */
  static getTargetNames(workspaceRoot?: string): string[] {
    const config = DeployService.readTargets(workspaceRoot);
    if (!config?.targets) { return []; }
    return Object.keys(config.targets);
  }

  /**
   * Resolve the workspace host URL from a Databricks CLI profile.
   */
  static async resolveWorkspaceHost(profile: string): Promise<string | undefined> {
    try {
      const raw = await exec(`databricks auth env --profile "${profile}"`);
      const env = JSON.parse(raw);
      return env.DATABRICKS_HOST?.replace(/\/+$/, '');
    } catch {
      return undefined;
    }
  }

  /**
   * Ensure Lakebase project and branch exist on the target workspace.
   * Creates the project if missing (long-running ~30s), then checks/creates the branch.
   */
  static async ensureLakebaseInfrastructure(
    profile: string,
    projectId: string,
    branchId: string,
    progress?: ProgressCallback,
  ): Promise<void> {
    // Check if project exists
    progress?.(`Checking Lakebase project: ${projectId}...`, 'infra');
    let projectExists = false;
    try {
      const raw = await exec(`databricks postgres list-projects -o json --profile "${profile}"`, { timeout: 30000 });
      const parsed = JSON.parse(raw);
      const projects = Array.isArray(parsed) ? parsed : parsed.projects || [];
      projectExists = projects.some((p: any) =>
        p.name === `projects/${projectId}` || p.uid === projectId || p.displayName === projectId
      );
    } catch {
      // list-projects failed — try creating anyway
    }

    if (!projectExists) {
      progress?.(`Creating Lakebase project: ${projectId} (this may take ~30s)...`, 'infra');
      await exec(`databricks postgres create-project "${projectId}" -o json --profile "${profile}"`, { timeout: 120000 });
      progress?.('Lakebase project created', 'infra');
    }

    // Check if branch exists
    progress?.(`Checking Lakebase branch: ${branchId}...`, 'infra');
    let branchExists = false;
    try {
      const raw = await exec(
        `databricks postgres list-branches "projects/${projectId}" -o json --profile "${profile}"`,
        { timeout: 30000 }
      );
      const parsed = JSON.parse(raw);
      const branches = Array.isArray(parsed) ? parsed : parsed.branches || [];
      branchExists = branches.some((b: any) => {
        const name = b.name || '';
        const id = name.split('/').pop() || '';
        return id === branchId || b.branchId === branchId;
      });
    } catch {
      // list-branches failed — branch might still exist
    }

    if (!branchExists) {
      // For deploy targets, the branch is typically "production" (the default).
      // If it's the default branch, it was created with the project. Only create non-default branches.
      if (branchId !== 'production' && branchId !== 'main') {
        progress?.(`Creating Lakebase branch: ${branchId}...`, 'infra');
        const spec = JSON.stringify({ spec: { source_branch: `projects/${projectId}/branches/main`, no_expiry: true } });
        await exec(
          `databricks postgres create-branch "projects/${projectId}" "${branchId}" --json '${spec}' --profile "${profile}"`,
          { timeout: 120000 }
        );
        progress?.('Lakebase branch created', 'infra');
      }
    }

    progress?.('Lakebase infrastructure ready', 'infra');
  }

  /**
   * Get the service principal client ID for a Databricks App.
   */
  static async getAppSpClientId(profile: string, appName: string): Promise<string | undefined> {
    try {
      const raw = await exec(`databricks apps get "${appName}" --profile "${profile}" -o json`);
      const parsed = JSON.parse(raw);
      return parsed.service_principal_client_id || parsed.id;
    } catch {
      return undefined;
    }
  }

  /**
   * Grant the app's service principal access to the Lakebase project and UC catalog.
   * Uses the permissions API with the SP's application_id (client_id) as service_principal_name.
   */
  static async grantAppPermissions(
    profile: string,
    appName: string,
    lbProjectId: string,
    ucCatalog: string | undefined,
    progress?: ProgressCallback,
  ): Promise<void> {
    const spClientId = await DeployService.getAppSpClientId(profile, appName);
    if (!spClientId) {
      progress?.('⚠ Could not resolve app service principal — skipping permission grants', 'infra');
      return;
    }

    // Grant CAN_MANAGE on Lakebase project
    progress?.('Granting app access to Lakebase project...', 'infra');
    try {
      await exec(`databricks api patch /api/2.0/permissions/database-projects/${lbProjectId} --profile "${profile}" --json '${JSON.stringify({
        access_control_list: [{ service_principal_name: spClientId, permission_level: 'CAN_MANAGE' }]
      })}'`);
    } catch {
      progress?.('⚠ Could not grant Lakebase project access — you may need to grant manually', 'infra');
    }

    // Grant USE CATALOG + volume access on UC catalog
    if (ucCatalog) {
      progress?.('Granting app access to UC catalog...', 'infra');
      try {
        await exec(`databricks api patch /api/2.1/unity-catalog/permissions/catalog/${ucCatalog} --profile "${profile}" --json '${JSON.stringify({
          changes: [{ principal: spClientId, add: ['USE_CATALOG', 'USE_SCHEMA', 'READ_VOLUME', 'WRITE_VOLUME'] }]
        })}'`);
      } catch {
        progress?.('⚠ Could not grant UC catalog access — you may need to grant manually', 'infra');
      }
    }
  }

  /**
   * Ensure Lakebase secret-based auth is set up for workspaces where SP auth
   * doesn't work (non-FEVM workspaces).
   *
   * Creates a secret scope, generates a PAT for the deploying user, stores it
   * in the scope, and grants the app's SP READ access.
   *
   * Returns the scope and key names (for inclusion in deploy-targets.yaml).
   */
  static async ensureLakebaseSecretAuth(
    profile: string,
    appName: string,
    scopeName: string,
    keyName: string,
    progress?: ProgressCallback,
  ): Promise<{ scope: string; key: string }> {
    const spClientId = await DeployService.getAppSpClientId(profile, appName);

    // 1. Create secret scope (idempotent — ignore "already exists" errors)
    progress?.(`Creating secret scope: ${scopeName}...`, 'infra');
    try {
      await exec(`databricks secrets create-scope "${scopeName}" --profile "${profile}"`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already exists') && !msg.includes('SCOPE_ALREADY_EXISTS')) {
        throw err;
      }
    }

    // 2. Generate a PAT for the deploying user (90-day lifetime)
    progress?.('Generating PAT for Lakebase auth...', 'infra');
    const tokenResult = await exec(
      `databricks tokens create --comment "Lakebase auth for ${appName}" --lifetime-seconds 7776000 -o json --profile "${profile}"`,
      { timeout: 30000 }
    );
    const tokenParsed = JSON.parse(tokenResult);
    const pat = tokenParsed.token_value;
    if (!pat) {
      throw new Error('PAT generation returned no token_value');
    }

    // 3. Store the PAT in the secret scope
    progress?.('Storing PAT in secret scope...', 'infra');
    await exec(
      `databricks secrets put-secret "${scopeName}" "${keyName}" --string-value "${pat}" --profile "${profile}"`
    );

    // 4. Grant the app's SP READ access to the scope
    if (spClientId) {
      progress?.('Granting app SP access to secret scope...', 'infra');
      try {
        await exec(
          `databricks secrets put-acl "${scopeName}" "${spClientId}" READ --profile "${profile}"`
        );
      } catch {
        progress?.('⚠ Could not grant SP access to secret scope — you may need to grant manually', 'infra');
      }
    }

    progress?.('Lakebase secret auth configured', 'infra');
    return { scope: scopeName, key: keyName };
  }

  /**
   * Check whether a UC catalog exists on the target workspace.
   */
  static async catalogExists(profile: string, catalog: string): Promise<boolean> {
    try {
      await exec(`databricks api get /api/2.1/unity-catalog/catalogs/${catalog} --profile "${profile}"`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Try to create a UC catalog programmatically.
   * Returns true if created, false if blocked (Default Storage workspaces reject this).
   */
  static async tryCreateCatalog(profile: string, catalog: string): Promise<boolean> {
    try {
      await exec(`databricks api post /api/2.1/unity-catalog/catalogs --profile "${profile}" --json '${JSON.stringify({
        name: catalog, comment: 'Created by Lakebase SCM deploy'
      })}'`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the Catalog Explorer URL for a workspace.
   */
  static catalogExplorerUrl(workspaceHost: string): string {
    return `${workspaceHost}/explore/data`;
  }

  /**
   * Ensure UC schema and volume exist (catalog must already exist).
   * Creates schema and volume if missing.
   */
  static async ensureSchemaAndVolume(
    profile: string,
    catalog: string,
    schema: string,
    volume: string,
    progress?: ProgressCallback,
  ): Promise<void> {
    // Check/create schema
    progress?.(`Checking UC schema: ${catalog}.${schema}...`, 'infra');
    try {
      await exec(`databricks api get /api/2.1/unity-catalog/schemas/${catalog}.${schema} --profile "${profile}"`);
    } catch {
      progress?.(`Creating UC schema: ${catalog}.${schema}...`, 'infra');
      await exec(`databricks api post /api/2.1/unity-catalog/schemas --profile "${profile}" --json '${JSON.stringify({
        name: schema, catalog_name: catalog, comment: 'Created by Lakebase SCM deploy'
      })}'`);
    }

    // Check/create volume
    progress?.(`Checking UC volume: ${catalog}.${schema}.${volume}...`, 'infra');
    try {
      await exec(`databricks api get /api/2.1/unity-catalog/volumes/${catalog}.${schema}.${volume} --profile "${profile}"`);
    } catch {
      progress?.(`Creating UC volume: ${catalog}.${schema}.${volume}...`, 'infra');
      await exec(`databricks api post /api/2.1/unity-catalog/volumes --profile "${profile}" --json '${JSON.stringify({
        catalog_name: catalog, schema_name: schema, name: volume,
        volume_type: 'MANAGED', comment: 'Created by Lakebase SCM deploy'
      })}'`);
    }

    progress?.('UC infrastructure ready', 'infra');
  }

  static async deploy(
    targetName: string,
    workspaceRoot?: string,
    progress?: ProgressCallback,
  ): Promise<{ success: boolean; appUrl?: string; workspaceHost?: string; error?: string }> {
    const root = workspaceRoot || getWorkspaceRoot();
    if (!root) {
      return { success: false, error: 'No workspace root found' };
    }

    const config = DeployService.readTargets(root);
    if (!config?.targets?.[targetName]) {
      return { success: false, error: `Target "${targetName}" not found in deploy-targets.yaml` };
    }

    const target = config.targets[targetName];
    const { workspace_profile: profile, workspace_path: wsPath, app_name: appName,
            lakebase_project: lbProject, lakebase_branch: lbBranch } = target;

    // Resolve workspace host for console URLs
    let workspaceHost: string | undefined;
    try {
      workspaceHost = await DeployService.resolveWorkspaceHost(profile);
    } catch {
      // Non-critical — deploy still works without clickable links
    }

    // Save original app.yaml before modification so we can restore after deploy
    const appYamlPath = path.join(root, 'app.yaml');
    const appYamlOriginal = fs.existsSync(appYamlPath) ? fs.readFileSync(appYamlPath, 'utf-8') : null;

    try {
      // Step 1: Build frontend (if client/ exists)
      const clientDir = path.join(root, 'client');
      if (fs.existsSync(path.join(clientDir, 'package.json'))) {
        progress?.('Building frontend...', 'build');
        await exec('npm run build', { cwd: clientDir, timeout: 120000 });
      }

      // Step 2: Generate app.yaml with target's env config
      if (appYamlOriginal) {
        progress?.('Generating app.yaml...', 'config');
        // Extract command block (everything before "env:")
        const envIndex = appYamlOriginal.indexOf('\nenv:');
        const commandBlock = envIndex >= 0 ? appYamlOriginal.substring(0, envIndex + 1) : appYamlOriginal + '\n';

        // Build env block dynamically from target config
        const envVars: { name: string; value: string }[] = [
          { name: 'LAKEBASE_PROJECT_ID', value: lbProject },
          { name: 'LAKEBASE_BRANCH_ID', value: lbBranch },
        ];
        if (target.uc_catalog) { envVars.push({ name: 'UC_CATALOG', value: target.uc_catalog }); }
        if (target.uc_schema) { envVars.push({ name: 'UC_SCHEMA', value: target.uc_schema }); }
        if (target.uc_volume) { envVars.push({ name: 'UC_VOLUME', value: target.uc_volume }); }
        if (target.lakebase_secret_scope) { envVars.push({ name: 'LAKEBASE_SECRET_SCOPE', value: target.lakebase_secret_scope }); }
        if (target.lakebase_secret_key) { envVars.push({ name: 'LAKEBASE_SECRET_KEY', value: target.lakebase_secret_key }); }
        if (target.ai_model) { envVars.push({ name: 'AI_MODEL', value: target.ai_model }); }

        const envBlock = 'env:\n' + envVars.map(v => `  - name: ${v.name}\n    value: "${v.value}"`).join('\n');
        fs.writeFileSync(appYamlPath, commandBlock + envBlock + '\n');
      }

      // Step 2.5: Ensure Lakebase project + branch exist
      await DeployService.ensureLakebaseInfrastructure(profile, lbProject, lbBranch, progress);

      // Step 2.6: Ensure UC infrastructure exists (if configured)
      if (target.uc_catalog && target.uc_schema && target.uc_volume) {
        progress?.(`Checking UC catalog: ${target.uc_catalog}...`, 'infra');
        const catalogOk = await DeployService.catalogExists(profile, target.uc_catalog);
        if (!catalogOk) {
          // Try to create it programmatically (works on non-Default-Storage workspaces)
          progress?.(`Catalog not found — attempting to create ${target.uc_catalog}...`, 'infra');
          const created = await DeployService.tryCreateCatalog(profile, target.uc_catalog);
          if (!created) {
            // Default Storage workspace — need manual creation
            // Return a specific error so the caller can handle the interactive flow
            return {
              success: false,
              workspaceHost,
              error: `CATALOG_MISSING:${target.uc_catalog}`,
            };
          }
        }
        await DeployService.ensureSchemaAndVolume(
          profile, target.uc_catalog, target.uc_schema, target.uc_volume, progress
        );
      }

      // Step 3: Upload source files (per-file for reliability)
      // IMPORTANT: databricks workspace import-dir does NOT reliably update
      // Python files. Always use per-file workspace import --overwrite.
      progress?.('Uploading source to workspace...', 'upload');
      const uploadCount = await DeployService.uploadSource(root, wsPath, profile, progress);
      progress?.(`Uploaded ${uploadCount} files`, 'upload');

      // Step 4: Ensure app exists (create if missing)
      progress?.('Checking app...', 'deploy');
      try {
        await exec(`databricks apps get "${appName}" --profile "${profile}"`);
      } catch {
        progress?.(`App "${appName}" not found — creating...`, 'deploy');
        await exec(
          `databricks apps create "${appName}" --description "Deployed by Lakebase SCM" --no-wait --profile "${profile}"`,
          { timeout: 60000 }
        );
      }

      // Step 4.5: Grant app SP access to Lakebase project + UC catalog
      await DeployService.grantAppPermissions(
        profile, appName, lbProject, target.uc_catalog, progress
      );

      // Step 4.6: Set up secret-based Lakebase auth (if target specifies it)
      if (target.lakebase_secret_scope && target.lakebase_secret_key) {
        await DeployService.ensureLakebaseSecretAuth(
          profile, appName, target.lakebase_secret_scope, target.lakebase_secret_key, progress
        );
      }

      // Step 5: Deploy the app (apps deploy waits for completion — allow 10 minutes)
      progress?.(`Deploying ${appName}...`, 'deploy');
      await exec(
        `databricks apps deploy "${appName}" --source-code-path "${wsPath}" --profile "${profile}"`,
        { cwd: root, timeout: 600000 }
      );

      // Extract app URL
      let appUrl: string | undefined;
      try {
        const getOutput = await exec(
          `databricks apps get "${appName}" --profile "${profile}"`,
          { cwd: root }
        );
        const appInfo = JSON.parse(getOutput);
        appUrl = appInfo.url;
      } catch {
        // Non-critical
      }

      // Step 6: Run seed data (if seed files exist)
      await DeployService.runSeedData(root, targetName, progress);

      return { success: true, appUrl, workspaceHost };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    } finally {
      // Restore original app.yaml so the local copy stays clean
      if (appYamlOriginal !== null) {
        fs.writeFileSync(appYamlPath, appYamlOriginal);
      }
    }
  }

  /**
   * Run seed data scripts if they exist in the project.
   * Looks for scripts/seed-data/seed_demo_data.py (primary) or any .py/.sql
   * files in scripts/seed-data/.
   */
  private static async runSeedData(
    projectRoot: string,
    targetName: string,
    progress?: ProgressCallback,
  ): Promise<void> {
    const seedDir = path.join(projectRoot, 'scripts', 'seed-data');
    if (!fs.existsSync(seedDir)) {
      return;
    }

    // Prefer seed_demo_data.py (supports --target)
    const demoSeed = path.join(seedDir, 'seed_demo_data.py');
    if (fs.existsSync(demoSeed)) {
      progress?.('Running seed data...', 'done');
      const args = [`--target`, targetName];
      if (fs.existsSync(path.join(seedDir, 'sfdc_partners.csv'))) {
        args.push('--with-partners');
      }
      try {
        await exec(
          `uv run python scripts/seed-data/seed_demo_data.py ${args.join(' ')}`,
          { cwd: projectRoot, timeout: 120000 }
        );
        progress?.('Seed data applied', 'done');
      } catch {
        progress?.('⚠ Seed data failed — you may need to run it manually', 'done');
      }
      return;
    }

    // Fallback: run any .py files in seed-data/ directory
    const seedFiles = fs.readdirSync(seedDir).filter(f => f.endsWith('.py'));
    if (seedFiles.length > 0) {
      progress?.(`Found ${seedFiles.length} seed file(s) — run manually: uv run python scripts/seed-data/<file> --target ${targetName}`, 'done');
    }
  }

  /**
   * Upload project source files to workspace, per-file for reliability.
   */
  private static async uploadSource(
    projectRoot: string,
    workspacePath: string,
    profile: string,
    progress?: ProgressCallback,
  ): Promise<number> {
    let count = 0;
    const createdDirs = new Set<string>();

    const ensureRemoteDir = async (remoteDirPath: string) => {
      if (createdDirs.has(remoteDirPath)) { return; }
      await exec(
        `databricks workspace mkdirs "${remoteDirPath}" --profile "${profile}"`
      );
      createdDirs.add(remoteDirPath);
    };

    // Ensure the root workspace path exists (first deploy to a new workspace)
    await ensureRemoteDir(workspacePath);

    const uploadFile = async (relPath: string) => {
      const localPath = path.join(projectRoot, relPath);
      const remotePath = `${workspacePath}/${relPath}`;
      // Ensure the parent directory exists in the workspace
      const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
      if (remoteDir !== workspacePath) {
        await ensureRemoteDir(remoteDir);
      }
      await exec(
        `databricks workspace import "${remotePath}" --file "${localPath}" --format AUTO --overwrite --profile "${profile}"`
      );
      count++;
    };

    // Upload root config files
    for (const f of ['app.yaml', 'pyproject.toml', 'uv.lock', 'alembic.ini', 'package.json']) {
      if (fs.existsSync(path.join(projectRoot, f))) {
        await uploadFile(f);
      }
    }

    // Upload app/ directory (Python source)
    progress?.('Uploading app/ ...');
    await DeployService.uploadDir(projectRoot, 'app', uploadFile, ['.py']);

    // Upload alembic/ directory (migrations)
    progress?.('Uploading alembic/ ...');
    await DeployService.uploadDir(projectRoot, 'alembic', uploadFile, ['.py', '.ini', '.mako']);

    // Upload static/ directory (built frontend)
    if (fs.existsSync(path.join(projectRoot, 'static'))) {
      progress?.('Uploading static/ ...');
      await DeployService.uploadDir(projectRoot, 'static', uploadFile);
    }

    return count;
  }

  /**
   * Recursively upload files from a directory, optionally filtered by extension.
   */
  private static async uploadDir(
    projectRoot: string,
    dirRelPath: string,
    uploadFn: (relPath: string) => Promise<void>,
    extensions?: string[],
  ): Promise<void> {
    const fullDir = path.join(projectRoot, dirRelPath);
    if (!fs.existsSync(fullDir)) { return; }

    for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
      const relPath = path.join(dirRelPath, entry.name);
      if (entry.isDirectory()) {
        await DeployService.uploadDir(projectRoot, relPath, uploadFn, extensions);
      } else if (!extensions || extensions.some(ext => entry.name.endsWith(ext))) {
        await uploadFn(relPath);
      }
    }
  }
}
