import * as vscode from 'vscode';
import { getConfig, getWorkspaceRoot } from '../utils/config';
import { exec } from '../utils/exec';
// Substrate covers clone + origin-remote parsing (FEIP-7065) AND, as of
// FEIP-7323 P5a, the workflow-coordination inspection ops (list local /
// remote branches, parent / merge-base resolution, status, migrations
// listing). The remaining ~50 methods on this service are VS Code
// SCM-flavored or generic git wrappers and stay inline pending later
// P5 sub-tasks.
import {
  formatOwnerRepo,
  parseOwnerRepo,
  cloneRepo as substrateCloneRepo,
  getGitHubUrl as substrateGetGitHubUrl,
  getOwnerRepo as substrateGetOwnerRepo,
  listLocalBranches as substrateListLocalBranches,
  listRemoteBranches as substrateListRemoteBranches,
  hasRemoteBranch as substrateHasRemoteBranch,
  resolveNearestParent as substrateResolveNearestParent,
  getNearestParentName as substrateGetNearestParentName,
  getMergeBase as substrateGetMergeBase,
  hasUpstream as substrateHasUpstream,
  getAheadBehind as substrateGetAheadBehind,
  isDirty as substrateIsDirty,
  listMigrationsOnBranch as substrateListMigrationsOnBranch,
  commit as substrateCommit,
  commitAll as substrateCommitAll,
  commitAmend as substrateCommitAmend,
  commitSignedOff as substrateCommitSignedOff,
  commitAllSignedOff as substrateCommitAllSignedOff,
  undoLastCommit as substrateUndoLastCommit,
  discardAllChanges as substrateDiscardAllChanges,
  push as substratePush,
  pull as substratePull,
  publishBranch as substratePublishBranch,
  pushCurrentBranchForPr as substratePushCurrentBranchForPr,
  deleteLocalBranch as substrateDeleteLocalBranch,
  renameBranch as substrateRenameBranch,
  mergeBranch as substrateMergeBranch,
  createTag as substrateCreateTag,
  deleteTag as substrateDeleteTag,
  deleteRemoteTag as substrateDeleteRemoteTag,
  // P6 substrate primitives
  stash as substrateStash,
  stashStaged as substrateStashStaged,
  stashIncludeUntracked as substrateStashIncludeUntracked,
  stashList as substrateStashList,
  stashApply as substrateStashApply,
  stashPop as substrateStashPop,
  stashDrop as substrateStashDrop,
  stashDropAll as substrateStashDropAll,
  abortRebase as substrateAbortRebase,
  isRebasing as substrateIsRebasing,
  rebaseBranch as substrateRebaseBranch,
  pullRebase as substratePullRebase,
  createWorktree as substrateCreateWorktree,
  listWorktrees as substrateListWorktrees,
  removeWorktree as substrateRemoveWorktree,
  addRemote as substrateAddRemote,
  removeRemote as substrateRemoveRemote,
  listRemotes as substrateListRemotes,
  deleteRemoteBranch as substrateDeleteRemoteBranch,
  fetch as substrateFetch,
  pullFrom as substratePullFrom,
  pushTo as substratePushTo,
  sync as substrateSync,
  getLogRaw as substrateGetLogRaw,
  getLogShortstat as substrateGetLogShortstat,
  getOutgoingCommits as substrateGetOutgoingCommits,
  getIncomingCommits as substrateGetIncomingCommits,
  getRecentMerges as substrateGetRecentMerges,
  getBranchesAtCommit as substrateGetBranchesAtCommit,
  getCommitFiles as substrateGetCommitFiles,
  getDiffFiles as substrateGetDiffFiles,
  getCurrentBranch as substrateGetCurrentBranch,
  getRepoRoot as substrateGetRepoRoot,
  getFileAtRef as substrateGetFileAtRef,
  listTags as substrateListTags,
  checkoutBranch as substrateCheckoutBranch,
  checkoutDetached as substrateCheckoutDetached,
  revert as substrateRevert,
  cherryPick as substrateCherryPick,
} from '@databricks-solutions/lakebase-app-dev-kit';

export interface PullRequestCheck {
  name: string;
  status: string;
  conclusion: string;
  detailsUrl?: string;
}

export interface PullRequestReview {
  author: string;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, PENDING, DISMISSED
  body: string;
  submittedAt?: string;
}

export interface PullRequestFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  ciStatus: 'pending' | 'success' | 'failure' | 'unknown';
  ciConclusion?: string;
  checks: PullRequestCheck[];
  headBranch: string;
  baseBranch: string;
  body?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  reviewDecision?: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface GitFileChange {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  path: string;
  oldPath?: string;
}


export class GitService {
  private _onBranchChanged = new vscode.EventEmitter<string>();
  readonly onBranchChanged = this._onBranchChanged.event;

  private currentBranch: string = '';
  private watcher: vscode.FileSystemWatcher | undefined;
  private pollInterval: NodeJS.Timeout | undefined;

  async initialize(): Promise<void> {
    this.currentBranch = await this.getCurrentBranch();

    // Watch .git/HEAD for branch changes
    const root = getWorkspaceRoot();
    if (root) {
      const headPattern = new vscode.RelativePattern(root, '.git/HEAD');
      this.watcher = vscode.workspace.createFileSystemWatcher(headPattern);
      this.watcher.onDidChange(() => this.checkBranchChange());
      this.watcher.onDidCreate(() => this.checkBranchChange());
    }

    // Poll as a fallback (some git operations don't trigger file watchers)
    this.pollInterval = setInterval(() => this.checkBranchChange(), 5000);
  }

  private async checkBranchChange(): Promise<void> {
    try {
      const branch = await this.getCurrentBranch();
      if (branch !== this.currentBranch && branch) {
        const previous = this.currentBranch;
        this.currentBranch = branch;
        this._onBranchChanged.fire(branch);
      }
    } catch {
      // Git not available or not in a repo
    }
  }

  async getCurrentBranch(): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    return substrateGetCurrentBranch({ cwd: root });
  }

  /**
   * Absolute path of the git repository root (the dir containing `.git` or
   * the parent of a submodule's `.git` file). Differs from the VS Code
   * workspace folder when the project lives in a subdirectory of the repo
   * (e.g. a monorepo). Git file paths (from `diff --name-status`, etc.) are
   * relative to this root, so file URIs must be built from it.
   *
   * Returns the workspace root as a fallback if the CLI call fails.
   */
  async getRepoRoot(): Promise<string> {
    if (this.cachedRepoRoot) { return this.cachedRepoRoot; }
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    const repoRoot = await substrateGetRepoRoot({ cwd: root });
    // Substrate returns "" on non-git cwd; fall back to workspace root
    // (extension's historical behavior - keeps file URIs working when
    // the workspace happens to be a non-git folder).
    this.cachedRepoRoot = repoRoot || root;
    return this.cachedRepoRoot;
  }
  private cachedRepoRoot = '';

  /**
   * Build the candidate parent list passed to substrate ancestry ops.
   * Order matters only for ties: substrate picks the candidate with the
   * most recent merge-base timestamp, but if two candidates tie at
   * 1-second precision the earlier one in the array wins.
   */
  private parentCandidates(): string[] {
    const cfg = getConfig();
    return Array.from(new Set(
      [cfg.trunkBranch, 'main', 'master', cfg.stagingBranch, 'staging'].filter(Boolean) as string[],
    ));
  }

  async listLocalBranches(): Promise<GitBranchInfo[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateListLocalBranches({ cwd: root });
  }

  /** List remote branches (excluding those already checked out locally) */
  async listRemoteBranches(): Promise<GitBranchInfo[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateListRemoteBranches({ cwd: root });
  }

  /** Get file contents at a given git ref (e.g. 'main', a commit sha) */
  async getFileAtRef(ref: string, filePath: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    return substrateGetFileAtRef({ cwd: root, ref, filePath });
  }

  /**
   * Pick the nearest parent of `tip` (default HEAD) across the configured
   * candidate branches (trunkBranch, main, master, stagingBranch, staging).
   * Returns the candidate whose merge-base with the tip has the most recent
   * commit timestamp. In a 3-tier setup where a feature forks from staging,
   * staging's merge-base is later than main's, so the parent resolves to
   * staging.
   *
   * Returns undefined when no candidate branch exists locally.
   */
  async resolveNearestParent(
    tip?: string,
  ): Promise<{ name: string; baseSha: string } | undefined> {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }
    return substrateResolveNearestParent({
      cwd: root,
      tip,
      candidates: this.parentCandidates(),
    });
  }

  /**
   * Resolve just the nearest parent branch NAME (for labels / UI). Returns
   * empty string when no candidate is found.
   */
  async getNearestParentName(tip?: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    return substrateGetNearestParentName({
      cwd: root,
      tip,
      candidates: this.parentCandidates(),
    });
  }

  /**
   * Get the merge-base commit between `tip` (default HEAD) and the nearest
   * parent across configured candidates (trunk, main, master, staging).
   * Falls back to direct merge-base against main/master so legacy
   * two-branch projects still get a useful diff base.
   */
  async getMergeBase(tip?: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    return substrateGetMergeBase({
      cwd: root,
      tip,
      candidates: this.parentCandidates(),
    });
  }

  /**
   * Merge-base against a SPECIFIC candidate (not the auto-discovered
   * nearest). Used when the caller has its own candidate list to rank,
   * e.g. PR base-branch picker enumerating trunk + master + staging +
   * baseBranch with per-candidate merge-base timestamps.
   */
  async getMergeBaseFor(candidate: string, tip?: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    return substrateGetMergeBase({
      cwd: root,
      tip,
      candidates: [candidate],
    });
  }

  async checkoutBranch(branchName: string, create: boolean = false, startPoint?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCheckoutBranch({ cwd: root, branch: branchName, create, startPoint });
  }

  /** Get files changed between current branch and main/master */
  /**
   * List files changed between a branch (default: HEAD / current working tree)
   * and a base branch (default: trunk – `config.trunkBranch` if set, else
   * `main`/`master`).
   *
   * @param branch    Branch to compute changes FOR. Default `HEAD` – include
   *                  uncommitted + untracked files in the working tree. Pass
   *                  an explicit branch name to compute that branch's diff
   *                  against the base, ignoring the working tree.
   * @param baseOverride  Branch to diff AGAINST. Defaults to `config.trunkBranch`
   *                  when set, otherwise `main`/`master`.
   */
  async getChangedFiles(branch?: string, baseOverride?: string): Promise<GitFileChange[]> {
    const root = getWorkspaceRoot();
    if (!root) {
      return [];
    }

    // Resolve base branch:
    //   1. explicit override arg
    //   2. LAKEBASE_BASE_BRANCH (config.baseBranch) – explicit project pin
    //      ("features fork from staging – diff against staging").
    //   3. NEAREST PARENT via merge-base. Across known parent candidates
    //      (config.trunkBranch || main, master, config.stagingBranch ||
    //      staging), pick the one whose merge-base with the tip has the
    //      most recent commit timestamp. In a 3-tier flow where a feature
    //      forks from staging, staging's merge-base is later than main's,
    //      so the diff naturally targets the actual parent.
    //   4. config.trunkBranch
    //   5. main / master
    const cfgGcf = getConfig();
    let baseBranch = baseOverride || cfgGcf.baseBranch || '';
    if (!baseBranch) {
      const tipForMb = branch && branch.length > 0 ? branch : 'HEAD';
      let currentBranchName = '';
      try { currentBranchName = (await exec('git rev-parse --abbrev-ref HEAD', root)).trim(); } catch { /* ignore */ }
      const tipBranch = (branch && branch.length > 0) ? branch : currentBranchName;
      const candidates = Array.from(new Set(
        [cfgGcf.trunkBranch, 'main', 'master', cfgGcf.stagingBranch, 'staging'].filter(Boolean) as string[]
      ));
      let bestTs = 0;
      for (const c of candidates) {
        if (c === tipBranch) { continue; }
        try {
          const baseSha = (await exec(`git merge-base "${tipForMb}" "${c}"`, root)).trim();
          if (!baseSha) { continue; }
          const ts = parseInt((await exec(`git log -1 --format=%at "${baseSha}"`, root)).trim(), 10) || 0;
          if (ts > bestTs) {
            bestTs = ts;
            baseBranch = c;
          }
        } catch { /* candidate not present locally – skip */ }
      }
    }
    if (!baseBranch) {
      baseBranch = cfgGcf.trunkBranch || 'main';
      try {
        await exec(`git rev-parse --verify ${baseBranch}`, root);
      } catch {
        try {
          await exec('git rev-parse --verify master', root);
          baseBranch = 'master';
        } catch {
          return [];
        }
      }
    } else {
      // Verify the chosen base actually exists.
      try {
        await exec(`git rev-parse --verify ${baseBranch}`, root);
      } catch {
        return [];
      }
    }

    // Resolve the "tip" side. HEAD means include untracked + uncommitted files.
    const tip = branch && branch.length > 0 ? branch : 'HEAD';
    const includeUntracked = tip === 'HEAD';

    try {
      // git diff <base>...<tip> == diff between merge-base(base,tip) and tip.
      // Using the triple-dot form lets git resolve the merge-base internally,
      // which works whether tip is HEAD or a named branch.
      const raw = await exec(`git diff --name-status ${baseBranch}...${tip}`, root);

      const statusMap: Record<string, GitFileChange['status']> = {
        'A': 'added', 'M': 'modified', 'D': 'deleted',
      };

      const changes: GitFileChange[] = raw
        ? raw.split('\n').filter(Boolean).map(line => {
            const parts = line.split('\t');
            const code = parts[0][0];
            if (code === 'R') {
              return { status: 'renamed' as const, path: parts[2], oldPath: parts[1] };
            }
            return { status: statusMap[code] || 'modified', path: parts[1] };
          })
        : [];

      // Also include untracked files (new files not yet staged) -- only when
      // looking at the working tree (HEAD). For named-branch diffs, untracked
      // files aren't part of that branch.
      if (includeUntracked) {
        try {
          const untracked = await exec('git ls-files --others --exclude-standard', root);
          if (untracked) {
            const trackedPaths = new Set(changes.map(c => c.path));
            for (const filePath of untracked.split('\n').filter(Boolean)) {
              if (!trackedPaths.has(filePath)) {
                changes.push({ status: 'added', path: filePath });
              }
            }
          }
        } catch {
          // Ignore – untracked listing is optional
        }
      }

      return changes;
    } catch {
      return [];
    }
  }

  /** List migration filenames on a given branch (without checking it out) */
  async listMigrationsOnBranch(branchName: string, migrationPath: string, pattern?: RegExp): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateListMigrationsOnBranch({
      cwd: root,
      branch: branchName,
      migrationPath,
      pattern,
    });
  }

  /** Get currently staged files */
  async getStagedFiles(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) {
      return [];
    }
    try {
      const raw = await exec('git diff --cached --name-only', root);
      return raw ? raw.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /** Get staged files with their change status */
  async getStagedChanges(): Promise<GitFileChange[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('git diff --cached --name-status', root);
      if (!raw) { return []; }
      const statusMap: Record<string, GitFileChange['status']> = {
        'A': 'added', 'M': 'modified', 'D': 'deleted',
      };
      return raw.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        const code = parts[0][0];
        if (code === 'R') {
          return { status: 'renamed' as const, path: parts[2], oldPath: parts[1] };
        }
        return { status: statusMap[code] || 'modified', path: parts[1] };
      });
    } catch {
      return [];
    }
  }

  /** Get unstaged changes (modified/deleted tracked files + untracked files) */
  async getUnstagedChanges(): Promise<GitFileChange[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const changes: GitFileChange[] = [];
      const statusMap: Record<string, GitFileChange['status']> = {
        'M': 'modified', 'D': 'deleted',
      };

      // Modified/deleted tracked files not yet staged
      const raw = await exec('git diff --name-status', root);
      if (raw) {
        for (const line of raw.split('\n').filter(Boolean)) {
          const parts = line.split('\t');
          const code = parts[0][0];
          changes.push({ status: statusMap[code] || 'modified', path: parts[1] });
        }
      }

      // Untracked files
      try {
        const untracked = await exec('git ls-files --others --exclude-standard', root);
        if (untracked) {
          for (const filePath of untracked.split('\n').filter(Boolean)) {
            changes.push({ status: 'added', path: filePath });
          }
        }
      } catch { /* ignore */ }

      return changes;
    } catch {
      return [];
    }
  }

  async stageFile(filePath: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git add "${filePath}"`, root);
  }

  async unstageFile(filePath: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git reset HEAD "${filePath}"`, root);
  }

  async discardFile(filePath: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    // Check if file is untracked
    try {
      await exec(`git ls-files --error-unmatch "${filePath}"`, root);
      // Tracked file – restore from HEAD
      await exec(`git checkout -- "${filePath}"`, root);
    } catch {
      // Untracked file – delete it
      const fs = require('fs');
      const path = require('path');
      const fullPath = path.join(root, filePath);
      if (fs.existsSync(fullPath)) { fs.unlinkSync(fullPath); }
    }
  }

  async commit(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCommit({ cwd: root, message });
  }

  /** Check if current branch has a remote upstream */
  async hasUpstream(): Promise<boolean> {
    const root = getWorkspaceRoot();
    if (!root) { return false; }
    return substrateHasUpstream({ cwd: root });
  }

  /** Get ahead/behind counts relative to upstream */
  async getAheadBehind(): Promise<{ ahead: number; behind: number; upstream: string }> {
    const root = getWorkspaceRoot();
    if (!root) { return { ahead: 0, behind: 0, upstream: '' }; }
    return substrateGetAheadBehind({ cwd: root });
  }

  async push(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substratePush({ cwd: root });
  }

  /** Push local branch to remote for the first time */
  async publishBranch(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substratePublishBranch({ cwd: root });
  }

  async pull(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substratePull({ cwd: root });
  }

  /**
   * Ensure the current branch is pushed to origin before PR creation.
   * Publishes with `-u origin` when no upstream exists; otherwise pushes
   * latest commits. Pair with {@link GitHubService.createPullRequest}:
   * git handles push, GitHubService handles the REST API.
   */
  async pushCurrentBranchForPr(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substratePushCurrentBranchForPr({ cwd: root });
  }

  async commitAll(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCommitAll({ cwd: root, message });
  }

  async commitAmend(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCommitAmend({ cwd: root });
  }

  async commitAmendMessage(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCommitAmend({ cwd: root, message });
  }

  async undoLastCommit(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateUndoLastCommit({ cwd: root });
  }

  /**
   * Wipe ALL working-tree changes (tracked + untracked). The substrate
   * requires confirm: true as a typed safety latch; the extension's UI
   * always prompts the user before invoking this, so we pass it
   * unconditionally here. CLI / agent consumers of the substrate get
   * the safety latch they need.
   */
  async discardAllChanges(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateDiscardAllChanges({ cwd: root, confirm: true });
  }

  /**
   * Delete a local branch. As of FEIP-7326 the substrate refuses to
   * delete production/main/master (throws ProtectedBranchError). This
   * is an intentional behavior tightening; the previous unbounded
   * delete was a footgun. Callers wanting the legacy behavior must
   * make it explicit by reaching the substrate directly with
   * allowProtected: true.
   */
  async deleteBranch(branchName: string, force = false): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateDeleteLocalBranch({ cwd: root, branch: branchName, force });
  }

  /** Check if a branch exists on origin. Returns false when no origin remote or branch is absent. */
  async hasRemoteBranch(branchName: string): Promise<boolean> {
    const root = getWorkspaceRoot();
    if (!root) { return false; }
    return substrateHasRemoteBranch({ cwd: root, branch: branchName });
  }

  /** True when the working tree has staged or unstaged changes. */
  async isDirty(): Promise<boolean> {
    const root = getWorkspaceRoot();
    if (!root) { return false; }
    return substrateIsDirty({ cwd: root });
  }

  async renameBranch(newName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateRenameBranch({ cwd: root, newName });
  }

  async mergeBranch(branchName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateMergeBranch({ cwd: root, branch: branchName });
  }

  async createTag(name: string, message?: string, sha?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCreateTag({ cwd: root, name, message, sha });
  }

  async deleteTag(name: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateDeleteTag({ cwd: root, name });
  }

  async deleteRemoteTag(name: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateDeleteRemoteTag({ cwd: root, name });
  }

  async commitSignedOff(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCommitSignedOff({ cwd: root, message });
  }

  async commitAllSignedOff(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCommitAllSignedOff({ cwd: root, message });
  }

  async stashStaged(message?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateStashStaged({ cwd: root, message });
  }

  async stashIncludeUntracked(message?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateStashIncludeUntracked({ cwd: root, message });
  }

  async stashList(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateStashList({ cwd: root });
  }

  async stashApply(index: number = 0): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateStashApply({ cwd: root, index });
  }

  async stashDrop(index: number = 0): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateStashDrop({ cwd: root, index });
  }

  async stashDropAll(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateStashDropAll({ cwd: root });
  }

  async listTags(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateListTags({ cwd: root });
  }

  async abortRebase(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateAbortRebase({ cwd: root });
  }

  async isRebasing(): Promise<boolean> {
    const root = getWorkspaceRoot();
    if (!root) { return false; }
    return substrateIsRebasing({ cwd: root });
  }

  async rebaseBranch(branchName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateRebaseBranch({ cwd: root, branch: branchName });
  }

  async deleteRemoteBranch(branchName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateDeleteRemoteBranch({ cwd: root, branch: branchName });
  }

  async addRemote(name: string, url: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateAddRemote({ cwd: root, name, url });
  }

  async removeRemote(name: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateRemoveRemote({ cwd: root, name });
  }

  async createWorktree(path: string, branchName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCreateWorktree({ cwd: root, path, branch: branchName });
  }

  async listWorktrees(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateListWorktrees({ cwd: root });
  }

  async removeWorktree(path: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateRemoveWorktree({ cwd: root, path });
  }

  async fetch(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateFetch({ cwd: root });
  }

  async fetchPrune(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateFetch({ cwd: root, prune: true });
  }

  async fetchAll(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateFetch({ cwd: root, all: true });
  }

  async revert(sha: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateRevert({ cwd: root, sha });
  }

  async cherryPick(sha: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCherryPick({ cwd: root, sha });
  }

  async checkoutDetached(sha: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateCheckoutDetached({ cwd: root, sha });
  }

  async getBranchesAtCommit(sha: string): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateGetBranchesAtCommit({ cwd: root, sha });
  }

  async getCommitFiles(sha: string): Promise<Array<{ status: string; path: string }>> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateGetCommitFiles({ cwd: root, sha });
  }

  /**
   * Get diff files between two refs, or between a ref and the working tree.
   * @param fromRef - The base ref (e.g. a commit SHA)
   * @param toRef - The target ref (e.g. "HEAD"), or null for working tree
   */
  async getDiffFiles(fromRef: string, toRef: string | null): Promise<Array<{ status: string; path: string }>> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateGetDiffFiles({ cwd: root, fromRef, toRef });
  }

  /**
   * Get the normalized GitHub HTTPS URL for the origin remote.
   * Handles HTTPS, git@, and ssh:// formats. Returns empty string if not GitHub.
   */
  async getGitHubUrl(cwd?: string): Promise<string> {
    const root = cwd || getWorkspaceRoot();
    if (!root) { return ''; }
    return substrateGetGitHubUrl(root);
  }

  /**
   * owner/repo slug for the origin remote, or empty string if not GitHub.
   * Used by {@link GitHubService} to scope Octokit API requests.
   * @param cwd - Optional repo root (defaults to workspace root)
   */
  async getOwnerRepo(cwd?: string): Promise<string> {
    const root = cwd || getWorkspaceRoot();
    if (!root) { return ''; }
    return substrateGetOwnerRepo(root);
  }

  /**
   * Get commit log with custom format. Returns raw output string.
   */
  async getLogRaw(format: string, limit: number, refArgs: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    return substrateGetLogRaw({ cwd: root, format, limit, refArgs });
  }

  /**
   * Get shortstat log. Returns raw output string.
   */
  async getLogShortstat(format: string, limit: number, refArgs: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    return substrateGetLogShortstat({ cwd: root, format, limit, refArgs });
  }

  /**
   * Get outgoing commits (local commits not on upstream).
   */
  async getOutgoingCommits(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateGetOutgoingCommits({ cwd: root });
  }

  /**
   * Get incoming commits (upstream commits not yet pulled).
   */
  async getIncomingCommits(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateGetIncomingCommits({ cwd: root });
  }

  async getRecentMerges(limit = 5): Promise<Array<{ sha: string; message: string }>> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateGetRecentMerges({ cwd: root, limit });
  }

  async pullRebase(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substratePullRebase({ cwd: root });
  }

  async pullFrom(remote: string, branch: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substratePullFrom({ cwd: root, remote, branch });
  }

  async pushTo(remote: string, branch: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substratePushTo({ cwd: root, remote, branch });
  }

  async listRemotes(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    return substrateListRemotes({ cwd: root });
  }

  async stash(message?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateStash({ cwd: root, message });
  }

  async stashPop(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateStashPop({ cwd: root });
  }

  /** Pull then push */
  async sync(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await substrateSync({ cwd: root });
  }

  /**
   * Clone a GitHub repository into a parent directory.
   * @param repoUrl - The repo URL (e.g. "https://github.com/owner/repo")
   * @param parentDir - Directory that will contain the cloned repo folder
   */
  async cloneRepo(repoUrl: string, parentDir: string): Promise<void> {
    return substrateCloneRepo({ repoUrl, parentDir });
  }

  getCachedBranch(): string {
    return this.currentBranch;
  }

  dispose(): void {
    this.watcher?.dispose();
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this._onBranchChanged.dispose();
  }
}
