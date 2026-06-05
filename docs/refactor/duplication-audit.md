# Extension duplication audit + service-layer refactor plan

Scope: `lakebase-scm-extension/src/**`. Goal: eliminate duplicated logic
(DRY) and push business logic out of the UI layer (`extension.ts`,
`providers/*`) into the service layer (`src/services/*`).

Method: `jscpd` (token-exact clones) plus three semantic-duplication
audits (extension.ts, providers/, services/+utils/). jscpd reported
1.27% token-exact duplication (14 clones); the semantic audit found
substantially more.

Litmus for "move to a service": if a duplicated block invokes a CLI,
parses output, resolves config, or mutates remote/db state, it belongs
in a service method. Only toasts, quick-picks, input boxes,
`withProgress`, and `provider.refresh()` stay in the UI layer.

Already fixed during the audit (do not re-report):
`selectAndAuthenticateWorkspace`, `pickLakebaseLanguage`,
`pickLakebaseRunner`, `runDatabricksLoginInBackground`,
`src/utils/text.ts` (`stripInvisibles` / `validateDatabricksHostInput`).

Line numbers are as of the audit commit; reverify before editing.

## Status (as of v0.5.16)

- **Tier 1 (A-D): DONE.** owner/repo, Lakebase-branch-resolve,
  migrate-command, .env parse all moved to services. Fixed 2 latent
  bugs (divergent owner/repo regexes; missing refresh-token wrap).
- **Tier 2 (F-K): DONE.** `withDatabricksHostEnv`, `parseCliJsonList`,
  `fetchCurrentUser`, `branchCall`, `parseNameStatus` + `parentCandidates`
  reuse, `latestDiagLog`, `parseColumnLines`, `loadCommitFiles`.
- **Tier 2 (E): SKIPPED by decision.** The ~50-site GitService
  workspace-root guard prelude is uniform boilerplate, not divergent
  logic (no latent bug). High-churn, low-value; deliberately left
  as-is. Do not re-open without a reason.
- **Cluster J: DONE.** `DiffService.sortMigrations` now delegates to
  `diffBuilder.sortMigrationsToEnd` (was a divergent basename-substring
  copy); `diffBuilder` stays live (graphWebview consumes it).
- **Tier 3 (L, M, N): DONE.** L -> `utils/statusPresentation.ts`
  (vscode-free status -> icon/color/label maps by domain: CI_STATUS,
  CHECK_CONCLUSION, REVIEW_DECISION, REVIEW_STATE, SYNC_STATE +
  `workflowRunStyle` + `resolveStatusStyle`), adopted by
  pullRequestTree, schemaScmProvider, runnerTreeProvider,
  statusBarProvider, branchTreeProvider (the last also dropped its dead
  local status maps for theme.ts `STATUS_ICONS`/`STATUS_COLORS`).
  M -> `providers/scmStateTree.ts` (`ScmStateTreeProvider` base +
  `scmStateToTreeItem`); mergesTree/migrationsTree/lakebaseSchemaTree are
  now thin subclasses. N -> `utils/fileRow.ts` `buildFileDiffCommand`,
  adopted by pullRequestTree, schemaScmProvider, branchTreeProvider.
  Each new util has hermetic coverage written first (statusPresentation,
  fileRow, scmStateTree test suites).
- **Tier 3 (O): SKIPPED by decision.** `escapeHtml` in schemaDiffProvider
  + graphWebview (server-side) is low-value churn; the in-page JS copy
  must stay inline regardless. Do not re-open without a reason.
- **Misc (auth-error signature corpus, `KNOWN_TIERS` const): still open.**
- **Greenfield GitHub creation: intentionally NOT unified** onto
  `setUpGitHubRemoteForFolder` (it targets a not-yet-opened folder via
  the kit's `createProject`; the helper targets the open workspace).
  This is a structural difference, not duplication.

---

## Tier 1: logic in the UI layer that belongs in a service

### A. GitHub owner/repo resolution (3 divergent regexes)
- extension.ts: `startRunner` 2126-2132, `setupCiSecrets` 2156-2162,
  `createLakebaseProject` runner sub-flow ~1693-1698, `removeRunner`
  2260-2264; providers: `branchTreeProvider.ts:155-156`,
  `runnerTreeProvider.ts:112-115`.
- The regexes differ (`/github\.com\/(.+)/`, `/(.+?)\/?$/`,
  `/(.+)$/`): a latent trailing-slash inconsistency, not just dup.
- Fix: `GitService.getOwnerRepo()` already exists; route every site
  through it. Delete the inline regexes. Add `getRepoName()` if a bare
  name is needed.
- Risk: low-med (confirm each caller wants owner/repo vs bare name).

### B. "Resolve the Lakebase branch for the current git branch"
- extension.ts: `refreshCredentials` 2082-2102, `openInConsole`
  2473-2484, `switchBranch` 2559-2565, `startCredentialRefresh`
  2877-2881.
- Pattern: `isMainBranch(branch, trunk) ? getDefaultBranch() :
  getBranchByName(branch)`.
- Fix: `LakebaseService.resolveBranchForGitBranch(gitBranch,
  { fallbackToDefault? })`.
- Risk: low-med (`openInConsole` adds a default fallback, so make it a flag).

### C. Migration-run command map (two copies have DIVERGED)
- extension.ts: `runMigrate` 2300-2315, `switchBranch` inline 2604-2624.
- Both map lang to `{name, cmd}` for java/kotlin/python/nodejs/unknown,
  but `switchBranch` omits the `refresh-token.sh` wrapper for some langs:
  a likely latent bug.
- Fix: `SchemaMigrationService.buildMigrateCommand(lang,
  { branchLabel?, wrapToken? })`; UI only does `createTerminal`.
- Risk: med (reconcile the divergence intentionally).

### D. `.env` hand-parsed instead of the shared parser
- `runnerService.ts:88-93` re-reads `.env` with regexes plus
  quote-stripping; the canonical reader is `utils/config.parseEnvFile`
  (config.ts:95-115), which does NOT strip quotes.
- Fix: call `parseEnvFile`; add quote-stripping there so all readers
  benefit (parseEnvFile keeping quotes is itself a latent bug).
- Risk: low.

---

## Tier 2: intra-service dedup (private helpers in the owning service)

### E. `getWorkspaceRoot()` + bail prelude (~50 sites)
- `gitService.ts`: return-empty flavor (~32 sites) and throw flavor
  (~45 sites); each method opens with the same 2-3 lines before a
  one-line substrate delegation.
- Fix: private `rootOrThrow(): string` and `rootOr<T>(fallback): string
  | T`; most methods collapse to
  `return substrateX({ cwd: this.rootOrThrow(), ... })`.
- Risk: med (preserve each method's fallback shape).

### F. `withHost` DATABRICKS_HOST save/mutate/restore (3 copies)
- `lakebaseService.ts:287-311` (richest, also sets
  DATABRICKS_CONFIG_PROFILE), `schemaMigrationService.ts:66-76`,
  `schemaDiffService.ts:235-253` (inline).
- Fix: `withDatabricksHost<T>(host, fn, { profile? })` in
  `utils/exec.ts` (or `utils/databricksEnv.ts`); lakebase keeps its
  async profile-resolver wrapper.
- Risk: med (lakebase resolves profile inside the mutated window).

### G. git `--name-status` parser (3 copies)
- `gitService.ts`: `getChangedFiles` 398-411, `getStagedChanges`
  471-481 (token-exact), `getUnstagedChanges` 493-505 (no rename branch).
- Fix: private `parseNameStatus(raw): GitFileChange[]`.
- Risk: low.

### H. `databricks ... -o json` parse then array-or-`.field` (4 copies)
- `lakebaseService.ts`: `listProfiles` 367-376, `listLakebaseProfiles`
  388-400, `checkAuth` 423-425, `getCurrentUserEmail` 451-453.
- Fix: private `cliJson(cmd, env?)` + `parseCliJsonList(raw, key)`; and
  a single `fetchCurrentUser()` shared by checkAuth + getCurrentUserEmail.
- Risk: low.

### I. branch-call skeleton (6 copies)
- `lakebaseService.ts`: `deleteBranch` 593-600, `getEndpoint` 604-611,
  `getCredential` 613-620, `queryBranchTables` 676-689,
  `queryBranchSchemaWithError` 698-715, `queryBranchSchema` 717-730.
- Pattern: `withHost(() => substrateX({ instance:
  requireProjectInstance(), branch: sanitizeBranchName(name) }))`.
- Fix: private `branchCall<T>(branch, fn)`; keep error handling at the
  call site (some rethrow, some swallow). `queryBranchSchema` can become
  `(await queryBranchSchemaWithError(b)).tables`.
- Risk: low-med.

### J. `DiffService` reimplements its own `utils/diffBuilder.ts`
- `diffService.ts:117-154` re-implements `buildDiffTuples`
  (diffBuilder.ts:15-24) and `sortMigrationsToEnd` (diffBuilder.ts:29-41).
  diffBuilder is a dead parallel extraction.
- Fix: adopt diffBuilder; reconcile basename-vs-fullpath migration match.
- Risk: med.

### K. Two-method-one-body pairs + small parsers (low risk)
- `runnerService.ts` log scanner 109-117 vs 120-128: `latestDiagLog(prefix)`.
- `schemaDiffService.ts` column parser 180-190 vs 192-202:
  `parseColumnLines(text, start, regex)`.
- `diffService.ts` 31-36 vs 54-59: `loadCommitFiles(sha)`.
- `gitService.ts` parentCandidates 211-216 vs inline 350-352: call the
  method.

---

## Tier 3: providers (shared base class / util)

### L. status to icon/color `Record` maps (8+ copies)
- `schemaScmProvider.ts:464-481`, `pullRequestTree.ts` 95-96 / 158-167 /
  199-206 / 282-293, `runnerTreeProvider.ts:247-256`,
  `branchTreeProvider.ts:759-760` (plus inline ladder 674-686),
  `statusBarProvider.ts:94-110`.
- Fix: `utils/statusPresentation.ts` exporting per-domain
  `{icon,color,label}` records (`CI_STATUS`, `REVIEW_STATE`,
  `CHECK_CONCLUSION`, `WORKFLOW_RUN`) + `themeIcon(map, key, ...)`.
- Risk: med (per-domain key sets differ; do NOT force one universal map).

### M. Three near-identical placeholder TreeDataProviders
- `mergesTree.ts:4-28`, `migrationsTree.ts:4-28`,
  `lakebaseSchemaTree.ts:4-28` (token-exact except 2 lines). The
  state-to-TreeItem mapping is also duplicated in
  `changesTreeProvider.ts:122-144` and `pullRequestTree.ts:182-186`.
- Fix: `src/providers/scmStateTree.ts` base class taking
  `(scmProvider, accessor, labelFn?)` + `scmStateToTreeItem(state, label?)`.
- Risk: low.

### N. GitFileChange to file-row + diff-command (4 copies)
- `pullRequestTree.ts:234-261`, `branchTreeProvider.ts:836-858`,
  `schemaScmProvider.ts:631-642` (plus resource builders 605-629).
- `branchTreeProvider.ts:829-834` re-declares STATUS_ICONS/STATUS_COLORS
  that already live in `utils/theme.ts`: dead dup, just import.
- Fix: `utils/fileRow.ts`: `buildFileDiffCommand(file, fileUri,
  labelSuffix)` + `applyFileStatusIcon(item, status)`.
- Risk: med (label strings + URI bases differ per caller, so pass params).

### O. HTML-escape helper (3 copies)
- `schemaDiffProvider.ts:694-696`, `graphWebview.ts:848` (server-side),
  `graphWebview.ts:696` (in-page JS, must stay).
- Fix: `utils/html.ts` `escapeHtml(s)` (plus `escapeAttr` for the
  newline-collapsing variant); import in the two server-side sites.
- Risk: low.

### Also
- `schemaScmProvider.ts` staged/unstaged refresh + count (186-210,
  226-239+349-351, 585-598): private `applyStagedAndUnstaged(root)` +
  `recomputeCount()`.
- `pullRequestTree.ts` getPr+ownerRepo guard (224-231 vs 267-274):
  private `withPrOwnerRepo(fetch, emptyLabel)`.
- `branchTreeProvider.ts` getTableList 3 inline table-row builders
  (582-622, 664-697, 752-782): private `makeTableItem(...)`.
- `KNOWN_TIERS` set duplicated: `schemaDiffService.ts:19` vs
  `branchTreeProvider.ts:18`: single const in `utils/theme.ts`.
- Auth-error signatures in 3 places (`utils/exec.ts:22-30`,
  `lakebaseService.ts:107`, `runnerService.ts:101`):
  `classifyDatabricksAuthError(msg)` corpus, keep tagging vs
  remediation roles separate.

---

## Suggested execution order
1. Tier 1 (A-D): UI-logic leaks to service methods. Highest
   architectural payoff, fixes 2 latent bugs (owner/repo regex, migrate
   token-wrap).
2. Tier 2 (E-K): intra-service private helpers. Mechanical, well-bounded.
3. Tier 3 (L-O): provider base class + presentation util.

Gate each cluster with `npm run typecheck` + `npm run package`. Commit
per cluster for incremental review. No version bump until explicitly
requested.
