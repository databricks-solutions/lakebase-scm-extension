# VS Code parity follow-ups for the integration test suite

The ecom + python-devloop integration tests are supposed to mirror what a
user does in VS Code: open the "Create Lakebase Project" command, watch the
scaffolder run, cut a staging tier, create a feature branch, open a PR,
merge it, and verify production reflects the change. This document captures
the gaps between what the tests do today and what a real VS Code user
experiences, plus the substrate/extension follow-ups needed to close them.

Filed after diagnosing why feature branches kept forking from production
instead of staging — root cause was the contributor's global
`core.hooksPath` pointing at the Databricks corporate hooks dir, which
made git skip `.git/hooks/` entirely. Fixed in lakebase-app-dev-kit
v0.3.0-alpha.10 (both `install-hook.sh` and the TypeScript `installHooks`
now pin `core.hooksPath` project-local). With the hook actually firing on
every git checkout, several test patterns that previously hid the bug now
need re-examination.

## 1. `createLakebaseBranchAndConnect` is now redundant with the hook (DONE — FEIP-7099)

**Today:** The integration test helpers explicitly call
`createLakebaseBranchAndConnect(ctx, BRANCH)` after `git checkout -b
feature/foo`. The helper calls `lakebaseService.createBranch(BRANCH)`
which forks a Lakebase branch from whichever branch is current in
`.env LAKEBASE_BRANCH_ID`.

**After the hook fix:** The post-checkout hook fires on `git checkout -b
feature/foo`, sees `feature/foo` is not a tier, falls through to the
feature-branch path, and creates the Lakebase branch itself (forking from
the previous tier in `.env`). The explicit `createLakebaseBranchAndConnect`
call now duplicates this work. Likely outcomes:
- Race: hook + helper both call `createBranch` with the same name.
  Idempotent in theory (substrate returns the existing branch), but if
  one beats the other to the source-branch resolution, the second may see
  inconsistent `PREV_LAKEBASE_BRANCH_ID` state in `.env`.
- Mask: the helper resolves credentials before the hook has flushed
  `.env`, so the in-memory credentials in the test diverge from what's on
  disk.

**Action:** Remove `createLakebaseBranchAndConnect` from the test helpers
(or shrink it to "wait for the hook to finish writing `.env`, then read
the connection out" — i.e. just `waitForEnvBranchId`). Let the post-checkout
hook be the only path that talks to Lakebase during a feature checkout.
This matches what a VS Code user experiences: they run `git checkout -b`,
the hook handles the rest.

Files to touch:
- `test/integration/ecommerce/helpers.ts` — `createLakebaseBranchAndConnect`
- `test/integration/python-devloop/helpers.ts` — same name
- All scenario `A1b` / `A2` blocks that call it

Probably also `verifyBranchConnection` (an `A1-verify` block) can drop to a
single `waitForEnvBranchId` + read.

## 2. No VS Code command for `createLongRunningBranch`

**Today:** The integration test bootstraps the staging tier by calling
the substrate primitive directly:

```ts
await createLongRunningBranch({
  name: 'staging',
  forkFromBranch: 'main',
  projectId, workTreeDir, databricksHost,
});
```

**A real VS Code user has no equivalent.** To cut a staging tier they
would have to:
1. Open a terminal
2. `databricks postgres create-branch projects/<id> staging --json '{"spec":{"no_expiry":true}}'`
3. `git fetch origin main && git branch -f staging main && git push -u origin staging`
4. `git checkout staging` (hook now fires and points `.env` at staging)

That's a substantial UX gap for a methodology we ship as the
recommended branching pattern.

**Proposed VS Code command:** `lakebaseSync.cutLongRunningBranch`
- Quick-pick: tier name (`staging`, `uat`, `perf`, or custom)
- Quick-pick: fork-from branch (default: current HEAD, or `main` for first
  tier)
- Confirmation dialog explaining "this creates a Lakebase branch and a
  matching git branch that release PRs target; it's not auto-created"
- Calls substrate `createLongRunningBranch` with the inputs
- On success: shows the tier in the branch sidebar with a distinct icon

Files to touch:
- `src/extension.ts` — register the command
- `src/services/lakebaseService.ts` — already has `createBranch`; just
  wire to `createLongRunningBranch` from the substrate
- `src/providers/branchTreeProvider.ts` — tier rendering (currently only
  knows about `stagingAlias`/`trunkAlias`; needs to discover tiers from
  the Lakebase branch list, matching what alpha.9 did in the hook)
- `package.json` — `contributes.commands` entry + `contributes.menus`
  placement (probably the branch tree title bar)

## 3. Spring Initializr is forced off by the test

**Today:** `ecommerceScenarios.test.ts` sets
`LAKEBASE_SCAFFOLD_FALLBACK=1` to force the bundled static Java template
instead of going through Spring Initializr.

**Real VS Code users:** Default path is Spring Initializr — different
generated `pom.xml`, different application class name, different
`.gitignore`. The fallback exists for offline cases and CI.

**Risk:** Bugs in the Initializr extraction path (zip handling, file
shadowing, application class naming) are never exercised by the
integration suite.

**Action:** Either (a) run the test in both modes via a parameterized
suite, or (b) add a separate `springInitializr.test.ts` integration test
that uses the real Initializr.

## 4. Self-hosted runner instead of GitHub-hosted

**Today:** Test forces `runnerType=self-hosted`, downloads + registers an
ephemeral runner per run. The substrate's `runnerType` setting now
correctly patches the deployed workflows for both modes (FEIP-7121,
substrate v0.3.0-alpha.17) — `github-hosted` rewrites `runs-on:
self-hosted` → `runs-on: ubuntu-latest` across `.github/workflows/*.yml`;
`self-hosted` keeps the template default + swaps in the local-JDK shim.

**Real VS Code users:** can already pick github-hosted at scaffold
time via the createProject Quick Pick (`src/extension.ts` line 664). The
substrate accepts it and `patchWorkflowsForRunnerType` rewrites
`runs-on:` to `ubuntu-latest` correctly (FEIP-7121, alpha.17). The
github-hosted code path is functional in the extension UI today.

What still blocks the FULL end-to-end on github-hosted:

- **Workspace IP allowlist (FEIP-7124).** Test runs surfaced that
  `fevm-serverless-stable-ecparr` (and likely other internal test
  workspaces) blocks GitHub Actions Azure egress IPs at the Databricks
  network layer. When `pr.yml` runs on github-hosted and tries
  `databricks postgres create-branch`, the auth fails with
  "Source IP address: 20.168.x.x is blocked by Databricks IP ACL". Self-
  hosted bypasses this because the runner is on the contributor's
  allowlisted laptop. Resolution paths: a workspace without IP ACL, a
  widened ACL, or a static-IP egress gateway. See FEIP-7124.
- **No post-scaffold switcher.** A user who scaffolded as self-hosted
  and later wants github-hosted has no in-product path; they'd manually
  re-run `patchWorkflowsForRunnerType` or hand-edit the YAML.
- **No default-policy ADR.** Self-hosted is the current default in the
  Quick Pick. Decide what we ship as default in the v1 release.
- **No README runner-type section.** Contributors hit the runner-type
  choice as a Quick Pick at scaffold time with no upstream doc context.

**Coverage status:** substrate-primitive coverage closed by
`test/integration/hook/githubHostedRunner.test.ts` (PR #16). Full E2E
under FEIP-7104 blocked on FEIP-7124 (workspace IP ACL).

**Action plan (roadmap):**

1. **FEIP-7124** — resolve the workspace IP ACL blocker so a real
   github-hosted CI run can succeed end-to-end.
2. **`lakebaseSync.changeRunnerType` command** — for projects already
   scaffolded, re-run `patchWorkflowsForRunnerType` against the working
   tree, commit the diff with a templated message.
3. **Default policy ADR** — short doc stating which mode we ship as the
   v1 default with rationale.
4. **README addition** — call out runner type in the scaffold flow +
   how to change it post-scaffold + note the workspace IP-ACL caveat
   for github-hosted CI.

Files likely to touch:
- `src/extension.ts` — register `lakebaseSync.changeRunnerType`
- `src/services/projectCreationService.ts` — already accepts +
  forwards `runnerType` (existing)
- `package.json` — `contributes.commands` for the change-runner-type
  command
- `docs/adr/` (new) — default-policy ADR
- `README.md` — runner-type section

## 5. PR creation bypasses the VS Code GitHub extension

**Today:** Test uses Octokit directly: `createPullRequest({ ... })` from
the substrate.

**Real VS Code users:** They click "Create PR" in the GitHub Pull
Requests extension, or run `gh pr create`. Both ultimately use the same
GitHub REST API.

**Verdict:** Equivalent. Not a real gap, just worth noting that the test
doesn't exercise the VS Code GitHub extension's UX layer.

## (alpha.11) `release()` merged before CI gate passed

Discovered while debugging why `Lakebase main` had no tables after a
staging→main release: the staging→main merge commit landed at 09:02:43Z,
**five seconds** after PR open at 09:02:38Z. pr.yml didn't even start
running until 09:02:45Z and didn't complete until 09:04:17Z. The PR was
merged before any CI gate could vote. Production code path had no
enforcement at all.

Root cause: substrate `release()` (alpha.7 onward) opens the PR and
immediately calls `mergePullRequest`. The original design relied on
GitHub branch protection (required status checks) to block the merge
button until pr.yml passed. **Branch protection is a paid feature on
private repos** — every test scaffold (free private repo) cannot
configure it, and the merge button is unconditional there. The same
applies to any user who scaffolds without GitHub Pro/Enterprise.

Fix (alpha.11): `release()` now waits for pr.yml on the PR's head ref
to complete with `conclusion=success` before calling
`mergePullRequest`. If pr.yml fails or times out, the release aborts
with the PR left open for inspection. New args:
- `prWorkflowFile?: string` (default `'pr.yml'`)
- `prGateTimeoutMs?: number` (default 10 min)
- `requireCiGate?: boolean` (default `true`) — escape hatch only for
  callers enforcing the gate some other way

In a properly-configured production repo with branch protection +
required status checks, the new wait is redundant-but-cheap belt-and-
suspenders. In every other repo, it's the only thing actually enforcing
the methodology.

Followup work this exposes:
- Scaffold could attempt to set up branch protection rules during
  `createProject` for repos that support it (skip silently on
  free-tier). Defense in depth.
- merge.yml's `on: push: branches: [main, ...]` should probably also
  filter out the initial scaffold push (no real migrations to apply,
  the run hangs trying to migrate against an empty target). The orphan
  initial-scaffold run on main during testing also seems to block
  subsequent merge.yml dispatches on the same branch — separate issue,
  but related to the test reliability story.

## 6. The pre-push and post-merge hooks weren't running before alpha.10

**Today (post-alpha.10):** With `core.hooksPath` pinned, every `git push`
during a test run now triggers `pre-push.sh` → `create-token-and-sync-secrets.sh`
(token refresh + GitHub secrets sync). Every `git pull` after a merge now
triggers `post-merge.sh` (Lakebase branch cleanup + ref prune).

**Implications:**
- Test runtime increases per `git push` (token refresh + secrets sync are
  not free — likely 5-15s each)
- The `delete-lakebase-branches.sh` cleanup script may delete branches the
  test still needs for assertions. Need to audit assumptions in Phase D
  verification blocks.
- The pre-push hook may fail if CI auth isn't set up correctly, masking
  the actual test failure. Pre-flight in the test should verify CI auth
  works before launching scenarios.

**Action:** Run a full ecom suite with the alpha.10 substrate, inspect
how much wall-time the now-firing hooks add, and audit whether
`post-merge.sh`'s Lakebase branch cleanup races with test assertions.

## 7. The `core.hooksPath` fix should be visible to contributors

Substrate alpha.10 silently pins `core.hooksPath` on install. Contributors
who previously relied on their global `core.hooksPath` (e.g. corporate
secret scanner) will be surprised that their scaffolded projects no
longer run that scanner.

**Action:** Add a README note in scaffolded projects: "This project pins
`core.hooksPath` to `.git/hooks/` to ensure the Lakebase hooks always
run. If you need a corporate secret scanner to also run, copy its hook
into `.git/hooks/` or chain to it from the existing hooks."

## 8. `paired-branch.ts` (substrate) and extension UI helpers still
reference the old `stagingAlias`

The alpha.9 hook redesign removed `LAKEBASE_STAGING_BRANCH` and the
hook's `STAGING_ALIAS` path, but two consumers still use the old
naming:
- Substrate: `scripts/lakebase/paired-branch.ts` — `stagingAlias` field
  in args, `isStagingAlias` logic
- Extension UI: `src/utils/theme.ts` `isStagingBranch`,
  `src/providers/branchTreeProvider.ts` tier coloring,
  `src/extension.ts` branch-change handler

These continue to work for two-tier projects where the user has
configured the deprecated `stagingBranch` setting, but they don't
auto-discover tiers from the Lakebase branch list like the hook now does.

**Action:** Migrate `paired-branch.ts` and the extension UI helpers to
the same auto-discovery model. Probably introduces a `isTier(branchName,
lakebaseBranches)` helper that both share.

## 9. `LAKEBASE_TRUNK_BRANCH` still exists; could it also auto-discover?

The hook still uses `LAKEBASE_TRUNK_BRANCH` to handle the special case
where the git trunk name (e.g. `main`) doesn't match the Lakebase
default branch's name (e.g. `production`).

**Could we auto-discover this too?** Maybe: the Lakebase default branch
has `.status.default == true`, but the GIT trunk name isn't recorded
anywhere on the Lakebase side. We could:
- Read `init.defaultBranch` from git config
- Check `origin/HEAD` symbolic ref to find the default git branch
- Assume the convention is `main` if not configured

This would let us drop `LAKEBASE_TRUNK_BRANCH` entirely.

**Action:** Probably worth doing in a follow-up; not blocking.

## 10. Reuse the small repro pattern for other substrate primitives

`test/integration/hook/hookOnCheckout.test.ts` runs in ~26s end-to-end
and exercises just the hook + a Lakebase project + a few git checkouts.
It was the right tool to surface the `core.hooksPath` bug — 60x faster
than the full ecom suite.

**Action:** Build similar small repros for:
- `release()` (PR open + merge + workflow polling) — exercises the
  release flow without 8 scenarios in front of it
- `cut-backup.ts` (pre-migrate snapshot lifecycle) — currently only
  hit transitively via the ecom Step E1/E2 assertions
- `pre-push.sh` token refresh — currently no isolated test
- `post-merge.sh` cleanup — currently no isolated test

The pattern: minimum viable scaffolding to exercise ONE substrate
primitive, with instrumentation (logs to `/tmp/<name>.log`) and
`<NAME>_NO_TEARDOWN=1` for preservation.

---

**Priority order suggested:**
1. (#1) Remove `createLakebaseBranchAndConnect` from test helpers — fixes a
   race that becomes visible now that the hook actually fires.
2. (#6) Audit `post-merge.sh` cleanup vs Phase D assertions; the now-firing
   hook may delete branches the test still inspects.
3. (#2) VS Code command for `createLongRunningBranch` — closes the biggest
   UX gap in the supported methodology.
4. (#8) Migrate `paired-branch.ts` + extension UI helpers to auto-discover
   tiers like the hook does.
5. (#10) Small repros for `release()`, `cut-backup`, `pre-push`, `post-merge`.
6. (#7) Scaffolded-project README note about `core.hooksPath`.
7. (#3, #4) Spring Initializr + github-hosted runner coverage.
8. (#9) Drop `LAKEBASE_TRUNK_BRANCH` if we can derive it from git config.
