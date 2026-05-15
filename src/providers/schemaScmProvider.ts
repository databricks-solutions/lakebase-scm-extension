import * as vscode from 'vscode';
import { GitService, GitFileChange, PullRequestInfo } from '../services/gitService';
import { SchemaMigrationService } from '../services/schemaMigrationService';
import { SchemaDiffService, SchemaDiffResult } from '../services/schemaDiffService';
import { LakebaseService } from '../services/lakebaseService';
import { isMainBranch } from '../utils/theme';
import { getConfig, getWorkspaceRoot } from '../utils/config';

/**
 * Content provider that resolves file contents at the merge-base with main.
 */
class GitBaseContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private gitService: GitService) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const filePath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
    const ref = await this.gitService.getMergeBase();
    if (!ref) { return ''; }
    return this.gitService.getFileAtRef(ref, filePath);
  }
}

/**
 * Unified SCM provider: Staged, Code, and Lakebase groups.
 * Full git workflow (stage/unstage/commit/push/pull) + schema diff.
 */
export class SchemaScmProvider {
  private scm: vscode.SourceControl | undefined;
  private stagedGroup: vscode.SourceControlResourceGroup | undefined;
  private codeGroup: vscode.SourceControlResourceGroup | undefined;
  private lakebaseGroup: vscode.SourceControlResourceGroup | undefined;

  private syncGroup: vscode.SourceControlResourceGroup | undefined;
  private migrationsGroup: vscode.SourceControlResourceGroup | undefined;
  private mergesGroup: vscode.SourceControlResourceGroup | undefined;
  private prGroup: vscode.SourceControlResourceGroup | undefined;
  private prPollTimer: NodeJS.Timeout | undefined;
  private lastPrInfo: PullRequestInfo | undefined;

  private _onDidRefresh = new vscode.EventEmitter<void>();
  readonly onDidRefresh: vscode.Event<void> = this._onDidRefresh.event;

  private gitService: GitService;
  private migrationService: SchemaMigrationService;
  private schemaDiffService: SchemaDiffService;
  private lakebaseService: LakebaseService;
  private baseContentProvider: vscode.Disposable;
  private migrationWatcher: vscode.Disposable | undefined;
  private commitWatcher: vscode.FileSystemWatcher | undefined;
  private gitIndexWatcher: vscode.FileSystemWatcher | undefined;
  private configWatcher: vscode.Disposable;
  private codeRefreshTimer: NodeJS.Timeout | undefined;
  private lastMigrationFiles: string[] = [];
  private schemaDiffInFlight = false;

  constructor(
    gitService: GitService,
    migrationService: SchemaMigrationService,
    schemaDiffService: SchemaDiffService,
    lakebaseService?: LakebaseService
  ) {
    this.gitService = gitService;
    this.migrationService = migrationService;
    this.schemaDiffService = schemaDiffService;
    this.lakebaseService = lakebaseService!;

    this.baseContentProvider = vscode.workspace.registerTextDocumentContentProvider(
      'lakebase-git-base',
      new GitBaseContentProvider(gitService)
    );

    this.lastMigrationFiles = this.migrationService.listMigrations().map(m => m.filename);
    this.migrationWatcher = this.migrationService.watchMigrations(() => this.onMigrationChange());

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      const commitPattern = new vscode.RelativePattern(root, '.git/COMMIT_EDITMSG');
      this.commitWatcher = vscode.workspace.createFileSystemWatcher(commitPattern);
      this.commitWatcher.onDidCreate(() => this.onCommitDetected());
      this.commitWatcher.onDidChange(() => this.onCommitDetected());

      const indexPattern = new vscode.RelativePattern(root, '.git/index');
      this.gitIndexWatcher = vscode.workspace.createFileSystemWatcher(indexPattern);
      this.gitIndexWatcher.onDidChange(() => this.debouncedCodeRefresh());
    }

    vscode.workspace.onDidSaveTextDocument(() => this.debouncedCodeRefresh());
    this.gitService.onBranchChanged(() => this.refresh());

    this.configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('lakebaseSync.showUnifiedRepo')) {
        if (getConfig().showUnifiedRepo) {
          this.createScm();
          this.refresh();
        } else {
          this.destroyScm();
        }
      }
    });

    if (getConfig().showUnifiedRepo) {
      this.createScm();
      this.refresh();
    }
  }

  private createScm(): void {
    if (this.scm) { return; }
    const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    this.scm = vscode.scm.createSourceControl('lakebaseUnified', 'Git + Lakebase', rootUri);
    this.scm.inputBox.placeholder = 'Commit message';
    this.scm.inputBox.visible = true;
    (this.scm as any).acceptInputCommand = {
      command: 'lakebaseSync.commit',
      title: 'Commit',
    };

    this.syncGroup = this.scm.createResourceGroup('sync', 'Sync Changes');
    this.syncGroup.hideWhenEmpty = true;

    this.stagedGroup = this.scm.createResourceGroup('staged', 'Staged');
    this.stagedGroup.hideWhenEmpty = true;

    this.codeGroup = this.scm.createResourceGroup('code', 'Code');
    this.codeGroup.hideWhenEmpty = false;

    this.lakebaseGroup = this.scm.createResourceGroup('lakebase', 'Lakebase');
    this.lakebaseGroup.hideWhenEmpty = false;

    this.migrationsGroup = this.scm.createResourceGroup('migrations', 'Schema Migrations');
    this.migrationsGroup.hideWhenEmpty = true;

    this.mergesGroup = this.scm.createResourceGroup('merges', 'Recent Merges');
    this.mergesGroup.hideWhenEmpty = true;

    this.prGroup = this.scm.createResourceGroup('pr', 'Pull Request');
    this.prGroup.hideWhenEmpty = true;
  }

  private destroyScm(): void {
    if (this.prPollTimer) { clearInterval(this.prPollTimer); this.prPollTimer = undefined; }
    this.syncGroup?.dispose();
    this.stagedGroup?.dispose();
    this.codeGroup?.dispose();
    this.lakebaseGroup?.dispose();
    this.migrationsGroup?.dispose();
    this.mergesGroup?.dispose();
    this.prGroup?.dispose();
    this.scm?.dispose();
    this.syncGroup = undefined;
    this.stagedGroup = undefined;
    this.codeGroup = undefined;
    this.lakebaseGroup = undefined;
    this.migrationsGroup = undefined;
    this.mergesGroup = undefined;
    this.prGroup = undefined;
    this.scm = undefined;
  }

  async refresh(): Promise<void> {
    if (!this.scm) { return; }

    const currentBranch = this.gitService.getCachedBranch() || await this.gitService.getCurrentBranch();
    const isMain = isMainBranch(currentBranch, getConfig().trunkBranch);

    if (!currentBranch) {
      this.clearGroups();
      return;
    }

    if (isMain) {
      await this.refreshMainBranch(currentBranch);
      return;
    }

    const root = getWorkspaceRoot();

    // Clear main-only groups when on a feature branch
    this.migrationsGroup!.resourceStates = [];
    this.mergesGroup!.resourceStates = [];

    // --- Staged files (git index) ---
    try {
      const staged = await this.gitService.getStagedChanges();
      this.stagedGroup!.resourceStates = staged.map(f => this.makeStagedResource(f, root));
    } catch {
      this.stagedGroup!.resourceStates = [];
    }

    // --- Code: unstaged working tree changes only (matches Git SCM CHANGES) ---
    try {
      const unstaged = await this.gitService.getUnstagedChanges();
      this.codeGroup!.resourceStates = unstaged.map(f => this.makeChangeResource(f, root));
    } catch {
      this.codeGroup!.resourceStates = [];
    }

    // --- Lakebase: live DB schema diff vs production ---
    // Sourced from schemaDiffService cache. On cache miss, fire a background
    // compare (guarded) and re-refresh when it completes. This surfaces any
    // drift — committed migrations not yet applied, ad-hoc ALTERs, etc. — not
    // just uncommitted migration files.
    this.lakebaseGroup!.resourceStates = this.buildSchemaItemsFromDiff();

    this.scm.count = this.stagedGroup!.resourceStates.length +
      this.codeGroup!.resourceStates.length +
      this.lakebaseGroup!.resourceStates.length;

    this.updateBranchStatusBar(currentBranch);

    // --- PR status ---
    this.refreshPrStatus();

    this._onDidRefresh.fire();
  }

  /** Update the SCM status bar with the current branch name and dirty indicator */
  /** Show production status when on main — migrations, Lakebase state, recent merges */
  private async refreshMainBranch(currentBranch: string): Promise<void> {
    if (!this.scm) { return; }

    // Staged + unstaged files (main can have uncommitted changes after merge, stash pop, etc.)
    try {
      const staged = await this.gitService.getStagedChanges();
      const root = getWorkspaceRoot();
      this.stagedGroup!.resourceStates = staged.map(f => this.makeStagedResource(f, root));
    } catch {
      this.stagedGroup!.resourceStates = [];
    }
    try {
      const unstaged = await this.gitService.getUnstagedChanges();
      const root = getWorkspaceRoot();
      this.codeGroup!.resourceStates = unstaged.map(f => this.makeChangeResource(f, root));
    } catch {
      this.codeGroup!.resourceStates = [];
    }
    this.syncGroup!.resourceStates = [];
    this.prGroup!.resourceStates = [];
    this.lastPrInfo = undefined;
    if (this.prPollTimer) { clearInterval(this.prPollTimer); this.prPollTimer = undefined; }
    vscode.commands.executeCommand('setContext', 'lakebaseSync.hasPR', false);

    // --- Lakebase group: production branch status only ---
    const lakebaseItems: vscode.SourceControlResourceState[] = [];
    try {
      if (this.lakebaseService) {
        const defaultBranch = await this.lakebaseService.getDefaultBranch();
        if (defaultBranch) {
          const consoleUrl = await this.lakebaseService.getConsoleUrl(defaultBranch.uid);
          lakebaseItems.push({
            resourceUri: vscode.Uri.parse(`lakebase-prod://status/production`),
            decorations: {
              tooltip: `Production: ${defaultBranch.branchId} (${defaultBranch.state})\nUID: ${defaultBranch.uid}\nClick to open in Databricks Console`,
              iconPath: new vscode.ThemeIcon(
                defaultBranch.state === 'READY' ? 'pass-filled' : 'loading~spin',
                new vscode.ThemeColor(defaultBranch.state === 'READY' ? 'charts.green' : 'charts.yellow')
              ),
            },
            command: consoleUrl
              ? { command: 'vscode.open', title: 'Open Production', arguments: [vscode.Uri.parse(consoleUrl)] }
              : { command: 'lakebaseSync.openInConsole', title: 'Open Console' },
          });
        }
      }
    } catch { /* ignore */ }
    this.lakebaseGroup!.resourceStates = lakebaseItems;

    // --- Schema Migrations group: list all migrations ---
    const migrationItems: vscode.SourceControlResourceState[] = [];
    const migrations = this.migrationService.listMigrations();
    for (const mig of migrations) {
      migrationItems.push({
        resourceUri: vscode.Uri.parse(`lakebase-prod://migration/V${mig.version}`),
        decorations: {
          tooltip: `V${mig.version}: ${mig.description}\nClick to open migration file`,
          iconPath: new vscode.ThemeIcon('file-code', new vscode.ThemeColor('foreground')),
        },
        command: {
          command: 'vscode.open',
          title: 'Open Migration',
          arguments: [vscode.Uri.file(mig.fullPath)],
        },
      });
    }
    this.migrationsGroup!.resourceStates = migrationItems;

    // --- Recent Merges group: last 5 merge commits ---
    const mergeItems: vscode.SourceControlResourceState[] = [];
    try {
      const root = getWorkspaceRoot();
      if (root) {
        let repoUrl = '';
        try {
          repoUrl = await this.gitService.getGitHubUrl();
        } catch { /* ignore */ }

        // Use getRecentMerges from GitService
        const merges = await this.gitService.getRecentMerges(5);
        const mergeLog = merges.map(m => `${m.sha}|${m.message}|`).join('\n');

        if (mergeLog) {
          // Split on lines that start with a sha (7+ hex chars followed by |)
          const entries = mergeLog.split(/\n(?=[0-9a-f]{7,}\|)/);

          for (const entry of entries) {
            if (!entry.trim()) { continue; }
            const parts = entry.split('|');
            if (parts.length < 2) { continue; }
            const sha = parts[0].trim();
            const subject = parts[1].trim();
            const body = (parts.slice(2).join('|') || '').split('\n')[0].trim();

            // Extract PR number from subject
            const prMatch = subject.match(/Merge pull request #(\d+)/);
            const prNum = prMatch ? prMatch[1] : '';

            // Build a human-readable label: prefer body (PR title), fall back to subject
            let label: string;
            if (prNum && body) {
              label = `PR #${prNum}: ${body}`;
            } else if (body) {
              label = body;
            } else {
              label = subject;
            }

            const commitUrl = repoUrl ? `${repoUrl}/commit/${sha}` : '';
            const cmd: vscode.Command = commitUrl
              ? { command: 'vscode.open', title: 'View on GitHub', arguments: [vscode.Uri.parse(commitUrl)] }
              : { command: 'lakebaseSync.showBranchStatus', title: 'View Status' };

            mergeItems.push({
              resourceUri: vscode.Uri.parse(`lakebase-prod://merge/${sha}`),
              decorations: {
                tooltip: `${label}\n${subject}${commitUrl ? '\nClick to view on GitHub' : ''}`,
                iconPath: new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('charts.purple')),
              },
              command: cmd,
            });
          }
        }
      }
    } catch { /* ignore */ }
    this.mergesGroup!.resourceStates = mergeItems;

    this.scm.count = this.stagedGroup!.resourceStates.length +
      this.codeGroup!.resourceStates.length +
      lakebaseItems.length + migrationItems.length + mergeItems.length;
    this.updateBranchStatusBar(currentBranch);
    this._onDidRefresh.fire();
  }

  private async updateBranchStatusBar(branch?: string): Promise<void> {
    if (!this.scm) { return; }
    const currentBranch = branch || this.gitService.getCachedBranch() || await this.gitService.getCurrentBranch();
    if (!currentBranch) {
      this.scm.statusBarCommands = [];
      return;
    }

    // Check for uncommitted changes (staged + unstaged working tree)
    let hasUncommitted = false;
    try {
      const staged = await this.gitService.getStagedChanges();
      const unstaged = await this.gitService.getUnstagedChanges();
      hasUncommitted = staged.length > 0 || unstaged.length > 0;
    } catch { /* ignore */ }

    const dirty = hasUncommitted ? '*' : '';
    const branchLabel = `$(git-branch) ${currentBranch}${dirty}`;

    const commands: vscode.Command[] = [{
      command: 'lakebaseSync.switchBranchPicker',
      title: branchLabel,
      tooltip: `${currentBranch}${dirty}; Check out Branch/Tag...`,
    }];

    // Sync group + status bar sync button
    try {
      const { ahead, behind, upstream } = await this.gitService.getAheadBehind();

      // Populate the Sync Changes group
      if (this.syncGroup) {
        if (upstream && (ahead > 0 || behind > 0)) {
          const parts: string[] = [];
          if (behind > 0) { parts.push(`${behind} to pull`); }
          if (ahead > 0) { parts.push(`${ahead} to push`); }
          const syncDescription = parts.join(', ');

          this.syncGroup.resourceStates = [{
            resourceUri: vscode.Uri.parse(`lakebase-sync://sync/${currentBranch}`),
            decorations: {
              tooltip: `Sync Changes: ${syncDescription}\nPull and push commits from and to ${upstream}`,
              iconPath: new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue')),
            },
            command: {
              command: 'lakebaseSync.sync',
              title: 'Sync Changes',
              tooltip: `Pull and push commits from and to ${upstream}`,
            },
          }];
        } else {
          this.syncGroup.resourceStates = [];
        }
      }
      if (upstream) {
        let syncLabel = '$(sync)';
        const parts: string[] = [];
        if (behind > 0) { parts.push(`${behind}$(arrow-down)`); }
        if (ahead > 0) { parts.push(`${ahead}$(arrow-up)`); }
        if (parts.length > 0) {
          syncLabel = `$(sync) ${parts.join(' ')}`;
        }

        const syncTooltip = ahead === 0 && behind === 0
          ? `Sync Changes; ${upstream} is up to date`
          : `Sync Changes; ${upstream}${behind > 0 ? ` — ${behind} to pull` : ''}${ahead > 0 ? ` — ${ahead} to push` : ''}`;

        commands.push({
          command: 'lakebaseSync.sync',
          title: syncLabel,
          tooltip: syncTooltip,
        });
      } else {
        // No upstream — show publish instead
        commands.push({
          command: 'lakebaseSync.publishBranch',
          title: '$(cloud-upload)',
          tooltip: 'Publish Branch...',
        });
      }
    } catch { /* ignore — just show branch without sync */ }

    this.scm.statusBarCommands = commands;

    // Note: VS Code's blue action button (actionButton) is a proposed API
    // available only to built-in extensions. Third-party extensions use
    // statusBarCommands (shown above) and scm/title navigation buttons.
  }

  /** Refresh PR status and show in the PR group */
  private async refreshPrStatus(): Promise<void> {
    if (!this.scm || !this.prGroup) { return; }

    const pr = await this.gitService.getPullRequest();
    this.lastPrInfo = pr;

    if (!pr) {
      this.prGroup.resourceStates = [];
      if (this.prPollTimer) { clearInterval(this.prPollTimer); this.prPollTimer = undefined; }
      vscode.commands.executeCommand('setContext', 'lakebaseSync.hasPR', false);
      return;
    }

    vscode.commands.executeCommand('setContext', 'lakebaseSync.hasPR', true);

    const ciIcons: Record<string, string> = {
      pending: 'loading~spin',
      success: 'pass-filled',
      failure: 'error',
      unknown: 'question',
    };
    const ciColors: Record<string, string> = {
      pending: 'charts.yellow',
      success: 'charts.green',
      failure: 'charts.red',
      unknown: 'foreground',
    };
    const ciLabels: Record<string, string> = {
      pending: 'CI running...',
      success: 'CI passed',
      failure: 'CI failed',
      unknown: 'CI status unknown',
    };

    const ciBranchName = `ci-pr-${pr.number}`;
    const items: vscode.SourceControlResourceState[] = [];

    // PR status item — label: "PR #42 - Feature description"
    const prLabel = `PR #${pr.number} - ${pr.title}`;
    items.push({
      resourceUri: vscode.Uri.parse(`lakebase-pr://status/${encodeURIComponent(prLabel)}`),
      decorations: {
        tooltip: `${prLabel}\n${ciLabels[pr.ciStatus]}\nCI branch: ${ciBranchName}\n\nClick to open PR`,
        iconPath: new vscode.ThemeIcon(ciIcons[pr.ciStatus], new vscode.ThemeColor(ciColors[pr.ciStatus])),
      },
      command: {
        command: 'vscode.open',
        title: 'Open PR',
        arguments: [vscode.Uri.parse(pr.url)],
      },
    });

    // CI Lakebase branch item — look up the actual UID for the console URL
    const lbLabel = `Lakebase Branch for ${ciBranchName}`;
    let ciBranchCommand: vscode.Command = {
      command: 'lakebaseSync.showBranchStatus',
      title: 'CI branch not found',
    };
    let ciBranchFound = false;
    try {
      if (this.lakebaseService) {
        const ciBranch = await this.lakebaseService.getBranchByName(ciBranchName);
        if (ciBranch) {
          ciBranchFound = true;
          const consoleUrl = await this.lakebaseService.getConsoleUrl(ciBranch.uid);
          if (consoleUrl) {
            ciBranchCommand = { command: 'vscode.open', title: 'Open CI Branch', arguments: [vscode.Uri.parse(consoleUrl)] };
          }
        }
      }
    } catch { /* ignore */ }

    items.push({
      resourceUri: vscode.Uri.parse(`lakebase-pr://ci-branch/${encodeURIComponent(lbLabel)}`),
      decorations: {
        tooltip: ciBranchFound
          ? `${lbLabel}\nCreated automatically by PR workflow\nClick to open in Databricks Console`
          : `${lbLabel}\nBranch not yet created — CI may still be running`,
        iconPath: new vscode.ThemeIcon(
          ciBranchFound ? 'database' : 'loading~spin',
          new vscode.ThemeColor(ciBranchFound ? ciColors[pr.ciStatus] : 'charts.yellow')
        ),
      },
      command: ciBranchCommand,
    });

    this.prGroup.resourceStates = items;

    // Start polling if CI is pending (every 30 seconds)
    if (pr.ciStatus === 'pending' && !this.prPollTimer) {
      this.prPollTimer = setInterval(() => this.refreshPrStatus(), 30_000);
    }
    // Stop polling when CI completes
    if (pr.ciStatus !== 'pending' && this.prPollTimer) {
      clearInterval(this.prPollTimer);
      this.prPollTimer = undefined;

      // Show notification on completion
      if (pr.ciStatus === 'success') {
        const action = await vscode.window.showInformationMessage(
          `PR #${pr.number} CI passed. Schema diff available.`,
          'View Schema Diff', 'Open PR'
        );
        if (action === 'View Schema Diff') {
          vscode.commands.executeCommand('lakebaseSync.showPrSchemaDiff');
        } else if (action === 'Open PR') {
          vscode.env.openExternal(vscode.Uri.parse(pr.url));
        }
      } else if (pr.ciStatus === 'failure') {
        const action = await vscode.window.showWarningMessage(
          `PR #${pr.number} CI failed.`,
          'Open PR'
        );
        if (action === 'Open PR') {
          vscode.env.openExternal(vscode.Uri.parse(pr.url));
        }
      }
    }
  }

  /** Get the last PR info (used by extension commands) */
  getLastPrInfo(): PullRequestInfo | undefined {
    return this.lastPrInfo;
  }

  private debouncedCodeRefresh(): void {
    if (this.codeRefreshTimer) { clearTimeout(this.codeRefreshTimer); }
    this.codeRefreshTimer = setTimeout(() => this.refreshCodeOnly(), 1000);
  }

  private async refreshCodeOnly(): Promise<void> {
    if (!this.scm) { return; }
    const currentBranch = this.gitService.getCachedBranch() || await this.gitService.getCurrentBranch();
    const isMain = isMainBranch(currentBranch, getConfig().trunkBranch);
    if (isMain || !currentBranch) { return; }

    try {
      const root = getWorkspaceRoot();
      const staged = await this.gitService.getStagedChanges();
      this.stagedGroup!.resourceStates = staged.map(f => this.makeStagedResource(f, root));

      const unstaged = await this.gitService.getUnstagedChanges();
      this.codeGroup!.resourceStates = unstaged.map(f => this.makeChangeResource(f, root));

      // --- Re-evaluate Lakebase schema changes from live DB diff ---
      this.lakebaseGroup!.resourceStates = this.buildSchemaItemsFromDiff();

      this.scm.count = this.stagedGroup!.resourceStates.length +
        this.codeGroup!.resourceStates.length +
        this.lakebaseGroup!.resourceStates.length;

      this.updateBranchStatusBar();
      this._onDidRefresh.fire();
    } catch { /* ignore */ }
  }

  private makeStagedResource(file: GitFileChange, root?: string): vscode.SourceControlResourceState {
    const filePath = root ? `${root}/${file.path}` : file.path;
    const resourceUri = vscode.Uri.file(filePath);
    return {
      resourceUri,
      decorations: {
        tooltip: `staged: ${file.path}`,
        iconPath: new vscode.ThemeIcon(this.getStatusIcon(file.status), new vscode.ThemeColor(this.getStatusColor(file.status))),
      },
      command: this.makeDiffCommand(file, resourceUri),
    };
  }

  private makeChangeResource(file: GitFileChange, root?: string): vscode.SourceControlResourceState {
    const filePath = root ? `${root}/${file.path}` : file.path;
    const resourceUri = vscode.Uri.file(filePath);
    return {
      resourceUri,
      decorations: {
        tooltip: `${file.status}: ${file.path}`,
        iconPath: new vscode.ThemeIcon(this.getStatusIcon(file.status), new vscode.ThemeColor(this.getStatusColor(file.status))),
      },
      command: this.makeDiffCommand(file, resourceUri),
    };
  }

  private makeDiffCommand(file: GitFileChange, resourceUri: vscode.Uri): vscode.Command {
    if (file.status === 'added') {
      return { command: 'vscode.open', title: 'Open File', arguments: [resourceUri] };
    }
    if (file.status === 'deleted') {
      const baseUri = vscode.Uri.parse(`lakebase-git-base://merge-base/${file.path}`);
      return { command: 'vscode.open', title: 'Open Base Version', arguments: [baseUri] };
    }
    const diffPath = file.status === 'renamed' && file.oldPath ? file.oldPath : file.path;
    const baseUri = vscode.Uri.parse(`lakebase-git-base://merge-base/${diffPath}`);
    return { command: 'vscode.diff', title: 'Show Diff', arguments: [baseUri, resourceUri, `${file.path} (main ↔ branch)`] };
  }

  private getStatusIcon(status: string): string {
    const icons: Record<string, string> = { added: 'diff-added', modified: 'diff-modified', deleted: 'diff-removed', renamed: 'diff-renamed' };
    return icons[status] || 'file';
  }

  private getStatusColor(status: string): string {
    const colors: Record<string, string> = { added: 'charts.green', modified: 'charts.yellow', deleted: 'charts.red', renamed: 'charts.blue' };
    return colors[status] || 'foreground';
  }

  /**
   * Build Lakebase schema-change items from the cached live diff. On cache
   * miss, kicks off a background compareBranchSchemas() (guarded against
   * concurrent calls) and triggers a re-refresh when it completes. On error
   * or no LAKEBASE_BRANCH_ID, returns [] so the count simply reads 0.
   */
  private buildSchemaItemsFromDiff(): vscode.SourceControlResourceState[] {
    const diff = this.schemaDiffService.getCachedDiff();
    if (!diff) {
      if (!this.schemaDiffInFlight) {
        this.schemaDiffInFlight = true;
        this.schemaDiffService.compareBranchSchemas()
          .then(result => { if (result && !result.error) { this.refresh(); } })
          .catch(() => { /* ignore */ })
          .finally(() => { this.schemaDiffInFlight = false; });
      }
      return [];
    }
    if (diff.error) { return []; }
    const items: vscode.SourceControlResourceState[] = [];
    for (const t of diff.created)  { items.push(this.makeSchemaResource(t.name, 'created')); }
    for (const t of diff.modified) { items.push(this.makeSchemaResource(t.name, 'modified')); }
    for (const t of diff.removed)  { items.push(this.makeSchemaResource(t.name, 'removed')); }
    return items;
  }

  private makeSchemaResource(tableName: string, diffType: 'created' | 'modified' | 'removed'): vscode.SourceControlResourceState {
    const resourceUri = vscode.Uri.parse(`lakebase-schema://table/${tableName}#${diffType}`);
    const icons: Record<string, string> = { created: 'diff-added', modified: 'diff-modified', removed: 'diff-removed' };
    const colors: Record<string, string> = { created: 'charts.green', modified: 'charts.yellow', removed: 'charts.red' };
    return {
      resourceUri,
      decorations: {
        tooltip: `${diffType}: ${tableName}`,
        iconPath: new vscode.ThemeIcon(icons[diffType], new vscode.ThemeColor(colors[diffType])),
      },
      command: { command: 'lakebaseSync.showTableDiff', title: 'Schema Diff', arguments: [tableName, diffType] },
    };
  }

  private clearGroups(): void {
    if (!this.scm) { return; }
    this.syncGroup!.resourceStates = [];
    this.stagedGroup!.resourceStates = [];
    this.codeGroup!.resourceStates = [];
    this.lakebaseGroup!.resourceStates = [];
    this.migrationsGroup!.resourceStates = [];
    this.mergesGroup!.resourceStates = [];
    this.prGroup!.resourceStates = [];
    this.scm.count = 0;
  }

  getLastDiff(): SchemaDiffResult | undefined {
    return this.schemaDiffService.getCachedDiff();
  }

  getScm(): vscode.SourceControl | undefined {
    return this.scm;
  }

  // --- Public accessors for sidebar tree providers ---

  getStaged(): vscode.SourceControlResourceState[] {
    return this.stagedGroup?.resourceStates ?? [];
  }

  getCode(): vscode.SourceControlResourceState[] {
    return this.codeGroup?.resourceStates ?? [];
  }

  getLakebase(): vscode.SourceControlResourceState[] {
    return this.lakebaseGroup?.resourceStates ?? [];
  }

  getMigrations(): vscode.SourceControlResourceState[] {
    return this.migrationsGroup?.resourceStates ?? [];
  }

  getMerges(): vscode.SourceControlResourceState[] {
    return this.mergesGroup?.resourceStates ?? [];
  }

  getPr(): vscode.SourceControlResourceState[] {
    return this.prGroup?.resourceStates ?? [];
  }

  getSync(): vscode.SourceControlResourceState[] {
    return this.syncGroup?.resourceStates ?? [];
  }

  private async onMigrationChange(): Promise<void> {
    const currentFiles = this.migrationService.listMigrations().map(m => m.filename);
    const previousSet = new Set(this.lastMigrationFiles);
    const added = currentFiles.filter(f => !previousSet.has(f));
    const removed = this.lastMigrationFiles.filter(f => !new Set(currentFiles).has(f));
    this.lastMigrationFiles = currentFiles;
    this.schemaDiffService.clearCache();

    if (added.length > 0) {
      const descriptions = added.map(f => {
        const match = f.match(/^V(\d+(?:\.\d+)*)__(.+)\.sql$/i);
        return match ? `V${match[1]}: ${match[2].replace(/_/g, ' ')}` : f;
      });
      const action = await vscode.window.showInformationMessage(
        `New migration${added.length > 1 ? 's' : ''} detected: ${descriptions.join(', ')}`,
        'View Branch Diff', 'Open File'
      );
      if (action === 'View Branch Diff') {
        vscode.commands.executeCommand('lakebaseSync.showBranchDiff');
      } else if (action === 'Open File') {
        const root = getWorkspaceRoot();
        if (root) {
          const config = getConfig();
          const filePath = vscode.Uri.file(`${root}/${config.migrationPath}/${added[0]}`);
          const doc = await vscode.workspace.openTextDocument(filePath);
          vscode.window.showTextDocument(doc);
        }
      }
    }
    if (removed.length > 0) {
      vscode.window.showWarningMessage(`Migration${removed.length > 1 ? 's' : ''} removed: ${removed.join(', ')}`);
    }
    await this.refresh();
  }

  private async onCommitDetected(): Promise<void> {
    const config = getConfig();
    const staged = await this.gitService.getStagedFiles();
    const stagedMigrations = staged.filter(f =>
      f.startsWith(config.migrationPath) && config.migrationPattern.test(f.split('/').pop() || f)
    );
    if (stagedMigrations.length === 0) { return; }
    const descriptions = stagedMigrations.map(f => {
      const filename = f.split('/').pop() || f;
      const match = filename.match(/^V(\d+(?:\.\d+)*)__(.+)\.sql$/i)
        || filename.match(/^([0-9a-f]+)_(.+)\.py$/i)
        || filename.match(/^(\d+)_(.+)\.(js|ts)$/i);
      return match ? `${match[1]}: ${match[2].replace(/_/g, ' ')}` : filename;
    });
    vscode.window.showInformationMessage(
      `Committing ${stagedMigrations.length} schema migration${stagedMigrations.length > 1 ? 's' : ''}: ${descriptions.join(', ')}`,
      'View Branch Diff'
    ).then(action => {
      if (action === 'View Branch Diff') { vscode.commands.executeCommand('lakebaseSync.showBranchDiff'); }
    });
  }

  dispose(): void {
    if (this.codeRefreshTimer) { clearTimeout(this.codeRefreshTimer); }
    this._onDidRefresh.dispose();
    this.baseContentProvider.dispose();
    this.migrationWatcher?.dispose();
    this.commitWatcher?.dispose();
    this.gitIndexWatcher?.dispose();
    this.configWatcher.dispose();
    this.destroyScm();
  }
}
