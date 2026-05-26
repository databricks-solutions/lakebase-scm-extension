// Tree command-completeness audit.
//
// Walks BranchTreeProvider.getChildren() against representative stub data,
// collects every BranchItem.command?.command surfaced to the user, and
// asserts each one is either declared in package.json#contributes.commands
// or is a known built-in (vscode.open, vscode.diff, etc.).
//
// Catches: tree items that reference a command which would surface as
// "Actual command not found, wanted to execute X" at click time.

import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { BranchItem, BranchTreeProvider } from "../../src/providers/branchTreeProvider";
import { GitService } from "../../src/services/gitService";
import { LakebaseBranch, LakebaseService } from "../../src/services/lakebaseService";
import { SchemaDiffService } from "../../src/services/schemaDiffService";
import { SchemaMigrationService } from "../../src/services/schemaMigrationService";

// Built-in commands VS Code provides without requiring contribution.
// Conservative whitelist – add only when intentional and documented.
const BUILTIN_COMMANDS = new Set<string>([
  "vscode.open",
  "vscode.diff",
  "vscode.openFolder",
  "workbench.action.openSettings",
]);

function packageCommands(): Set<string> {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8"),
  );
  const cmds: Array<{ command: string }> = pkg?.contributes?.commands ?? [];
  return new Set(cmds.map((c) => c.command));
}

function makeBranch(id: string, isDefault = false): LakebaseBranch {
  return {
    uid: `br-${id}`,
    name: `projects/p1/branches/${id}`,
    branchId: id,
    state: "READY",
    isDefault,
  };
}

async function collectCommands(provider: BranchTreeProvider): Promise<string[]> {
  const seen = new Set<string>();
  const queue: BranchItem[] = await provider.getChildren();
  // Cap traversal so a broken stub can't loop forever.
  for (let safety = 0; safety < 500 && queue.length > 0; safety++) {
    const item = queue.shift()!;
    if (item.command?.command) {
      seen.add(item.command.command);
    }
    if (item.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
      const children = await provider.getChildren(item);
      queue.push(...children);
    }
  }
  return [...seen];
}

describe("BranchTreeProvider command registration", () => {
  let provider: BranchTreeProvider;
  let gitStub: sinon.SinonStubbedInstance<GitService>;
  let lakebaseStub: sinon.SinonStubbedInstance<LakebaseService>;
  let migrationStub: sinon.SinonStubbedInstance<SchemaMigrationService>;
  let diffStub: sinon.SinonStubbedInstance<SchemaDiffService>;

  beforeEach(() => {
    gitStub = sinon.createStubInstance(GitService);
    (gitStub as any).onBranchChanged = new (vscode as any).EventEmitter().event;
    gitStub.getCurrentBranch.resolves("feature-x");
    gitStub.listLocalBranches.resolves([
      { name: "main", isCurrent: false, isRemote: false },
      { name: "feature-x", isCurrent: true, isRemote: false },
    ]);
    gitStub.listMigrationsOnBranch.resolves([]);

    lakebaseStub = sinon.createStubInstance(LakebaseService);
    lakebaseStub.sanitizeBranchName.callsFake((n: string) => n);
    lakebaseStub.checkAuth.resolves({
      authenticated: true,
      currentHost: "ws.databricks.com",
      expectedHost: "ws.databricks.com",
      mismatch: false,
    });
    lakebaseStub.listBranches.resolves([
      makeBranch("main", true),
      makeBranch("feature-x"),
    ]);
    lakebaseStub.getDefaultBranch.resolves(makeBranch("main", true));
    lakebaseStub.queryBranchSchemaWithError.resolves({
      tables: [
        { name: "new_table", columns: [{ name: "id", dataType: "int" }] },
        { name: "modified_table", columns: [{ name: "id", dataType: "int" }, { name: "extra", dataType: "text" }] },
      ],
    });
    lakebaseStub.queryBranchSchema.resolves([
      { name: "modified_table", columns: [{ name: "id", dataType: "int" }] },
      { name: "removed_table", columns: [{ name: "id", dataType: "int" }] },
    ]);

    migrationStub = sinon.createStubInstance(SchemaMigrationService);
    diffStub = sinon.createStubInstance(SchemaDiffService);

    provider = new BranchTreeProvider(
      gitStub as any,
      lakebaseStub as any,
      migrationStub as any,
      diffStub as any,
    );
  });

  afterEach(() => sinon.restore());

  it("every command referenced by a tree item is declared in package.json or is a built-in", async () => {
    const referenced = await collectCommands(provider);
    const declared = packageCommands();

    const orphans = referenced.filter(
      (cmd) => !declared.has(cmd) && !BUILTIN_COMMANDS.has(cmd),
    );

    assert.deepStrictEqual(
      orphans,
      [],
      `Tree items reference commands not declared in package.json#contributes.commands ` +
        `and not on the built-in whitelist. Add a contributes.commands entry (or extend ` +
        `BUILTIN_COMMANDS if intentional): ${orphans.join(", ")}`,
    );
  });

  it("table-row commands dispatch to the side-by-side webview for new/modified/removed", async () => {
    const referenced = new Set(await collectCommands(provider));
    // Tables with diffs render through the per-table webview
    // (lakebaseSync.showTableDiff), which mirrors Branch Diff Summary's
    // aesthetic. The earlier vscode.diff-over-DDL path stripped the
    // side-by-side row rendering – regress against that.
    assert.ok(
      referenced.has("lakebaseSync.showTableDiff"),
      "Expected lakebaseSync.showTableDiff in tree commands — " +
        "table rows under a non-default branch should dispatch the webview. " +
        `Got: ${[...referenced].sort().join(", ")}`,
    );
  });
});
