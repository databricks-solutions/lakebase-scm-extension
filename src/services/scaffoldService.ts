import * as fs from 'fs';
import * as path from 'path';
import { exec } from '../utils/exec';

export type ProjectLanguage = 'java' | 'python' | 'nodejs';

/**
 * Service for scaffolding new Lakebase projects.
 * Deploys common files (scripts, workflows, hooks, config) plus language-specific
 * project files (Java/Maven, Python/FastAPI, Node.js/Express).
 */
export class ScaffoldService {
  private templateDir: string;

  constructor(extensionPath: string) {
    this.templateDir = path.join(extensionPath, 'templates', 'project');
  }

  private commonDir(): string { return path.join(this.templateDir, 'common'); }
  private langDir(language: ProjectLanguage): string { return path.join(this.templateDir, language); }

  // ── Common file deployment ──────────────────────────────────────

  /** Deploy all scripts from common/scripts/ */
  async deployScripts(targetDir: string): Promise<string[]> {
    const srcDir = path.join(this.commonDir(), 'scripts');
    const destDir = path.join(targetDir, 'scripts');
    return this.copyDir(srcDir, destDir, true);
  }

  /** Deploy GitHub Actions workflows from common/.github/workflows/ */
  async deployWorkflows(targetDir: string): Promise<string[]> {
    const srcDir = path.join(this.commonDir(), '.github', 'workflows');
    const destDir = path.join(targetDir, '.github', 'workflows');
    return this.copyDir(srcDir, destDir, false);
  }

  /** Install git hooks by running scripts/install-hook.sh */
  async installHooks(targetDir: string): Promise<string> {
    const hookScript = path.join(targetDir, 'scripts', 'install-hook.sh');
    if (!fs.existsSync(hookScript)) {
      throw new Error(`install-hook.sh not found at ${hookScript}. Deploy scripts first.`);
    }
    return exec(`bash "${hookScript}"`, { cwd: targetDir });
  }

  /** Deploy .env.example with optional value substitution */
  async deployEnvExample(targetDir: string, values?: { databricksHost?: string; lakebaseProjectId?: string }): Promise<void> {
    const src = path.join(this.commonDir(), '.env.example');
    const dest = path.join(targetDir, '.env.example');
    let content = fs.readFileSync(src, 'utf-8');
    if (values?.databricksHost) {
      content = content.replace(/DATABRICKS_HOST=.*/, `DATABRICKS_HOST=${values.databricksHost}`);
    }
    if (values?.lakebaseProjectId) {
      content = content.replace(/LAKEBASE_PROJECT_ID=.*/, `LAKEBASE_PROJECT_ID=${values.lakebaseProjectId}`);
    }
    fs.writeFileSync(dest, content);
  }

  /** Deploy deploy-targets.yaml with optional project name substitution */
  async deployDeployTargets(targetDir: string, projectName?: string): Promise<void> {
    const src = path.join(this.commonDir(), 'deploy-targets.yaml');
    const dest = path.join(targetDir, 'deploy-targets.yaml');
    if (!fs.existsSync(src)) { return; }
    let content = fs.readFileSync(src, 'utf-8');
    if (projectName) {
      content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
    }
    fs.writeFileSync(dest, content);
  }

  /** Deploy .vscode/settings.json (disables built-in Git SCM) */
  async deployVscodeSettings(targetDir: string): Promise<void> {
    const src = path.join(this.commonDir(), '.vscode', 'settings.json');
    const destDir = path.join(targetDir, '.vscode');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, 'settings.json'));
  }

  /** Deploy .gitignore: merge common base + language-specific extras */
  async deployGitignore(targetDir: string, language: ProjectLanguage = 'java'): Promise<void> {
    const base = fs.readFileSync(path.join(this.commonDir(), '.gitignore.base'), 'utf-8');
    const extraPath = path.join(this.langDir(language), '.gitignore.extra');
    const extra = fs.existsSync(extraPath) ? fs.readFileSync(extraPath, 'utf-8') : '';
    fs.writeFileSync(path.join(targetDir, '.gitignore'), base + '\n' + extra);
  }

  // ── Language-specific deployment ────────────────────────────────

  /**
   * Deploy language-specific project files.
   * Copies the entire language template directory and performs placeholder substitution.
   * Skips .gitignore.extra (handled by deployGitignore).
   */
  async deployLanguageProject(targetDir: string, language: ProjectLanguage, projectName?: string): Promise<void> {
    const langSrc = this.langDir(language);
    if (!fs.existsSync(langSrc)) {
      throw new Error(`No template found for language: ${language}`);
    }

    // Copy all files from the language template
    this.copyDirWithSubstitution(langSrc, targetDir, projectName);

    // Set executable permissions where needed
    if (language === 'java') {
      const mvnw = path.join(targetDir, 'mvnw');
      if (fs.existsSync(mvnw)) { fs.chmodSync(mvnw, 0o755); }
    }
  }

  // ── Full scaffold ──────────────────────────────────────────────

  /**
   * Full scaffold: deploy common + language-specific files to a target directory.
   */
  async scaffoldAll(targetDir: string, values?: {
    databricksHost?: string;
    lakebaseProjectId?: string;
    language?: ProjectLanguage;
    runnerType?: 'self-hosted' | 'github-hosted';
  }): Promise<{
    scripts: string[];
    workflows: string[];
    hooks: string;
  }> {
    const language = values?.language || 'java';
    const runnerType = values?.runnerType || 'self-hosted';

    // Common files
    await this.deployGitignore(targetDir, language);
    await this.deployEnvExample(targetDir, values);
    await this.deployVscodeSettings(targetDir);
    await this.deployDeployTargets(targetDir, values?.lakebaseProjectId);

    // Language-specific project files
    await this.deployLanguageProject(targetDir, language, values?.lakebaseProjectId);

    // Scripts, workflows, hooks (common across all languages)
    const scripts = await this.deployScripts(targetDir);
    const workflows = await this.deployWorkflows(targetDir);

    // Patch workflows for runner type
    await this.patchWorkflowsForRunnerType(targetDir, runnerType);

    const hooks = await this.installHooks(targetDir);
    return { scripts, workflows, hooks };
  }

  /**
   * Patch pr.yml and merge.yml for the selected runner type.
   * Templates ship with github-hosted config (actions/setup-java, online Maven).
   * For self-hosted runners, replaces with local JDK detection and offline Maven.
   */
  async patchWorkflowsForRunnerType(targetDir: string, runnerType: 'self-hosted' | 'github-hosted'): Promise<void> {
    if (runnerType === 'github-hosted') { return; }

    const workflowDir = path.join(targetDir, '.github', 'workflows');
    const localJdkStep = [
      '- name: Set up JDK (local)',
      '        run: |',
      '          echo "Using local JDK:"',
      '          java -version',
      '          if [ -z "$JAVA_HOME" ]; then',
      '            export JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null || dirname $(dirname $(readlink -f $(which java))))"',
      '            echo "JAVA_HOME=$JAVA_HOME" >> $GITHUB_ENV',
      '          fi',
      '          echo "JAVA_HOME=$JAVA_HOME"',
      '',
    ].join('\n');

    for (const file of ['pr.yml', 'merge.yml']) {
      const filePath = path.join(workflowDir, file);
      if (!fs.existsSync(filePath)) { continue; }
      let content = fs.readFileSync(filePath, 'utf-8');

      // Replace actions/setup-java block with local JDK step
      content = content.replace(
        /- name: Set up JDK\n\s+uses: actions\/setup-java@v4\n\s+with:\n(?:\s+#[^\n]*\n)*(?:\s+[\w-]+:.*\n)+/g,
        localJdkStep
      );

      // Add -o (offline) to mvnw calls for local Maven cache
      content = content.replace(/\.\/mvnw /g, './mvnw -o ');

      fs.writeFileSync(filePath, content);
    }
  }

  // ── Verification ───────────────────────────────────────────────

  verifyHooks(targetDir: string): { postCheckout: boolean; prepareCommitMsg: boolean; prePush: boolean } {
    const hooksDir = path.join(targetDir, '.git', 'hooks');
    return {
      postCheckout: fs.existsSync(path.join(hooksDir, 'post-checkout')),
      prepareCommitMsg: fs.existsSync(path.join(hooksDir, 'prepare-commit-msg')),
      prePush: fs.existsSync(path.join(hooksDir, 'pre-push')),
    };
  }

  verifyWorkflows(targetDir: string): { pr: boolean; merge: boolean } {
    const wfDir = path.join(targetDir, '.github', 'workflows');
    return {
      pr: fs.existsSync(path.join(wfDir, 'pr.yml')),
      merge: fs.existsSync(path.join(wfDir, 'merge.yml')),
    };
  }

  // ── Private ────────────────────────────────────────────────────

  private copyDir(srcDir: string, destDir: string, makeExecutable: boolean): string[] {
    if (!fs.existsSync(srcDir)) { throw new Error(`Source directory not found: ${srcDir}`); }
    fs.mkdirSync(destDir, { recursive: true });
    const files = fs.readdirSync(srcDir);
    for (const file of files) {
      const srcPath = path.join(srcDir, file);
      const destPath = path.join(destDir, file);
      if (fs.statSync(srcPath).isDirectory()) {
        this.copyDir(srcPath, destPath, makeExecutable);
      } else {
        fs.copyFileSync(srcPath, destPath);
        if (makeExecutable && file.endsWith('.sh')) {
          fs.chmodSync(destPath, 0o755);
        }
      }
    }
    return files;
  }

  /** Copy directory with {{PROJECT_NAME}} placeholder substitution. Skips .gitignore.extra. */
  private copyDirWithSubstitution(srcDir: string, destDir: string, projectName?: string): void {
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      if (file === '.gitignore.extra') { continue; }
      const srcPath = path.join(srcDir, file);
      const destPath = path.join(destDir, file);
      if (fs.statSync(srcPath).isDirectory()) {
        this.copyDirWithSubstitution(srcPath, destPath, projectName);
      } else {
        let content = fs.readFileSync(srcPath, 'utf-8');
        if (projectName) {
          content = content.replace(/\{\{PROJECT_NAME\}\}/g, projectName);
        }
        fs.writeFileSync(destPath, content);
      }
    }
  }
}
