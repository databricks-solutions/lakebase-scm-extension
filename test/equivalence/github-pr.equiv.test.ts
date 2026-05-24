// Equivalence tests: GitHubService PR-flow proxies vs substrate.
// FEIP-7080.

import { strict as assert } from "assert";
import { GitHubService } from "../../src/services/githubService";
import { restoreSubstrate, stubSubstrate } from "./harness";

describe("equivalence: github PR flow", () => {
  let service: GitHubService;

  beforeEach(() => {
    service = new GitHubService();
  });

  afterEach(() => {
    restoreSubstrate();
  });

  it("createPullRequest – maps positional args to single object { ownerRepo, headBranch, title, body, baseBranch }", async () => {
    const tracker = stubSubstrate(
      "createPullRequest",
      "https://github.com/acme/repo/pull/42"
    );

    const url = await service.createPullRequest(
      "acme/repo",
      "feature/x",
      "Add X",
      "Body",
      "main"
    );

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      ownerRepo: "acme/repo",
      headBranch: "feature/x",
      title: "Add X",
      body: "Body",
      baseBranch: "main",
    });
    assert.strictEqual(url, "https://github.com/acme/repo/pull/42");
  });

  it("getPullRequest – passes ownerRepo + headBranch positionally", async () => {
    const tracker = stubSubstrate("getPullRequest", {
      number: 42,
      title: "Add X",
      state: "open",
    });

    const result = await service.getPullRequest("acme/repo", "feature/x");

    assert.strictEqual(tracker.callCount, 1);
    assert.strictEqual(tracker.firstCall!.args[0], "acme/repo");
    assert.strictEqual(tracker.firstCall!.args[1], "feature/x");
    assert.deepStrictEqual(result, { number: 42, title: "Add X", state: "open" });
  });

  it("mergePullRequest – defaults to merge + deleteRemoteBranch=true", async () => {
    const tracker = stubSubstrate("mergePullRequest", "merged-sha");

    const result = await service.mergePullRequest("acme/repo", 42);

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      ownerRepo: "acme/repo",
      pullNumber: 42,
      method: "merge",
      deleteRemoteBranch: true,
    });
    assert.strictEqual(result, "merged-sha");
  });

  it("mergePullRequest – honors method + deleteRemoteBranch overrides", async () => {
    const tracker = stubSubstrate("mergePullRequest", "merged-sha");

    await service.mergePullRequest("acme/repo", 42, "squash", false);

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      ownerRepo: "acme/repo",
      pullNumber: 42,
      method: "squash",
      deleteRemoteBranch: false,
    });
  });
});
