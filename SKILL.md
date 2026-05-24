---
name: lakebase-scm-extension
description: "VS Code/Cursor surface for paired-branch Lakebase SCM workflows. Use ONLY when guiding a human in their IDE, for programmatic / agent operations on the same workflow domain, use the substrate skill `lakebase-scm-workflows` directly."
compatibility: VS Code >= 1.85 or Cursor; requires databricks CLI, git, Node.js 20+, and consumes `@databricks-solutions/lakebase-app-dev-kit`
metadata:
  version: "0.5.6"
parent: lakebase-scm-workflows
---

# Lakebase SCM Extension

The VS Code/Cursor surface for the SCM workflow domain hosted by [`lakebase-app-dev-kit`](https://github.com/databricks-solutions/lakebase-app-dev-kit). Same canonical operations as the substrate skill `lakebase-scm-workflows`; this skill documents the IDE-specific UX that is **not** exposed via the agent-callable substrate scripts.

**Agents driving paired-branch SCM should use the parent [`lakebase-scm-workflows`](https://github.com/databricks-solutions/lakebase-app-dev-kit/blob/main/skills/lakebase-scm-workflows/SKILL.md) skill directly.** This skill exists to (a) document the extension surface for discoverability and (b) give an agent acting on behalf of a human in VS Code the right command IDs to invoke via `vscode.commands.executeCommand`.

## Relationship to the substrate

```
lakebase-app-dev-kit (the kit)
├── skills/lakebase-scm-workflows/SKILL.md  ← agent surface, parent skill
└── (consumed by) lakebase-scm-extension     ← this skill, IDE surface
```

The extension is a thin VS Code shell over the substrate. Every operation (branch lifecycle, schema diff, PR flow, scaffold, runner setup, credential mint) calls the same substrate function the agent skill calls. The equivalence harness at `test/equivalence/` (FEIP-7080) catches drift between extension proxies and the substrate.

## What only the extension provides

The IDE-specific surface that has **no** agent-callable equivalent:

### Sidebar tree views

Eight TreeDataProviders in the `lakebase-synced-scm` activity bar container:

| View | Provider | Shows |
|---|---|---|
| `lakebaseBranches` | `branchTreeProvider` | Lakebase branches paired with the current git workspace |
| `lakebaseChanges` | `changesTreeProvider` | Working-tree changes (git status), with stage/unstage actions |
| `lakebaseMigrations` | `migrationsTree` | Pending migration files vs. last-applied state |
| `lakebasePR` | `pullRequestTree` | PRs touching the current paired branch + status checks |
| `lakebaseRunner` | `runnerTreeProvider` | Self-hosted GitHub Actions runner status |
| `lakebaseMerges` | `mergesTree` | Merge-aware view across paired branches |
| `lakebaseGraph` | `graphWebview` | Git graph webview (commits, branches, merges) |

### Status bar
`statusBarProvider` shows current paired Lakebase branch state (READY / NOT_READY / error) at all times. Click to refresh credentials.

### Webview-based diff
`schemaDiffProvider` renders the schema diff against the parent branch as an HTML webview (table-by-table coloring, column add/drop badges). `getSchemaDiff` from the substrate produces the JSON; the rendering is extension-side only.

### Workspace picker
`connectWorkspace` command, interactive picker that lists Databricks profiles and writes the chosen host into the workspace's `.env`. Drives the per-session host override on `LakebaseService`.

### Branch picker
`switchBranch` command, git branch picker + post-checkout sync hook orchestration. The post-checkout hook itself lives in the substrate (`installHooks`); the IDE-side picker is what the developer interacts with.

## Command IDs (for agents acting via `executeCommand`)

Paired-branch + Lakebase ops:
- `lakebaseSync.showBranchStatus`: open the branch status panel
- `lakebaseSync.connectWorkspace`: interactive workspace selector
- `lakebaseSync.refreshBranches`: refresh the Lakebase branches tree
- `lakebaseSync.createBranch`: create Lakebase branch (with picker for parent)
- `lakebaseSync.createUnifiedBranch`: create paired git + Lakebase branch in one step
- `lakebaseSync.deleteBranch`: delete a Lakebase branch
- `lakebaseSync.deleteBranchEverywhere`: delete from Lakebase, git local, and git remote
- `lakebaseSync.refreshCredentials`: re-mint Lakebase token, rewrite `.env`
- `lakebaseSync.switchBranch`: git checkout with paired-branch sync
- `lakebaseSync.publishBranch`: push current branch + open PR

Schema + migrations:
- `lakebaseSync.runMigrate`: apply pending migrations (current substrate-bridged; FEIP-7091 standardizes the primitive)
- `lakebaseSync.showMigrationHistory`: open the migrations tree
- `lakebaseSync.showTableDiff`: single-table schema diff
- `lakebaseSync.showBranchDiff`: full branch schema diff webview
- `lakebaseSync.showCachedBranchDiff`: open last-rendered diff without re-querying

Tests + tooling:
- `lakebaseSync.runTests`: run the project's test suite against the branch
- `lakebaseSync.installPlaywrightConfig`: drop in Playwright config (FEIP-7094 standardizes the primitive)

Git ops (also available in core VS Code SCM, surfaced here too):
- `lakebaseSync.stageFile` / `unstageFile` / `discardChanges` / `stageAll` / `unstageAll`
- `lakebaseSync.commit` / `push` / `pull` / `sync`
- `lakebaseSync.createPullRequest` / `reviewBranch`
- `lakebaseSync.openInConsole`: open the Databricks console URL for the current paired branch

(See `package.json` `contributes.commands` for the full enumerated list.)

## How agents should think about this

- **Operating on workspaces in VS Code on a developer's machine?** Use `vscode.commands.executeCommand('lakebaseSync.<id>', ...)` to drive the IDE surface (this preserves the user's running tree views + status bar state). The substrate ops fire automatically as side effects.
- **Operating headlessly (Claude Desktop, OpenAI Codex, Genie Code, CI)?** Use the parent skill `lakebase-scm-workflows` and call substrate functions directly. The extension is not in the loop.
- **Want to know what the extension currently shows?** No agent-callable equivalent exists yet for tree-view state, agents should ask the user to look, or use VS Code's read-only `vscode.window.activeTextEditor` etc. surfaces.

## Why this skill is intentionally short

The extension's operations are not new, they're the substrate's operations wrapped in VS Code UX. Most of the agent-relevant knowledge lives in the parent skill. This skill is the satellite that says "here's where the IDE-specific surface lives" without duplicating substrate documentation.

## Cross-references

- Parent skill: [`lakebase-scm-workflows`](https://github.com/databricks-solutions/lakebase-app-dev-kit/blob/main/skills/lakebase-scm-workflows/SKILL.md), agent surface for the same operations
- Architecture diagram + version history: [`docs/plugin-plan.md`](./docs/plugin-plan.md)
- Equivalence test pattern (catches extension/substrate drift): [`test/equivalence/`](./test/equivalence/) and the FEIP-7080 ticket
- Sibling skills (planned): `lakebase-tdd-workflows` (FEIP-7066 hint), future deploy-to-Apps workflow skill
