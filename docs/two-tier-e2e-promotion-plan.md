# PR #12 plan: two-tier E2E + release primitive (N-tier-shaped)

Branch: `kevin.hartman/two-tier-e2e-with-promotion`
Status: DRAFT - foundation shipped; test surgery + integration runs remain.

## Why this PR exists

Before this PR, every integration scenario merged its feature PR directly into `main`. `merge.yml` therefore only ever fired on the `main` push, and the substrate-routed `lakebase-cut-backup` + `lakebase-schema-migrate apply` against the prod Lakebase branch was technically exercised on every scenario - but with no intermediate `staging` tier, the *interesting* path (`staging → main` promotion under realistic accumulated drift) was never tested.

This PR introduces the two-tier flow (feature → staging → main) as the integration suite's default. In the process it also commits to the design described in the substrate's [`lakebase-release-workflows`](../../lakebase-app-dev-kit/skills/lakebase-release-workflows/SKILL.md) skill: **a release is a from→to promotion between two adjacent long-running branches**. Two-tier is the default; N-tier (e.g. `dev → staging → prod`) is an explicit per-project option and the same primitive serves every adjacent pair.

The test surgery in this PR therefore deliberately avoids hardcoding `'staging'` or `'main'`. Scenarios are parameterized over `ctx.baseBranch` (the long-running branch the scenario merges back into). A future PR that switches a test project to three-tier sets `ctx.baseBranch = 'dev'` in the harness and the same scenario files work without modification.

## What "release" means here

A release is a primitive defined in the substrate. PR #12 ships the extension's test-side helper as `promoteStagingToMain(...)`, but the design intent is the substrate's `release({ from, to, releaseId })` primitive (planned). The extension helper is a thin caller. In a future cleanup the helper should be renamed `release({ from, to })` and `promoteStagingToMain` becomes a one-line shim for the two-tier default.

Two-tier shape (this PR):

```
prod  ←  staging  ←  feature/*    (release: staging → prod, run by Step E1/E2)
```

Three-tier shape (future, no scenario file changes required):

```
prod  ←  staging  ←  dev  ←  feature/*    (two releases: dev → staging, staging → prod)
```

## Implementation scope

### 1. ScenarioContext gains a `baseBranch` field

`test/integration/{ecommerce,python-devloop}/helpers.ts`:

```ts
export interface ScenarioContext {
  // ...existing fields...
  baseBranch: string;          // the long-running branch this scenario PRs into
                               // (two-tier: 'staging'; three-tier: 'dev')
}
```

Each test file's `before()` block sets `ctx.baseBranch` after `createStagingBranch` succeeds. Two-tier suites set `'staging'`. An N-tier suite would set `'dev'` (and the harness would need additional release-step invocations).

### 2. Per-language helpers parameterize over `ctx.baseBranch`

`pullMain(ctx)` → `pullBaseBranch(ctx)`:

```ts
export function pullBaseBranch(ctx: ScenarioContext): void {
  const branch = ctx.baseBranch;
  execSync(`git checkout ${branch} && git pull origin ${branch}`, { cwd: ctx.projectDir });
}
```

`createPR` defaults stay at `'staging'` for two-tier convenience, but scenarios that need to be explicit pass `ctx.baseBranch` through.

### 3. Scenario files lose `'main'` literals

13 scenario files (`ecommerce/scenario1Book.ts` ... `scenario8DropBook.ts`, `scenario1_6_AllEntities.ts`; `python-devloop/scenario1Partner.ts` ... `scenario4DropPartner.ts`) currently contain:

```ts
const result = await waitForWorkflowRun(ctx, 'merge.yml', { branch: 'main', event: 'push', afterRunId: beforeMergeRunId });
// ...
pullMain(ctx);
```

After this PR:

```ts
const result = await waitForWorkflowRun(ctx, 'merge.yml', { branch: ctx.baseBranch, event: 'push', afterRunId: beforeMergeRunId });
// ...
pullBaseBranch(ctx);
```

Assertion strings ("Flyway on production") similarly become tier-neutral ("merge.yml succeeds on the base branch").

### 4. Release primitive (Step E1 / E2) stays separate

`test/integration/lib/staging-promotion.ts` keeps its current shape but the helper's *contract* is "promote between two adjacent long-running branches" - the implementation just happens to default to `staging → main`. The two Step E describe blocks in each suite call it; nothing in scenarios calls it.

When the substrate ships the real `release` primitive, this helper collapses into a thin caller. The test-side contract doesn't change.

### 5. Test launch hardening (already landed)

`test/integration/lib/launch-cli.ts` (commit `991763e`) wraps `npm run test:integration` and polls the log for refusal markers within 20s. Catches the single-run-lock + before-all-hook + IntegrationSetupError class of silent-launch failures that the previous ad-hoc nohup pattern missed.

### 6. Preserve-by-default test infra (already landed in PR #11)

Integration suites never auto-teardown. `cleanup-cli.ts` is the only path to delete a test's GitHub repo + Lakebase project + local dir, gated on per-resource y/N confirmation. The same rule applies to this PR's reruns.

## What's already done

| Commit | Scope |
|---|---|
| `2847d88` | Lib foundation: `staging-promotion.ts` (createStagingBranch, promoteStagingToMain, assertBackupSnapshotLifecycle, assertProdSchemaContains) + `createPR` baseBranch param + per-language wrappers default to `'staging'`. Kit pinned to `v0.3.0-alpha.5`. |
| `24d6f7b` | `lib.queryBranch` generalization + per-language `verify*` helpers default to `branch='staging'`. |
| `e566cc5` | Test surgery (initial): inserted `createStagingBranch` into both `before()` blocks + Step E1/E2 describes at fixed positions. |
| `981a1f1` | (Superseded by `3f109ab`) Initial `createStagingBranch` fix - hardcoded prod discovery. |
| `3f109ab` | Backed out hardcoded prod discovery; aligned with substrate's "no parent → fork from current; no .env → main/prod" convention. |
| `c2256be` | Set `process.env.LAKEBASE_BRANCH_ID = 'staging'` in `createStagingBranch` after `git checkout staging` - mirrors the post-checkout hook's disk write so subsequent in-process `createBranch(feature)` calls fork features off staging, not production. |
| `991763e` | `launch-cli` for startup verification. |

## What remains for this PR

1. **ScenarioContext refactor.** Add `baseBranch: string`. Initialize in both suites' `before()` blocks. Update typings.
2. **Helpers refactor.** Rename `pullMain` → `pullBaseBranch` (keep `pullMain` as a deprecated shim for one release). Both languages.
3. **Scenario surgery.** Replace `branch: 'main'` → `branch: ctx.baseBranch` and `pullMain(ctx)` → `pullBaseBranch(ctx)` in all 13 scenario files. Update assertion message strings to be tier-neutral.
4. **Verify against fresh runs.** Re-run ecom + pydev integration suites. Confirm scenarios PR into staging, merge.yml fires on staging push, feature Lakebase branches fork from staging, Step E1/E2 promote staging → main successfully, and `assertProdSchemaContains` matches expectations.
5. **Memory updates.** Reflect that N-tier is now an explicit option in the substrate's release-workflows skill.

## Test-surgery anti-patterns to avoid

The substrate's [methodology doc](../../lakebase-app-dev-kit/skills/lakebase-release-workflows/references/branching-and-release-methodology.md) calls this out explicitly:

> **Hardcoding `staging` or `prod` in test scenarios.** Tests should be parameterized over their target tier (read from project metadata or scenario context), so the same e2e suite exercises two-tier and N-tier configurations identically. Scenarios that contain `branch: 'main'` or `git checkout staging` literals will silently misbehave when the chain shape changes.

The PR before this surgery had exactly that hardcode (`branch: 'main'` in every scenario's C3 step), which silently broke under the two-tier flow - `waitForWorkflowRun` polled for a `main` push that never happened and the test process died without flushing a useful error. Fixing this now also future-proofs against N-tier.

## Risk

- 13 files × ~3 hits each is mechanical but error-prone. Mocha describe ordering, ScenarioContext mutation across files, and the `ctx.baseBranch` initialization timing (must be set before any scenario describe runs) all need attention.
- The release helper rename (`promoteStagingToMain` → `release`) is *not* in this PR's scope. PR #12 ships the two-tier-shaped name; a follow-up generalizes when substrate's `release` primitive lands.
- Step E1/E2 promotion still expects `branch: 'main'` in its own `waitForWorkflowRun` call - that one is correct (the staging→main release fires merge.yml on main push) and should NOT be parameterized over `ctx.baseBranch`. It's parameterized over the release primitive's `to` tier instead.
