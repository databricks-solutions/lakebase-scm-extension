# Releasing the lakebase-scm-extension

End-to-end checklist for cutting a new release. The extension ships as a
`.vsix` asset on a [GitHub release](https://github.com/databricks-solutions/lakebase-scm-extension/releases),
not via the VS Code Marketplace. Users install via "Extensions -> Install
from VSIX" after downloading.

## TL;DR

```bash
# 1. CHANGELOG entry written for the new version (## X.Y.Z (YYYY-MM-DD))
# 2. All code changes for the release merged to main BEFORE this step
# 3. From a clean main, run:
scripts/release.sh 0.6.0
```

`scripts/release.sh` IS the canonical release flow. The manual steps below are the underlying procedure the script automates; read them only when debugging the script or recovering from a partial release.

## Principles enshrined in `scripts/release.sh`

Lessons from prior releases that the script now enforces in code:

1. **Smoke the vsix BEFORE the tag, never after.** v0.5.8 was re-tagged three times because we tagged + cut a release before installing the vsix in a real editor. The script halts at an interactive gate after building the vsix and refuses to proceed until the human types `yes`.
2. **Refuse to release a version without a CHANGELOG entry.** The `version` field in `package.json` is not enough; the script `grep`s for `^## X.Y.Z ` in `CHANGELOG.md` and bails if missing.
3. **Refuse to release on a non-main / dirty / out-of-sync branch.** Catches the "I'll just commit on this branch real quick" mistake at the start, not after artifacts have been built.
4. **Refuse to re-claim an existing tag.** The script checks local + remote refs for `vX.Y.Z` and bails if it exists. Re-tagging an existing version is the path to inconsistent published artifacts.
5. **Tag points at the squash-merge commit of the release PR.** Enforced by tagging only after `gh pr merge` + `git pull --ff-only`.
6. **vsix attached to the GitHub release is REBUILT from the tagged commit.** The pre-merge vsix is what the human smoked; the published vsix comes from the tagged commit so SHA in release notes matches artifact bits. Phase 10 of the script.
7. **Hermetic checks (typecheck + tests) run inside the script** in addition to pre-push, so `HUSKY=0 git push` cannot route around them.
8. **A failed smoke does not leak release state.** Aborting at the smoke gate leaves the release branch on origin for iteration; no tag is created, no GitHub release is cut, no artifact is published.

## When to release

Default cadence is **one tagged release per substantive feature / bug-fix
batch**. The kit (`lakebase-app-dev-kit`) cuts alpha-versioned releases
on a per-PR cadence (`v0.3.0-alpha.<N>`), but the extension consolidates
multiple PRs into a single user-facing version bump (`v0.5.<N>`).

Bump rules:

| Change | Bump |
|---|---|
| Bug fix or doc-only | patch (`0.5.7` -> `0.5.8`) |
| New user-visible feature (command / view / option) | minor (`0.5.7` -> `0.6.0`) |
| Breaking change to command keybindings or extension settings | minor with `**Breaking**` callout in CHANGELOG |
| Major architectural shift (e.g. extraction track completion) | minor or major at maintainer discretion |

## Pre-flight (before opening the release PR)

Run these from a clean checkout on `main`:

```bash
# 1. Pull latest
git checkout main && git pull --ff-only origin main

# 2. Verify the kit pin is what you want shipping
grep "lakebase-app-dev-kit" package.json

# 3. Hermetic checks
npm run typecheck
npm test

# 4. Bundle smoke
npm run package
# Verify .vsix size is sane (currently ~1.3 MB)
ls -lh lakebase-scm-extension-*.vsix
```

If `LAKEBASE_TEST_E2E=1` workspace creds are available, run the
integration tier too:

```bash
DATABRICKS_TEST_HOST=https://<your-workspace>.cloud.databricks.com \
LAKEBASE_TEST_E2E=1 \
npm run test:integration
```

See `CONTRIBUTING.md`'s three-tier testing section for the full env
contract.

## Release steps

### 1. Branch + bump

```bash
git checkout -b release/v0.5.X
```

Update three places to the new version (must match exactly):

- `package.json` -> `"version": "0.5.X"`
- `package-lock.json` (run `npm install --package-lock-only` after
  editing `package.json` to sync)
- `CHANGELOG.md` -> prepend a new `## 0.5.X (YYYY-MM-DD)` section

CHANGELOG sections to include (skip any that are empty for this
release):

```markdown
## 0.5.X (YYYY-MM-DD)

<1-2 sentence headline theme>

### Added
- ...

### Changed
- ...

### Fixed: substrate bugs surfaced by live BDD
- ...

### Fixed: extension surface
- ...

### Repo / governance
- ...
```

The existing CHANGELOG is the style reference: lead with WHY each change
matters, not WHAT it does. Quote test counts at the bottom of the
section ("X passing, zero failing").

### 2. Open the release PR

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
0.5.X - <one-line headline>

<3-5 lines summarizing the headline theme, mirroring the CHANGELOG
intro paragraph>

Co-authored-by: Isaac
EOF
)"
git push -u origin release/v0.5.X
gh pr create --base main --head release/v0.5.X \
  --title "0.5.X - <one-line headline>" \
  --body-file <(echo "Release PR for v0.5.X. See CHANGELOG for details.")
```

The PR ships ONLY the version bump + CHANGELOG. No code changes in the
release PR; those should already be merged independently.

### 3. Merge + tag

```bash
gh pr merge <PR-number> --squash --delete-branch
git checkout main && git pull --ff-only origin main
git tag v0.5.X
git push origin v0.5.X
```

The tag MUST point at the merge commit of the release PR (so the .vsix
artifact and the CHANGELOG entry match).

### 4. Build the .vsix

```bash
npm install --frozen-lockfile  # match the published lockfile exactly
npm run package
```

Verify the output:

```bash
ls -lh lakebase-scm-extension-0.5.X.vsix
# ~1.3 MB expected. Significantly larger = check that webpack didn't
# bundle node_modules unexpectedly (vsce package pulls node_modules in
# by design, but a 5+ MB jump suggests new heavy deps).
```

### 5. Smoke test the .vsix locally

```bash
code --install-extension lakebase-scm-extension-0.5.X.vsix --force
# Reload window: Cmd+Shift+P -> "Developer: Reload Window"
```

Manual smoke (matches the user's First-Time Setup flow in README):

- [ ] Activity bar shows the "Lakebase SCM Extension" icon
- [ ] `lakebaseBranches` view renders with current project's branches
- [ ] `lakebaseSync.connectWorkspace` command runs without error
- [ ] In a paired project, status bar shows the current branch sync state
- [ ] One paired-branch creation flow round-trips (e.g. create + switch
      + verify .env updates)

### 6. Cut the GitHub release

```bash
gh release create v0.5.X \
  --title "v0.5.X - <one-line headline>" \
  --notes-file <(awk '/^## 0\.5\.X/,/^## 0\.5\./' CHANGELOG.md | sed '$d') \
  lakebase-scm-extension-0.5.X.vsix
```

The `--notes-file` step extracts just this version's CHANGELOG section.
Double-check the release page renders the markdown correctly; edit via
the web UI if a code block needs fixing.

### 7. Verify the README install path still works

```bash
# Simulate a user clicking the README's "latest release" link:
gh release view --web
```

The release page should show the `.vsix` as a downloadable asset and the
CHANGELOG body as the release notes. Anyone hitting the README's
"latest release" link should land here.

## Post-release

- Close any Jira tickets whose work shipped in this release. Add a
  comment to each pointing at the tag URL.
- If the kit was bumped, confirm the kit's release notes reference any
  consumer-facing changes. The kit (`lakebase-app-dev-kit`) has its own
  release cadence; this checklist is extension-only.
- Update the SKILL.md / lakebase-scm-workflows skill docs ONLY if the
  release introduced a user-facing command rename or removed a primitive.
  Otherwise the substrate side handles its own SKILL doc updates.

## Rollback

If a smoke test fails or a critical bug is discovered post-release:

1. **Don't delete the tag.** Tags shipped to users; deleting breaks
   anyone who pinned to it.
2. Cut a patch release with the fix (`v0.5.X+1`).
3. Edit the GitHub release page for the broken version to mark it as
   "Pre-release" or add a `> WARNING: known issue X, use v0.5.X+1`
   banner at the top of the notes.

## Reference

- Tag pattern: `v<major>.<minor>.<patch>` (semver, no `-alpha` suffixes
  on the extension side; alpha versions are kit-only)
- CHANGELOG style: see existing entries; lead with WHY, quote test
  counts at the end of each section
- `package.json` publisher: `kevin-hartman` (personal publisher; not the
  Databricks marketplace publisher)
- vsce: `./node_modules/.bin/vsce` (devDependency, not global) - the
  `npm run package` script wraps this without `--no-dependencies` so
  `node_modules/` ships in the .vsix
