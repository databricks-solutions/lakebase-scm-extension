# Lakebase SCM Extension

## What This Is For

Lakebase SCM Extension is a VS Code / Cursor extension that replaces the built-in Git source control with a unified **Git + Lakebase** SCM provider. Every code branch gets a paired Databricks Lakebase database branch – code and schema travel together through development, review, CI/CD, and merge.

**The problem it solves:** When applications use Lakebase (Databricks' Postgres-compatible database with copy-on-write branching), developers need to keep code branches and database branches in sync. Without this extension, you manually create database branches, refresh credentials, track schema diffs, and clean up branches – across the CLI, the Databricks console, and GitHub.

**What it does:**
- **Create New Project** – 10-step wizard scaffolds a complete project: GitHub repo + Lakebase database + language template (Java/Kotlin/Python/Node.js) + CI/CD workflows + self-hosted runner
- **Automatic branch pairing** – `git checkout -b feature/x` automatically creates a Lakebase database branch
- **Live schema visibility** – see actual database tables on each branch with diff indicators (new/modified/removed vs the branch's parent)
- **Two parallel interfaces** – work from the **Lakebase sidebar** or the **SCM view**, both with full functionality
- **CI Runner management** – deploy, start, stop, and monitor a self-hosted GitHub Actions runner from the sidebar
- **PR integration** – commit → push → create PR in one flow; CI creates a dedicated Lakebase branch for testing
- **Merge awareness** – merge PRs from VS Code; CI applies migrations to production and cleans up branches
- **Branch Review** – multi-diff editor showing all code + schema changes vs the branch's parent, querying actual database state
- **Deploy to Databricks Apps** – multi-target deploy wizard with per-file workspace upload, clickable deploy progress, and post-deploy app launch
- **Full Git SCM parity** – every command from the built-in Git extension is available, plus Lakebase sync

## Install the Extension

The first step is always installing the VSIX. Both Getting Started paths below assume the extension is installed.

### Prerequisites

| Requirement | Install |
|-------------|---------|
| VS Code 1.85+ or Cursor | – |
| Databricks CLI v0.285+ | `brew install databricks` |
| GitHub sign-in (VS Code) or PAT | Sign in when prompted, or set `lakebaseSync.githubToken` |
| PostgreSQL client (psql) | `brew install libpq` |
| Databricks workspace | With Lakebase enabled |

**For Java/Kotlin projects:** JVM 21+ and Maven (the scaffold includes `mvnw`)
**For Python projects:** Python 3.10+ and [uv](https://docs.astral.sh/uv/) (`brew install uv` or `pip install uv`)
**For Node.js projects:** Node.js 18+

### Install the VSIX

1. Download the `lakebase-scm-extension-*.vsix` asset from the [latest release](https://github.com/databricks-solutions/lakebase-scm-extension/releases/latest)
2. In VS Code: **Extensions** → `...` → **Install from VSIX** → select the file
3. Reload the window

## Getting Started

Two paths, pick one:

1. **[Create a New Project](#1-create-a-new-project)** when there is no git repo or Lakebase database yet. The wizard scaffolds everything end-to-end.
2. **[Adopt an Existing Project](#2-adopt-an-existing-project)** when the git repo already exists. The command onboards it to Lakebase without touching the rest of the codebase.

### 1. Create a New Project

The fastest way to start a brand-new project is the **Create New Project** wizard. Two keystrokes get you there:

1. Press **`Cmd-Shift-P`** (macOS) or **`Ctrl-Shift-P`** (Windows/Linux) to open the VS Code Command Palette.
2. Type **`Lakebase: Create New Project`** and hit return.

The wizard walks through 10 steps:

| Step | What | Detail |
|------|------|--------|
| 1 | Project name | Lowercase, letters/numbers/hyphens |
| 2 | Parent directory | Where the project folder will be created |
| 3 | GitHub authentication | Sign in via browser, or use existing auth |
| 4 | GitHub repo name | Defaults to project name |
| 5 | Visibility | Private (default) or Public |
| 6 | Language | Java/Spring Boot, Kotlin/Spring Boot, Python/FastAPI, or Node.js/Express |
| 7 | Runner type | Self-hosted (default) or GitHub-hosted |
| 8 | Databricks workspace | Select or connect to a workspace with Lakebase |
| 9 | Lakebase project name | Defaults to repo name |
| 10 | Execute | Creates everything with progress notification |

**What gets created:**
- GitHub repository with CI/CD workflows (`pr.yml`, `merge.yml`)
- Lakebase database project with a production branch
- Language-specific scaffold (entity, migration, test framework, build tool)
- 18 shell scripts (hooks, migration, secrets, schema diff, federation, cleanup)
- `.env` with Databricks connection, `.gitignore`, `.vscode/settings.json`
- Self-hosted GitHub Actions runner (if selected) – deployed and listening
- Initial commit pushed to main

After creation, the extension offers to open the new project folder.

#### Language Templates

| Language | Framework | Migration Tool | Package Manager | Test Framework |
|----------|-----------|---------------|-----------------|----------------|
| **Java** | Spring Boot (latest via [start.spring.io](https://start.spring.io)) / JPA | Flyway | Maven (mvnw) | JUnit 5 |
| **Kotlin** | Spring Boot (latest via [start.spring.io](https://start.spring.io)) / JPA | Flyway | Maven (mvnw) | JUnit 5 |
| **Python** | FastAPI / SQLAlchemy / psycopg3 | Alembic 1.14 | uv + pyproject.toml | pytest + httpx |
| **Node.js** | Express | Knex 3.1 | npm | Jest + supertest |

Java and Kotlin projects are generated live from Spring Initializr at scaffold time (always the latest stable Spring Boot version). Lakebase-specific configuration (datasource, Flyway plugin, migration placeholder) is overlaid on top. If Initializr is unreachable, the extension falls back to bundled templates. Override the Initializr URL with the `lakebaseSync.springInitializrUrl` setting for private instances.

Smart scripts (`flyway-migrate.sh`, `run-tests.sh`) auto-detect the language from `pom.xml`, `pyproject.toml`, or `package.json`. CI workflows are language-aware – they detect the project type and run the correct setup, migration, and test tools automatically.

#### Runner Types

| Type | How CI runs | When to use |
|------|------------|-------------|
| **Self-hosted** (default) | On your local machine via a GitHub Actions runner | No internet needed for builds; uses local JDK + Maven cache |
| **GitHub-hosted** | On GitHub's infrastructure | Standard GitHub Actions; requires internet for dependency downloads |

### 2. Adopt an Existing Project

For an existing git repo that has no Lakebase database project yet:

1. Open the project folder in VS Code.
2. Press **`Cmd-Shift-P`** (macOS) or **`Ctrl-Shift-P`** and run **`Lakebase: Set Up Existing Project`**.
3. The command prompts for project name, Databricks host, and language (auto-detected from `pom.xml` / `pyproject.toml` / `package.json`), then composes the kit's brownfield onboarding: creates the Lakebase database project, drops `.env`, the git hooks under `.githooks/`, the GitHub Actions workflows under `.github/workflows/`, and (when applicable) the `.tdd/` and `.claude/commands/` scaffolds. Existing files are detected as drift and preserved by default; pass an explicit overwrite when the kit's templates should win.
4. Run **Health Check** to verify the wiring.

If you skip step 2 and just open the project, the sidebar's Lakebase view shows a "Set Up Lakebase for This Workspace" welcome button instead of silently dropping the row. Click it to run the same command.

## Developer Workflow

### 1. Create a Feature Branch

Click `$(git-branch)` on the project item → **Create New Branch...** → type a name.

A git branch and a Lakebase database branch are created together. The `.env` updates with the new database connection. Your code now runs against an isolated copy of production.

### 2. Write Code, Migration, and Tests

Write your feature:
- **Entity/model** – JPA entity, SQLAlchemy model, or Knex schema
- **Migration** – `V{N}__{description}.sql` (Flyway), Alembic migration, or Knex migration
- **Given/When/Then tests** – integration tests that run against the real Lakebase branch database

### 3. Run Tests Locally

```bash
./scripts/run-tests.sh        # auto-detects language
# or directly:
./mvnw test                   # Java
uv run pytest                 # Python
npm test                      # Node.js
```

Flyway/Alembic/Knex applies the migration to the branch database → framework validates entities → tests execute against live PostgreSQL. No mocks.

### 4. Commit and Push

Stage files and commit from the sidebar. If the branch hasn't been pushed, the extension prompts to push when you create a PR.

### 5. Create a Pull Request

Click `$(git-pull-request-create)` on the project item. The extension handles the full pipeline:

1. Detects uncommitted changes → prompts to commit → verifies commit succeeded
2. Pushes branch automatically (no separate dialog)
3. Syncs CI secrets (non-blocking)
4. Prompts for PR title and description
5. Creates the PR

The CI workflow (`pr.yml`) automatically:
- Creates a `ci-pr-<N>` Lakebase branch from production (24h TTL auto-expiry)
- Runs Flyway/Alembic/Knex migrate on the CI branch
- Runs tests
- Posts a schema diff comment on the PR

### 6. Monitor CI

The **CI Runner** view in the sidebar shows:
- Runner status (online/offline) with start/stop controls
- Runner and job logs
- Recent workflow runs with status icons (click opens GitHub)

The **Pull Request** view shows PR status and CI branch status.

### 7. Merge

Click `$(git-merge)` in the Pull Request view:
1. Choose merge method (Merge, Squash, Rebase)
2. Confirm
3. Extension merges, checks out main, pulls latest

The merge workflow (`merge.yml`) automatically:
- Creates a pre-migration snapshot branch (rollback safety)
- Runs Flyway/Alembic/Knex migrate on production
- Verifies schema (checks all expected tables exist)
- Deletes the snapshot branch on success (preserves on failure with recovery instructions)
- Deletes the `ci-pr-<N>` and feature Lakebase branches

### 8. Verify Production

On main, expand the production database node to see all tables. The **Branch Review** queries the actual database state – including ALTER TABLE changes from previous merges.

## Deploy to Databricks Apps

The extension includes a multi-target deploy wizard for deploying applications to Databricks Apps. Run it from the Command Palette:

**Lakebase: Deploy to Databricks App**

### Deploy Targets

Deploy targets are defined in `deploy-targets.yaml` at the project root. Each target specifies where and how to deploy:

```yaml
targets:
  staging:
    workspace_profile: my-staging-workspace
    workspace_path: /Workspace/Users/you@company.com/my-app
    app_name: my-app
    lakebase_project: my-app
    lakebase_branch: production
    uc_catalog: my_catalog
    uc_schema: my_schema
    uc_volume: my_volume
  prod:
    workspace_profile: my-prod-workspace
    workspace_path: /Workspace/Users/you@company.com/my-app
    app_name: my-app
    lakebase_project: my-app
    lakebase_branch: production
    uc_catalog: my_catalog
    uc_schema: my_schema
    uc_volume: my_volume
    lakebase_secret_scope: pat-app-secrets
    lakebase_secret_key: lakebase-pat
```

| Field | Required | Description |
|-------|----------|-------------|
| `workspace_profile` | Yes | Databricks CLI profile name |
| `workspace_path` | Yes | Workspace path where source files are uploaded |
| `app_name` | Yes | Databricks App name (created if missing) |
| `lakebase_project` | Yes | Lakebase project name |
| `lakebase_branch` | Yes | Lakebase branch (typically `production`) |
| `uc_catalog` | No | Unity Catalog catalog for file storage volumes |
| `uc_schema` | No | UC schema within the catalog |
| `uc_volume` | No | UC volume name for file uploads |
| `lakebase_secret_scope` | No | Secret scope containing a PAT for Lakebase auth (see below) |
| `lakebase_secret_key` | No | Secret key within the scope |

### Deploy Steps

The deploy wizard executes these steps in order:

| Step | What | Detail |
|------|------|--------|
| 1 | Build frontend | Runs `npm run build` in `client/` (if it exists) |
| 2 | Generate app.yaml | Builds the env block from target config, restores the original after deploy |
| 3 | Ensure Lakebase infra | Creates Lakebase project and branch if missing |
| 4 | Ensure UC infra | Creates catalog, schema, and volume if missing (prompts for manual creation on Default Storage workspaces) |
| 5 | Upload source | Per-file `databricks workspace import` for app code, migrations, config, and built frontend |
| 6 | Create app | Creates the Databricks App if it doesn't exist |
| 7 | Grant permissions | Grants the app's service principal access to the Lakebase project and UC catalog |
| 8 | Secret auth | Creates secret scope, generates PAT, stores it, grants SP read access (only when `lakebase_secret_scope` is configured) |
| 9 | Deploy | Runs `databricks apps deploy` and waits for completion |
| 10 | Seed data | Runs `scripts/seed-data/seed_demo_data.py --target <name>` if the file exists |

### Lakebase Auth: SP vs PAT

Databricks Apps run as a service principal (SP). On most workspaces, the SP can generate Lakebase database credentials directly. However, **some workspaces do not accept SP-generated credentials** (a platform-level feature gap).

**Workaround:** Store a user PAT in a Databricks secret scope. At startup, the app reads the PAT, temporarily masks the SP's OAuth env vars, and creates a PAT-based `WorkspaceClient` to generate Lakebase credentials as the PAT owner.

To enable this for a target, add two fields to `deploy-targets.yaml`:

```yaml
prod:
  # ... other fields ...
  lakebase_secret_scope: pat-app-secrets
  lakebase_secret_key: lakebase-pat
```

The deploy process automates the setup:
1. Creates the secret scope (idempotent)
2. Generates a 90-day PAT for the deploying user
3. Stores the PAT in the secret scope
4. Grants the app's SP READ access to the scope

The PAT is refreshed on each deploy. The app reads these via the `LAKEBASE_SECRET_SCOPE` and `LAKEBASE_SECRET_KEY` env vars in `app.yaml`.

**App-side implementation** (in `database.py` or equivalent):
```python
# When LAKEBASE_SECRET_SCOPE and LAKEBASE_SECRET_KEY are set:
# 1. Use default WorkspaceClient (SP auth) to read the PAT from secrets
# 2. Temporarily mask DATABRICKS_CLIENT_ID and DATABRICKS_CLIENT_SECRET
# 3. Create a PAT-based WorkspaceClient to generate Lakebase credentials
# 4. Restore the masked env vars
```

### Seed Data

After a successful deploy, the extension checks for seed data scripts in the project:

- **Primary:** `scripts/seed-data/seed_demo_data.py` – runs with `--target <name>` and `--with-partners` (if `sfdc_partners.csv` exists)
- **Fallback:** Lists any `.py` files in `scripts/seed-data/` for manual execution

Seed data is idempotent – existing rows are skipped, changed rows are updated. Failure is non-fatal (the deploy succeeds, a warning is shown).

To add seed data to a project, create `scripts/seed-data/seed_demo_data.py` with a `--target` argument that reads `deploy-targets.yaml` to connect to the correct database.

### CLI Deploy Script

Projects can also include a `scripts/deploy.sh` for command-line deployment. It follows the same steps as the extension wizard and reads the same `deploy-targets.yaml`:

```bash
./scripts/deploy.sh              # list available targets
./scripts/deploy.sh staging      # deploy to staging
./scripts/deploy.sh prod         # deploy to prod
```

## Sidebar Views

Click the Lakebase icon in the activity bar. The sidebar contains:

| View | Shows | When |
|------|-------|------|
| **Project** | Repo, Lakebase project, branches with expandable details (tables, files, migrations) | Always |
| **Changes** | Staged, Code (unstaged), Lakebase schema changes, Sync indicator | Always |
| **Schema Migrations** | All V*.sql migration files | On main only |
| **Pull Request** | PR status, CI branch status, merge action | When PR exists |
| **CI Runner** | Runner status, start/stop, logs, recent workflow runs | Always |
| **Recent Merges** | Last 5 merge commits | On main only |
| **Graph** | Visual commit graph with Lakebase annotations | Always |

### Branch Table Diff

Expanding a branch's database node queries the actual Lakebase database and shows each table with a diff indicator against the branch's parent (e.g. `staging` for a feature forked from staging):

- `+` – new table created on this branch
- `~` – table with modified columns vs the parent
- `-` – table removed on this branch (still present on the parent)
- no marker – table is identical on both sides

Click any table to open a side-by-side comparison panel: parent columns on the left, branch columns on the right, with per-column markers for added / removed / type-changed.

## Database Migration Strategy

The extension supports explicit, versioned migrations – not ORM auto-DDL. Schema changes must go through migration files:

| Language | Migration Tool | Migration Files |
|----------|---------------|----------------|
| Java / Kotlin | Flyway | `src/main/resources/db/migration/V{N}__desc.sql` |
| Python | Alembic | `alembic/versions/*.py` |
| Node.js | Knex | `migrations/*.js` |

**Why:** Versioned migrations are reviewable in PRs, applied deterministically by CI, and diffed between branches. ORM auto-DDL (`ddl-auto=create`, `db.create_all()`) bypasses this – use `validate` mode instead.

## Settings

Search `lakebaseSync` in VS Code Settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `autoCreateBranch` | `true` | Auto-create Lakebase branch on git checkout |
| `autoRefreshCredentials` | `true` | Background credential refresh (45 min) |
| `showUnifiedRepo` | `true` | Show Git + Lakebase in Source Control |
| `productionReadOnly` | `true` | Prevent deleting the production branch |
| `migrationPath` | _(empty – auto-detect)_ | Migration file path. Leave empty to auto-detect from project language. |
| `trunkBranch` | _(empty)_ | Alternative git branch name to treat as `main` (in addition to `main`/`master`). Also readable from `LAKEBASE_TRUNK_BRANCH` in `.env`. |
| `stagingBranch` | _(empty)_ | Git branch name that pairs with the project's `staging` Lakebase tier. Set this when you use a 3-tier flow (feature → staging → production) so feature branches diff against staging instead of falling back to production. Also readable from `LAKEBASE_STAGING_BRANCH` in `.env`. |
| `baseBranch` | _(empty – auto-resolve)_ | Explicit base branch for file diffs. When empty, the extension picks the nearest parent across `trunkBranch` / `main` / `master` / `stagingBranch` / `staging` via `git merge-base` recency. Also readable from `LAKEBASE_BASE_BRANCH` in `.env`. |

### Trunk Branch Alias

By default the extension and the `post-checkout` hook treat only `main` and `master` as the trunk (and connect `.env` to the project's default Lakebase branch when you're on one of them). If your repo uses a prefixed or otherwise non-standard trunk branch – common in shared-monorepo conventions where each project's "production" branch is a user- or team-prefixed name like `team-alpha/project-foo` – you can opt in by setting either:

- `LAKEBASE_TRUNK_BRANCH=<git-branch-name>` in `.env`, or
- `lakebaseSync.trunkBranch` in VS Code settings (overrides `.env`).

When set, checking out that branch points `.env` at the default Lakebase branch (production) instead of cutting a new feature branch from it. Everything else (main/master) continues to work.

### Staging Branch Alias

Three-tier projects fork feature branches off `staging` (which itself forks off the trunk). To make the extension diff feature branches against staging instead of falling back to production, name the git branch paired with the `staging` Lakebase tier via either:

- `LAKEBASE_STAGING_BRANCH=<git-branch-name>` in `.env`, or
- `lakebaseSync.stagingBranch` in VS Code settings (overrides `.env`).

When set, the **Branch Diff Summary** and per-table comparison panel diff feature branches against staging, the **Tiers** section in the sidebar groups staging as a long-running branch, and **Cut Long-Running Tier...** treats staging as a managed tier rather than a feature branch. Two-tier projects (feature → production) can leave this unset.

## Lakebase Sync Across Git Operations

| Git Operation | Lakebase Action |
|--------------|-----------------|
| Create branch | Creates Lakebase branch from production |
| Switch branch | Updates .env with database connection |
| Delete branch | Deletes corresponding Lakebase branch |
| Rename branch | Deletes old, auto-creates new |
| Merge branch | Offers to delete merged branch's Lakebase branch |
| Pull / Sync | Clears schema cache + refreshes credentials |
| Create PR | Syncs CI secrets; CI creates ci-pr-N branch |
| Merge PR | CI applies migration to production + cleanup |

## Known Limitations

- **Existing pre-v0.4.0 projects** need manual workflow update (replace `actions/setup-java` with local JDK step) for self-hosted runners
- **Schema diff** relies on `psql` queries; a native `databricks postgres schema-diff` CLI command would be faster and more complete
- **Merge conflict resolution** – no special handling for conflicting migration versions across branches
- **Multi-project support** – assumes one Lakebase project per workspace
- **Blue action button** – VS Code's SCM action button uses a proposed API not available to third-party extensions
- **Local branch after merge** – the `post-merge` hook attempts to delete the local feature branch and prune stale remote tracking refs, but this may not succeed in all cases (e.g., squash merges with non-standard commit messages, local uncommitted changes). If the branch persists after merge, delete it manually with `git branch -d <branch>`. Needs investigation – a more reliable approach may be to have the extension explicitly delete the local branch by name (which it already knows from the PR context) after merge, rather than relying on the hook's heuristic parsing of commit messages.

## Contributing

Maintainer-facing docs (development setup, running locally, building the VSIX, the three test tiers, and the pull-request checklist) live in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Roadmap

- **Data preview** – Read-only table viewer for branch databases
- **Conflict detection** – Warn when two branches modify the same tables
- **Branch comparison** – Diff any two Lakebase branches
- **Cursor AI context** – Expose database schema to AI-assisted code generation
