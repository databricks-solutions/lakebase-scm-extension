// Thin proxy over @databricks-solutions/lakebase-scm-workflow-scripts.
//
// Substrate source: scripts/lakebase/scaffold.ts (+ scaffold-language.ts,
// spring-initializr.ts, project-verify.ts). The extension keeps the
// ScaffoldService class shell so call sites in the extension don't change,
// but every method body delegates to the substrate. Templates ship with both
// the extension (.vsix) and the substrate (node_modules); we pass the
// extension's bundled location through to keep behavior identical.
//
// FEIP-7065 (publish_and_consume).

import * as path from "path";
import * as vscode from "vscode";
import {
  SpringInitializrClient,
  deployScripts as substrateDeployScripts,
  deployWorkflows as substrateDeployWorkflows,
  installHooks as substrateInstallHooks,
  deployEnvExample as substrateDeployEnvExample,
  deployDeployTargets as substrateDeployDeployTargets,
  deployVscodeSettings as substrateDeployVscodeSettings,
  deployGitignore as substrateDeployGitignore,
  patchWorkflowsForRunnerType as substratePatchWorkflowsForRunnerType,
  scaffoldAll as substrateScaffoldAll,
  deployLanguageProject as substrateDeployLanguageProject,
  verifyHooks as substrateVerifyHooks,
  verifyWorkflows as substrateVerifyWorkflows,
} from "@databricks-solutions/lakebase-scm-workflow-scripts";

export type ProjectLanguage = "java" | "kotlin" | "python" | "nodejs";

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
    this.templateDir = path.join(extensionPath, "templates", "project");
  }

  private getInitializrClient(): SpringInitializrClient {
    if (this.initializrClient) { return this.initializrClient; }
    const baseUrl = vscode.workspace.getConfiguration("lakebaseSync").get<string>(
      "springInitializrUrl",
      "https://start.spring.io",
    );
    return new SpringInitializrClient(baseUrl);
  }

  // ── Common file deployment ──────────────────────────────────────

  async deployScripts(targetDir: string): Promise<string[]> {
    return substrateDeployScripts(targetDir, { templatesDir: this.templateDir });
  }

  async deployWorkflows(targetDir: string): Promise<string[]> {
    return substrateDeployWorkflows(targetDir, { templatesDir: this.templateDir });
  }

  async installHooks(targetDir: string): Promise<string> {
    return substrateInstallHooks(targetDir);
  }

  async deployEnvExample(
    targetDir: string,
    values?: { databricksHost?: string; lakebaseProjectId?: string },
  ): Promise<void> {
    return substrateDeployEnvExample(targetDir, {
      templatesDir: this.templateDir,
      databricksHost: values?.databricksHost,
      lakebaseProjectId: values?.lakebaseProjectId,
    });
  }

  async deployDeployTargets(targetDir: string, projectName?: string): Promise<void> {
    return substrateDeployDeployTargets(targetDir, projectName, { templatesDir: this.templateDir });
  }

  async deployVscodeSettings(targetDir: string): Promise<void> {
    return substrateDeployVscodeSettings(targetDir, { templatesDir: this.templateDir });
  }

  async deployGitignore(targetDir: string, language: ProjectLanguage = "java"): Promise<void> {
    return substrateDeployGitignore(targetDir, language, { templatesDir: this.templateDir });
  }

  // ── Language-specific deployment ────────────────────────────────

  async deployLanguageProject(
    targetDir: string,
    language: ProjectLanguage,
    projectName?: string,
    report?: ScaffoldReportFn,
  ): Promise<void> {
    return substrateDeployLanguageProject({
      targetDir,
      language,
      projectName,
      report,
      templatesDir: this.templateDir,
      initializrClient: this.getInitializrClient(),
    });
  }

  // ── Full scaffold ──────────────────────────────────────────────

  async scaffoldAll(
    targetDir: string,
    values?: {
      databricksHost?: string;
      lakebaseProjectId?: string;
      language?: ProjectLanguage;
      runnerType?: "self-hosted" | "github-hosted";
      report?: ScaffoldReportFn;
    },
  ): Promise<{ scripts: string[]; workflows: string[]; hooks: string }> {
    // Substrate returns `hooksInstalled`; extension callers expect `hooks`.
    const { scripts, workflows, hooksInstalled } = await substrateScaffoldAll({
      targetDir,
      databricksHost: values?.databricksHost,
      lakebaseProjectId: values?.lakebaseProjectId,
      language: values?.language ?? "java",
      runnerType: values?.runnerType ?? "self-hosted",
      report: values?.report,
      templatesDir: this.templateDir,
      initializrClient: this.getInitializrClient(),
    });
    return { scripts, workflows, hooks: hooksInstalled };
  }

  async patchWorkflowsForRunnerType(
    targetDir: string,
    runnerType: "self-hosted" | "github-hosted",
  ): Promise<void> {
    return substratePatchWorkflowsForRunnerType(targetDir, runnerType);
  }

  // ── Verification ───────────────────────────────────────────────

  verifyHooks(targetDir: string): { postCheckout: boolean; prepareCommitMsg: boolean; prePush: boolean } {
    return substrateVerifyHooks(targetDir);
  }

  verifyWorkflows(targetDir: string): { pr: boolean; merge: boolean } {
    return substrateVerifyWorkflows(targetDir);
  }
}
