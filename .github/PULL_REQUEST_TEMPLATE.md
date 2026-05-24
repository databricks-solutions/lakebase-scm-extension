## What this changes

<!-- One paragraph. Focus on the user-visible behavior change, not the file diff. -->

## Why

<!-- The motivation. If it's a bug fix, what was the symptom and the root cause. -->

## Tests run (all required)

Three tiers, all of them. See `CONTRIBUTING.md` § Testing for setup.

- [ ] **Tier 1 — Hermetic unit suite**: `npm test` → "N passing" with no failures
- [ ] **Tier 2 — Hermetic substrate BDD**: `(cd node_modules/@databricks-solutions/lakebase-app-dev-kit && npx vitest run)` → all green
- [ ] **Tier 3 — Full integration**: `npm run test:integration` against YOUR own Databricks workspace (set `DATABRICKS_TEST_HOST` + `databricks auth login` + `gh auth login` first) → ecom AND python-devloop both green

> **Tier 3 is not optional.** It's the only layer that exercises the real CI workflow templates (`pr.yml`/`merge.yml`), self-hosted runner setup, real Lakebase branch CRUD, and the cleanup pipeline. Bugs that ship through Tier-1+2-only review almost always surface here. If you genuinely cannot run Tier 3 (no Databricks workspace access), say so explicitly so the reviewer knows what's covered.

### Manual scenarios for UI / view changes (if applicable)

<!-- For UI/view changes no test suite covers, describe what you exercised:
     - Which extension command(s) you triggered
     - Which view(s) you observed (Project tree, Branch Diff Summary, Changes panel, ...)
     - State before vs state after
-->

## Surfaces touched (check all that apply)

- [ ] TypeScript: `src/services/`, `src/providers/`, `src/extension.ts`
- [ ] Shell hooks: `templates/project/common/scripts/*.sh`
- [ ] CI templates: `templates/project/common/.github/workflows/*.yml`
- [ ] Substrate dep bumped (`@databricks-solutions/lakebase-app-dev-kit` SHA/tag)
- [ ] User-facing copy: README, command titles, settings descriptions
- [ ] CHANGELOG.md updated

> The TypeScript path and the shell hook path implement parallel logic for branch lifecycle. Behavior changes that touch one usually need to touch the other — please check.

## Build

- [ ] `./node_modules/.bin/vsce package` produced `DONE  Packaged: ...` with no `ERROR` lines
