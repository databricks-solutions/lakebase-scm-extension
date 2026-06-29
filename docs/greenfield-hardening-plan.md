# Greenfield Hardening , Full Plan + Live Integration Tests

Branches: `kevin.hartman/scm-greenfield-hardening` in BOTH repos (kit + extension).
Ships as ONE coordinated release. Ordering constraint: extension pins the kit by
github tag, so the release event is kit bump+tag+release, then extension repin +
bump+tag+release.

## Status legend
- [DONE] committed on the branch, hermetic-tested.
- [TODO] implementation remaining.
- Each item names its repo(s), the fix, and the integration test that confirms it
  (LOCAL = real git/fs/hooks, no cloud; LIVE = needs DATABRICKS_HOST +
  LAKEBASE_TEST_INSTANCE on workspace fevm-serverless-stable-ecparr).

---

## How to review (entry points)

- Extension LOCAL: `npm run test:integration` (test/integration/**, real git/fs).
- Extension LIVE: `DATABRICKS_HOST=https://fevm-serverless-stable-ecparr.cloud.databricks.com LAKEBASE_TEST_INSTANCE=<id> npm run test:integration`.
- Kit LIVE: `scripts/run-live-tests.sh --all` (auto-provisions venv + Flyway CLI).
- New review collector: `test/integration/greenfieldReview.test.ts` (extension, LOCAL)
  and `tests/bdd/greenfield-*-live.test.ts` (kit, LIVE) gather one test per finding
  that reproduces the eval symptom and shows it fixed.

---

## Workstreams

### MIGRATION-LAYOUT (monorepo detect + overrides) , [DONE]
Kit `migration-layout.ts` (source of truth) + extension `config.ts` consumes it.
- LOCAL test: temp tree `recipe-app/migrations` + `recipe-app/package.json`, set
  workspace root, `getConfig()` -> language `nodejs`, migrationPath honored,
  pattern matches `20260101_*.js`, not `V1__*.sql`. (kit migration-layout.test +
  extension config.test already cover; add an fs-tree integration variant.)
- LIVE test: scaffold/point at a subdir-app knex project on the workspace, run a
  knex migration, assert the Schema Changes cache fast-path fires (no 10-min TTL).

### W0 DRY foundation (branchParsing, errorClassification, scmOps) , [DONE]
- LOCAL: `scmUtils.test.ts` (parse, null-safe normalize, classifier matrix,
  gitOpErrorMessage). Add `commitLanded` unit (landed / same-sha / still-staged /
  unborn).

### W1 truthful panels (commit + push/sync) , [DONE]
Kit: none. Extension: `gitService.commitTruthfully` + `commitLanded`; push/sync/pull
through `runScmOp` + `gitOpErrorMessage`.
- LOCAL integration (greenfieldReview): real temp repo +
  - commit happy-path with a best-effort `prepare-commit-msg` hook -> `commit()`
    resolves, HEAD advances, `getStagedChanges()` empties (panel would NOT show
    "Staged"/"Commit failed").
  - bare remote: 2nd push (nothing new) -> `push()` resolves (in-sync = success).
  - remote ahead -> `push()` throws -> `classifyGitError` = `rejected` ->
    `gitOpErrorMessage('Push','rejected')` says "pull first".
- LIVE integration: the eval's real loop , scaffold a project, pair a feature
  branch to a Lakebase branch, stage 5 files, commit, push; assert the reported
  outcome matches `git` state (HEAD/staged) at each step.

### W6 per-table schema-diff `.trim` crash , [DONE]
Extension: `normalizeBranchName` (null-safe) at `schemaDiffService:307` + `tiers:47`.
- LOCAL: `normalizeBranchName(undefined)` doesn't throw (done in scmUtils).
- LIVE integration (extension): fork a feature branch whose parent is recorded only
  as a resource path (empty short-name); open the per-table schema-diff
  (`compareBranchSchemas` / showTableDiff path) -> no `name.trim` throw, returns a
  diff. Add to test/integration gated on LAKEBASE_TEST_INSTANCE.

### W2 commit off the synchronous-install path , [TODO] (kit templates + `lk`)
Fix: hard timeout on commit-time schema-diff; NEVER `npm install` on commit (skip
silently if the kit cache is cold); run enrichment best-effort/background.
Files: `templates/project/common/scripts/prepare-schema-diff.sh` (+ `lk` shim).
- LOCAL integration (kit or extension hook/): temp project with a COLD kit cache,
  run `prepare-commit-msg`/commit -> asserts (a) wall-clock < timeout (e.g. 5s),
  (b) `npm install` was NOT invoked (spy/PATH shim), (c) commit still succeeds and
  the message simply lacks the diff. Reproduces the 72s stall -> proves it gone.
- LIVE: with a WARM kit, the diff enrichment runs and appends to the commit msg
  within the timeout.

### W3 warm + verify at create (loud failure) , [TODO] (kit + extension create flow)
Fix: pre-warm the kit at project-create, VERIFY it, fail LOUDLY at create when the
warm fails (instead of a later commit hang).
Files: `create-project.ts` (extension ProjectCreationService + kit createProject),
`lk --warm`.
- LIVE integration (extension projectCreation): create a project -> assert the warm
  step ran + verified (kit resolvable). Failure path: point `lk` at an unreachable
  registry -> create surfaces a specific "kit could not be warmed" error AT create
  time (test asserts the thrown/surfaced message), and does not leave a half-state.

### W5 hooks fail loud in UI + surface the prereq , [TODO] (extension + kit hooks)
Fix: detect/prompt the one-time `databricks auth login` prereq in the create flow;
hooks emit specific, parseable reasons that the extension maps to precise UI
messages (composes with W1 `gitOpErrorMessage` + W8).
- LOCAL integration: a fake failing `databricks` on PATH -> `classifyGitError` =
  `auth` -> `gitOpErrorMessage` = the sign-in message (not generic). (Extends
  greenfieldReview.)
- LIVE: with stale auth, a push surfaces the specific sign-in guidance in the panel;
  with auth present, the prereq check passes silently.

### W7 Flyway baseline trap (`baselineVersion=0`) , [TODO] (kit templates)
Fix: add `<baselineVersion>0</baselineVersion>` to java + kotlin fallback `pom.xml`.
- LOCAL: assert both generated poms contain `baselineVersion=0` alongside
  `baselineOnMigrate=true` (template/scaffoldService assertion).
- LIVE (kit `schema-migrate-live-flyway` or extension create+migrate): scaffold a
  Java project, provision a Lakebase branch, run Flyway migrate on a FRESH db ->
  assert `V1` applied (its object exists) and `V2` succeeds (the eval's exact trap).

### W8 pre-push warn-not-block , [TODO] (kit templates)
Fix: `pre-push.sh` token-refresh failure -> warn (exit 0), do not `exit 1`.
- LOCAL integration: temp repo + the scaffolded `pre-push.sh` + a fake
  `databricks auth token` on PATH that exits nonzero -> `git push` to a bare remote
  SUCCEEDS (exit 0) with the warning on stderr. Reproduces "push blocked by stale
  DB auth" -> proves it warns instead.

### W9 orphaned project slug on failed create , [TODO] (extension + kit create)
Fix: roll back the just-created Lakebase project on a partial-failure, OR detect the
reserved/soft-deleted slug on retry and offer purge (`delete-project --purge`).
- LIVE integration (extension projectCreation): inject a failure AFTER project
  creation -> assert rollback removed the project (retry with same name succeeds),
  OR retry detects the slug collision and the purge path clears it.

### W10 multi-schema schema-diff , [TODO] (kit)
Fix: drop the hardcoded `public` filter in `schema-diff.ts`/`branch-schema.ts`;
accept a schema/catalog argument (default still `public`).
- LIVE integration (kit `schema-migrate-live` / branch-schema): create a branch with
  an object in a NON-public schema (e.g. `cfg.foo`); run schema-diff scoped to
  `cfg` (or all) -> the diff is non-empty / includes the cfg object (today it shows
  empty). Deep-DDL (constraints/indexes/defaults/functions/triggers) is DEFERRED to
  the native `databricks postgres schema-diff` roadmap.

---

## Deferred (design decision first, NOT in this release)
- #4 Firewall-safe kit runtime: vendor the kit into the scaffold or fetch from a
  Databricks-hosted artifact (no public-npm egress). Integration test: simulate a
  registry-blocked env -> warm/commit still work from the vendored copy.
- #10 deep-DDL compare: full-DDL parity test against a schema with constraints,
  indexes, defaults, functions, triggers.

---

## Sequencing on the branches
1. Kit branch: W7 + W8 + W2 + W10 + W5(hook reasons) + W3(kit warm) -> typecheck +
   vitest + LIVE (`run-live-tests.sh --all`) + dist.
2. Extension branch: W0 commitLanded unit + W1 greenfieldReview LOCAL set + W3
   (create warm/verify) + W5(UI mapping) + W6 LIVE + W9 LIVE -> typecheck + full
   suite + `npm run test:integration` (LOCAL) + LIVE subset.
3. Coordinated release: kit bump/CHANGELOG/PR/merge/tag/release -> extension repin +
   npm install + bump/CHANGELOG/VSIX/PR/merge/tag/release.

## Live env to confirm
Workspace `fevm-serverless-stable-ecparr`; need `LAKEBASE_TEST_INSTANCE=<existing
project id>` for the LIVE suites (W6, W7-run, W9, W10, W1-loop, W3).
