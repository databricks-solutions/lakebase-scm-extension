# Lakebase SCM Extension — VS Code / Cursor Extension Plan

## Workflow Process Analysis

### Current Code + Database Branch Lifecycle

This project implements a synchronized git-branch to database-branch workflow:

| Git Event | Code Action | Database Action |
|-----------|------------|-----------------|
| `git checkout -b feature/x` | Create git branch | **post-checkout hook** creates Lakebase branch, updates `.env` + `application-local.properties` |
| `git commit` | Stage & commit code | **prepare-commit-msg hook** appends schema diff to commit message |
| `git push` / PR opened | Push to remote, CI triggers | **pr.yml** creates `ci-pr-<N>` Lakebase branch, runs Flyway migrations, runs tests, posts schema diff as PR comment |
| PR updated (synchronize) | Push new commits | **pr.yml** re-runs migrations + tests on CI branch, updates PR comment |
| PR merged to main | Merge code | **merge.yml** runs Flyway on production, deletes `ci-pr-<N>` + feature Lakebase branches, deletes GitHub branch |
| PR closed (not merged) | Close PR | Lakebase branches left for manual cleanup |

### Key Insight

The "unit of change" is code + schema together. Every feature branch has a paired Lakebase database branch. Migrations in `src/main/resources/db/migration/` travel with the code. The schema diff (branch vs. production) is generated at commit time, PR time, and merge time.

---

## Plugin Vision

A VS Code / Cursor extension that provides unified visibility into both code changes and database schema changes across the git lifecycle. It makes the invisible (database branch state, schema diffs, migration status) visible alongside the familiar (git diffs, branch status, PR state).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                     │
├──────────────┬────────────────┬──────────────────────────────┤
│  Lakebase    │  SCM Provider  │  Webview Panels              │
│  Sidebar     │  (Git+Lakebase)│                              │
│  ┌─────────┐ │  ┌──────────┐  │  ┌─────────────────────────┐ │
│  │ Project │ │  │ Staged   │  │  │ Branch Diff Summary     │ │
│  │ Changes │ │  │ Code     │  │  │ Table Diff              │ │
│  │ Schema  │ │  │ Lakebase │  │  │ Health Check            │ │
│  │ Migr.   │ │  │ PR       │  │  │ PR Schema Diff          │ │
│  │ PR      │ │  │ Migr.    │  │  └─────────────────────────┘ │
│  │ Merges  │ │  │ Merges   │  │                              │
│  └─────────┘ │  └──────────┘  │  Status Bar                  │
│              │                │  - Branch picker             │
│              │                │  - Sync indicator            │
│              │                │  - Lakebase status           │
├──────────────┴────────────────┴──────────────────────────────┤
│                      Service Layer                            │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ GitService   │  │ LakebaseServ │  │ SchemaDiffService    │ │
│  │ - branch ops │  │ - branch CRUD│  │ - pg_dump comparison │ │
│  │ - staging    │  │ - endpoints  │  │ - per-branch cache   │ │
│  │ - commit     │  │ - credentials│  │ - migration parsing  │ │
│  │ - PR via gh  │  │ - console URL│  │                      │ │
│  │ - ahead/behind│ │ - display name│ │                      │ │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────┘ │
│         │                │                      │             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ SchemaMigr.  │  │ SchemaContent│  │ GitBaseContent       │ │
│  │  Service     │  │ Provider     │  │ Provider             │ │
│  │ - list/parse │  │ - DDL for    │  │ - file at merge-base │ │
│  │   migrations │  │   multi-diff │  │   for code diffs     │ │
│  └──────────────┘  └──────────────┘  └─────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│                    External CLIs                              │
│  ┌──────────┐  ┌───────────────────┐  ┌────────────────────┐ │
│  │ git      │  │ databricks CLI    │  │ gh (GitHub CLI)    │ │
│  │          │  │ - postgres        │  │ - pr create/merge  │ │
│  │          │  │   list-branches   │  │ - secret set       │ │
│  │          │  │   create-branch   │  │ - pr view          │ │
│  │          │  │   list-endpoints  │  │                    │ │
│  │          │  │   generate-cred   │  │                    │ │
│  │          │  │   list-projects   │  │                    │ │
│  └──────────┘  └───────────────────┘  └────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ pg_dump (PostgreSQL client)                              │ │
│  │ - schema-only dumps for branch vs production comparison  │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Foundation (MVP) ✅ COMPLETE

### Goals
- Extension scaffold with TypeScript + webpack
- Lakebase API client wrapping Databricks CLI
- Git watcher detecting branch changes
- Status bar showing current git branch, Lakebase branch, sync status
- Branch tree view listing all git branches with paired Lakebase branch status

### Deliverables
1. ✅ **Extension scaffold** — `package.json`, activation events, command registration
2. ✅ **LakebaseService** — Branch CRUD, endpoint management, credential generation via CLI
3. ✅ **GitService** — Branch detection, event watching, file change detection, per-branch migration listing
4. ✅ **StatusBarProvider** — Persistent status bar: DB branch + migration version + sync status
5. ✅ **BranchTreeProvider** — Sidebar tree view with git/Lakebase branch pairs, switch branch workflow

---

## Phase 2: Diff & Visibility ✅ COMPLETE

### Goals
- Schema diff engine using pg_dump with fresh Lakebase CLI credentials
- Unified diff panel showing code + schema changes side by side
- Migration parser tracking Flyway version state per branch
- SCM integration showing real schema differences via pg_dump
- Per-table Schema Diff webview following GitHub diff conventions

### Deliverables
6. ✅ **SchemaDiffService** — pg_dump comparison with fresh credentials for both branches; per-branch cache with migration-mtime invalidation and 10-minute max age; error results never cached
7. ✅ **Branch Diff WebView** — Two-column: code file changes (left) + schema changes (right); per-item diff for any branch without switching
8. ✅ **FlywayService** (now `SchemaMigrationService`) — Read migration files, track version state, per-branch via git ls-tree
9. ✅ **Unified Repo SCM** — Single "Unified Repo" in Source Control with flat "Code" and "Lakebase" groups; icons for added/modified/removed; clicking code files opens git diff; clicking schema items opens table diff
10. ✅ **Per-table Schema Diff** — Two-column production vs branch with GitHub diff conventions (empty panes for created/removed)
11. ✅ **Open in Databricks Console** — Per-branch link to Lakebase console URL
12. ✅ **Settings** — `showUnifiedRepo` (toggle Unified Repo in SCM), `productionReadOnly` (prevent deleting default branch)
13. ✅ **Test suite** — 120 unit tests across 9 suites; mocha + sinon + ts-node; vscode mock for testing outside extension host

---

## Phase 3: Workflow Automation ✅ COMPLETE

### Goals
- Auto-branch creation hooking into VS Code git branch creation
- Background credential refresh
- Full Git SCM parity with Lakebase sync on every operation
- PR integration showing GitHub PR status with schema diff from CI
- Merge awareness detecting merge to main, showing production status

### Deliverables
14. ✅ **Auto-branch creation** — On `git checkout -b`, auto-creates Lakebase branch, gets endpoint + credentials, updates `.env`; respects `autoCreateBranch` config; always syncs `.env` connection on branch change even when auto-create is off
15. ✅ **Unified branch creation** — "Create Branch (Code + Database)" command: prompts for name, runs `git checkout -b`, creates Lakebase branch, connects, updates config — one click for both
16. ✅ **Live code change tracking** — Watches `.git/index` and file saves; debounced 1-second refresh; includes untracked files via `git ls-files`; code diff view on click; Git SCM parity (Code group shows working tree, not branch scope)
17. ✅ **Schema cache invalidation** — Cache cleared on migration file changes, Flyway migrate, and branch switch; migration watcher only refreshes code (not schema) to avoid re-caching stale data before Flyway runs
18. ✅ **Background credential refresh** — 20-minute interval; gets fresh credentials for current branch; updates `.env` and `application-local.properties`; respects `autoRefreshCredentials` setting; restarts on setting change
19. ✅ **Full SCM integration** — Complete Git parity with Lakebase sync:
    - **Staged + Code groups** — Staged shows git index; Code shows unstaged working tree changes (matches Git SCM CHANGES behavior)
    - **Stage/unstage/discard** — Inline actions per file; stage all / unstage all on group headers
    - **Commit** — Auto-stages all if nothing staged; Commit Staged, Commit All, Undo Last Commit, Abort Rebase, Amend variants, Signed Off variants
    - **Push/Pull/Sync/Fetch** — Pull, Pull (Rebase), Pull from..., Push, Push to..., Sync, Fetch, Fetch (Prune), Fetch From All Remotes
    - **Branch** — Merge..., Rebase Branch..., Create Branch..., Create Branch From..., Rename Branch..., Delete Branch..., Delete Remote Branch..., Publish Branch...
    - **Stash** — Stash, Stash (Include Untracked), Stash Staged, Apply/Pop (Latest and picker), Drop/Drop All, View Stash...
    - **Tags** — Create Tag, Delete Tag, Delete Remote Tag
    - **Worktrees** — Create Worktree, List Worktrees, Delete Worktree
    - **Remote** — Add Remote..., Remove Remote...
    - **Clone** — Clone repository to local directory
    - **Lakebase sync on all operations** — branch delete/rename/merge sync Lakebase branches; pull/stash/undo/discard clear schema cache; publish shows Lakebase branch name
    - **Submenus with separators** — Full More Actions menu matching Git SCM structure
20. ✅ **PR integration** — Create PR with auto-secret sync (generates fresh Databricks token); PR group in SCM view with CI status polling (30s); View PR Schema Diff (live pg_dump fallback when no CI comment); Merge Pull Request (merge/squash/rebase with auto-checkout main); pre-flight secret check before PR creation
21. ✅ **Merge awareness** — On main: Lakebase group shows production branch status; Schema Migrations group lists all V*.sql files; Recent Merges group shows last 5 merge commits with PR titles linking to GitHub
22. ✅ **Branch picker** — Status bar shows `⑂ branch*` with Lakebase pairing; click opens QuickPick with local + remote branches, each showing Lakebase branch; actions: Create, Create From, Checkout Detached; remote branches checkout with tracking
23. ✅ **Sync indicator** — Status bar shows `⟳ N↓ M↑` with ahead/behind counts; Sync Changes group appears when behind/ahead; click syncs with Lakebase credential refresh
24. ✅ **Review Branch** — Multi-diff editor via `vscode.changes` API showing all code + schema DDL diffs; Branch Diff Summary webview with two-column layout
25. ✅ **Health check** — Validates workflows, secrets, CLI auth, gh CLI, migration directory, post-checkout hook; webview panel with ✅/❌ per item
26. ✅ **Open in Databricks Console** — Per-branch console URL using branch UID; CI branch resolves to correct `ci-pr-<N>` UID
27. ✅ **Test suite** — 277 tests across 15 suites covering all services, providers, git operations, Lakebase sync, branch picker, merge awareness, and PR integration

---

## Phase 3.5: Lakebase Sidebar ✅ COMPLETE (v0.3.5)

### Goals
- Reproduce the full SCM functionality in the Lakebase sidebar
- Provide an alternative to the SCM view with richer branch and schema exploration
- Full feature parity: every action available from the SCM view is available from the sidebar

### Deliverables
28. ✅ **SchemaScmProvider public API** — Added 7 public accessors (`getStaged()`, `getCode()`, `getLakebase()`, `getMigrations()`, `getMerges()`, `getPr()`, `getSync()`) and `onDidRefresh` event firing after every refresh cycle
29. ✅ **Project view** — Repo name + "Git + Lakebase" root item with full inline action bar (Checkout, Publish, Commit, Create PR, Refresh, Review Branch, Branch Diff Summary) and complete overflow menu (9 submenus + top actions). Expandable to show:
    - GitHub repo link (clickable, opens browser)
    - Lakebase project display name + workspace URL (clickable, opens workspace; fetched via `getProjectDisplayName()` API)
    - Connection status via auth check
    - Current Branch section with expandable branch details
    - Other Branches section with Lakebase-only branches
30. ✅ **Expandable branch details** — Each branch expands to show:
    - **Git tracking** (`fileList`) — Collapsible; shows all changed files vs main with diff status icons (green/yellow/red/blue); click opens diff view or file
    - **Database** (`tableList`) — Collapsible; color-coded tables: green (new), amber (modified), red (removed), white (unchanged); click opens CREATE TABLE DDL or production-vs-branch diff; column count + tooltip with column definitions; compares branch migrations against main to determine status
    - **Endpoint status** — ACTIVE/INACTIVE indicator
    - **Schema migrations** (`migrationList`) — Collapsible; lists individual V*.sql files with parsed descriptions; click opens file
31. ✅ **Changes view** — Three groups: Staged, Code (renamed from Changes), Lakebase (moved from standalone view):
    - **File rendering** — Mirrors SCM exactly: file-type icons from VS Code icon theme, status decorations (M/A/D/R) on the right via `resourceUri`, relative directory path as description
    - **List/tree toggle** — Title bar button switches between flat list and folder-grouped tree view with collapsed single-child directory chains
    - **Inline actions on files** — Stage (+), Discard (↩) on unstaged; Unstage (−) on staged
    - **Inline actions on group headers** — Stage All (+), Discard All (↩) on Code group; Unstage All (−) on Staged group
    - **Title bar** — Commit, Publish, Create PR, Refresh, Review Branch + full overflow menu with all 9 submenus
    - **Lakebase subgroup** — Schema changes from uncommitted migration files (moved from standalone view)
    - **Sync Changes** — Shows ahead/behind status when out of sync
32. ✅ **Schema Migrations view** — All V*.sql files on main branch; `when` clause hides on feature branches
33. ✅ **Pull Request view** — PR status + CI branch with merge/schema diff/refresh title bar actions; `when` clause shows only when PR exists
34. ✅ **Recent Merges view** — Last 5 merge commits on main with PR titles; clickable to GitHub
35. ✅ **Badge count** — Activity bar icon shows pending change count (staged + unstaged + schema)
36. ✅ **SchemaContentProvider fallback** — Falls back to parsing migration files for table DDL when no pg_dump cache is available, so table definitions are always viewable
37. ✅ **Graceful branch switch** — Catches "local changes would be overwritten" error; offers Stash & Switch, Commit First, or Cancel
38. ✅ **LakebaseService.getProjectDisplayName()** — Fetches human-readable project name from `databricks postgres list-projects` API
39. ✅ **Updated sidebar icon** — New SVG with Lakebase bars + SCM symbol
40. ✅ **Renamed** — "Unified Branch Diff Summary" → "Branch Diff Summary"
41. ✅ **Test suite** — 299 tests across 16 suites; all existing tests preserved; new tests for Project view hierarchy

### Files created
- `src/providers/changesTreeProvider.ts` — Changes view with Staged/Code/Lakebase groups, list/tree toggle
- `src/providers/migrationsTree.ts` — Schema Migrations view
- `src/providers/pullRequestTree.ts` — Pull Request view
- `src/providers/mergesTree.ts` — Recent Merges view
- `src/providers/lakebaseSchemaTree.ts` — (Created but later merged into Changes view as Lakebase subgroup)

### Files modified
- `src/providers/schemaScmProvider.ts` — Public accessors + `onDidRefresh` event
- `src/providers/branchTreeProvider.ts` — Restructured as Project view with expandable branch details, table color coding, migration listing, file listing
- `src/providers/schemaContentProvider.ts` — Migration file parsing fallback
- `src/providers/schemaDiffProvider.ts` — Renamed to "Branch Diff Summary"
- `src/services/lakebaseService.ts` — `getProjectDisplayName()` method
- `src/extension.ts` — Register sidebar views, badge count, list/tree toggle commands, graceful branch switch
- `package.json` — 5 sidebar views, view/title menus, view/item/context menus with inline actions, overflow submenus, version bump to 0.3.5
- `test/suite/branchTreeProvider.test.ts` — Updated for Project view hierarchy

---

## Phase 4: Unified Project Creation

### Goals
- One-step creation of a new GitHub repository + Lakebase database from within the extension
- Project scaffold template embedded in the extension
- Automated CI/CD setup (GitHub secrets, workflows)
- Open new project workspace when complete

### Template Structure

```
templates/project/
├── common/                     # Shared across all languages
│   ├── .env.example
│   ├── .gitignore.base
│   ├── .vscode/settings.json
│   ├── .github/workflows/
│   │   ├── pr.yml              # Language-aware CI (detects pom.xml/pyproject.toml/package.json)
│   │   └── merge.yml           # Language-aware merge + cleanup
│   └── scripts/                # 16 shared scripts (hooks, migration, secrets, schema diff)
├── java/                       # Spring Boot + Flyway + JUnit
│   ├── pom.xml, mvnw, .mvn/
│   ├── src/main/resources/db/migration/V1__init_placeholder.sql
│   └── src/main/java/.../DemoApplication.java
├── python/                     # FastAPI + SQLAlchemy + Alembic (uv + pyproject.toml)
│   ├── pyproject.toml
│   ├── Makefile
│   ├── app/main.py, database.py, models.py
│   ├── alembic/env.py, versions/001_init_placeholder.py
│   └── tests/test_app.py
└── nodejs/                     # Express + Knex + Jest
    ├── package.json, knexfile.js
    ├── src/index.js, db.js, routes/health.js
    ├── migrations/001_init_placeholder.js
    └── tests/app.test.js
```

### Command: `lakebaseSync.createProject`

Available from Command Palette and Project view title bar.

### Execution Steps (10-step wizard)

| Step | Action | Method |
|------|--------|--------|
| 1 | Project name | `showInputBox` |
| 2 | Parent directory | `showOpenDialog` (folder picker) |
| 3 | GitHub authentication | `gh auth login` if needed |
| 4 | GitHub repo name | `showInputBox` (defaults to project name) |
| 5 | Visibility | Private (default) or Public |
| 6 | Language | Java/Spring Boot, Python/FastAPI, or Node.js/Express |
| 7 | Runner type | Self-hosted (default) or GitHub-hosted |
| 8 | Databricks workspace | Select or connect + `databricks auth login` |
| 9 | Lakebase project name | `showInputBox` (defaults to repo name) |
| 10 | Execute | Create GitHub repo, Lakebase project, scaffold, secrets, hooks, runner, initial commit, offer to open |

### Deliverables
42. **Project scaffold template** ✅ — 51 files in `templates/project/` (16 scripts, 2 workflows, .env.example, .gitignore, .vscode/settings.json, V1 migration placeholder). Deployed by `ScaffoldService`.
43. **Lakebase project creation** ✅ — `LakebaseService.createProject()` via `databricks postgres create-project` CLI (not REST API — CLI supports it now). Includes `setProjectIdOverride()` for test contexts.
44. **GitHub repo creation** ✅ — `GitService.createRepo()` via `gh repo create` with visibility, description. `syncCiSecrets()` sets DATABRICKS_HOST, LAKEBASE_PROJECT_ID, DATABRICKS_TOKEN.
45. **Create Project command** ✅ — `lakebaseSync.createProject` wizard with 10-step UI flow: project name → parent dir → GitHub auth gate (web login) → repo name (defaults from project name) → visibility → Databricks workspace picker + auth gate → Lakebase project name (defaults from repo name) → execute with progress → offer to open folder. Cleanup on failure.
46. **`.vscodeignore` update** ✅ — `templates/` included in packaged extension (51 files).
47. **Disable built-in Git SCM in workspace** ✅ — `.vscode/settings.json` with `"git.enabled": false` deployed by `ScaffoldService.deployVscodeSettings()`.

### Resolved Questions
- Lakebase project creation uses `databricks postgres create-project` CLI (not REST API)
- Auth reuses existing `databricks auth login` session from `~/.databrickscfg`
- Default project settings handled by Lakebase backend (auto-provisions default branch + endpoint)

---

## Phase 5: Advanced

### Goals
- Data preview querying branch database from VS Code
- Conflict detection warning when two branches modify the same tables
- Branch comparison between any two Lakebase branches
- Cursor AI integration exposing database context
- Visual commit graph in the Lakebase sidebar

### Deliverables
48. **Data preview** — Read-only table viewer for branch databases
49. **Conflict detection** — Table-level conflict warnings
50. **Branch comparison** — Any-to-any Lakebase branch diff
51. **Cursor AI context** — Schema-aware code generation
52. **Graph webview** — Visual commit graph with branch lines, Lakebase pairing annotations, and clickable commits ✅ (v0.3.7)
53. **Adopt STATUS_ICONS/STATUS_COLORS from theme.ts** — Replace all inline icon/color object literals in schemaScmProvider.ts (3 maps), branchTreeProvider.ts (3 maps + inline assignments), and pullRequestTree.ts (1 map) with imports from `src/utils/theme.ts`. The constants exist but are not yet consumed by callers.
54. **Evaluate pg_dump vs migration SQL parsing consolidation** — ✅ Partially resolved: `compareBranchSchemas` now uses `queryBranchSchema()` (information_schema query) as primary path, with pg_dump as fallback. The two parsers (`parsePgDumpTables` and `FlywayService.parseSql`) still exist separately but pg_dump is no longer the primary code path. Remaining: remove `parsePgDumpTables` if pg_dump fallback is never triggered, or keep as defensive fallback.

---

## Extension Structure

```
lakebase-scm-extension/
├── package.json              # Extension manifest, contributions, commands, views, menus
├── tsconfig.json             # TypeScript configuration
├── webpack.config.js         # Bundling configuration
├── src/
│   ├── extension.ts          # Activation, command registration, view registration
│   ├── providers/
│   │   ├── branchTreeProvider.ts    # Project view: repo identity, branches, expandable details
│   │   ├── changesTreeProvider.ts   # Changes view: Staged, Code, Lakebase, list/tree toggle
│   │   ├── migrationsTree.ts        # Schema Migrations view
│   │   ├── pullRequestTree.ts       # Pull Request view
│   │   ├── mergesTree.ts            # Recent Merges view
│   │   ├── runnerTreeProvider.ts    # CI Runner view: status, start/stop, logs, recent runs
│   │   ├── statusBarProvider.ts     # Status bar management
│   │   ├── schemaDiffProvider.ts    # Branch Diff Summary + table diff webviews
│   │   ├── schemaContentProvider.ts # DDL content for multi-diff (with migration fallback)
│   │   ├── schemaScmProvider.ts     # SCM provider with public accessors + onDidRefresh
│   │   └── graphWebview.ts          # Visual commit graph with Lakebase annotations
│   ├── services/
│   │   ├── lakebaseService.ts       # Databricks CLI wrapper + console URLs + syncConnection
│   │   ├── gitService.ts            # Git operations + event watching + diff content
│   │   ├── schemaMigrationService.ts # Migration parsing (Flyway/Alembic/Knex)
│   │   ├── schemaDiffService.ts     # Schema diff generation + per-branch cache
│   │   ├── diffService.ts           # Diff tuple builder for review/compare
│   │   ├── graphService.ts          # Commit graph data + avatar fetching
│   │   ├── projectCreationService.ts # 10-step project creation wizard
│   │   ├── scaffoldService.ts       # Template deployment (common + java/python/nodejs)
│   │   └── runnerService.ts         # Self-hosted GitHub Actions runner lifecycle
│   └── utils/
│       ├── config.ts                # .env + settings management + connection updates
│       ├── exec.ts                  # Async exec wrapper with auth error detection
│       ├── ciSecrets.ts             # GitHub Actions secret sync
│       ├── diffBuilder.ts           # Diff URI/tuple construction
│       └── theme.ts                 # Status icons, colors, branch name utilities
├── resources/icons/
├── templates/project/               # Multi-language scaffold (common + java + python + nodejs)
├── docs/
│   ├── plugin-plan.md               # This file
│   └── e-commerce-scenarios.md      # Integration test design doc
├── test/
│   ├── suite/                       # 328 unit tests across 17 suites
│   └── integration/                 # 165 integration tests (e-commerce + runner + python devloop)
└── .vscodeignore
```

## Configuration

```jsonc
{
  "lakebaseSync.databricksHost": "",            // Auto-read from .env
  "lakebaseSync.lakebaseProjectId": "",         // Auto-read from .env
  "lakebaseSync.autoCreateBranch": true,        // Create DB branch on git checkout
  "lakebaseSync.autoRefreshCredentials": true,   // Background credential refresh
  "lakebaseSync.showUnifiedRepo": true,         // Show Unified Repo in SCM
  "lakebaseSync.productionReadOnly": true,      // Prevent deleting default branch
  "lakebaseSync.migrationPath": "src/main/resources/db/migration"
}
```

## Design Decisions

1. **CLI-based, not API-based** — Wraps `databricks` CLI rather than calling REST APIs directly. Reuses existing auth (OAuth, PAT) and avoids token management complexity. Lakebase project creation uses `databricks postgres create-project` CLI.
2. **Event-driven, not polling** — Uses VS Code FileSystemWatcher and git extension events rather than polling Lakebase API. File saves and git index changes trigger debounced code refreshes.
3. **Schema diff at multiple layers** — Per-branch cache with migration-mtime invalidation for speed; pg_dump for accuracy; migration parsing as fallback; cache cleared on migration changes, Flyway runs, and branch switches.
4. **Complements existing hooks** — Provides visibility into what post-checkout and prepare-commit-msg hooks do, does not replace them. Auto-branch creation syncs `.env` on every branch change.
5. **Cursor-compatible** — Standard VS Code extension, automatically works in Cursor. Phase 5 adds Cursor-specific AI context.
6. **Dual interface** — Both the Lakebase sidebar (recommended) and SCM view provide full functionality. The sidebar offers richer exploration (expandable branch details, color-coded tables, migration files) while the SCM view provides the familiar Git workflow with a commit input box.
7. **Graceful degradation** — Schema content provider falls back to migration file parsing when pg_dump cache is unavailable. Branch switch offers stash/commit options when working tree is dirty. Auth failures prompt reconnection.

## Phase 6: Remaining Cleanup

### Goals
- Wire DiffService into callers
- Surface command-palette-only commands in menus
- Eliminate remaining raw execSync in GraphService

### Deliverables
55. **Wire DiffService into callers** — extension.ts `reviewBranch` and graphWebview.ts `reviewCommit`/`buildComparisonTuples` currently build tuples inline. Rewire to call `DiffService.reviewBranch()`, `DiffService.reviewCommitTwoPane()`, and `DiffService.compareRefs()`.
56. **Add menu placements for orphaned commands** — 6 commands are registered but only accessible via Command Palette:
    - `lakebaseSync.refreshCredentials` — Refresh Database Credentials
    - `lakebaseSync.runMigrate` — Run Flyway Migrate
    - `lakebaseSync.showMigrationHistory` — Show Migration History
    - `lakebaseSync.showBranchStatus` — Show Branch Status
    - `lakebaseSync.createBranch` — Create Lakebase Branch (db-only)
    - `lakebaseSync.showCachedBranchDiff` — Branch Diff (Cached)
    Add these to appropriate menus (Lakebase submenu, Project view context, or view title bars).
57. **Eliminate remaining execSync in GraphService** — ✅ Complete: `fetchAvatars()` uses `gitService.getCurrentBranch()` + `gitService.ghApi()`. `getCommits()` uses `gitService.getLogRaw()` + `gitService.getLogShortstat()`. No `execSync` remains.

---

## Phase 7: Deploy to Databricks Apps

### Goals
- One-click deployment of the scaffolded project to Databricks Apps
- Generate `app.yaml`, `databricks.yml`, and DABs resource files
- Use `databricks-sdk` for OAuth M2M auth (service principal) in deployed apps
- Support synced tables (Delta → Lakebase) for read paths alongside migration-managed schema

### Deliverables
58. **Deploy command** — `Lakebase: Deploy to Databricks Apps` from the sidebar or Command Palette. Generates deployment config, builds frontend (if React), and runs `databricks bundle deploy`.
59. **`app.yaml` generation** — Auto-detect language and generate the app entry point (`uvicorn main:app` for Python, `node src/index.js` for Node.js, `java -jar` for Java). Inject `PGHOST`, `PGDATABASE`, `PGSCHEMA` env vars.
60. **`databricks.yml` bundle config** — Generate DABs bundle with app resource, Lakebase database instance, and optional synced table resources. Support `dev`/`staging`/`production` targets.
61. **OAuth M2M auth in deployed apps** — Add `databricks-sdk` to project dependencies at deploy time. Generate a `database.py` (Python) or equivalent that uses `WorkspaceClient().config.oauth_token().access_token` as the Postgres password. Local dev continues to use `.env`-based credentials; deployed apps use service principal auth.
62. **Database resource config** — Generate `resources/database.yml` defining the Lakebase instance and any synced tables. Auto-detect instance capacity from current project.
63. **Service principal permissions** — After deploy, run `GRANT` statements to give the app's service principal access to the Lakebase database and tables.
64. **Frontend build integration** — For projects with a `frontend/` directory (React+Vite), run `npm install && npm run build` before deploy. Configure `sync.include` for `frontend/dist` in `databricks.yml`.
65. **Deploy status in sidebar** — Show deployment status, app URL, and logs in the CI Runner or a new Deployments view.

### Dependencies
- Databricks CLI v0.285+ with `bundle deploy` and `apps` support
- Databricks workspace with Apps enabled
- Service principal auto-created by Databricks Apps

---

## Summary

| Phase | What | Status | Version |
|-------|------|--------|---------|
| 1 | Foundation (MVP) | ✅ Complete | — |
| 2 | Diff & Visibility | ✅ Complete | — |
| 3 | Workflow Automation | ✅ Complete | — |
| 3.5 | Lakebase Sidebar | ✅ Complete | v0.3.5 |
| 4 | Unified Project Creation | ✅ Complete | v0.4.0 |
| 5 | Advanced Features | Partially complete | v0.3.7 (Graph), v0.3.8 (Refactoring) |
| 5.5 | R1-R8 Refactoring | ✅ Complete | v0.3.8 |
| 6 | Remaining Cleanup | Partially complete | v0.4.0 (#55-#56 open, #57 done) |
| 7 | Deploy to Databricks Apps | ✅ Complete | v0.5.1 |
| — | OAuth-only CI, template parity | ✅ Complete | v0.4.1–v0.4.9 |

**Current state:** v0.5.1

### v0.4.0 changelog:
- **Create New Project wizard** — 10-step flow: project name → parent dir → GitHub auth gate → repo name → visibility → language (Java/Python/Node.js) → runner type (self-hosted/GitHub-hosted) → Databricks workspace + auth gate → Lakebase project name → execute. Cascading defaults, cleanup on failure, opens project folder.
- **Configurable runner type** — Wizard step 6 picks self-hosted (default) or GitHub-hosted. Self-hosted: workflows patched (local JDK, offline Maven), runner auto-deployed. GitHub-hosted: workflows unchanged (actions/setup-java, online Maven), no runner deployed. `ScaffoldService.patchWorkflowsForRunnerType()` handles patching.
- **Multi-language templates** — `common/` + `java/` + `python/` + `nodejs/`. Smart scripts detect language via marker files.
- **Self-hosted CI Runner** — `RunnerService` at `~/.lakebase/runners/{project}/`. Skips re-configuration on restart if already configured. Kills child .NET processes via pkill. Clears stale diagnostics on stop/restart.
- **CI Runner sidebar view** — Top-level view with status, start/stop, logs, collapsible Recent Runs.
- **Live branch table queries** — `queryBranchSchema()` (information_schema) as primary, pg_dump as fallback. Correctly captures ALTER TABLE columns. Diff indicators vs production.
- **Branch Review** — Uses `queryBranchSchema` for both sides (fast, captures ALTER TABLE effects).
- **PR flow** — Full pipeline: uncommitted → commit → unpushed → push → sync secrets (non-blocking) → PR title → create. PR status deduplicates check runs (latest wins).
- **Service layer routing** — Extension.ts, providers, and graphService route through GitService/LakebaseService. Remaining: health check version commands (acceptable).
- **Integration tests** — 70 passing (3 e-commerce scenarios, ~15 min) + 12 passing (self-hosted runner test, 2 min) + 83 passing (4 Python devloop scenarios, ~40 min) = **165 total**.

### v0.4.1 changelog:
- **Fix .env pointing at production after branch creation** — `syncConnection` now immediately clears `.env` connection fields before waiting for the endpoint, ensuring `.env` never remains pointed at production. Retries up to 30s for the endpoint to become available.
- **More Actions menu** — `...` (ellipsis) icon on the project tree item opens a QuickPick with all Git + Lakebase commands (Pull, Push, Commit, Branch, Stash, Tags, Lakebase ops) with separators.
- **Auth error detection** — Added `cannot configure default credentials` to the auth error recognition in `exec.ts`.
- **README rewrite** — Comprehensive docs covering all features, workflows, settings, and the full developer lifecycle.

### v0.4.2 changelog:
- **Language-aware CI/CD** — `pr.yml` and `merge.yml` detect project language via marker files (`pom.xml` → Java/Flyway, `pyproject.toml` → Python/Alembic, `package.json` → Node.js/Knex) and run the correct setup, migration, and test tools. Conditional steps for JDK, Python+uv, or Node.js setup.
- **Generic env vars** — `.env` now uses `DATABASE_URL`, `DB_USERNAME`, `DB_PASSWORD` instead of `SPRING_DATASOURCE_*`. Java continues to get `spring.datasource.*` via `application-local.properties` (only written when `pom.xml` exists). CI workflows set both generic and Spring vars for backward compatibility.
- **Python template: pyproject.toml + uv** — Replaced `requirements.txt` with `pyproject.toml` and `uv` for package management. Switched from `psycopg2-binary` to `psycopg[binary]` (v3). Updated `database.py` and `alembic/env.py` to use the `postgresql+psycopg://` dialect. `Makefile` uses `uv sync --all-extras` and `uv run --env-file .env`.
- **Python database.py** — Reads `DATABASE_URL` (preferred) or builds URL from `DB_USERNAME`/`DB_PASSWORD`/`LAKEBASE_HOST` env vars. No more `SPRING_DATASOURCE_*` in Python templates.
- **Node.js knexfile.js** — Reads `DATABASE_URL` (preferred) or builds connection from `DB_USERNAME`/`DB_PASSWORD`/`LAKEBASE_HOST`. No more `SPRING_DATASOURCE_*` in Node.js templates.
- **Schema diff fallback** — Replaced `flyway:info` version comparison with language-independent `psql` table comparison for the pg_dump fallback path.
- **Phase 7 planned** — Deploy to Databricks Apps (deliverables 58–65): deploy command, `app.yaml`/`databricks.yml` generation, OAuth M2M via `databricks-sdk`, database resource config, frontend build integration.

### v0.4.3 changelog:
- **Fix stale runner auto-reconfigure** — `setupRunner` now verifies the runner is registered on GitHub before reusing the `.runner` config. If stale (removed from GitHub side), it deletes credentials and re-runs `config.sh` with a fresh token automatically.
- **Fix Alembic sys.path** — `alembic/env.py` adds the project root to `sys.path` so `from app.database import ...` resolves in CI runner working directories.
- **Register refreshRunner command** — Was declared in `package.json` but missing from `extension.ts`; CI Runner view refresh button now works.
- **Docs updated** — README reflects v0.4.3, uv in prerequisites, language-aware CI, Deploy to Databricks Apps in roadmap. Plan updated with multi-language template structure, 10-step wizard, current extension file tree. Removed completed plan docs.

### v0.4.4 changelog:
- **Fix PR flow silent abort** — `createPullRequest` command no longer silently exits when the push dialog is dismissed. Removed the separate "Push to GitHub?" blocking dialog — `gitService.createPullRequest()` already handles pushing internally, so the dialog was redundant and fragile. Added post-commit verification: after the commit step, re-checks for uncommitted changes and stops with a clear message if the commit wasn't completed. Added cancellation feedback at every early-return point.
- **Template: `maybe_npm_install` helper** — `post-checkout.sh` now auto-runs `npm install` in `client/` when `node_modules` is missing, so branch switches are fully self-contained for projects with a React client.

### v0.4.5 changelog:
- **Post-merge auto-refresh** — Polls Lakebase branches after PR merge to auto-refresh tree when CI cleans up. Added `branchTreeProvider.refresh()` to local merge flow.
- **Language detection fix** — Use `git ls-files` in CI workflows to avoid stale file language detection on self-hosted runners.
- **Python integration tests** — 4-scenario Python dev loop suite (Alembic/FastAPI/pytest): CREATE TABLE, CREATE with FK, ALTER TABLE, DROP TABLE.

### v0.4.6 changelog:
- **Service principal CI/CD auth** — New `setup-ci-auth.sh` creates a Databricks service principal with OAuth M2M credentials (don't expire). Scaffolding runs it automatically. Replaces PAT-based auth that caused silent CI failures.
- **merge.yml: fail-loud, no duplicate runs** — Migration job on `push`, cleanup job on `pull_request: closed`. Auth failures exit 1 with `::error::`. Cleanup uses PR event data directly (no squash-merge parsing bug).
- **pr.yml: service principal auth support** — Accepts `DATABRICKS_CLIENT_ID`/`SECRET` (preferred) or `DATABRICKS_TOKEN` (legacy). Verifies auth before proceeding.
- **Deleted stale pre-refactor template copies** — Removed `templates/project/{.env.example,.github,.gitignore,scripts,src}`.
- **Added branch lifecycle integration test** — `test/integration/branchLifecycle.test.ts`.

### v0.4.7 changelog:
- **Renamed FlywayService → SchemaMigrationService** — Language-agnostic name. 22 files updated, unused `migrate()` deleted.
- **Language-aware migration detection** — Auto-detects Python/Alembic, Java/Flyway, Node.js/Knex from marker files. Correct migration path, file pattern, and parser per language.
- **Lakebase Changes uses live database diff** — Queries actual Lakebase branch tables and diffs against production (same as branch tree). Language-agnostic, no migration file parsing.
- **Alembic migration parser** — `op.create_table`, `op.drop_table`, `op.add_column` from Python migration files.
- **Branch tree inline icons** — Create (diff-added), delete (trash), console (link-external), branch diff, refresh, and run tests (beaker) icons on branch and database detail rows. Db-only branches get console + diff + trash. "No Lakebase branch" row shows create icon.
- **Run Tests command** — Beaker icon on current branch row. Runs `refresh-token.sh` → `run-tests.sh` (which applies pending migrations then runs tests).
- **Language-aware migration commands** — `Run Migrations` and branch-switch migration use `refresh-token.sh` + correct tool per language (Alembic/Flyway/Knex).
- **run-tests.sh applies pending migrations** — Detects language and runs Alembic/Flyway/Knex upgrade before test runner.

### v0.4.8 changelog:
- **SP auth refinements** — Polished service principal workflow from v0.4.6. Fixed 9 pre-existing test failures: `getConsoleUrl` async/await, `schemaDiffService` cache bypass stub, `updateEnvConnection` Spring-specific assertions, SCM provider schema tests updated for live DB diff.
- **328 tests passing, 0 failing.**

### v0.4.9 changelog:
- **OAuth-only CI auth** — Removed all service principal references from workflows and scripts. CI uses `DATABRICKS_TOKEN` (OAuth token refreshed by pre-push hook). Fail-loud `::error::` on missing/expired credentials.
- **Pre-push hook refreshes OAuth token** — `pre-push.sh` runs `databricks auth token` before every push, syncing a fresh token to `DATABRICKS_TOKEN` in GitHub secrets. Eliminates stale token failures.
- **Backported PAT fixes to templates** — Auth preflight check, `.name`-over-`.uid` jq branch lookup, 3-char Lakebase branch name padding in `post-checkout.sh` and `refresh-token.sh`.
- **Full template/project parity** — All 16 scripts and 2 workflows verified identical between extension templates and deployed projects.
- **328 tests passing, 0 failing.**

### v0.5.1 changelog:
- **Deploy App command** — Multi-step wizard: pick existing target or create/edit one. Confirms before deploy. Builds frontend, updates `app.yaml` with Lakebase config, uploads source files per-file to workspace, deploys via `databricks apps deploy`. Clickable "View in Databricks" notification during deploy, "Open App" + "Copy URL" buttons on success.
- **Workspace mkdirs before upload** — `uploadSource` now creates remote parent directories (`databricks workspace mkdirs`) before importing files, fixing deploys with nested asset directories (e.g. `static/_static/`).
- **deploy-targets.yaml** — New config file format for multi-target deployments. Scaffolded projects get a template with `{{PROJECT_NAME}}` substitution.
- **migrationPath default fix** — Changed default from hardcoded `src/main/resources/db/migration` to empty string (auto-detect from project language). Python and Node.js projects no longer need manual configuration.
- **Lakebase folder always visible** — Changes tree shows the Lakebase folder even when empty (collapsed), instead of hiding it entirely.
- **Lakebase re-evaluation on stage/unstage** — `refreshCodeOnly` now re-evaluates migration files, so staging a migration immediately updates the Lakebase group.
- **Removed debug logging** — Cleaned up `Lakebase SCM Debug` output channel added during migrationPath troubleshooting.

### Known issues / tech debt:
- Existing projects created before v0.4.0 need manual workflow update (replace `actions/setup-java` with local JDK step) for self-hosted runners.
- Runner zombie processes can still occur if the extension crashes mid-operation.
- Health check commands (`databricks --version`, `gh --version`) use direct `execSync` — acceptable.
- More Actions `...` opens a QuickPick at the top of the window — VS Code extension API does not support floating popups positioned near tree items.
- `lakebaseSync` prefix used for all command IDs, settings, context keys, and submenu IDs (457 occurrences across 11 files). Should be renamed to `lakebaseScm` to match the extension name "Lakebase SCM Extension". Breaking change — requires updating all `when` clauses, `registerCommand` calls, `contributes` entries, and user-facing settings simultaneously.
- `DiffService` exists but is not wired into callers (Phase 6 #55). `extension.ts` and `graphWebview.ts` still build diff tuples inline.
- 6 commands are registered but only accessible via Command Palette — no menu placements (Phase 6 #56).
- `STATUS_ICONS`/`STATUS_COLORS` exported from `theme.ts` but not consumed by providers (Phase 5 #53).
