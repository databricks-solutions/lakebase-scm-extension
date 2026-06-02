#!/usr/bin/env bash
# Gated release flow for lakebase-scm-extension.
#
# Encodes the order documented in RELEASING.md as a single command with
# guardrails so the release is never tagged before the vsix has been
# built + smoke-tested. Lessons enshrined here:
#
#   - Smoke the vsix BEFORE the tag, never after. v0.5.8 was re-tagged
#     three times because we tagged + cut a release before installing
#     the vsix in a real editor. Tag points at known-good code, period.
#   - Refuse to release a version that does not have a CHANGELOG entry.
#     The version field in package.json is not enough; we want release
#     notes too.
#   - Refuse to release on a branch other than main or a dirty / out-
#     of-sync main. Skip-the-fork moves that produced our worst commits
#     this session.
#   - Refuse to release if hermetic checks fail. (Pre-push covers
#     normal pushes; this script doubles up because the release branch
#     re-checks even with HUSKY=0.)
#   - Smoke is an interactive gate. The script halts and asks the
#     human to install the vsix into a real editor, exercise it, and
#     type `yes`. Any non-`yes` answer aborts. This is the line that
#     stops us from publishing broken builds.
#   - Tag points at the squash-merge commit of the release PR (per
#     RELEASING.md). The script enforces this by tagging only after
#     merge + pull + ff-only sync.
#   - vsix attached to the GitHub release is REBUILT from the tagged
#     commit, not the pre-merge artifact. Guarantees the published
#     artifact matches the tag hash.
#
# Usage:
#   scripts/release.sh <new-version>      # e.g. 0.6.0
#
# Required env:
#   GH_TOKEN or `gh auth login` already complete (for PR + release).
#
# Optional env:
#   VSCODE_BIN   editor binary used for smoke install (default: code).
#                Use `cursor` to install + smoke in Cursor.
#   AUTO_YES     if "1", skip the interactive smoke gate (CI only).
#                Default unset; the gate is mandatory by design.

set -euo pipefail

NEW_VERSION="${1:-}"
VSCODE_BIN="${VSCODE_BIN:-code}"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
phase()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fatal()  { red "FATAL: $*"; exit 1; }

[[ -n "$NEW_VERSION" ]] || fatal "Usage: $0 <new-version> (e.g. 0.6.0)"
[[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
  fatal "version '$NEW_VERSION' must match semver X.Y.Z (no pre-release tags here)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Phase 1: branch + tree state. Refuse to release from a dirty branch
# or a not-main branch or out-of-sync main. We do allow proceeding from
# a clean main; the release-branch creation below is a step that this
# script owns, not the user.
phase "1. Pre-flight: branch + tree state"
CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  fatal "release.sh must run from main. Current branch: $CURRENT_BRANCH"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  fatal "working tree must be clean before release. Stash or commit pending changes first."
fi
git fetch origin main
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  fatal "local main is not up to date with origin/main. Pull --ff-only first."
fi
green "  on main, clean, up to date with origin"

# Phase 2: refuse to release a version that has no CHANGELOG section.
# Captures notes-write discipline before we get to the tag.
phase "2. CHANGELOG entry exists for $NEW_VERSION"
if ! grep -q "^## $NEW_VERSION " CHANGELOG.md; then
  fatal "CHANGELOG.md is missing '## $NEW_VERSION (YYYY-MM-DD)' section. Add release notes first."
fi
green "  CHANGELOG.md has an entry for $NEW_VERSION"

# Phase 3: refuse to release a duplicate tag. v0.5.8 lived through 3
# re-tags this session and we do not want to repeat that.
phase "3. Refuse if v$NEW_VERSION already exists"
if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
  fatal "tag v$NEW_VERSION already exists locally. Bump to the next version."
fi
if git ls-remote --tags origin "v$NEW_VERSION" | grep -q "v$NEW_VERSION"; then
  fatal "tag v$NEW_VERSION already exists on origin. Bump to the next version."
fi
green "  v$NEW_VERSION is free to claim"

# Phase 4: pre-flight checks (typecheck + hermetic tests). The pre-push
# hook also runs these but we double up here to catch the case where
# someone pushed with HUSKY=0.
phase "4. Hermetic checks"
npm run typecheck
npm test
green "  typecheck + hermetic tests pass"

# Phase 5: branch + bump. The release PR ships ONLY the version bump +
# CHANGELOG (which must already be in place). Code changes for the
# release should have been merged independently into main BEFORE this
# script runs; that contract is documented in RELEASING.md.
phase "5. Branch + bump package.json + package-lock.json"
RELEASE_BRANCH="release/v$NEW_VERSION"
if git rev-parse --verify "$RELEASE_BRANCH" >/dev/null 2>&1; then
  fatal "branch $RELEASE_BRANCH already exists. Delete it or use a different version."
fi
git checkout -b "$RELEASE_BRANCH"
npm version "$NEW_VERSION" --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore(release): v$NEW_VERSION"
git push -u origin "$RELEASE_BRANCH"
green "  release branch pushed: $RELEASE_BRANCH"

# Phase 6: build the vsix from the bumped branch. We rebuild AGAIN
# from the merged commit later, but smoke runs against this build so
# the human is testing actual current code.
phase "6. Build vsix"
rm -f "lakebase-scm-extension-$NEW_VERSION.vsix"
npm run package
[[ -f "lakebase-scm-extension-$NEW_VERSION.vsix" ]] || \
  fatal "vsix build did not produce lakebase-scm-extension-$NEW_VERSION.vsix"
green "  vsix built: $(ls -lh "lakebase-scm-extension-$NEW_VERSION.vsix" | awk '{print $5}')"

# Phase 7: install + smoke gate. THIS IS THE NEW GUARDRAIL. The script
# halts here until the human confirms the vsix actually works in a
# real editor. Any answer other than "yes" aborts and leaves the
# release branch in place for cleanup / iteration.
phase "7. Install + smoke gate (interactive unless AUTO_YES=1)"
"$VSCODE_BIN" --install-extension "lakebase-scm-extension-$NEW_VERSION.vsix" --force
echo ""
yellow "  Installed lakebase-scm-extension-$NEW_VERSION.vsix into '$VSCODE_BIN'."
yellow "  Smoke checklist (per RELEASING.md):"
yellow "    1. FULLY QUIT $VSCODE_BIN (Cmd+Q), then reopen this project."
yellow "       In-window Reload Window is not enough after a vsix replace."
yellow "    2. Activity bar shows the 'Lakebase SCM' icon."
yellow "    3. lakebaseBranches view renders without errors."
yellow "    4. Cmd+Shift+P typing 'Lakebase SCM' surfaces every command."
yellow "    5. In a paired project, status bar shows current branch sync state."
yellow "    6. One paired-branch round-trip works end to end."
echo ""

if [[ "${AUTO_YES:-}" == "1" ]]; then
  yellow "  AUTO_YES=1 set; skipping interactive gate (CI mode)"
else
  read -r -p "  Did smoke pass? Type 'yes' to merge + tag + cut the release: " ANSWER
  if [[ "$ANSWER" != "yes" ]]; then
    red "  Smoke gate not passed. Release aborted."
    red "  Release branch $RELEASE_BRANCH is still on origin for iteration / cleanup."
    red "  Tag v$NEW_VERSION was NOT created. No GitHub release was cut."
    exit 1
  fi
fi
green "  smoke gate passed"

# Phase 8: merge the release PR. The PR should have been opened
# automatically by github-pr-create-on-push, OR we open it now.
phase "8. Open + merge release PR (squash)"
PR_NUM="$(gh pr list --head "$RELEASE_BRANCH" --json number --jq '.[0].number // empty')"
if [[ -z "$PR_NUM" ]]; then
  PR_NUM="$(gh pr create \
    --base main \
    --head "$RELEASE_BRANCH" \
    --title "chore(release): v$NEW_VERSION" \
    --body "Release PR for v$NEW_VERSION. See CHANGELOG.md for details. Smoke gate passed." \
    --json number --jq .number 2>/dev/null \
    || gh pr view "$RELEASE_BRANCH" --json number --jq .number)"
fi
[[ -n "$PR_NUM" ]] || fatal "Could not resolve a PR number for $RELEASE_BRANCH"
gh pr merge "$PR_NUM" --squash --delete-branch
green "  merged PR #$PR_NUM"

# Phase 9: sync local main + tag at the squash-merge commit.
phase "9. Sync main, tag v$NEW_VERSION at the merge commit"
git checkout main
git pull --ff-only origin main
git tag "v$NEW_VERSION"
git push origin "v$NEW_VERSION"
green "  tagged v$NEW_VERSION at $(git rev-parse v$NEW_VERSION)"

# Phase 10: rebuild vsix from the tagged commit and attach to the
# GitHub release. The pre-merge vsix from phase 6 was smoke-tested but
# the attached artifact must come from the tagged commit so the SHA in
# the release notes matches the artifact bits.
phase "10. Rebuild vsix from the tagged commit + cut GitHub release"
rm -f "lakebase-scm-extension-$NEW_VERSION.vsix"
npm run package
[[ -f "lakebase-scm-extension-$NEW_VERSION.vsix" ]] || \
  fatal "post-tag vsix rebuild did not produce lakebase-scm-extension-$NEW_VERSION.vsix"

NOTES_FILE="$(mktemp -t release-notes-$NEW_VERSION.XXXXXX.md)"
trap 'rm -f "$NOTES_FILE"' EXIT
awk -v ver="$NEW_VERSION" '
  $0 ~ "^## " ver " " {flag=1; next}
  flag && /^## [0-9]+\.[0-9]+\.[0-9]+/ {exit}
  flag {print}
' CHANGELOG.md > "$NOTES_FILE"
[[ -s "$NOTES_FILE" ]] || fatal "Extracted release notes are empty. Check CHANGELOG.md format."

gh release create "v$NEW_VERSION" \
  --title "v$NEW_VERSION" \
  --notes-file "$NOTES_FILE" \
  "lakebase-scm-extension-$NEW_VERSION.vsix"
green "  GitHub release v$NEW_VERSION cut with vsix attached"

phase "Done. v$NEW_VERSION shipped end to end."
echo ""
yellow "Post-release checklist (manual):"
yellow "  - Close JIRA tickets whose work shipped in this release"
yellow "  - If the kit was bumped, confirm its release notes reference any"
yellow "    consumer-facing changes"
echo ""
