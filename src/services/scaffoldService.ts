// Thin proxy over @databricks-solutions/lakebase-app-dev-kit.
//
// Substrate source: scripts/lakebase/scaffold.ts (+ scaffold-language.ts,
// spring-initializr.ts, project-verify.ts). The extension keeps the
// ScaffoldService class shell so call sites in the extension don't change,
// but every method body delegates to the substrate. Templates ship with
// the kit's npm package (FEIP-7435); the substrate's findTemplatesDir
// auto-resolves them from node_modules. The extension no longer maintains
// its own templates/project/ copy.

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
} from "@databricks-solutions/lakebase-app-dev-kit";

export type ProjectLanguage = "java" | "kotlin" | "python" | "nodejs";

export type ScaffoldReportFn = (message: string, detail?: string) => void;

/**
 * Service for scaffolding new Lakebase projects.
 * Deploys common files (scripts, workflows, hooks, config) plus language-specific
 * project files (Java/Kotlin via Spring Initializr, Python/FastAPI, Node.js/Express).
 */
export class ScaffoldService {
  constructor(private readonly initializrClient?: SpringInitializrClient) {}

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
    return substrateDeployScripts(targetDir);
  }

  async deployWorkflows(targetDir: string): Promise<string[]> {
    return substrateDeployWorkflows(targetDir);
  }

  async installHooks(targetDir: string): Promise<string> {
    return substrateInstallHooks(targetDir);
  }

  async deployEnvExample(
    targetDir: string,
    values?: { databricksHost?: string; lakebaseProjectId?: string },
  ): Promise<void> {
    return substrateDeployEnvExample(targetDir, {
      databricksHost: values?.databricksHost,
      lakebaseProjectId: values?.lakebaseProjectId,
    });
  }

  async deployDeployTargets(targetDir: string, projectName?: string): Promise<void> {
    return substrateDeployDeployTargets(targetDir, projectName);
  }

  async deployVscodeSettings(targetDir: string): Promise<void> {
    return substrateDeployVscodeSettings(targetDir);
  }

  async deployGitignore(targetDir: string, language: ProjectLanguage = "java"): Promise<void> {
    return substrateDeployGitignore(targetDir, language);
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
