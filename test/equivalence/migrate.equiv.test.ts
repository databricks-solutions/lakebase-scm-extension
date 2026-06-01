// Equivalence tests: SchemaMigrationService substrate proxies vs
// substrate.applySchemaMigrations / rollbackSchemaMigration / schemaMigrationStatus /
// listSchemaMigrations.
//
// Each test stubs the corresponding substrate function, calls the
// matching extension proxy, and asserts:
//   1. Substrate was called with the {instance, branch, projectDir}
//      derived from VS Code config + env (catches arg-mapping drift).
//   2. The proxy returned the substrate result unchanged - migrate
//      proxies do no adapting today (catches future-shape divergence).
//
// Pairs with the substrate's own live BDD coverage in lakebase-app-dev-kit
// (migrate-live.test.ts for Alembic, migrate-live-flyway.test.ts for
// Flyway). FEIP-7091 / FEIP-7098.

import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { LakebaseService } from "../../src/services/lakebaseService";
import { SchemaMigrationService } from "../../src/services/schemaMigrationService";
import { plantConfig, restoreSubstrate, stubSubstrate } from "./harness";

describe("equivalence: migrate substrate proxies", () => {
  let lakebase: LakebaseService;
  let migration: SchemaMigrationService;
  let restoreConfig: () => void;
  let tmpRoot: string;

  const EXPECTED_INSTANCE = "proj-x";
  const EXPECTED_BRANCH = "br-feature";

  beforeEach(() => {
    restoreConfig = plantConfig({ lakebaseProjectId: EXPECTED_INSTANCE });
    // The substrate-proxy methods resolve branch from getEnvConfig(),
    // which reads <workspaceRoot>/.env. Use a real tmpdir so writes
    // land somewhere the file scan can see, and so projectDir flows
    // through to the substrate call as an actual path.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-equiv-"));
    fs.writeFileSync(path.join(tmpRoot, ".env"), `LAKEBASE_BRANCH_ID=${EXPECTED_BRANCH}\n`);
    (vscode.workspace as { workspaceFolders?: unknown[] }).workspaceFolders = [
      { uri: { fsPath: tmpRoot } },
    ];
    lakebase = new LakebaseService();
    lakebase.setHostOverride("https://example.cloud.databricks.com");
    lakebase.setProjectIdOverride(EXPECTED_INSTANCE);
    migration = new SchemaMigrationService(lakebase);
  });

  afterEach(() => {
    restoreSubstrate();
    restoreConfig();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("applyMigrationsViaSubstrate - forwards {instance, branch, projectDir} and preserves substrate result", async () => {
    const fixture = {
      applied: [{ version: "a1b2c3d4", description: "init users" }],
      alreadyAtLatest: false,
      tool: "alembic" as const,
    };
    const tracker = stubSubstrate("applySchemaMigrations", fixture);

    const result = await migration.applyMigrationsViaSubstrate();

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      instance: EXPECTED_INSTANCE,
      branch: EXPECTED_BRANCH,
      projectDir: tmpRoot,
    });
    assert.deepStrictEqual(result, fixture);
  });

  it("rollbackMigrationViaSubstrate - forwards {instance, branch, projectDir, target} and preserves substrate result", async () => {
    const fixture = {
      rolledBack: [{ version: "a1b2c3d4", description: "init users" }],
      tool: "alembic" as const,
    };
    const tracker = stubSubstrate("rollbackSchemaMigration", fixture);

    const result = await migration.rollbackMigrationViaSubstrate("-1");

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      instance: EXPECTED_INSTANCE,
      branch: EXPECTED_BRANCH,
      projectDir: tmpRoot,
      target: "-1",
    });
    assert.deepStrictEqual(result, fixture);
  });

  it("migrationStatusViaSubstrate - forwards {instance, branch, projectDir} and preserves substrate result", async () => {
    const fixture = {
      current: "a1b2c3d4",
      pending: [],
      tool: "alembic" as const,
    };
    const tracker = stubSubstrate("schemaMigrationStatus", fixture);

    const result = await migration.migrationStatusViaSubstrate();

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      instance: EXPECTED_INSTANCE,
      branch: EXPECTED_BRANCH,
      projectDir: tmpRoot,
    });
    assert.deepStrictEqual(result, fixture);
  });

  it("listMigrationsViaSubstrate - forwards {projectDir} and preserves substrate result", async () => {
    const fixture = [
      {
        version: "a1b2c3d4",
        filename: "a1b2c3d4_init_users.py",
        description: "init users",
        type: "Python" as const,
        tool: "alembic" as const,
      },
    ];
    const tracker = stubSubstrate("listSchemaMigrations", fixture);

    // Harness stubs are always async; substrate.listSchemaMigrations is sync.
    // The proxy returns whatever the substrate returns, so the stubbed
    // path yields a Promise. Await covers both cases.
    const result = await (migration.listMigrationsViaSubstrate() as unknown as Promise<typeof fixture>);

    assert.strictEqual(tracker.callCount, 1);
    assert.deepStrictEqual(tracker.firstCall!.args[0], {
      projectDir: tmpRoot,
    });
    assert.deepStrictEqual(result, fixture);
  });

  it("applyMigrationsViaSubstrate - throws when lakebaseProjectId is missing", async () => {
    restoreConfig();
    restoreConfig = plantConfig({ lakebaseProjectId: "" });
    await assert.rejects(() => migration.applyMigrationsViaSubstrate(), /lakebaseProjectId/);
  });

  it("applyMigrationsViaSubstrate - throws when LAKEBASE_BRANCH_ID is missing", async () => {
    fs.writeFileSync(path.join(tmpRoot, ".env"), "");
    await assert.rejects(() => migration.applyMigrationsViaSubstrate(), /LAKEBASE_BRANCH_ID/);
  });
});
