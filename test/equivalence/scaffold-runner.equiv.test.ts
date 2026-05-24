// Equivalence tests: ProjectCreationService, ScaffoldService,
// RunnerService, and LakebaseService.getCredential. FEIP-7080.

import { strict as assert } from "assert";
import { LakebaseService } from "../../src/services/lakebaseService";
import { GitHubService } from "../../src/services/githubService";
import { ScaffoldService } from "../../src/services/scaffoldService";
import { RunnerService } from "../../src/services/runnerService";
import { ProjectCreationService } from "../../src/services/projectCreationService";
import { plantWorkspace, restoreSubstrate, stubSubstrate } from "./harness";

describe("equivalence: scaffold + runner + project creation + credential", () => {
  beforeEach(() => {
    plantWorkspace();
  });

  afterEach(() => {
    restoreSubstrate();
  });

  it("ProjectCreationService.createProject — forwards full ProjectCreationInput to substrate", async () => {
    const tracker = stubSubstrate("createProject", {
      projectDir: "/tmp/demo",
      githubRepoUrl: "https://github.com/acme/demo",
      lakebaseProjectId: "demo",
    });

    const lakebase = new LakebaseService();
    const github = new GitHubService();
    const scaffold = new ScaffoldService("/fake/extension");
    const runner = new RunnerService(github);
    void runner; // exercise constructor; createProject doesn't use it directly
    const service = new ProjectCreationService(
      {} as never,
      github,
      lakebase,
      scaffold
    );

    const result = await service.createProject({
      projectName: "demo",
      parentDir: "/tmp",
      databricksHost: "https://example.cloud.databricks.com",
      githubOwner: "acme",
      createGithubRepo: true,
      privateRepo: false,
      language: "python",
      runnerType: "github-hosted",
    });

    assert.strictEqual(tracker.callCount, 1);
    const args = tracker.firstCall!.args[0] as Record<string, unknown>;
    assert.strictEqual(args.projectName, "demo");
    assert.strictEqual(args.parentDir, "/tmp");
    assert.strictEqual(args.databricksHost, "https://example.cloud.databricks.com");
    assert.strictEqual(args.githubOwner, "acme");
    assert.strictEqual(args.createGithubRepo, true);
    assert.strictEqual(args.privateRepo, false);
    assert.strictEqual(args.language, "python");
    assert.strictEqual(args.runnerType, "github-hosted");
    assert.strictEqual(result.projectDir, "/tmp/demo");
    assert.strictEqual(result.githubRepoUrl, "https://github.com/acme/demo");
  });

  it("ScaffoldService.scaffoldAll — renames hooksInstalled → hooks in result", async () => {
    const tracker = stubSubstrate("scaffoldAll", {
      scripts: ["deploy.sh"],
      workflows: ["pr.yml"],
      hooksInstalled: "all-installed",
    });
    const scaffold = new ScaffoldService("/fake/extension");

    const result = await scaffold.scaffoldAll("/tmp/proj", {
      databricksHost: "https://example.cloud.databricks.com",
      lakebaseProjectId: "demo",
      language: "java",
      runnerType: "self-hosted",
    });

    assert.strictEqual(tracker.callCount, 1);
    const args = tracker.firstCall!.args[0] as Record<string, unknown>;
    assert.strictEqual(args.targetDir, "/tmp/proj");
    assert.strictEqual(args.databricksHost, "https://example.cloud.databricks.com");
    assert.strictEqual(args.language, "java");
    assert.strictEqual(args.runnerType, "self-hosted");
    assert.deepStrictEqual(result, {
      scripts: ["deploy.sh"],
      workflows: ["pr.yml"],
      hooks: "all-installed",
    });
  });

  it("ScaffoldService.scaffoldAll — defaults language=java, runnerType=self-hosted when not provided", async () => {
    const tracker = stubSubstrate("scaffoldAll", {
      scripts: [],
      workflows: [],
      hooksInstalled: "",
    });
    const scaffold = new ScaffoldService("/fake/extension");

    await scaffold.scaffoldAll("/tmp/proj");

    const args = tracker.firstCall!.args[0] as Record<string, unknown>;
    assert.strictEqual(args.language, "java");
    assert.strictEqual(args.runnerType, "self-hosted");
  });

  it("RunnerService.stopRunner — pure delegate, positional projectName", () => {
    const tracker = stubSubstrate("stopRunner", undefined);
    const runner = new RunnerService(new GitHubService());

    runner.stopRunner("demo-runner");

    assert.strictEqual(tracker.callCount, 1);
    assert.strictEqual(tracker.firstCall!.args[0], "demo-runner");
  });

  it("LakebaseService.getCredential — forwards { instance, branch }", async () => {
    const tracker = stubSubstrate("getCredential", {
      token: "fake-token",
      email: "u@example.com",
    });
    const lakebase = new LakebaseService();
    lakebase.setHostOverride("https://example.cloud.databricks.com");
    lakebase.setProjectIdOverride("proj-x");

    const result = await lakebase.getCredential("customer-entity");

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      instance: "proj-x",
      branch: "customer-entity",
    });
    assert.deepStrictEqual(result, { token: "fake-token", email: "u@example.com" });
  });
});
