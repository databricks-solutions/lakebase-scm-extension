## What this changes

<!-- One paragraph. Focus on the user-visible behavior change, not the file diff. -->

## Why

<!-- The motivation. If it's a bug fix, what was the symptom and the root cause. -->

## Manual test plan

<!-- We don't have automated tests yet. Describe what you exercised:
     - Which extension command(s) you triggered
     - Which view(s) you observed (Project tree, Branch Diff Summary, Changes panel, ...)
     - State before vs state after
-->

## Surfaces touched (check all that apply)

- [ ] TypeScript: `src/services/`, `src/providers/`, `src/extension.ts`
- [ ] Shell hooks: `templates/project/common/scripts/*.sh`
- [ ] CI templates: `templates/project/common/.github/workflows/*.yml`
- [ ] User-facing copy: README, command titles, settings descriptions
- [ ] CHANGELOG.md updated

> The TypeScript path and the shell hook path implement parallel logic for branch lifecycle. Behavior changes that touch one usually need to touch the other — please check.

## Build

- [ ] `./node_modules/.bin/vsce package` produced `DONE  Packaged: ...` with no `ERROR` lines
