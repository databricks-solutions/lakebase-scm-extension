// Equivalence tests: SchemaDiffService proxy vs substrate.getSchemaDiff.
// FEIP-7080.

import { strict as assert } from "assert";
import { LakebaseService } from "../../src/services/lakebaseService";
import { SchemaDiffService } from "../../src/services/schemaDiffService";
import {
  plantConfig,
  plantWorkspace,
  restoreSubstrate,
  stubSubstrate,
} from "./harness";

describe("equivalence: schema diff", () => {
  let lakebase: LakebaseService;
  let schemaDiff: SchemaDiffService;
  let restoreConfig: () => void;

  beforeEach(() => {
    // SchemaDiffService reads `lakebaseProjectId` from VS Code's
    // workspace config via getConfig() — plant a value so it sees
    // the test instance.
    restoreConfig = plantConfig({ lakebaseProjectId: "proj-x" });
    const ctx = plantWorkspace();
    lakebase = new LakebaseService();
    lakebase.setHostOverride(ctx.host);
    lakebase.setProjectIdOverride(ctx.projectId);
    schemaDiff = new SchemaDiffService(lakebase);
  });

  afterEach(() => {
    restoreSubstrate();
    restoreConfig();
  });

  it("compareBranchSchemas — forwards { instance, branch } and preserves substrate result + timestamp", async () => {
    const tracker = stubSubstrate("getSchemaDiff", {
      branchName: "br-feature",
      timestamp: "2026-05-01T00:00:00Z",
      added: [],
      removed: [],
      modified: [],
    });

    const result = await schemaDiff.compareBranchSchemas("br-feature", true);

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      instance: "proj-x",
      branch: "br-feature",
    });
    assert.strictEqual(result.branchName, "br-feature");
    assert.strictEqual(result.timestamp, "2026-05-01T00:00:00Z");
  });

  it("compareBranchSchemas — fills in timestamp when substrate omits it", async () => {
    stubSubstrate("getSchemaDiff", {
      branchName: "br-feature",
      timestamp: "",
      added: [],
      removed: [],
      modified: [],
    });

    const result = await schemaDiff.compareBranchSchemas("br-feature", true);
    assert.ok(result.timestamp, "timestamp must be filled when missing");
    // ISO 8601 sanity
    assert.match(result.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
