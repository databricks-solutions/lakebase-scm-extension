import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getConfig, getWorkspaceRoot } from '../utils/config';
import { exec } from '../utils/exec';

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


/** Safe execution using spawn with shell — arguments passed as array, not interpolated into command string */
function execArgs(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(file, args, { cwd, timeout: 60000, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(stderr.trim() || `Process exited with code ${code}`)); return; }
      resolve(stdout.trim());
    });
    child.on('error', (err) => { reject(new Error(stderr.trim() || err.message)); });
  });
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
    if (!root) {
      return '';
    }
    try {
      return await exec('git rev-parse --abbrev-ref HEAD', root);
    } catch {
      return '';
    }
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
    if (this.cachedRepoRoot) {
      return this.cachedRepoRoot;
    }
    const root = getWorkspaceRoot();
    if (!root) {
      return '';
    }
    try {
      const out = await exec('git rev-parse --show-toplevel', root);
      this.cachedRepoRoot = out.trim();
      return this.cachedRepoRoot;
    } catch {
      return root;
    }
  }
  private cachedRepoRoot = '';

  async listLocalBranches(): Promise<GitBranchInfo[]> {
    const root = getWorkspaceRoot();
    if (!root) {
      return [];
    }

    const current = await this.getCurrentBranch();
    const raw = await exec('git branch --format="%(refname:short)|%(upstream:short)|%(upstream:track)"', root);

    if (!raw) {
      return [];
    }

    return raw.split('\n').filter(Boolean).map(line => {
      const [name, tracking, trackInfo] = line.split('|');
      let ahead = 0;
      let behind = 0;

      if (trackInfo) {
        const aheadMatch = trackInfo.match(/ahead (\d+)/);
        const behindMatch = trackInfo.match(/behind (\d+)/);
        if (aheadMatch) {ahead = parseInt(aheadMatch[1], 10);}
        if (behindMatch) {behind = parseInt(behindMatch[1], 10);}
      }

      return {
        name,
        isCurrent: name === current,
        isRemote: false,
        tracking: tracking || undefined,
        ahead,
        behind,
      };
    });
  }

  /** List remote branches (excluding those already checked out locally) */
  async listRemoteBranches(): Promise<GitBranchInfo[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }

    try {
      const localBranches = await this.listLocalBranches();
      const localNames = new Set(localBranches.map(b => b.name));

      const raw = await exec('git branch -r --format="%(refname:short)"', root);
      if (!raw) { return []; }

      return raw.split('\n').filter(Boolean)
        .filter(name => !name.includes('HEAD'))
        .map(name => {
          // Remote branch names are like "origin/feature-x"
          const shortName = name.replace(/^origin\//, '');
          return { name, shortName };
        })
        .filter(({ shortName }) => !localNames.has(shortName))
        .map(({ name, shortName }) => ({
          name: shortName,
          isCurrent: false,
          isRemote: true,
          tracking: name,
        }));
    } catch {
      return [];
    }
  }

  /** Get file contents at a given git ref (e.g. 'main', a commit sha) */
  async getFileAtRef(ref: string, filePath: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    try {
      return await exec(`git show "${ref}:${filePath}"`, root);
    } catch {
      return ''; // File doesn't exist at that ref (new file)
    }
  }

  /** Get the merge-base commit between HEAD and main/master */
  async getMergeBase(): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    let baseBranch = 'main';
    try {
      await exec('git rev-parse --verify main', root);
    } catch {
      try {
        await exec('git rev-parse --verify master', root);
        baseBranch = 'master';
      } catch {
        return '';
      }
    }
    try {
      return await exec(`git merge-base ${baseBranch} HEAD`, root);
    } catch {
      return '';
    }
  }

  async checkoutBranch(branchName: string, create: boolean = false, startPoint?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) {
      throw new Error('No workspace root');
    }
    const flag = create ? '-b ' : '';
    const sp = startPoint ? ` "${startPoint}"` : '';
    await exec(`git checkout ${flag}"${branchName}"${sp}`, root);
  }

  /** Get files changed between current branch and main/master */
  /**
   * List files changed between a branch (default: HEAD / current working tree)
   * and a base branch (default: trunk — `config.trunkBranch` if set, else
   * `main`/`master`).
   *
   * @param branch    Branch to compute changes FOR. Default `HEAD` — include
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
    //   2. LAKEBASE_BASE_BRANCH (config.baseBranch) — explicit project pin
    //      ("features fork from staging — diff against staging").
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
        } catch { /* candidate not present locally — skip */ }
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
          // Ignore — untracked listing is optional
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
    if (!root) {
      return [];
    }
    const filePattern = pattern || /^V\d+.*\.sql$/i;
    try {
      const raw = await exec(
        `git ls-tree --name-only "${branchName}" -- "${migrationPath}/"`,
        root
      );
      if (!raw) {
        return [];
      }
      return raw.split('\n')
        .map(f => f.split('/').pop() || f)
        .filter(f => filePattern.test(f))
        .sort();
    } catch {
      return [];
    }
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
      // Tracked file — restore from HEAD
      await exec(`git checkout -- "${filePath}"`, root);
    } catch {
      // Untracked file — delete it
      const fs = require('fs');
      const path = require('path');
      const fullPath = path.join(root, filePath);
      if (fs.existsSync(fullPath)) { fs.unlinkSync(fullPath); }
    }
  }

  async commit(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    if (!message.trim()) { throw new Error('Commit message is required'); }
    await exec(`git commit -m "${message.replace(/"/g, '\\"')}"`, root);
  }

  /** Check if current branch has a remote upstream */
  async hasUpstream(): Promise<boolean> {
    const root = getWorkspaceRoot();
    if (!root) { return false; }
    try {
      await exec('git rev-parse --abbrev-ref @{u}', root);
      return true;
    } catch {
      return false;
    }
  }

  /** Get ahead/behind counts relative to upstream */
  async getAheadBehind(): Promise<{ ahead: number; behind: number; upstream: string }> {
    const root = getWorkspaceRoot();
    if (!root) { return { ahead: 0, behind: 0, upstream: '' }; }
    try {
      const upstream = (await exec('git rev-parse --abbrev-ref @{u}', root)).trim();
      const raw = await exec(`git rev-list --left-right --count HEAD...@{u}`, root);
      const parts = raw.trim().split(/\s+/);
      return {
        ahead: parseInt(parts[0], 10) || 0,
        behind: parseInt(parts[1], 10) || 0,
        upstream,
      };
    } catch {
      return { ahead: 0, behind: 0, upstream: '' };
    }
  }

  async push(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git push', root);
  }

  /** Push local branch to remote for the first time */
  async publishBranch(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    const branch = await this.getCurrentBranch();
    if (!branch) { throw new Error('No current branch'); }
    await exec(`git push -u origin "${branch}"`, root);
  }

  async pull(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git pull', root);
  }

  /** Create a pull request via gh CLI. Returns the PR URL. */
  async createPullRequest(title: string, body: string, baseBranch?: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    const branch = await this.getCurrentBranch();
    if (!branch) { throw new Error('No current branch'); }

    // Ensure branch is pushed to remote
    const hasRemote = await this.hasUpstream();
    if (!hasRemote) {
      await exec(`git push -u origin "${branch}"`, root);
    } else {
      // Push latest commits even if upstream exists
      await exec('git push', root);
    }

    // Use --head flag to explicitly specify the branch, and --body-file for safe body passing.
    // --base is honored when provided — otherwise gh defaults to the repo's default branch,
    // which silently ignores 3-tier (feature → staging → main) flows.
    const result = await new Promise<string>((resolve, reject) => {
      const escapedTitle = title.replace(/"/g, '\\"');
      const baseFlag = baseBranch ? ` --base "${baseBranch}"` : '';
      const child = cp.exec(
        `gh pr create --title "${escapedTitle}" --head "${branch}"${baseFlag} --body-file -`,
        { cwd: root, timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) { reject(new Error(stderr || err.message)); }
          else { resolve(stdout); }
        }
      );
      child.stdin?.write(body);
      child.stdin?.end();
    });
    // gh pr create outputs the PR URL
    const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+/);
    return urlMatch ? urlMatch[0] : result.trim();
  }

  async commitAll(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    if (!message.trim()) { throw new Error('Commit message is required'); }
    await exec('git add -A', root);
    await exec(`git commit -m "${message.replace(/"/g, '\\"')}"`, root);
  }

  async commitAmend(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git commit --amend --no-edit', root);
  }

  async commitAmendMessage(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    if (!message.trim()) { throw new Error('Commit message is required'); }
    await exec(`git commit --amend -m "${message.replace(/"/g, '\\"')}"`, root);
  }

  async undoLastCommit(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git reset --soft HEAD~1', root);
  }

  async discardAllChanges(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git checkout -- .', root);
    await exec('git clean -fd', root);
  }

  async deleteBranch(branchName: string, force = false): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    const flag = force ? '-D' : '-d';
    await exec(`git branch ${flag} "${branchName}"`, root);
  }

  /** Check if a branch exists on origin. Returns false when no origin remote or branch is absent. */
  async hasRemoteBranch(branchName: string): Promise<boolean> {
    const root = getWorkspaceRoot();
    if (!root) { return false; }
    try {
      const out = await exec(`git ls-remote --heads origin "${branchName}"`, root);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** True when the working tree has staged or unstaged changes. */
  async isDirty(): Promise<boolean> {
    const root = getWorkspaceRoot();
    if (!root) { return false; }
    try {
      const out = await exec('git status --porcelain', root);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  async renameBranch(newName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git branch -m "${newName}"`, root);
  }

  async mergeBranch(branchName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git merge "${branchName}"`, root);
  }

  async createTag(name: string, message?: string, sha?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    const msg = message ? ` -m "${message.replace(/"/g, '\\"')}"` : '';
    const target = sha ? ` "${sha}"` : '';
    await exec(`git tag${msg ? ' -a' : ''} "${name}"${msg}${target}`, root);
  }

  async deleteTag(name: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git tag -d "${name}"`, root);
  }

  async deleteRemoteTag(name: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git push origin --delete "refs/tags/${name}"`, root);
  }

  async commitSignedOff(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    if (!message.trim()) { throw new Error('Commit message is required'); }
    await exec(`git commit -s -m "${message.replace(/"/g, '\\"')}"`, root);
  }

  async commitAllSignedOff(message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    if (!message.trim()) { throw new Error('Commit message is required'); }
    await exec('git add -A', root);
    await exec(`git commit -s -m "${message.replace(/"/g, '\\"')}"`, root);
  }

  async stashStaged(message?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    const msg = message ? ` -m "${message.replace(/"/g, '\\"')}"` : '';
    await exec(`git stash push --staged${msg}`, root);
  }

  async stashIncludeUntracked(message?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    const msg = message ? ` -m "${message.replace(/"/g, '\\"')}"` : '';
    await exec(`git stash push --include-untracked${msg}`, root);
  }

  async stashList(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('git stash list', root);
      return raw ? raw.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async stashApply(index: number = 0): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git stash apply stash@{${index}}`, root);
  }

  async stashDrop(index: number = 0): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git stash drop stash@{${index}}`, root);
  }

  async stashDropAll(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git stash clear', root);
  }

  async listTags(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('git tag -l', root);
      return raw ? raw.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async abortRebase(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git rebase --abort', root);
  }

  async isRebasing(): Promise<boolean> {
    const root = getWorkspaceRoot();
    if (!root) { return false; }
    const fs = require('fs');
    const path = require('path');
    return fs.existsSync(path.join(root, '.git/rebase-merge')) ||
           fs.existsSync(path.join(root, '.git/rebase-apply'));
  }

  async rebaseBranch(branchName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git rebase "${branchName}"`, root);
  }

  async deleteRemoteBranch(branchName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git push origin --delete "${branchName}"`, root);
  }

  async addRemote(name: string, url: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git remote add "${name}" "${url}"`, root);
  }

  async removeRemote(name: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git remote remove "${name}"`, root);
  }

  async createWorktree(path: string, branchName: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git worktree add "${path}" -b "${branchName}"`, root);
  }

  async listWorktrees(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('git worktree list', root);
      return raw ? raw.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async removeWorktree(path: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git worktree remove "${path}"`, root);
  }

  async fetch(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git fetch', root);
  }

  async fetchPrune(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git fetch --prune', root);
  }

  async fetchAll(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git fetch --all', root);
  }

  async revert(sha: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    // Detect merge commits and automatically use -m 1 (revert relative to first parent)
    const parents = (await exec(`git rev-parse "${sha}^@"`, root)).trim().split('\n').filter(Boolean);
    const mFlag = parents.length > 1 ? ' -m 1' : '';
    await exec(`git revert --no-edit${mFlag} "${sha}"`, root);
  }

  async cherryPick(sha: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git cherry-pick "${sha}"`, root);
  }

  async checkoutDetached(sha: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git checkout --detach "${sha}"`, root);
  }

  async getBranchesAtCommit(sha: string): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec(`git branch -a --points-at "${sha}" --format="%(refname:short)"`, root);
      return raw.trim().split('\n').filter(Boolean).filter(b => !b.includes('HEAD') && b !== 'origin');
    } catch { return []; }
  }

  async getCommitFiles(sha: string): Promise<Array<{ status: string; path: string }>> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    let raw = await exec(`git diff-tree --no-commit-id --name-status -r "${sha}"`, root);
    // Merge commits: diff-tree returns empty, diff against first parent
    if (!raw.trim()) {
      try { raw = await exec(`git diff --name-status "${sha}^1" "${sha}"`, root); } catch { return []; }
    }
    return raw.split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      return { status: parts[0][0], path: parts[parts.length - 1] };
    });
  }

  /**
   * Get diff files between two refs, or between a ref and the working tree.
   * @param fromRef - The base ref (e.g. a commit SHA)
   * @param toRef - The target ref (e.g. "HEAD"), or null for working tree
   */
  async getDiffFiles(fromRef: string, toRef: string | null): Promise<Array<{ status: string; path: string }>> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const cmd = toRef
        ? `git diff --name-status "${fromRef}" "${toRef}"`
        : `git diff --name-status "${fromRef}"`;
      const raw = await exec(cmd, root);
      return raw.split('\n').filter(Boolean).map(line => {
        const parts = line.split('\t');
        return { status: parts[0][0], path: parts[parts.length - 1] };
      });
    } catch { return []; }
  }

  /**
   * Get the normalized GitHub HTTPS URL for the origin remote.
   * Handles HTTPS, git@, and ssh:// formats. Returns empty string if not GitHub.
   */
  async getGitHubUrl(): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    try {
      const url = (await exec('git remote get-url origin', root)).trim();
      return url
        .replace(/\.git$/, '')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
    } catch { return ''; }
  }

  /**
   * Get commit log with custom format. Returns raw output string.
   */
  async getLogRaw(format: string, limit: number, refArgs: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    try {
      return await exec(`git log --date-order --format="${format}" -${limit}${refArgs}`, root);
    } catch { return ''; }
  }

  /**
   * Get shortstat log. Returns raw output string.
   */
  async getLogShortstat(format: string, limit: number, refArgs: string): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { return ''; }
    try {
      return await exec(`git log --date-order --format="${format}" --shortstat -${limit}${refArgs}`, root);
    } catch { return ''; }
  }

  /**
   * Get outgoing commits (local commits not on upstream).
   */
  async getOutgoingCommits(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('git log --oneline @{u}..HEAD', root);
      return raw.split('\n').filter(Boolean).map(l => l.split(' ')[0]);
    } catch { return []; }
  }

  /**
   * Get incoming commits (upstream commits not yet pulled).
   */
  async getIncomingCommits(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('git log --oneline HEAD..@{u}', root);
      return raw.split('\n').filter(Boolean).map(l => l.split(' ')[0]);
    } catch { return []; }
  }

  async getRecentMerges(limit = 5): Promise<Array<{ sha: string; message: string }>> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec(`git log --merges --oneline -${limit}`, root);
      return raw.split('\n').filter(Boolean).map(line => {
        const sp = line.indexOf(' ');
        return { sha: line.substring(0, sp), message: line.substring(sp + 1) };
      });
    } catch { return []; }
  }

  async pullRebase(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git pull --rebase', root);
  }

  async pullFrom(remote: string, branch: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git pull "${remote}" "${branch}"`, root);
  }

  async pushTo(remote: string, branch: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec(`git push "${remote}" "${branch}"`, root);
  }

  async listRemotes(): Promise<string[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('git remote', root);
      return raw ? raw.split('\n').filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  async stash(message?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    const msg = message ? ` -m "${message.replace(/"/g, '\\"')}"` : '';
    await exec(`git stash push${msg}`, root);
  }

  async stashPop(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git stash pop', root);
  }

  /** Pull then push */
  async sync(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    await exec('git pull', root);
    await exec('git push', root);
  }

  /** Get PR info for the current branch via gh CLI */
  async getPullRequest(): Promise<PullRequestInfo | undefined> {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }
    try {
      const raw = await exec(
        'gh pr view --json number,title,url,state,isDraft,headRefName,baseRefName,body,statusCheckRollup,additions,deletions,changedFiles,reviewDecision',
        root
      );
      const pr = JSON.parse(raw);

      // Only return open PRs
      if (pr.state && pr.state !== 'OPEN') { return undefined; }

      // Parse CI status and individual checks from statusCheckRollup.
      // GitHub returns ALL check runs (including retries), so we must deduplicate
      // by check name and only consider the LATEST run for each.
      let ciStatus: PullRequestInfo['ciStatus'] = 'unknown';
      const rawChecks = pr.statusCheckRollup || [];
      const parsedChecks: PullRequestCheck[] = rawChecks.map((c: any) => ({
        name: c.name || c.context || 'unknown',
        status: (c.status || '').toUpperCase(),
        conclusion: (c.conclusion || '').toUpperCase(),
        detailsUrl: c.detailsUrl || c.targetUrl || undefined,
      }));

      if (rawChecks.length === 0) {
        ciStatus = 'pending';
      } else {
        // Deduplicate: keep only the latest check per name (last in the array = most recent)
        const latestByName = new Map<string, any>();
        for (const c of rawChecks) {
          const name = c.name || c.context || 'unknown';
          latestByName.set(name, c);
        }
        const latestChecks = Array.from(latestByName.values());
        const states = latestChecks.map((c: any) => (c.conclusion || c.status || '').toUpperCase());
        if (states.some((s: string) => s === 'FAILURE' || s === 'ERROR' || s === 'ACTION_REQUIRED')) {
          ciStatus = 'failure';
        } else if (states.every((s: string) => s === 'SUCCESS' || s === 'NEUTRAL' || s === 'SKIPPED')) {
          ciStatus = 'success';
        } else {
          ciStatus = 'pending';
        }
      }

      return {
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        isDraft: pr.isDraft || false,
        ciStatus,
        checks: parsedChecks,
        headBranch: pr.headRefName,
        baseBranch: pr.baseRefName,
        body: pr.body,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        reviewDecision: pr.reviewDecision,
      };
    } catch {
      return undefined;
    }
  }

  /** Get PR reviews (approvals, change requests, comments) */
  async getPullRequestReviews(): Promise<PullRequestReview[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('gh pr view --json reviews', root);
      const data = JSON.parse(raw);
      return (data.reviews || []).map((r: any) => ({
        author: r.author?.login || 'unknown',
        state: r.state || 'COMMENTED',
        body: r.body || '',
        submittedAt: r.submittedAt,
      }));
    } catch {
      return [];
    }
  }

  /** Get PR changed files */
  async getPullRequestFiles(): Promise<PullRequestFile[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('gh pr view --json files', root);
      const data = JSON.parse(raw);
      return (data.files || []).map((f: any) => {
        const statusMap: Record<string, PullRequestFile['status']> = {
          added: 'added', removed: 'deleted', modified: 'modified', renamed: 'renamed',
        };
        return {
          path: f.path || '',
          status: statusMap[(f.status || '').toLowerCase()] || 'modified',
          additions: f.additions || 0,
          deletions: f.deletions || 0,
        };
      });
    } catch {
      return [];
    }
  }

  /** Get PR comments (for finding CI schema diff comment) */
  async getPullRequestComments(): Promise<Array<{ author: string; body: string }>> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }
    try {
      const raw = await exec('gh pr view --json comments', root);
      const data = JSON.parse(raw);
      return (data.comments || []).map((c: any) => ({
        author: c.author?.login || 'unknown',
        body: c.body || '',
      }));
    } catch {
      return [];
    }
  }

  /** Merge the current branch's PR via gh CLI. Returns the merge URL. */
  async mergePullRequest(method: 'merge' | 'squash' | 'rebase' = 'merge', deleteRemoteBranch: boolean = true): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error('No workspace root'); }
    const deleteFlag = deleteRemoteBranch ? ' --delete-branch' : '';
    const result = await exec(`gh pr merge --${method}${deleteFlag}`, root);
    return result.trim();
  }

  /**
   * Create a new GitHub repository via gh CLI.
   * @param name - Repo name (e.g. "my-app") or "owner/my-app"
   * @param opts - Options: private (default true), clone (default false), description
   * @returns The created repo URL
   */
  async createRepo(name: string, opts?: { private?: boolean; clone?: boolean; description?: string; parentDir?: string }): Promise<string> {
    const visibility = opts?.private !== false ? '--private' : '--public';
    const cloneFlag = opts?.clone ? ' --clone' : '';
    const descFlag = opts?.description ? ` --description "${opts.description.replace(/"/g, '\\"')}"` : '';
    const cwd = opts?.parentDir || getWorkspaceRoot() || undefined;
    const result = await exec(`gh repo create "${name}" ${visibility}${cloneFlag}${descFlag}`, cwd);
    return result.trim();
  }

  /**
   * Delete a GitHub repository via gh CLI. Requires delete_repo scope.
   * @param name - Full repo name (e.g. "owner/my-app")
   */
  async deleteRepo(name: string): Promise<void> {
    await exec(`gh repo delete "${name}" --yes`);
  }

  /**
   * Set a GitHub Actions secret on a repository.
   * @param repoName - Full repo name (e.g. "owner/my-app")
   * @param secretName - Secret name (e.g. "DATABRICKS_TOKEN")
   * @param secretValue - Secret value
   */
  async setRepoSecret(repoName: string, secretName: string, secretValue: string): Promise<void> {
    const root = getWorkspaceRoot() || undefined;
    await exec(`echo "${secretValue.replace(/"/g, '\\"')}" | gh secret set "${secretName}" --repo "${repoName}"`, root);
  }

  /**
   * Check if a GitHub repository exists.
   * @param name - Full repo name (e.g. "owner/my-app")
   */
  async repoExists(name: string): Promise<boolean> {
    try {
      await exec(`gh repo view "${name}" --json name`);
      return true;
    } catch {
      return false;
    }
  }

  /** Get the currently authenticated GitHub username via gh CLI. */
  async getCurrentGitHubUser(): Promise<string> {
    const result = await exec('gh api user --jq ".login"');
    return result.trim();
  }

  /**
   * Clone a GitHub repository into a parent directory.
   * @param repoUrl - The repo URL (e.g. "https://github.com/owner/repo")
   * @param parentDir - The directory to clone into
   */
  async cloneRepo(repoUrl: string, parentDir: string): Promise<void> {
    await exec(`git clone "${repoUrl}"`, parentDir);
  }

  /**
   * List GitHub Actions secrets for the current repository.
   * @param cwd - Optional working directory (defaults to workspace root)
   */
  async listSecrets(cwd?: string): Promise<string> {
    const root = cwd || getWorkspaceRoot() || undefined;
    const result = await exec('gh secret list', root);
    return result.trim();
  }

  /**
   * Generic GitHub API call via gh CLI.
   * @param endpoint - API endpoint (e.g. "repos/{owner}/{repo}/actions/runs")
   * @param method - Optional HTTP method (e.g. "POST", "DELETE")
   * @param jqFilter - Optional jq filter (e.g. ".[].name")
   * @returns Raw response string
   */
  async ghApi(endpoint: string, method?: string, jqFilter?: string): Promise<string> {
    const methodFlag = method ? `-X ${method} ` : '';
    const jqFlag = jqFilter ? ` --jq '${jqFilter}'` : '';
    const result = await exec(`gh api ${methodFlag}"${endpoint}"${jqFlag}`);
    return result.trim();
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
