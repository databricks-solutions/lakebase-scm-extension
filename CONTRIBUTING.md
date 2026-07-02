# Contributing

Thanks for your interest in contributing to the Lakebase SCM Extension. This is a [Databricks Labs](https://github.com/databrickslabs) project – community-supported, not officially supported by Databricks.

## Development setup

Prerequisites:
- Node.js 18+ and npm
- VS Code 1.85 or newer
- The [`vsce`](https://github.com/microsoft/vscode-vsce) CLI (installed as a devDependency; use `./node_modules/.bin/vsce`)
- The [Databricks CLI](https://docs.databricks.com/dev-tools/cli/) authenticated to a workspace with Lakebase enabled (only required for live testing against Lakebase)

```bash
git clone https://github.com/databrickslabs/lakebase-scm-extension
cd lakebase-scm-extension
npm install
```

## Running locally

Open the repo in VS Code and press `F5` (`Run → Start Debugging`). VS Code launches an Extension Development Host with this extension loaded. Make changes in `src/`, reload the host (`Ctrl/Cmd+R` in the host window) to pick them up.

## Building a VSIX

```bash
npm run package
```

This is the canonical build command. It wraps `vsce package` (no `--no-dependencies`) so `node_modules/` ships in the vsix; the externalized deps (`tweetsodium`, `tweetnacl`, `blakejs`, `adm-zip`) are loaded at runtime via webpack externals and the extension fails to activate without them.

Produces `lakebase-scm-extension-<version>.vsix` at the repo root. Sideload with:

```bash
code --install-extension lakebase-scm-extension-<version>.vsix --force
```

then `Developer: Reload Window` in the host to pick up new menu wiring / commands.

## Project structure

```
src/
  extension.ts            # command registrations and activation
  providers/              # tree views + SCM provider + webviews
  services/               # Lakebase, git, schema diff, runner, etc.
  utils/                  # config, exec, theme, diff helpers
templates/project/common/ # files copied into scaffolded user projects
  scripts/                # post-checkout, refresh-token, etc.
  scripts/ci/             # CI helpers used by pr.yml / merge.yml
  .github/workflows/      # pr.yml, merge.yml, cleanup-orphans.yml
```

The extension has two parallel surfaces that must stay in sync:
- **Shell hooks** (`templates/project/common/scripts/*.sh`) – fire from terminal `git` operations.
- **TypeScript services** (`src/services/lakebaseService.ts` etc.) – invoked by VS Code UI commands.

When you change branch lifecycle behavior (fork source, connection target, credential mint), update both paths in the same PR.

## Testing

> **All three tiers, every PR.** That includes the live integration suites in Tier 3 – they're the only layer that exercises real CI workflow templates, self-hosted runner setup, Lakebase branch CRUD, and the cleanup pipeline. Bugs that ship through Tier-1+2-only review almost always surface here. If you genuinely can't run Tier 3 (no Databricks workspace access), say so in the PR description so reviewers know exactly what's covered.

Three tiers, ordered by what they require and how long they take:

### Tier 1 – Hermetic unit / suite tests (no credentials, ~1 min)

```bash
npm run package && npm test
```

Runs the mocha `test/suite/` and `test/equivalence/` tests against mocks. **Always run this before pushing.** Catches API breakage, regex/parse logic, scaffold deviations, and drift between extension proxies and the substrate they delegate to.

`npm run package` first because `test/suite/bundleSmoke.test.ts` requires `dist/extension.js` (it `require()`s the packed bundle to catch externalized-but-not-bundled deps). The test self-skips when `dist/` is absent, so on a fresh clone `npm test` alone will pass without the smoke ever running. The pre-push gate (husky) compiles first; do the same locally.

**Equivalence harness (`test/equivalence/`)** – every extension service method that delegates to `@databricks-solutions/lakebase-app-dev-kit` has an adapter-aware equivalence test. Each test stubs the substrate function via `test/mocks/substrate.js` and asserts (a) substrate is called with the args the proxy derived from VS Code context, and (b) the proxy returns the documented adapter applied to the substrate result. When you change a proxy's argument-mapping or its result-adapter, update the matching test in `test/equivalence/`. Run just this slice with `npm run test:equivalence`.

### Tier 2 – Hermetic substrate BDD (no credentials, ~10s)

```bash
cd node_modules/@databricks-solutions/lakebase-app-dev-kit && npx vitest run
```

Covers branch-create collision validation, env-file shape, github URL parsing, etc. against mocks. Runs in your editor / pre-commit hook range. Useful when changing anything in `src/services/lakebaseService.ts` or anything that re-exports substrate symbols.

### Tier 3 – Full integration (requires your own accounts, ~17 min)

The `test/integration/` suites (ecommerce, python-devloop) create **real** Lakebase projects and GitHub repos under YOUR accounts. There is no shared sandbox – you must set this up before the test will run.

**Required setup (one-time):**

1. Pick a Databricks workspace where you can create Lakebase projects. **This will be billed to that workspace.**

2. Set the workspace URL as an env var:

   ```bash
   export DATABRICKS_TEST_HOST=https://<your-workspace>.cloud.databricks.com
   ```

   Add it to your shell rc file (`~/.zshrc` / `~/.bashrc`) so it survives new terminals.

3. Authenticate the Databricks CLI to that host:

   ```bash
   databricks auth login --host "$DATABRICKS_TEST_HOST"
   ```

   OAuth tokens are ~1h TTL – you may need to re-run this between long sessions.

4. Authenticate the GitHub CLI (any owner – the test creates repos under whoever `gh api user` returns):

   ```bash
   gh auth status   # if "not logged in", run:
   gh auth login
   ```

5. Run the integration tests:

   ```bash
   npm run test:integration                                # both suites (~30 min)
   npm run test:integration -- --grep "E-Commerce"        # just ecommerce (~17 min)
   npm run test:integration -- --grep "Python Dev Loop"   # just python-devloop (~10 min)
   ```

If any credential is missing or the wrong host is set, the test fails fast at `before()` with an `IntegrationSetupError` that names the exact command to run. The test never falls back to a shared default host – you have to opt into a workspace explicitly.

### When to run which tier

| Change scope | Minimum |
|---|---|
| Docs / comments | Tier 1 |
| `src/services/*.ts` | Tier 1 + Tier 2 |
| `src/extension.ts` command registrations | Tier 1 + 2 + manual test in Extension Host (F5) |
| Branch lifecycle, project creation, CI templates | **Tier 3 mandatory before PR** |
| `templates/project/common/.github/workflows/*.yml` | **Tier 3 mandatory** (this is what the integration suite actually exercises) |

PRs that change Tier-3-impacting code without a Tier 3 run should say so explicitly so reviewers know what was and wasn't covered.

### Manual scenarios

For UI / view changes that no suite covers, describe the scenarios you exercised:
- Which extension command(s) you triggered
- Which view(s) you observed (Project tree, Branch Diff Summary, Changes panel, etc.)
- What you saw before and after

## Pull requests

- Branch off `main`. Branch names: `fix/<short>`, `feat/<short>`, etc.
- One logical change per PR. Keep commits small and squashable.
- Commit messages: short subject (≤72 chars), then a body explaining *why*. Code already shows *what*.
- **Run all three test tiers** (see § Testing) before opening the PR – including Tier 3 integration. The PR template has a checklist; tick every item or explain in the description what you couldn't run and why.
- Run `npm run package` and confirm it produces `DONE Packaged: ...` (no `ERROR ...` lines) before pushing.
- Update `CHANGELOG.md` for any user-visible change.
- If your PR adds a new command, hook event, or setting, also update the relevant section of `README.md`.

## Reporting issues

Use the issue templates under `.github/ISSUE_TEMPLATE/`. Include the extension version, VS Code version, OS, and the exact command you ran. For schema-diff or branch-tree bugs, the workspace's `.env` (with secrets redacted) and the output of `databricks postgres list-branches "<project-path>"` are usually decisive.

## Code of conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/) – see `CODE_OF_CONDUCT.md`.
