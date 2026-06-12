// Equivalence tests: LakebaseService branch lifecycle proxies vs substrate.
// FEIP-7080.

import { strict as assert } from "assert";
import { LakebaseService } from "../../src/services/lakebaseService";
import {
  expectedBranchAdapter,
  plantWorkspace,
  restoreSubstrate,
  sampleBranchInfo,
  stubSubstrate,
} from "./harness";

describe("equivalence: lakebase branch lifecycle", () => {
  let service: LakebaseService;

  beforeEach(() => {
    const ctx = plantWorkspace();
    service = new LakebaseService();
    service.setHostOverride(ctx.host);
    service.setProjectIdOverride(ctx.projectId);
  });

  afterEach(() => {
    restoreSubstrate();
  });

  it("createBranch – delegates to the substrate createBranch primitive (no-expiry feature default)", async () => {
    // The service routes through the raw createBranch primitive. It defaults to
    // no_expiry: true when no ttl is given , the kit's current feature-branch
    // convention (a non-expiring feature branch can parent experiments). The
    // extension passes its own resolved parent. The git branch + .env are the
    // extension's responsibility, not this Lakebase-only call.
    const tracker = stubSubstrate("createBranch", sampleBranchInfo({ uid: "br-new" }));

    const result = await service.createBranch("customer-entity", "main", "main");

    assert.strictEqual(tracker.callCount, 1);
    const args = tracker.firstCall!.args[0] as {
      instance: string;
      branch: string;
      parentBranch: string;
    };
    assert.strictEqual(args.instance, "proj-x");
    assert.strictEqual(args.branch, "customer-entity");
    assert.strictEqual(args.parentBranch, "main");
    assert.deepStrictEqual(result, expectedBranchAdapter(sampleBranchInfo({ uid: "br-new" })));
  });

  it("deleteBranch – forwards { instance, branch }", async () => {
    const tracker = stubSubstrate("deleteBranch", { deleted: true });

    await service.deleteBranch("customer-entity");

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      instance: "proj-x",
      branch: "customer-entity",
    });
  });

  it("listBranches – applies adaptBranchInfo over each substrate row", async () => {
    const rows = [
      sampleBranchInfo({ uid: "br-1", name: "projects/proj-x/branches/a" }),
      sampleBranchInfo({
        uid: "br-2",
        name: "projects/proj-x/branches/b",
        isDefault: true,
        sourceBranchName: "",
      }),
    ];
    const tracker = stubSubstrate("listBranches", rows);

    const result = await service.listBranches();

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], { instance: "proj-x" });
    assert.deepStrictEqual(result, rows.map(expectedBranchAdapter));
  });

  it("getDefaultBranch – adapts when present", async () => {
    const tracker = stubSubstrate("getDefaultBranch", sampleBranchInfo({ isDefault: true }));
    const result = await service.getDefaultBranch();
    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], { instance: "proj-x" });
    assert.deepStrictEqual(result, expectedBranchAdapter(sampleBranchInfo({ isDefault: true })));
  });

  it("getDefaultBranch – returns undefined when substrate returns undefined", async () => {
    stubSubstrate("getDefaultBranch", undefined);
    const result = await service.getDefaultBranch();
    assert.strictEqual(result, undefined);
  });

  it("getBranchByName – passes name as first arg, instance via opts", async () => {
    const tracker = stubSubstrate("getBranchByName", sampleBranchInfo());
    const result = await service.getBranchByName("customer-entity");
    assert.strictEqual(tracker.callCount, 1);
    assert.strictEqual(tracker.firstCall!.args[0], "customer-entity");
    assert.deepStrictEqual(tracker.firstCall!.args[1], { instance: "proj-x" });
    assert.deepStrictEqual(result, expectedBranchAdapter(sampleBranchInfo()));
  });

  it("waitForBranchReady – single-arg shape { instance, branch, timeoutMs }, 5s × maxAttempts", async () => {
    const tracker = stubSubstrate("waitForBranchReady", sampleBranchInfo({ state: "READY" }));
    const result = await service.waitForBranchReady("customer-entity", 12);
    assert.strictEqual(tracker.callCount, 1);
    const args = tracker.firstCall!.args[0] as {
      instance: string;
      branch: string;
      timeoutMs: number;
    };
    assert.strictEqual(args.instance, "proj-x");
    assert.strictEqual(args.branch, "customer-entity");
    assert.strictEqual(args.timeoutMs, 12 * 5_000);
    assert.deepStrictEqual(result, expectedBranchAdapter(sampleBranchInfo({ state: "READY" })));
  });

  it("createLongRunningBranch – forwards { name, forkFromBranch, projectId, workTreeDir, databricksHost } (FEIP-7097)", async () => {
    const stubResult = {
      lakebaseBranchName: "projects/proj-x/branches/staging",
      gitBranch: "staging",
      lakebase: sampleBranchInfo({ uid: "br-staging", name: "projects/proj-x/branches/staging" }),
    };
    const tracker = stubSubstrate("createLongRunningBranch", stubResult);

    const result = await service.createLongRunningBranch({
      name: "staging",
      forkFromBranch: "main",
      workTreeDir: "/tmp/proj",
    });

    assert.strictEqual(tracker.callCount, 1);
    const args = tracker.firstCall!.args[0] as {
      name: string;
      forkFromBranch: string;
      projectId: string;
      workTreeDir: string;
      databricksHost?: string;
    };
    assert.strictEqual(args.name, "staging");
    assert.strictEqual(args.forkFromBranch, "main");
    assert.strictEqual(args.projectId, "proj-x");
    assert.strictEqual(args.workTreeDir, "/tmp/proj");
    assert.strictEqual(args.databricksHost, "https://example.cloud.databricks.com");
    assert.deepStrictEqual(result, stubResult);
  });
});
