import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from '../utils/exec';
import { patchPomForLakebase } from '../utils/pomPatch';
import { extractZipToDir } from '../utils/zipExtract';
import {
  SpringInitializrClient,
  SpringJvmLanguage,
  InitializrNetworkError,
} from './springInitializrClient';

export type ProjectLanguage = 'java' | 'kotlin' | 'python' | 'nodejs';

export type ScaffoldReportFn = (message: string, detail?: string) => void;

/**
 * Service for scaffolding new Lakebase projects.
 * Deploys common files (scripts, workflows, hooks, config) plus language-specific
 * project files (Java/Kotlin via Spring Initializr, Python/FastAPI, Node.js/Express).
 */
export class ScaffoldService {
  private templateDir: string;

  constructor(
    extensionPath: string,
    private readonly initializrClient?: SpringInitializrClient,
  ) {
    this.templateDir = path.join(extensionPath, 'templates', 'project');
  }

  private commonDir(): string { return path.join(this.templateDir, 'common'); }
  private springDir(): string { return path.join(this.templateDir, 'spring'); }
  private langDir(language: ProjectLanguage): string { return path.join(this.templateDir, language); }

  private getInitializrClient(): SpringInitializrClient {
    if (this.initializrClient) {
      return this.initializrClient;
    }
    const baseUrl = vscode.workspace.getConfiguration('lakebaseSync').get<string>(
      'springInitializrUrl',
      'https://start.spring.io',
    );
    return new SpringInitializrClient(baseUrl);
  }

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

  /** Install git hooks by copying template scripts into `.git/hooks` (replaces `scripts/install-hook.sh`). */
  async installHooks(targetDir: string): Promise<string> {
    const scriptsDir = path.join(targetDir, 'scripts');
    const gitHooksDir = path.join(targetDir, '.git', 'hooks');
    if (!fs.existsSync(path.join(targetDir, '.git'))) {
      throw new Error(`Not a git repo root: ${targetDir}`);
    }
    fs.mkdirSync(gitHooksDir, { recursive: true });

    const hookPairs: Array<[string, string]> = [
      ['post-checkout.sh', 'post-checkout'],
      ['prepare-commit-msg.sh', 'prepare-commit-msg'],
      ['pre-push.sh', 'pre-push'],
      ['post-merge.sh', 'post-merge'],
    ];
    const installed: string[] = [];
    for (const [srcName, hookName] of hookPairs) {
      const src = path.join(scriptsDir, srcName);
      if (!fs.existsSync(src)) { continue; }
      const dest = path.join(gitHooksDir, hookName);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
      installed.push(hookName);
    }
    return `Installed hooks: ${installed.join(', ') || 'none'}`;
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
   * Java/Kotlin use Spring Initializr; Python/Node copy static templates.
   */
  async deployLanguageProject(
    targetDir: string,
    language: ProjectLanguage,
    projectName?: string,
    report?: ScaffoldReportFn,
  ): Promise<void> {
    if (language === 'java' || language === 'kotlin') {
      await this.deploySpringFromInitializr(targetDir, language, projectName, report);
      return;
    }

    const langSrc = this.langDir(language);
    if (!fs.existsSync(langSrc)) {
      throw new Error(`No template found for language: ${language}`);
    }
    this.copyDirWithSubstitution(langSrc, targetDir, projectName);
  }

  private async deploySpringFromInitializr(
    targetDir: string,
    language: SpringJvmLanguage,
    projectName?: string,
    report?: ScaffoldReportFn,
  ): Promise<void> {
    const label = language === 'kotlin' ? 'Kotlin' : 'Java';
    const useFallback = process.env.LAKEBASE_SCAFFOLD_FALLBACK === '1';

    if (useFallback) {
      report?.(`Using bundled ${label} template (LAKEBASE_SCAFFOLD_FALLBACK)...`);
      await this.deploySpringFallback(targetDir, language, projectName);
      await this.deploySpringOverlays(targetDir);
      return;
    }

    report?.(`Fetching Spring Boot project from start.spring.io (${label})...`);
    let initializrExtracted = false;
    try {
      const client = this.getInitializrClient();
      const metadata = await client.getMetadata();
      report?.(
        `Scaffolding Spring Boot ${metadata.bootVersion} (JVM ${metadata.javaVersion}, ${label})...`,
        `bootVersion=${metadata.bootVersion}`,
      );

      const zip = await client.generateMavenProject({
        language,
        artifactId: projectName || 'demo',
        name: projectName,
      });
      extractZipToDir(zip, targetDir);
      initializrExtracted = true;

      const pomPath = path.join(targetDir, 'pom.xml');
      if (!fs.existsSync(pomPath)) {
        throw new Error('Spring Initializr did not produce a Maven project (missing pom.xml)');
      }

      const mvnw = path.join(targetDir, 'mvnw');
      if (fs.existsSync(mvnw)) { fs.chmodSync(mvnw, 0o755); }

      await this.deploySpringOverlays(targetDir);
      patchPomForLakebase(pomPath);
    } catch (err) {
      if (initializrExtracted) {
        throw new Error(
          `Spring Initializr project was extracted but post-processing failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const reason = err instanceof InitializrNetworkError ? err.message : String(err);
      report?.(`Spring Initializr unavailable; using bundled ${label} template.`, reason);
      this.clearScaffoldArtifacts(targetDir);
      await this.deploySpringFallback(targetDir, language, projectName);
      await this.deploySpringOverlays(targetDir);
    }
  }

  /** Remove scaffold output while preserving an existing .git directory. */
  private clearScaffoldArtifacts(targetDir: string): void {
    if (!fs.existsSync(targetDir)) { return; }
    for (const entry of fs.readdirSync(targetDir)) {
      if (entry === '.git') { continue; }
      fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
    }
  }

  private async deploySpringFallback(
    targetDir: string,
    language: SpringJvmLanguage,
    projectName?: string,
  ): Promise<void> {
    const fallbackDir = path.join(this.langDir(language), 'fallback');
    if (!fs.existsSync(fallbackDir)) {
      throw new Error(`No fallback template found for language: ${language}`);
    }
    this.copyDirWithSubstitution(fallbackDir, targetDir, projectName);
    const mvnw = path.join(targetDir, 'mvnw');
    if (fs.existsSync(mvnw)) { fs.chmodSync(mvnw, 0o755); }
  }

  private async deploySpringOverlays(targetDir: string): Promise<void> {
    const overlayDir = this.springDir();
    if (!fs.existsSync(overlayDir)) {
      throw new Error(`Spring overlay template not found at ${overlayDir}`);
    }
    this.copyDirWithSubstitution(overlayDir, targetDir);
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
    report?: ScaffoldReportFn;
  }): Promise<{
    scripts: string[];
    workflows: string[];
    hooks: string;
  }> {
    const language = values?.language || 'java';
    const runnerType = values?.runnerType || 'self-hosted';
    const report = values?.report;

    // Common files
    await this.deployGitignore(targetDir, language);
    await this.deployEnvExample(targetDir, values);
    await this.deployVscodeSettings(targetDir);
    await this.deployDeployTargets(targetDir, values?.lakebaseProjectId);

    // Language-specific project files
    await this.deployLanguageProject(targetDir, language, values?.lakebaseProjectId, report);

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
      if (file === '.gitignore.extra' || file === 'fallback') { continue; }
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
