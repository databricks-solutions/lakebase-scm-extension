// Equivalence tests: LakebaseService project + endpoint proxies vs substrate.
// FEIP-7080.

import { strict as assert } from "assert";
import { LakebaseService } from "../../src/services/lakebaseService";
import {
  plantWorkspace,
  restoreSubstrate,
  sampleEndpoint,
  stubSubstrate,
} from "./harness";

describe("equivalence: lakebase project lifecycle + endpoint", () => {
  let service: LakebaseService;
  const HOST = "https://example.cloud.databricks.com";

  beforeEach(() => {
    const ctx = plantWorkspace(HOST);
    service = new LakebaseService();
    service.setHostOverride(ctx.host);
    service.setProjectIdOverride(ctx.projectId);
  });

  afterEach(() => {
    restoreSubstrate();
  });

  it("createProject — forwards { projectId, host }", async () => {
    const tracker = stubSubstrate("createLakebaseProject", {
      uid: "proj-new",
      name: "proj-new",
      state: "READY",
    });

    const result = await service.createProject("proj-new");

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      projectId: "proj-new",
      host: HOST,
    });
    assert.deepStrictEqual(result, { uid: "proj-new", name: "proj-new", state: "READY" });
  });

  it("deleteProject — forwards { projectId, host }", async () => {
    const tracker = stubSubstrate("deleteLakebaseProject", undefined);

    await service.deleteProject("proj-old");

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      projectId: "proj-old",
      host: HOST,
    });
  });

  it("getEndpoint — forwards { instance, branch }, passes through unadapted", async () => {
    const tracker = stubSubstrate("getEndpoint", sampleEndpoint());

    const result = await service.getEndpoint("customer-entity");

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      instance: "proj-x",
      branch: "customer-entity",
    });
    assert.deepStrictEqual(result, sampleEndpoint());
  });
});
