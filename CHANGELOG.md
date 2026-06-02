# Changelog

## 0.5.9 (2026-06-02)

The headline theme is **kit alpha.36 + tier auto-discovery in the extension + auth-storage cleanup**. Three PRs:

### Added

- **`isTierBranch(name)` + module-level tier cache** in `src/utils/theme.ts`. Sync helper backed by a cache that `LakebaseService.listBranches()` refreshes on every call via the substrate's `tierBranchNames()`. Replaces `isStagingBranch(name, alias)` across the extension (statusBarProvider, branchTreeProvider, ~10 extension.ts call sites). Status bar, tree grouping, validators, and the auto-create gate all now drive off the same auto-discovered tier set: any non-default, no-expireTime Lakebase branch counts as a tier (FEIP-7098). PR #53 + PR #54.

### Fixed: substrate bugs surfaced by live smoke

- **Tier classification swept in feature branches.** Kit alpha.35's `isTier` / `tierBranchNames` filtered only on `!isDefault`, so `demo-feature`, `smoke-test`, and other feature branches showed as long-running tiers in the extension UI (purple icon, tier section, refused-to-delete). Real predicate is `!b.isDefault && !b.expireTime`: tiers are created via `createLongRunningBranch` (sets `noExpiry: true`, so `expireTime` absent on the API response); features carry a TTL. Fixed in kit alpha.36; picked up via PR #54.

### Fixed: extension surface

- **Auth-storage override no longer poisons workspace `.env`.** The 0.5.8 respin's `onAuthStorageRuntimeChange` listener persisted `DATABRICKS_AUTH_STORAGE=plaintext` into the workspace `.env` so the runtime fallback survived reload. Side effect: every shell script that sourced `.env` (post-checkout hook, `refresh-token.sh`, etc.) inherited the override. If the user's actual credentials lived in the keyring (re-authed without that env set), those scripts forced plaintext storage, looked at an empty store, and surfaced "Databricks CLI auth failed" messages – even though the interactive CLI was fine. Fix: persist to `context.globalState` instead; extension reads it at activation and calls `setAuthStorageRuntime` before any `LakebaseService` call. Shell scripts stay on the user's default storage (typically keyring). PR #55.
- **`updateEnvConnection` breadcrumb accumulation.** Every `syncConnection` call wrote a `# Connection pending at <ts>` comment to `.env`, but the same function's "keys to replace before rewriting" filter did NOT include the comment pattern. Result: hundreds of stale "Connection pending" lines piled up over weeks (one user accumulated 600+ going back ~6 weeks). Fix: filter `^#\s*Connection pending at ` in the same rewrite pass. PR #55.

### Substrate

- **Kit pin: `v0.3.0-alpha.34` → `v0.3.0-alpha.36`.** alpha.35 shipped FEIP-7098 (`isTier` / `tierBranchNames` + `paired-branch.ts` auto-discover seam) + FEIP-7139 (`updateWorkflows()` in-place YAML refresh primitive). alpha.36 hotfixed the `expireTime` filter so feature branches stop being misclassified as tiers.

372/372 hermetic tests pass.

## 0.5.8 (2026-06-01)

The headline theme is **substrate v0.3.0-alpha.34 + tidy-up + CLI auth-storage compat fix**. Picks up the FEIP-7210 schema-migration adapter pattern (Flyway / Alembic / Knex behind one contract; `lakebase-schema-migrate` bin) plus every kit-API identifier now carrying the `Schema` prefix. Folds in long-standing Phase 6 / Phase 5 cleanup that the prior 9-PR substrate-extraction sweep left behind: orphaned commands gain menu placements, the Cmd+Shift+P findability gap closes, the `theme.ts` constants finally get adopted, and one last inline `git merge-base` exec call routes through the substrate. Late addition: surfaced + fixed an auth-storage compat issue caused by recent Databricks CLI upgrades.

### Added

- **Consistent Command Palette prefix.** All 98 registered commands now carry `category: "Lakebase SCM"` in `package.json#contributes.commands`. Cmd+Shift+P typing "Lakebase" surfaces every extension command under that single prefix (vs. 96 of 98 previously rendering with no category at all).
- **Menu placements for 6 palette-only commands.** `refreshCredentials`, `runMigrate`, `showMigrationHistory`, `showBranchStatus`, `createBranch` (db-only), `showCachedBranchDiff` now appear in the `lakebaseSync.lakebaseMenu` submenu, grouped as `1_lakebase` (status / db-branch / creds / diff) + `3_migrations` (migrate + history). Closes plugin-plan Phase 6 #56.
- **`gitService.getMergeBaseFor(candidate, tip?)`.** Per-candidate merge-base routed through the substrate (`@databricks-solutions/lakebase-app-dev-kit#getMergeBase` with explicit `candidates: [candidate]`). Used by the PR base-branch picker to rank parent candidates by merge-base recency.
- **`DATABRICKS_AUTH_STORAGE` honored end-to-end.** Newly added to `LakebaseConfig` + `EnvConfig` (read from `.env`, workspace settings, or process env), and propagated by `lakebaseExec` to every spawned `databricks` CLI invocation. Lets users opt into plaintext file-cache storage on workspaces where the CLI was upgraded past the keyring-credentials break.

### Fixed: extension surface

- **CLI auth-storage compat (the loop bug).** Symptom: on Cursor / VS Code with a newly-upgraded `databricks` CLI, the extension reports "Not connected", `Connect to Workspace` re-authenticates, the in-memory hostOverride lets things work for a moment, and the next window reload puts the user back to "Not connected". Root cause: the new CLI rejects credentials saved by older versions ("stored credentials from older CLI versions are no longer used") and the extension's `handleAuthError` didn't recognize this error class, so it just reported the generic "Not connected" without the remediation hint. Fix: `lakebaseService.isAuthStorageCacheError()` matches the error substring; `handleAuthError` and the activation-time check both surface a two-action notification ("Re-authenticate" / "Use plaintext storage"). The "Use plaintext storage" action writes `DATABRICKS_AUTH_STORAGE=plaintext` into the workspace `.env` via the existing `upsertEnvKeys` helper, then offers a one-click reload. After reload, `lakebaseExec` reads the value via `getConfig()` and propagates it to every CLI call. Recovery is one click instead of a CLI archaeology session.
- **Post-install hygiene: auto-clean prior versions + restart prompt.** Symptom (surfaced during 0.5.8 smoke): after a `--force` vsix install, both the old and new version directories sit side-by-side under `~/.cursor/extensions/`. VS Code's marketplace-managed update flow handles cleanup + restart prompt automatically; manual `--install-extension` (vsix sideloading) handles neither, which is exactly the path that leaves users on stale code after "successfully installed". Fix: `handlePostInstall()` runs once per activation, gated by a `globalState`-persisted `lastActivatedVersion`. On a fresh version it does two things, matching the install contract a real package needs to honor:
  1. `autoRemoveOlderInstalls()` silently `rm -rf`s any sibling install dirs with the same id prefix (`kevin-hartman.lakebase-scm-extension-X.Y.Z`) other than the current one. No user prompt: stale install dirs are never desired.
  2. Surfaces an information notification naming the version transition + any cleaned-up dirs, with one action button: `Restart <appName>`. On click, `restartHostApp()` quits the host editor and (on macOS) schedules a detached `open -a "<appName>"` so the app re-launches automatically. Non-Mac platforms fall back to `workbench.action.reloadWindow` (best-effort without spawning untrusted shell commands).
  Errors anywhere in the handler are swallowed and logged; activation completes regardless.

### Changed

- **PR base-branch picker uses substrate-routed merge-base.** `lakebaseSync.createPullRequest` previously shelled out to `git merge-base HEAD "<candidate>"` inline via `execUtil`. Now calls `gitService.getMergeBaseFor(c)` which delegates to the substrate. Removes one of the few remaining inline `exec()` calls in `src/extension.ts`. The picker UX (ranked alternatives + nearest-parent default) is unchanged.
- **`STATUS_ICONS` / `STATUS_COLORS` from `theme.ts` adopted by 2 providers.** `schemaScmProvider.ts` (2 maps) and `pullRequestTree.ts` (1 map) now import from `src/utils/theme.ts` instead of redefining inline `Record<string, string>` literals. Closes plugin-plan Phase 5 #53 in two of three identified providers. `branchTreeProvider.ts` has scattered inline `new vscode.ThemeIcon(...)` assignments in conditional blocks; refactoring those needs more than a literal swap, so they're tracked as a smaller follow-up.

### Substrate

- **Kit pin: `v0.3.0-alpha.33` → `v0.3.0-alpha.34`.** Brings in (kit #91, #95, #96): the schema-migration adapter pattern (Alembic / Knex adapters, Knex runner promotion from stub to full implementation), the `lakebase-migrate` → `lakebase-schema-migrate` bin rename, and the `Schema`-prefix audit across every public kit identifier (`MigrationAdapter` → `SchemaMigrationAdapter`, `applyMigrations` → `applySchemaMigrations`, `MigrationFile` → `SchemaMigrationFile`, etc.).
- **Extension absorbed the renames** in `src/services/schemaMigrationService.ts` (imports + return-type aliases), `test/integration/{ecommerce,python-devloop}/helpers.ts`, `test/equivalence/migrate.equiv.test.ts` (`stubSubstrate` keys), and `docs/two-tier-e2e-promotion-plan.md`. Extension-internal class methods (e.g. `SchemaMigrationService.listMigrations()`) stay unprefixed: the class name carries `Schema` and the methods read fine in context.
- **Also picks up kit #92 / #93 / #94 / #97** from the alpha.34 release: `run-all-live-tests.sh` config collapse (no more redundant `--database` / `--feature-ttl-days` / `--github-owner` flags; everything in `.env.local.test.config`), renamed test config files + a new `.env.kit.example` for kit users, and the `waitForBranchAuthReady()` primitive that handles the transient "External authorization failed" window on freshly-provisioned Lakebase projects for non-retrying Postgres drivers (Knex).

### Respin (2026-06-02)

Same tag, regenerated `.vsix`. Five live-smoke fixes folded back in without bumping the version, because the initial 0.5.8 vsix shipped with three issues that surfaced the first time real users installed it:

- **Self-correcting auth, end to end.** `handleAuthError` now detects the OAuth `refresh token is invalid` / `access token could not be retrieved` failure class and surfaces a one-click "Re-authenticate" notification that opens a terminal pre-typed with `databricks auth login --profile <name>`. The right profile is auto-resolved by matching the project host against `~/.databrickscfg` (`LakebaseService.resolveProfileForHost`). The storage-cache auto-recovery now persists `DATABRICKS_AUTH_STORAGE=plaintext` into the workspace `.env` the first time the runtime fallback fires, via a one-shot `onAuthStorageRuntimeChange` observer, so the override survives reload instead of being rediscovered on every launch.
- **Status-bar pairing for Git branches with slashes.** `StatusBarProvider` previously showed a spurious "No DB Branch" warning when a Git branch with a slash (`feature/parallel-ab-test`) was paired with the sanitized Lakebase form (`feature-parallel-ab-test`), because `LakebaseService.getBranchByName()` passed the raw string straight to substrate's exact-string match. Fix moved into `LakebaseService` itself: every branch-name method (`getBranchByName`, `waitForBranchReady`, `deleteBranch`, `getEndpoint`, `getCredential`, `syncConnection`, `queryBranchTables`, `queryBranchSchema`, `queryBranchSchemaWithError`) now sanitizes at entry, mirroring the existing `createBranch` pattern. Sanitization is idempotent on already-sanitized inputs, UIDs, and hardcoded values like `'staging'`, so callers passing `lb.branchId` keep working unchanged.
- **Install-event detection by mtime + size, not version string.** `handlePostInstall` keys off `mtime + size` of `<extensionPath>/package.json` rather than version string, so a rebuilt same-version vsix is correctly detected as an install event and the restart prompt fires. The previous version-string check silently swallowed the prompt during hotfix iteration (every rebuild of `0.5.8` looked identical to the persisted "we already prompted for 0.5.8" value).
- **Self-announcing future upgrades.** `watchForOwnInstall` hooks `vscode.extensions.onDidChange` so the currently-running extension prompts the user to reload as soon as a newer copy of itself appears on disk. From 0.5.8 forward, users no longer have to know to run "Developer: Reload Window" by hand after `cursor --install-extension`.
- **Cold-start pg timeouts tuned for interactive use.** New `src/preload-env.ts` (first import in `extension.ts`) sets `LAKEBASE_KIT_TIMEOUT_PG_CONNECT_MS=60000` and `LAKEBASE_KIT_TIMEOUT_PG_STATEMENT_MS=30000` before the substrate evaluates its `KIT_TIMEOUTS` constant. Kit defaults of 10s / 15s were tuned for hermetic tests with already-warm endpoints; in the IDE we routinely hit cold-start Lakebase compute (idle endpoints paused, first wake takes >10s), which surfaced as "Lakebase schema query failed: timeout expired" on the smoke-test branch. User overrides via `.env` or shell still win.

372/372 hermetic tests pass. Tag `v0.5.8` force-moved to the respin commit so the published `.vsix` matches the tagged source.

### Known follow-ups (not in this release)

- **Scaffolded-project README about `core.hooksPath` pinning** (parity-followup #7). Identified during this PR's audit. Doing it requires adding `templates/project/common/README.md` to the kit (doesn't exist today) + a kit alpha.35 + another extension pin bump. Tracked.
- **`branchTreeProvider` inline-icon refactor.** Inline `new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('charts.green'))` in conditional blocks. Needs restructuring to drive off a `status` variable. Tracked.
- **`lakebaseSync` → `lakebaseScm` prefix rename** (457 occurrences across 11 files). Own release cycle; breaking.

## 0.5.7 (2026-05-31)

The headline theme is **VS Code command for the long-running-tier methodology + parent-branch / branch-identifier hardening**. The kit ships the "fork from staging" PSA convention but a real VS Code user had no way to cut a `staging` (or `uat` / `perf`) tier without dropping to a terminal. Closes that UX gap. Plus a long tail of bugfixes around parent-branch resolution, branch identifier flows, and the table-diff webview.

### Added

- **`lakebaseSync.cutLongRunningTier` command** (FEIP-7097). Closes the biggest documented UX gap in the supported branching methodology. Quick-picks tier name (`staging` / `uat` / `perf` / custom) and fork-from branch (defaults to current HEAD or `main` for the first tier). One confirmation dialog explains "this creates a Lakebase branch + matching git branch that release PRs target; it's not auto-created". Calls substrate `createLongRunningBranch` with the inputs. Surfaces in the Project view title bar.
- **`isMigrationMetadataTable` helper** (PR #23). Consolidates `flyway_schema_history` / `alembic_version` / `knex_migrations` exclusion behind a single predicate consumed by every table-diff path. Previously each call site had its own filter list.
- **Auth helper hardening** (FEIP-7112, PR #19). Silent-fallback removal across `lakebaseService` auth paths. Typecheck cleanup pass. CI gate ensures typecheck stays green on every PR.

### Fixed

- **`adm-zip` activation crash** (PR #25). The `adm-zip` package was bundled into the extension's webpack output but its native runtime resources weren't included; activation crashed with a `Cannot find module` error in the published vsix. Externalize `adm-zip` from the webpack bundle and ship it under `node_modules/` so the runtime resolution succeeds.
- **README install instructions** (PR #24). Made the install commands version-agnostic so they don't drift every release.
- **Parent-branch resolution + branch identifier flows + table diff webview** (PR #26). Catch-all fix bundle for issues surfaced during the v0.5.6 release validation. See PR description for the per-bug breakdown.

### Substrate

- **`deployService` + `runnerService` routed through substrate** (FEIP-7128, FEIP-7129, PR #20). Both services now delegate to substrate primitives for their non-VS Code-specific paths. Same pattern as the earlier migrations of `gitService` and `lakebaseService`. Part of the broader substrate-extraction story.
- **Kit pin: alpha.17 → alpha.18** (PR #18). Picked up substrate fixes for the staging-tier discovery flow.

### Tooling

- **Drop broken `npm run lint`** (FEIP-7132, PR #21). The script was registered but no eslint config existed; running it produced confusing errors. Removed until eslint is genuinely set up.
- **Correct section 4 of `vs-code-parity-followups.md`** (FEIP-7104, PR #17). The self-hosted-vs-github-hosted runner write-up was out of date relative to the substrate's actual capabilities.

## 0.5.6 (2026-05-24)

The headline theme is **substrate `v0.1.0-alpha.0`** – the workflow-scripts dep is now version-tagged rather than pinned to a bare SHA, and the extension's branch-create + integration-test surfaces tighten around the lock. Two real substrate bugs found via live BDD against a freshly-created workspace and fixed: `schema-diff` was passing branch UIDs to `databricks postgres list-endpoints` (which only accepts names), and `branch-create` returned existing branches even when the requested parent differed. The integration suites stop silently defaulting the Databricks host to one maintainer's workspace – contributors must opt in to their own. End-to-end coverage at this version: **1554 tests, zero failing**.

### Added

- **`requireLakebaseLiveEnv` helper (substrate)** – `tests/bdd/credentials.ts` consolidates the live-test env contract (`DATABRICKS_TEST_HOST`, `LAKEBASE_TEST_INSTANCE/BRANCH/PARENT`, `LAKEBASE_TEST_E2E`, `LAKEBASE_TEST_INITIALIZR`, `GITHUB_TOKEN`) behind one call. Returns a typed `LakebaseLiveEnv` or prints a copy-paste-ready setup banner when fields are missing. `gh auth token` auto-fallback so contributors don't have to shell-substitute. Drafted, not yet wired into existing tests.
- **`assertIntegrationCredentials` helper (extension)** – `test/integration/lib/credentials.ts` is the extension-side equivalent. Both ecommerce and python-devloop integration `before()` hooks now call it before any cloud-resource creation; failures throw a banner-prefixed `IntegrationSetupError` naming the exact `databricks auth login` / `gh auth login` commands to run.
- **`acquireSingleRunLock(suiteName)` (extension)** – pid-file lock in `test/integration/lib/lifecycle.ts`. A second mocha launch for the same integration suite refuses to start (rather than racing into orphaned project pairs). `process.kill(pid, 0)` liveness check correctly treats EPERM-on-foreign-pid as alive so an unrelated PID reuse can't reclaim the lock. Wired into both `ecom` and `pydev`.
- **`lakebaseSync.createUnifiedBranchFrom`** – renamed from `lakebaseSync.createBranchFrom` for symmetry with `createUnifiedBranch`. Both names now describe what they do: create paired git + Lakebase branch from current (`createUnifiedBranch`) or from a picked base (`createUnifiedBranchFrom`). Lakebase-only creation remains `lakebaseSync.createBranch`. **Breaking** if you had keybindings bound to the old name.
- **Three-tier testing section in `CONTRIBUTING.md`** – hermetic unit / hermetic substrate BDD / full integration. Maps "what changed" → "minimum tier to run" and documents the env setup for Tier 3. Tier 3 is mandatory before merging branch-lifecycle or CI-template changes.
- **`branch-create` collision-vs-idempotency validation (substrate)** – when a branch with the target name exists, compare its actual source to the requested parent. Match → return existing (true retry idempotency). Mismatch → throw `LakebaseBranchError` naming both sources, so the operator picks delete-then-recreate or a different target. Previously the existing branch was returned silently regardless of lineage. Hermetic test coverage via `vi.mock` on `branch-utils` (no Lakebase needed).

### Fixed: substrate bugs surfaced by live BDD

- **`schema-diff` no longer passes UIDs to `list-endpoints`.** Two helpers in `scripts/lakebase/schema-diff.ts` were returning branch UIDs (`br-still-bar-d2ubc465`) where the Lakebase API needs the branch NAME (`staging`): `resolveComparisonBranch` returned `branchInfo.source_branch_id` verbatim, and `findDefaultBranch` preferred `def.uid` over `def.name`. Symptom on a freshly-forked branch: every `getSchemaDiff` call surfaced `error: "branch id not found"` and `inSync: false` with empty change arrays. Now `resolveComparisonBranch` resolves UID → name via a new `resolveBranchNameByUid` helper (scans `list-branches`), and `findDefaultBranch` prefers `name` over `uid`. The happy path (`inSync: true` for empty=empty fork) now fires.
- **`syncCiSecrets` takes host + projectId as direct args** (substrate). After option 3 removed the `.env` write from `createProject`, `syncCiSecrets` (which read `.env` to get HOST + PROJECT_ID) silently failed with "`.env` not found" – projects shipped without `DATABRICKS_HOST` / `LAKEBASE_PROJECT_ID` / `DATABRICKS_TOKEN` GitHub Actions secrets, so every PR's `migrate-target` and `cleanup-lakebase-branches` job hit `LAKEBASE_PROJECT_ID=` empty and failed. The user-visible symptom was "Lakebase feature branches not removed with their GitHub branches" – symptom; root cause was upstream missing secrets. Now `syncCiSecrets` requires both as args; the create-project caller passes them from the already-in-scope values.
- **`createProject` no longer writes `.env`** (substrate, "option 3"). Closes the last path by which a real Lakebase JWT could end up staged in git: previously substrate wrote `.env` (host + project-id, no JWT) and committed it; the post-checkout hook would then append a JWT to the tracked `.env`, which `git add .` would stage and Gitleaks would (correctly) reject. With `.env` never tracked in the first place, that race disappears. The post-checkout hook bootstraps `.env` from `.env.example` on first switch.
- **`merge.yml` snapshot lifecycle hardening (substrate templates).** The pre-migration snapshot's `create-branch` call was `... 2>&1 || true` followed by an unconditional `SNAPSHOT_NAME=...` export – a silent create-failure produced a misleading "may have already expired" log in the cleanup step. Now `SNAPSHOT_NAME` is only exported when create-branch succeeded; otherwise the job emits a clear `::warning::Failed to create pre-migration snapshot`. Also dropped the dead `MIGRATE_RESULT="${{ steps.snapshot.outcome }}"` line (referenced the wrong step's outcome and was never used).
- **`createProject` live E2E test no longer leaks Lakebase projects.** Vitest's 5s default timeout was way under the actual `createProject` runtime (~30-60s); the test timed out before completion, retried, and left 3 orphaned projects on the workspace per run. Bumped to a 180s timeout and added an `afterEach` that deletes whatever project the test created – so an assertion failure on the contract still cleans up the cloud resource.

### Fixed: extension surface

- **Drift detection in `lakebaseService.createBranch`.** Resolution precedence is now: `baseBranchOverride` → `getConfig().baseBranch` → **`currentGitBranch` arg** (sanitized, passed by the caller) → `LAKEBASE_BRANCH_ID` from `.env` → substrate default. When the caller passes `currentGitBranch`, the service cross-checks it against `.env`'s `LAKEBASE_BRANCH_ID`; on disagreement it warns and prefers the git side. Fixes a silent failure mode where a stale `.env` (post-checkout hook didn't fire, or the user ran `git checkout` with hooks disabled) made Lakebase fork from the wrong parent. Four call sites in `extension.ts` updated to pass the value (`createBranch` button, `createUnifiedBranch`, `createUnifiedBranchFrom`, `switchBranch` create-if-missing). Logic extracted as an exported pure helper (`resolveCreateBranchParent`) for unit-testability.
- **Dead `writeEnvFile` deleted from `projectCreationService.ts`.** The private method was orphaned when `createProject` got proxied to substrate. Removed so it can't be accidentally rewired – reintroducing a local `.env` writer would re-open the exact gitleaks path substrate option 3 closed.
- **`githubService.ts` implicit-any fixed.** Annotated `data.map(c => …)` in `listCommits` with a structural `CommitItem` type (`sha`, `author?.avatar_url`, `commit?.author?.name`). Avoids importing Octokit's full `RestEndpointMethodTypes` chain, which is what tsc was choking on. Extension typechecks completely clean now.
- **Integration tests no longer default to one maintainer's Databricks workspace.** Both `ecommerceScenarios.test.ts` and `pythonDevloop.test.ts` removed the silent `process.env.DATABRICKS_HOST || 'https://fevm-…'` fallback. Contributors must `export DATABRICKS_TEST_HOST=https://<their-workspace>...` and `databricks auth login` against it before running. Failure mode is now a banner-prefixed `IntegrationSetupError` with copy-paste setup commands, not a confusing "we're creating projects on someone else's workspace" surprise.
- **`createProject` "Step 6" comment block updated** to reflect that `.env` is intentionally not written by the create flow. Documents the rationale inline so the next person looking at the orchestration doesn't try to add it back.

### Repo / governance

- **Substrate is now version-tagged.** `databricks-solutions/lakebase-app-dev-kit#v0.1.0-alpha.0` (annotated tag at `f61af250`). The extension's `@databricks-solutions/lakebase-app-dev-kit` dep references the tag, not a bare SHA – reproducible installs, bisect-friendly, and a clear forward path for future bumps (`v0.1.0-alpha.1`, etc.).
- **Test coverage at this release:** hermetic substrate BDD 175 passing / 22 skipped; full live substrate BDD 197 / 0 (with `LAKEBASE_TEST_E2E=1` + `LAKEBASE_TEST_INITIALIZR=1`); extension unit suite 343 / 0; extension ecom integration 413 / 0; extension python-devloop integration 426 / 0. **1554 tests, zero failing.**

## 0.5.5 (2026-05-13)

The headline theme is **consistency on the "parent branch"**. Five views – code diff, schema diff (Branch Diff Summary), per-table modal, branch-tree table coloring, and the base of newly-created PRs – used to default to "main" or "production." They now resolve the actual parent (the nearest ancestor via git merge-base on the git side; the Lakebase branch's `source_branch` on the schema side). A feature forked from `staging` now diffs against `staging` everywhere, and `gh pr create` targets `staging`. Plus a long tail of branch-lifecycle and runner fixes, and the standard scaffolding for donating the repo to `databrickslabs/`.

### Added

- **`lakebaseSync.deleteBranchEverywhere`** – trash-icon and context-menu action on branch rows in the Project tree. One confirm dialog enumerates exactly what will be deleted (local git, `origin/<branch>` if pushed, Lakebase branch) and skips items that don't exist. Supports deleting the currently-checked-out branch: picks the first existing local branch among `config.trunkBranch` / `main` / `master`, refuses on a dirty tree, checks out the parent first, then deletes. Refuses trunk and staging-alias branches.
- **`lakebaseSync.installPlaywrightConfig`** – copies the reference `client-reference/playwright.config.ts` into `client/`. Prompts on overwrite, no-ops if `client/` is absent. The reference now also defaults `DEV_MODE=true` and forwards `DATABRICKS_HOST` / `DATABRICKS_TOKEN` from `process.env` so CI's Playwright-booted backend exposes test-only endpoints and uses env-based SDK auth (no more `refresh token is invalid` 30 minutes in).
- **Up-front dirty-tree prompt on branch switch** – `lakebaseSync.switchBranch` now warns before any git op when the working tree has uncommitted edits, with Stash & Switch / Commit First / Cancel. Removes the silent "git carried my edits across the checkout" surprise that masquerades as "the new branch has my changes already." Auto-stash always uses `--include-untracked` now (was a plain `git stash push`, which left new files on disk to get clobbered by checkout – a near-data-loss path on three call sites; all three fixed).
- **`databricks current-user me` preflight on runner setup** – `setupRunner` now reads `.env` for `DATABRICKS_CONFIG_PROFILE` and verifies the runner host's CLI auth before configuring the runner. On `refresh token is invalid`, surfaces an actionable message including the exact `databricks auth login --host ... --profile ...` command. Non-fatal – runner still sets up.
- **Actionable 404 on runner registration-token** – when the active `gh` user can't see the target repo (typical when a private repo's owner differs from the active EMU/personal session), the previous error was bare "Not Found (HTTP 404)." Now reads the active `gh` user via `gh auth status` and tells you exactly which user to switch to.
- **`createBranchFrom` quickpick passes the chosen base through** – both `lakebaseSync.createBranchFrom` and the create-from action inside the switch-branch picker now pre-create the Lakebase branch with the explicit base **before** running `git checkout -b`. Previously they relied on the post-checkout hook + auto-listener race, which silently forked from production whenever the `.git/hooks/post-checkout` copy was stale or the listener fired first.
- **PR base picker on `lakebaseSync.createPullRequest`** – `gh pr create` was called without `--base`, so PRs always targeted the repo's default branch (main) even for features that branched off staging. The command now quick-picks the base from local candidates (`trunk`, `master`, configured `staging`, configured `LAKEBASE_BASE_BRANCH`), defaulting to the "nearest parent" by merge-base recency, and passes `--base` through. The "No commits between main and this branch" warning now uses the selected base. The merge-flow progress message and success toast use `pr.baseBranch` instead of hardcoded "main"/"production."
- **`databricks/setup-cli@main` action in CI templates** – replaces `curl | sudo sh`, which required passwordless sudo on self-hosted runners.
- **Reference Playwright config** – `templates/project/common/client-reference/playwright.config.ts` documents the full-stack boot pattern (`webServer: []` with backend + frontend entries). Install with the new `installPlaywrightConfig` command.

### Fixed: parent-branch consistency

These all stem from one root cause: hardcoded `'main'` / `production` as the comparison target. Replaced with parent-aware resolution everywhere.

- **`gitService.getChangedFiles` – diff against nearest parent.** Resolution order: explicit `baseOverride` → `LAKEBASE_BASE_BRANCH` → nearest parent via `git merge-base` across candidates (`config.trunkBranch || 'main'`, `master`, `config.stagingBranch || 'staging'`) – pick the candidate whose merge-base commit is most recent → trunk/main/master fallback. For a feature forked from `staging`, `staging` wins automatically.
- **Schema diff (`compareBranchSchemas`) – compare against the Lakebase branch's `source_branch`**, not always production. New `LakebaseBranch.sourceBranchId` field populated from `status.source_branch` in `listBranches`. Falls back to the default branch when source is missing or unresolvable. `SchemaDiffResult` now exposes `comparisonBranchName`; renderer shows "X vs `<parent>`" instead of "X vs production" – Branch Diff Summary subtitle, sync message, per-table modal title, "Table does not exist in ..." fallback.
- **Branch-tree per-table coloring – same parent-aware target.** The expanded table list under each branch row colored tables `new` / `modified` / `removed` against production. Now queries the parent branch's schema via `sourceBranchId`. Three views (summary, per-table modal, branch-tree coloring) consistent.
- **`post-checkout.sh` – new Lakebase feature branches fork from the previous Lakebase branch by default**, matching `git checkout -b` semantics. Capture `LAKEBASE_BRANCH_ID` from `.env` before the hook rewrites it; use that as the fork source unless `LAKEBASE_BASE_BRANCH` is set (which still wins as an explicit pin). Verifies the previous branch exists; falls through to the project default if it doesn't.
- **`lakebaseService.createBranch` – same rule in TS-land.** UI flows that route through this method (switch-branch fallback, the `createBranch` command) used to default to the project's default Lakebase branch. Now mirrors the post-checkout hook precedence. Both shell and TS paths must agree because the UI vs CLI ratio is project-dependent.

### Fixed: schema diff data quality

- **SCM "Lakebase" count is now sourced from the live DB diff.** Previously this count only populated when the working tree had uncommitted migration FILES – committed migrations and direct DDL drift never surfaced. Now sourced from `schemaDiffService`'s cached diff (`created + modified + removed`); on cache miss a single background `compareBranchSchemas()` is fired (guarded against concurrent calls) and the SCM refreshes when it completes. Two removed hardcoded `'main'` lookups in `schemaScmProvider`.
- **Schema diff cache primes lazily.** Clicking a table in the branch tree used to show "No schema data available for X" when the cache hadn't been built yet (branch-tree's `queryBranchSchema` doesn't populate the schema-diff cache). The content provider now `await`s `compareBranchSchemas()` on cache miss, populating the cache and rendering DDL on both panes.
- **Branch-tree table click forces a fresh compare.** Was dispatching `vscode.diff` directly against a possibly-stale cache. A new wrapper command runs `compareBranchSchemas(undefined, true)` first so the editor's two panes read the same live snapshot the tree used to decide "modified."
- **Removed the migration-file supplement in Branch Diff Summary.** When the live diff said `inSync=true`, a fallback compared migration FILES on the current branch vs git `main` and pushed deltas into `diff.created/modified/removed` as if they were live DB diffs. Three bugs stacked: (1) `listMigrationsOnBranch` defaulted to the Flyway regex `/^V\d+.*\.sql$/i` so Alembic/Knex projects always saw an empty trunk and classified every file as "new on branch"; (2) trunk was hardcoded to `'main'`; (3) the spread-copy `diff = {...diff, inSync: false}` left array references pointing at the cached arrays, so subsequent `push` mutated the cache while the local `inSync` flip didn't propagate – every re-open of the panel doubled the entries. Trust the live DB query; pending migrations belong in the SCM Code/Staged panels, not in a schema diff.

### Fixed: runner setup

- **Aggressive state reset before reconfigure.** `config.sh` exits "Cannot configure the runner because it is already configured" when ANY leftover state file exists (not just `.runner`). New `resetRunnerConfig` wipes `.runner`, `.credentials`, `.credentials_rsaparams`, `.path`, `.service`, `svc.sh`, `.runner_migrated` (the in-place-upgrade marker – empirically blocks reconfigure even when `.runner` is absent), and the macOS launchd plist (with best-effort `launchctl unload`). Called up-front when `.runner` is missing AND when a configured runner's `.runner` JSON's URL doesn't match the target – prevents the silent `--replace`-no-op after an owner migration.
- **CI templates URL-encode `DATABASE_URL` username.** The Lakebase username is always an email containing `@`, which makes `postgresql://user@host/db` parse host as the email domain (`databricks.com`) and fail DNS. Three template scripts fixed: `scripts/ci/resolve-lakebase-branch.sh` (primary CI path; was only encoding the password), `scripts/run-tests.sh` and `scripts/flyway-migrate.sh` (backward-compat fallbacks).

### Fixed: workflow polish

- **`tsconfig.json` excludes `templates/`** so the new `client-reference/playwright.config.ts` reference template doesn't get pulled into the extension's TS program (it references `@playwright/test` which isn't an extension dep).
- **Auto-stash includes untracked files.** New / staged-but-not-committed files used to be left on disk during a switch's Stash & Switch step – a checkout could then clobber them. All three auto-stash call sites now use `stashIncludeUntracked`.
- **Build/ship discipline:** silent VSIX uploads of stale binaries (`vsce package` errored, but the chained `gh release upload --clobber` happily uploaded the old `.vsix`) caught and fixed. Save this as a session-level lesson, not a code change.

### Repo / governance

- **Apache 2.0 LICENSE** (was missing – `vsce package` warned on every build).
- **`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`**, plus issue/PR templates under `.github/`. Standard scaffolding so the repo is in transferable shape for the `databrickslabs/` donation conversation.
- **Genericized personal references** in user-facing text. README "Trunk Branch Alias" example and the `LAKEBASE_TRUNK_BRANCH` doc in `.env.example` / `post-checkout.sh` no longer name a specific user/sandbox. `src/extension.ts` no longer hardcodes an email for the workspace-path default – calls `databricks current-user me` (via new `LakebaseService.getCurrentUserEmail()` helper) and falls back to a generic placeholder.
- **Untracked historical `*.vsix` binaries** (`lakebase-scm-extension-0.5.1.vsix` and `-0.5.3.vsix`) from `main`. `.gitignore` already had `*.vsix` but the existing tracked files stayed in the index. New clones download ~600 KB less. Historical commits and tags retain them (no history rewrite).

## 0.5.4 (2026-04-23)

### Added
- Configurable trunk branch alias via `LAKEBASE_TRUNK_BRANCH` in `.env` or the `lakebaseSync.trunkBranch` VS Code setting. Projects that use user-prefixed or non-standard trunk branch names (e.g., `<user>/<project>` in a monorepo) can opt in. **When the alias is set, it REPLACES `main`/`master` as the project's trunk** – the shared monorepo `main` will NOT also pair with the project's default Lakebase branch. When no alias is set, `main`/`master` behave as before.
- Companion `LAKEBASE_STAGING_BRANCH` alias: pairs a named git branch (e.g. `user/project-staging` in a monorepo) with the Lakebase `staging` branch. Mirrors `LAKEBASE_TRUNK_BRANCH` semantics but targets the `staging` Lakebase branch instead of the default. Requires the Lakebase `staging` branch to already exist – the hook does NOT auto-create it.

### Fixed
- **post-checkout hook scope** – the hook now exits immediately if `.env` is missing at the work-tree root, and `unset`s all `LAKEBASE_*` / `DATABRICKS_*` env vars before sourcing `.env`. This prevents two monorepo-hostile failure modes: (1) the hook firing at a parent-submodule level and creating spurious Lakebase branches for unrelated git branches; (2) shell-inherited env vars (from sourcing a project activation script earlier in the session) leaking into checkouts in unrelated repos and triggering the "feature branch" codepath when there's no actual project context.
- **Feature branches now honor `LAKEBASE_BASE_BRANCH`** – both the post-checkout hook and `lakebaseService.createBranch()` read `LAKEBASE_BASE_BRANCH` from `.env` (or the `lakebaseSync.baseBranch` VS Code setting) and use it as the source when creating a new feature Lakebase branch. Previously the hook's `.env.example` documented `LAKEBASE_BASE_BRANCH=staging` but the value was never read – features always forked from the default branch. Now a `feature/* → staging → production` promotion flow works end-to-end.
- **Branch-tree file list is per-branch, not per-HEAD** – expanding a branch in the sidebar now shows that branch's diff vs trunk, not the current working tree's diff. Previously `getBranchFiles` ignored its `branchName` argument and always called `gitService.getChangedFiles()` for HEAD, so every branch node listed the same files. Also: `getChangedFiles()` now diffs against `config.trunkBranch` when set (falling back to `main`/`master`), which fixes a monorepo bug where branch views listed unrelated sandboxes as "added" because the diff base was the wrong trunk.
- **`LAKEBASE_GIT_BRANCH_PREFIX` scopes the branch list** – the sidebar used to list every git branch in the repo, including branches from unrelated projects/users in a monorepo. Set `LAKEBASE_GIT_BRANCH_PREFIX` (or `lakebaseSync.gitBranchPrefix`) to a string prefix (e.g. `user/project-`) and only branches starting with that prefix are shown. The currently-checked-out branch is always shown regardless, so you never "lose" the branch you're on.
- **Self-hosted runner: clear setup hint for `/Users/runner/hostedtoolcache`** – `actions/setup-python@v5`'s installer script (from `actions/python-versions`) hardcodes `/Users/runner/hostedtoolcache` as the install path on macOS. On a self-hosted runner running as a normal user, that path doesn't exist and mkdir fails with "Permission denied". `RUNNER_TOOL_CACHE` doesn't help – it redirects setup-python's cache LOOKUP but not where the installer writes, and setting it to a different path causes re-downloads every run. The only durable fix is a one-time sudo: `sudo mkdir -p /Users/runner/hostedtoolcache && sudo chown -R <user> /Users/runner`. `setupRunner` now checks that path at install time and emits the exact command if missing, so users know what to run.
- **Template workflows install Databricks CLI via `databricks/setup-cli@main`** – previous templates used `curl | sudo sh` which requires passwordless sudo on the runner host (not configured by default on self-hosted runners, and even when configured, pipes the installer through root). The official action installs to a user-writable path on the runner and is a no-op when the CLI is already on PATH.
## 0.5.3 (2026-04-21)

### Two-tier CI (fork + migrate against parent branch)
- **`templates/.github/workflows/pr.yml`** now forks `ci-pr-<N>` from the PR's **base.ref** branch (e.g. `staging`) instead of the Lakebase default. Schema diff compares CI branch vs parent, not vs production. Projects using a `feature/* → staging → main` promotion flow now test against the right baseline.
- **`templates/.github/workflows/merge.yml`** triggers on push to `main` **or** `staging`. The `migrate-target` job resolves the matching Lakebase branch from `github.ref_name` (main → default/production; staging → `staging`). Cleanup of `ci-pr-<N>` + the merged feature branch's Lakebase clone fires on **any** merged PR, not just PRs to `main`.
- **New helper `templates/scripts/ci/resolve-lakebase-branch.sh`** – single source of truth for the git→Lakebase branch mapping. Uses `scripts/sanitize-branch-name.sh` for non-main branches, the project default for `main`/`master`. Handles create-from-parent, endpoint ensure, credential mint, and emits env vars to `$GITHUB_ENV` + non-secret vars to stdout for same-step `eval`.
- **Source-mismatch verification** – if `ci-pr-<N>` already exists but was forked from the wrong parent (e.g. from a prior run when base.ref was `main` but now it's `staging`), the helper can delete + re-fork from the correct parent (`--recreate-on-source-mismatch`). Previously the extension silently reused the wrong-source branch. New `LAKEBASE_BRANCH_STATUS` output (`CREATED` / `VERIFIED` / `RECREATED` / `EXISTS` / `UNVERIFIED`) exposes the truth in CI logs + step summaries.
- **Protected-branch allowlist** – `templates/scripts/delete-lakebase-branches.sh` refuses to delete `main`/`master`/`staging`/`production` or the project's default branch, even if a PR's HEAD_REF happens to sanitize to one of them (matters when `staging → main` PRs get merged).

### Schema tree reliability
- **`pg` client fallback** – `queryBranchSchema` no longer silently returns `[]` when `psql` isn't on the user's PATH (the common macOS default). It now tries `psql` first and falls back to the bundled `pg` node client, so the schema tree populates regardless of local binary availability. Errors surface in the developer console instead of being swallowed.

### Developer-experience fixes
- `$GITHUB_ENV` writes don't apply to the same step that wrote them. The helper now ALSO emits non-secret vars to stdout so callers can `eval` them in-step – fixes an earlier regression where `JDBC_URL` was empty when writing the step output.
- Informational echoes in the helper go to stderr, so `HELPER_OUT` captures only `KEY='value'` lines (avoids `eval: syntax error near unexpected token '('`).

## 0.5.2 (2026-04-18)

### Setup helpers
- New `setupCiSecrets` command + automatic prompt after runner setup so GitHub repo secrets (`DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `LAKEBASE_PROJECT_ID`) get populated without a trip to the repo UI.
- New `createLakebaseProject` command for one-shot Lakebase autoscaling project creation.
- `.vscodeignore` tightened to keep the VSIX lean.

### Database name resolution
- `getProjectDatabase()` now parses the path segment of `DATABASE_URL` before falling back to `databricks_postgres`, so projects using a custom app DB no longer have to hard-code overrides.

## 0.5.1 (2026-04-17)

### Deploy Enhancements
- **Lakebase PAT-based auth** -- New `ensureLakebaseSecretAuth()` method: creates secret scope, generates 90-day PAT, stores in secret, grants app SP READ ACL. Enables Lakebase Postgres auth on workspaces where SP-generated credentials are not accepted (e.g. partner-demo-catalog).
- **Seed data automation** -- New `runSeedData()` method: detects `scripts/seed-data/seed_demo_data.py`, runs with `--target` and `--with-partners` flags. Integrated as Step 6 of deploy flow.
- **Dynamic app.yaml generation** -- Step 2 now builds the env block programmatically from deploy target config instead of sed replacements. Includes `lakebase_secret_scope`, `lakebase_secret_key`, and `ai_model` fields. Original app.yaml restored in `finally` block.
- **AI model override** -- New `ai_model` field in deploy targets, passed as `AI_MODEL` env var in app.yaml for workspaces where default Foundation Model endpoints are rate-limited.
- **UC catalog permissions** -- Deploy Step 4 now grants `USE_CATALOG`, `USE_SCHEMA`, `READ_VOLUME`, `WRITE_VOLUME` to the app SP on the target UC catalog.

### Documentation
- **Deploy to Databricks Apps** -- New README section covering deploy targets configuration, deploy steps, Lakebase Auth (SP vs PAT), seed data, and CLI deploy script reference.

## 0.5.0 (2026-04-14)

### CI Reliability Hardening
- **Block push on token refresh failure** -- `pre-push.sh` now exits 1 when OAuth token refresh fails, preventing pushes with stale tokens that cause CI failures mid-run. Clear error message tells developers to run `databricks auth login`.
- **Auto-expire CI branches** -- CI branches (`ci-pr-*`) are now created with a 24-hour TTL instead of `no_expiry`. If merge workflow cleanup fails or a direct push skips it, branches auto-delete instead of lingering with active endpoints.
- **Pre-migration snapshot** -- `merge.yml` creates a snapshot branch from production before running migrations. Deleted on success. On failure, the snapshot is preserved with recovery instructions in the GitHub job summary. Uses 24h TTL as a safety net.

### Branch Name Sanitization
- **Centralized sanitization** -- Extracted the git-to-Lakebase branch name regex into `sanitize-branch-name.sh`. Replaces 4 inline copies across `post-checkout.sh`, `pr.yml`, and `merge.yml`. Single source of truth: lowercase, slash-to-dash, strip special chars, truncate to 63 chars, pad to 3 char minimum.

### Orphan Cleanup
- **Weekly garbage collector** -- New `cleanup-orphans.yml` GitHub Action runs every Monday at 6am UTC. Lists all `ci-pr-*` Lakebase branches, compares against open PRs, and deletes orphaned branches whose PRs are closed or merged. Also available via manual `workflow_dispatch`.

### Token Lifecycle
- **Optimized refresh interval** -- Background credential refresh changed from 20 minutes to 45 minutes. Token lifetime is ~1 hour; the previous 20-minute interval was unnecessarily aggressive. 45 minutes provides a 15-minute buffer before expiry.
- **All migrate commands wrapped** -- Java (Flyway) and Node.js (Knex) migrate commands now run through `refresh-token.sh`, matching the existing Python (Alembic) behavior. Prevents expired credentials during long dev sessions.

### Observability
- **Fork point audit trail** -- Branch creation in `post-checkout.sh` and `pr.yml` now logs `source_branch_lsn` and `source_branch_time` from the Lakebase API response. Useful for debugging "my branch has different data than expected" scenarios.
- **Connection verification** -- `post-checkout.sh` runs a `psql SELECT 1` after creating a branch to verify the endpoint is reachable and credentials work. Retries credential generation once on failure. Non-blocking: skips if `psql` is not installed.

### Resilience
- **Retry UI for failed connections** -- When `syncConnection()` cannot reach an endpoint, VS Code now shows a warning notification with a "Retry" button instead of failing silently. The `.env` file includes a timestamped comment with recovery instructions.

### Federation Support
- **Lakehouse Federation setup script** -- New `setup-federation.sh` for partners who need to query Lakebase tables from the lakehouse side. Creates a native Postgres role with SCRAM-SHA-256 auth (required because Federation only supports static credentials), grants read-only access, and creates a Databricks connection + foreign catalog. One-time setup per project. Based on Cameron Casher's Lakebase-Backstage POC.

## 0.4.9 (2026-04-06)

- Fix: exclude `.claude/hooks` symlink and `.agent-logs` from VSIX
- Add `post-merge` hook and update `install-hook` to deploy it

## 0.4.8 and earlier

See [git log](https://github.com/kevin-hartman/lakebase-scm-extension/commits/main) for full history.
