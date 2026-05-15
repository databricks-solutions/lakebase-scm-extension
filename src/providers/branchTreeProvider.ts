import * as vscode from 'vscode';
import { GitService, GitBranchInfo } from '../services/gitService';
import { LakebaseService, LakebaseBranch } from '../services/lakebaseService';
import { SchemaMigrationService } from '../services/schemaMigrationService';
import { SchemaDiffService } from '../services/schemaDiffService';
import { isMainBranch, isStagingBranch } from '../utils/theme';
import { getConfig } from '../utils/config';

type ItemType = 'project' | 'branch' | 'currentBranch' | 'detail' | 'sectionHeader'
  | 'migrationList' | 'tableList' | 'fileList';

export class BranchItem extends vscode.TreeItem {
  /** Branch name carried from parent so children can look up data */
  public branchName?: string;

  constructor(
    public readonly gitBranch: GitBranchInfo | undefined,
    public readonly lakebaseBranch: LakebaseBranch | undefined,
    public readonly itemType: ItemType,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.contextValue = itemType;
  }
}

export class BranchTreeProvider implements vscode.TreeDataProvider<BranchItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BranchItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private gitService: GitService;
  private lakebaseService: LakebaseService;
  private migrationService: SchemaMigrationService;
  private schemaDiffService: SchemaDiffService;
  private cachedData: BranchItem[] = [];
  private _suppressRefresh = false;

  constructor(
    gitService: GitService,
    lakebaseService: LakebaseService,
    migrationService: SchemaMigrationService,
    schemaDiffService?: SchemaDiffService
  ) {
    this.gitService = gitService;
    this.lakebaseService = lakebaseService;
    this.migrationService = migrationService;
    this.schemaDiffService = schemaDiffService!;

    this.gitService.onBranchChanged(() => this.refresh());
  }

  /** Suppress automatic refreshes (e.g. during branch switch workflow) */
  set suppressRefresh(value: boolean) {
    this._suppressRefresh = value;
  }

  refresh(): void {
    if (this._suppressRefresh) {
      return;
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: BranchItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BranchItem): Promise<BranchItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    if (element.itemType === 'project') {
      return this.getProjectDetails();
    }
    if (element.itemType === 'sectionHeader') {
      return this.getSectionChildren(element.label as string);
    }
    if (element.itemType === 'branch' || element.itemType === 'currentBranch') {
      return await this.getBranchDetails(element);
    }
    if (element.itemType === 'migrationList') {
      return this.getMigrationFiles(element.branchName!);
    }
    if (element.itemType === 'tableList') {
      return this.getTableList(element.branchName, element.lakebaseBranch);
    }
    if (element.itemType === 'fileList') {
      return this.getBranchFiles(element.branchName!);
    }
    return [];
  }

  private async getRootItems(): Promise<BranchItem[]> {
    const items: BranchItem[] = [];

    // Derive repo name from git remote for the root label
    let repoName = 'my-project';
    let repoUrl = '';
    try {
      repoUrl = await this.gitService.getGitHubUrl();
      const match = repoUrl.match(/\/([^/]+)$/);
      repoName = match ? match[1] : repoName;
    } catch { /* no remote */ }

    const projectItem = new BranchItem(
      undefined, undefined, 'project',
      repoName,
      vscode.TreeItemCollapsibleState.Expanded
    );
    projectItem.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('charts.blue'));
    projectItem.description = 'Git + Lakebase';
    items.push(projectItem);

    return items;
  }

  private async getProjectDetails(): Promise<BranchItem[]> {
    const items: BranchItem[] = [];

    // Check Lakebase auth status (used to color the database icon)
    let isConnected = false;
    try {
      const authStatus = await this.lakebaseService.checkAuth();
      isConnected = authStatus.authenticated;
    } catch { /* ignore */ }

    // GitHub repo — green icon if remote is available, clickable to open
    try {
      const repoUrl = await this.gitService.getGitHubUrl();
      if (repoUrl) {
        const match = repoUrl.match(/github\.com\/(.+)/);
        const fullRepoName = match ? match[1] : repoUrl;
        const ghItem = new BranchItem(undefined, undefined, 'detail', fullRepoName);
        ghItem.iconPath = new vscode.ThemeIcon('github');
        ghItem.tooltip = `${repoUrl}\nClick to open on GitHub`;
        ghItem.command = { command: 'vscode.open', title: 'Open on GitHub', arguments: [vscode.Uri.parse(repoUrl)] };
        items.push(ghItem);
      }
    } catch { /* no remote */ }

    // Lakebase project + workspace — green if connected, red if not
    const config = getConfig();
    if (config.lakebaseProjectId) {
      let displayName: string | undefined;
      if (isConnected) {
        try { displayName = await this.lakebaseService.getProjectDisplayName(); } catch { /* ignore */ }
      }
      const label = displayName || config.lakebaseProjectId;
      const lbItem = new BranchItem(undefined, undefined, 'detail', label);
      lbItem.iconPath = new vscode.ThemeIcon('database');
      const host = config.databricksHost ? config.databricksHost.replace(/^https?:\/\//, '') : '';
      lbItem.description = host;
      lbItem.tooltip = isConnected
        ? `Lakebase Project: ${label}${displayName ? `\nID: ${config.lakebaseProjectId}` : ''}${host ? `\nWorkspace: ${host}` : ''}\nConnected`
        : `Lakebase Project: ${config.lakebaseProjectId}${host ? `\nWorkspace: ${host}` : ''}\nNot connected — click to login`;
      if (isConnected) {
        const consoleUrl = await this.lakebaseService.getConsoleUrl();
        lbItem.command = consoleUrl
          ? { command: 'vscode.open', title: 'Open Lakebase Project', arguments: [vscode.Uri.parse(consoleUrl)] }
          : { command: 'lakebaseSync.openInConsole', title: 'Open Console' };
      } else {
        lbItem.command = { command: 'lakebaseSync.connectWorkspace', title: 'Connect' };
      }
      items.push(lbItem);
    }

    // Current Branch section
    const currentHeader = new BranchItem(undefined, undefined, 'sectionHeader',
      'Current Branch',
      vscode.TreeItemCollapsibleState.Expanded
    );
    currentHeader.iconPath = new vscode.ThemeIcon('git-branch');
    items.push(currentHeader);

    // Other Branches section
    const otherHeader = new BranchItem(undefined, undefined, 'sectionHeader',
      'Other Branches',
      vscode.TreeItemCollapsibleState.Collapsed
    );
    otherHeader.iconPath = new vscode.ThemeIcon('git-branch');
    items.push(otherHeader);

    return items;
  }

  private async getSectionChildren(sectionLabel: string): Promise<BranchItem[]> {
    const items: BranchItem[] = [];

    try {
      const allGitBranches = await this.gitService.listLocalBranches();
      const currentGitBranchEarly = await this.gitService.getCurrentBranch();

      // Scope to this project's branches when LAKEBASE_GIT_BRANCH_PREFIX is set.
      // Always include the current branch (so the user sees what they're on
      // even if they temporarily check out an unrelated branch).
      const prefix = getConfig().gitBranchPrefix;
      const gitBranches = prefix
        ? allGitBranches.filter(b => b.name.startsWith(prefix) || b.name === currentGitBranchEarly)
        : allGitBranches;

      let lakebaseBranches: LakebaseBranch[] = [];

      try {
        lakebaseBranches = await this.lakebaseService.listBranches();
      } catch {
        // Lakebase not available
      }

      const currentGitBranch = currentGitBranchEarly;

      if (sectionLabel === 'Current Branch') {
        const gb = gitBranches.find(b => b.name === currentGitBranch);
        if (gb) {
          const item = this.makeBranchItem(gb, lakebaseBranches, currentGitBranch, true);
          items.push(item);
        }
      } else {
        for (const gb of gitBranches) {
          if (gb.name === currentGitBranch) { continue; }
          const item = this.makeBranchItem(gb, lakebaseBranches, currentGitBranch, false);
          items.push(item);
        }

        // Lakebase-only branches (ci-pr-*, orphaned)
        const trunkAlias = getConfig().trunkBranch;
        const stagingAlias = getConfig().stagingBranch;
        const matchedNames = new Set(
          gitBranches.map(gb => {
            const isMain = isMainBranch(gb.name, trunkAlias);
            const isStaging = isStagingBranch(gb.name, stagingAlias);
            if (isMain) {
              return lakebaseBranches.find(b => b.isDefault)?.name;
            }
            if (isStaging) {
              return lakebaseBranches.find(b => b.branchId === 'staging')?.name;
            }
            return lakebaseBranches.find(b =>
              b.branchId === this.lakebaseService.sanitizeBranchName(gb.name)
            )?.name;
          }).filter(Boolean)
        );

        for (const lb of lakebaseBranches) {
          if (!matchedNames.has(lb.name) && !lb.isDefault) {
            const item = new BranchItem(
              undefined, lb, 'branch',
              `${lb.branchId} (db only)`,
              vscode.TreeItemCollapsibleState.Collapsed
            );
            item.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('charts.blue'));
            item.description = lb.state;
            item.contextValue = 'dbOnlyBranch';
            items.push(item);
          }
        }
      }
    } catch (err: any) {
      const errorItem = new BranchItem(undefined, undefined, 'detail', err.message);
      errorItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      items.push(errorItem);
    }

    return items;
  }

  private makeBranchItem(
    gb: GitBranchInfo,
    lakebaseBranches: LakebaseBranch[],
    currentGitBranch: string | undefined,
    isCurrent: boolean
  ): BranchItem {
    const cfg = getConfig();
    const isMain = isMainBranch(gb.name, cfg.trunkBranch);
    const isStaging = !isMain && isStagingBranch(gb.name, cfg.stagingBranch);
    const sanitized = this.lakebaseService.sanitizeBranchName(gb.name);

    let lb: LakebaseBranch | undefined;
    if (isMain) {
      lb = lakebaseBranches.find(b => b.isDefault);
    } else if (isStaging) {
      lb = lakebaseBranches.find(b => b.branchId === 'staging');
    } else {
      lb = lakebaseBranches.find(b =>
        b.branchId === sanitized ||
        b.uid === sanitized ||
        b.name.endsWith(`/branches/${sanitized}`)
      );
    }

    const item = new BranchItem(
      gb, lb,
      isCurrent ? 'currentBranch' : 'branch',
      gb.name,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    item.iconPath = this.getStateThemeIcon(lb);

    if (isCurrent) {
      const lbState = lb?.state || 'no db branch';
      const lbName = lb ? (lb.isDefault ? 'default' : lb.branchId) : '';
      item.description = lbName ? `→ ${lbName} (${lbState})` : lbState;
      if (!lb && !isMain && !isStaging) { item.contextValue = 'currentBranchNoDb'; }
    } else {
      item.description = lb?.state || '';
      if (!lb) { item.contextValue = 'branchNoDb'; }
    }

    return item;
  }

  private async getBranchDetails(parent: BranchItem): Promise<BranchItem[]> {
    const details: BranchItem[] = [];
    const gb = parent.gitBranch;
    const lb = parent.lakebaseBranch;

    // Git tracking — collapsible to show branch files
    if (gb) {
      const tracking = gb.tracking ? `→ ${gb.tracking}` : '(no remote)';
      const gitItem = new BranchItem(undefined, undefined, 'fileList',
        `${gb.name} ${tracking}`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      gitItem.iconPath = new vscode.ThemeIcon('git-branch');
      gitItem.branchName = gb.name;
      gitItem.tooltip = 'Click to expand and see changed files on this branch';
      details.push(gitItem);

      if (gb.ahead || gb.behind) {
        const parts = [];
        if (gb.ahead) { parts.push(`${gb.ahead} ahead`); }
        if (gb.behind) { parts.push(`${gb.behind} behind`); }
        const syncItem = new BranchItem(undefined, undefined, 'detail', parts.join(', '));
        syncItem.iconPath = new vscode.ThemeIcon('git-compare');
        details.push(syncItem);
      }
    }

    // Database — collapsible to show tables; inline icons for delete/refresh/console
    const isCurrent = parent.itemType === 'currentBranch';
    if (lb) {
      const dbLabel = lb.isDefault ? `production (${lb.state})` : `${lb.branchId} (${lb.state})`;
      const dbItem = new BranchItem(undefined, lb, 'tableList',
        dbLabel,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      dbItem.iconPath = new vscode.ThemeIcon('database');
      dbItem.branchName = gb?.name;
      dbItem.tooltip = lb.isDefault
        ? 'Click to expand and see tables on production'
        : 'Click to expand and see tables in this Lakebase branch';
      // Context for inline icons: delete, refresh, open in console
      dbItem.contextValue = lb.isDefault ? 'dbItemDefault' : 'dbItemBranch';
      details.push(dbItem);

      if (lb.endpointHost) {
        const epItem = new BranchItem(undefined, undefined, 'detail', `${lb.endpointState || 'unknown'}`);
        epItem.iconPath = new vscode.ThemeIcon('plug');
        details.push(epItem);
      }
    } else if (isCurrent) {
      const noDbItem = new BranchItem(undefined, undefined, 'detail', 'No Lakebase branch');
      noDbItem.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
      // Context for inline create icon
      noDbItem.contextValue = 'dbItemMissing';
      details.push(noDbItem);
    } else {
      const noDbItem = new BranchItem(undefined, undefined, 'detail', 'No Lakebase branch');
      noDbItem.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
      details.push(noDbItem);
    }

    // Migrations — collapsible to show individual files
    if (gb) {
      const config = getConfig();
      const migFiles = await this.gitService.listMigrationsOnBranch(gb.name, config.migrationPath);
      if (migFiles.length > 0) {
        const lastFile = migFiles[migFiles.length - 1];
        const versionMatch = lastFile.match(/^V(\d+(?:\.\d+)*)/i);
        const version = versionMatch ? versionMatch[1] : '?';
        const migItem = new BranchItem(
          undefined, undefined, 'migrationList',
          `schema-migration (${migFiles.length} file${migFiles.length !== 1 ? 's' : ''}, V${version})`,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        migItem.iconPath = new vscode.ThemeIcon('versions');
        migItem.branchName = gb.name;
        migItem.tooltip = 'Click to expand and see migration files';
        details.push(migItem);
      }
    }

    return details;
  }

  // --- Expandable detail children ---

  private async getMigrationFiles(branchName: string): Promise<BranchItem[]> {
    const config = getConfig();
    const migFiles = await this.gitService.listMigrationsOnBranch(branchName, config.migrationPath);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    return migFiles.map(filename => {
      const match = filename.match(/^V(\d+(?:\.\d+)*)__(.+)\.sql$/i);
      const label = match ? `V${match[1]}: ${match[2].replace(/_/g, ' ')}` : filename;
      const item = new BranchItem(undefined, undefined, 'detail', label);
      item.iconPath = new vscode.ThemeIcon('file-code');
      item.tooltip = filename;
      if (root) {
        const fileUri = vscode.Uri.file(`${root}/${config.migrationPath}/${filename}`);
        item.command = { command: 'vscode.open', title: 'Open Migration', arguments: [fileUri] };
      }
      return item;
    });
  }

  private makeTableCommand(tableName: string, changeType: 'new' | 'modified' | 'removed' | 'unchanged'): vscode.Command {
    const branchUri = vscode.Uri.parse(`lakebase-schema-content://branch/${tableName}`);
    if (changeType === 'unchanged') {
      // No diff needed — just show the DDL
      return { command: 'vscode.open', title: 'View Table', arguments: [branchUri] };
    }
    // Force a fresh compareBranchSchemas before dispatching vscode.diff, so
    // SchemaContentProvider's cache reflects the same live snapshot that drove
    // the branch tree's own modified/new/removed decision. Otherwise a stale
    // cache can make both panes render identical DDL (empty diff).
    return {
      command: 'lakebaseSync.openBranchTableDiff',
      title: 'Schema Diff',
      arguments: [tableName, changeType],
    };
  }

  private async getTableList(branchName?: string, lakebaseBranch?: LakebaseBranch): Promise<BranchItem[]> {
    // Query actual tables + columns from the Lakebase branch database, diff against production
    if (lakebaseBranch) {
      const branchSchema = await this.lakebaseService.queryBranchSchema(lakebaseBranch.uid);
      const filtered = branchSchema.filter(t => t.name !== 'flyway_schema_history');

      if (filtered.length === 0 && lakebaseBranch.isDefault) {
        const emptyItem = new BranchItem(undefined, undefined, 'detail', 'No tables');
        emptyItem.iconPath = new vscode.ThemeIcon('info');
        return [emptyItem];
      }

      // For non-default branches, query the PARENT branch's schema for
      // comparison (matches Branch Diff Summary semantics — for a feature
      // forked from staging, compare against staging, not production).
      // Falls back to the default branch when source can't be resolved.
      let prodSchema: Map<string, string[]> | undefined; // tableName → sorted column signatures
      let comparisonName = '';
      if (!lakebaseBranch.isDefault) {
        try {
          let target: LakebaseBranch | undefined;
          if (lakebaseBranch.sourceBranchId) {
            try { target = await this.lakebaseService.getBranchByName(lakebaseBranch.sourceBranchId); } catch { /* fall through */ }
          }
          if (!target) {
            target = await this.lakebaseService.getDefaultBranch();
          }
          if (target) {
            comparisonName = target.branchId;
            const targetTables = await this.lakebaseService.queryBranchSchema(target.uid);
            prodSchema = new Map();
            for (const t of targetTables) {
              if (t.name === 'flyway_schema_history') { continue; }
              prodSchema.set(t.name, t.columns.map(c => `${c.name}:${c.dataType}`).sort());
            }
          }
        } catch { /* can't reach parent — skip diff */ }
      }

      type TableStatus = 'new' | 'modified' | 'unchanged';
      const statusMap = new Map<string, TableStatus>();

      const items: BranchItem[] = filtered.map(table => {
        const item = new BranchItem(undefined, undefined, 'detail', table.name);
        const colCount = table.columns.length;
        let status: TableStatus = 'unchanged';

        if (prodSchema !== undefined && !lakebaseBranch.isDefault) {
          const prodCols = prodSchema.get(table.name);
          if (!prodCols) {
            // Table doesn't exist on production → new
            status = 'new';
          } else {
            // Compare column signatures
            const branchCols = table.columns.map(c => `${c.name}:${c.dataType}`).sort();
            if (JSON.stringify(branchCols) !== JSON.stringify(prodCols)) {
              status = 'modified';
            }
          }
        }

        statusMap.set(table.name, status);

        if (status === 'new') {
          item.iconPath = new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('charts.green'));
          item.description = `new · ${colCount} columns`;
        } else if (status === 'modified') {
          item.iconPath = new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('charts.yellow'));
          item.description = `modified · ${colCount} columns`;
        } else {
          // unchanged — always shown on production; on feature branches included below if no diffs
          item.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('foreground'));
          item.description = colCount > 0 ? `${colCount} columns` : '';
        }

        const colList = table.columns.map(c => `${c.name}: ${c.dataType}`).join('\n');
        item.tooltip = new vscode.MarkdownString(
          `**${table.name}**${status !== 'unchanged' ? ` (${status})` : ''}\n\n` +
          (colList ? `\`\`\`\n${colList}\n\`\`\`` : 'No columns')
        );
        item.command = this.makeTableCommand(table.name, status === 'new' ? 'new' : status === 'modified' ? 'modified' : 'unchanged');
        return item;
      });

      // Tables removed on this branch (exist on production but not on branch)
      const removedItems: BranchItem[] = [];
      if (prodSchema !== undefined && !lakebaseBranch.isDefault) {
        const branchSet = new Set(filtered.map(t => t.name));
        for (const [name] of prodSchema) {
          if (!branchSet.has(name)) {
            const item = new BranchItem(undefined, undefined, 'detail', name);
            item.iconPath = new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('charts.red'));
            item.description = 'removed';
            item.command = this.makeTableCommand(name, 'removed');
            removedItems.push(item);
          }
        }
      }

      // Show all tables (new/modified/unchanged) + removed, sorted: diffs first, then unchanged
      const allItems = [...items, ...removedItems];
      allItems.sort((a, b) => {
        const sa = statusMap.get(a.label as string) || 'removed';
        const sb = statusMap.get(b.label as string) || 'removed';
        const order: Record<string, number> = { new: 0, modified: 1, removed: 2, unchanged: 3 };
        return (order[sa] ?? 3) - (order[sb] ?? 3);
      });

      if (allItems.length === 0) {
        const emptyItem = new BranchItem(undefined, undefined, 'detail', 'No tables');
        emptyItem.iconPath = new vscode.ThemeIcon('info');
        return [emptyItem];
      }
      return allItems;
    }

    // Try cached schema diff first (has branchTables + diff status)
    if (this.schemaDiffService) {
      const cached = this.schemaDiffService.getCachedDiff();
      if (cached && cached.branchTables && cached.branchTables.length > 0) {
        const createdSet = new Set(cached.created.map(t => t.name));
        const modifiedSet = new Set(cached.modified.map(t => t.name));

        // Branch tables (created + unchanged + modified)
        const items: BranchItem[] = cached.branchTables.map(table => {
          const colCount = table.columns?.length || 0;
          const item = new BranchItem(undefined, undefined, 'detail', table.name);
          const isNew = createdSet.has(table.name);
          const isMod = modifiedSet.has(table.name);
          const isChanged = isNew || isMod;

          let status: string;
          let icon: string;
          let color: string;
          if (isNew) {
            status = 'new';
            icon = 'diff-added';
            color = 'charts.green';
          } else if (isMod) {
            status = 'modified';
            icon = 'diff-modified';
            color = 'charts.yellow';
          } else {
            status = '';
            icon = 'symbol-class';
            color = 'foreground';
          }

          item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
          item.description = [status, colCount > 0 ? `${colCount} columns` : ''].filter(Boolean).join(' · ');
          const colList = table.columns?.map(c => `  ${c.name}: ${c.dataType}`).join('\n') || '';
          item.tooltip = new vscode.MarkdownString(
            `**${table.name}**${status ? ` (${status})` : ''}\n\n` +
            (colList ? `\`\`\`\n${table.columns!.map(c => `${c.name}: ${c.dataType}`).join('\n')}\n\`\`\`` : 'No column data')
          );
          item.command = this.makeTableCommand(table.name, isNew ? 'new' : isMod ? 'modified' : 'unchanged');
          return item;
        });

        // Removed tables (exist on production but not on branch)
        for (const table of cached.removed) {
          const item = new BranchItem(undefined, undefined, 'detail', table.name);
          item.iconPath = new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('charts.red'));
          item.description = 'removed';
          const colList = table.columns?.map(c => `${c.name}: ${c.dataType}`).join('\n') || '';
          item.tooltip = new vscode.MarkdownString(
            `**${table.name}** (removed)\n\n` +
            (colList ? `\`\`\`\n${colList}\n\`\`\`` : '')
          );
          item.command = this.makeTableCommand(table.name, 'removed');
          items.push(item);
        }

        return items;
      }
    }

    // Fallback: parse migration files, compare against main to determine diff status
    const allMigrations = this.migrationService.listMigrations();
    if (allMigrations.length > 0) {
      // Find which migrations are new on this branch (not on main)
      const config = getConfig();
      let mainMigrationSet = new Set<string>();
      try {
        const mainFiles = await this.gitService.listMigrationsOnBranch('main', config.migrationPath);
        mainMigrationSet = new Set(mainFiles);
      } catch { /* main may not exist */ }

      const newMigrations = allMigrations.filter(m => !mainMigrationSet.has(m.filename));

      // Parse all migrations for the full table inventory with columns
      const allChanges = this.migrationService.parseMigrationSchemaChanges(allMigrations);
      const allTables = new Map<string, { type: string; columns: Array<{ name: string; dataType: string }> }>();
      for (const c of allChanges) {
        const existing = allTables.get(c.tableName);
        const merged = existing ? [...existing.columns, ...c.columns] : [...c.columns];
        allTables.set(c.tableName, { type: c.type, columns: merged });
      }

      // Parse only new migrations to identify what changed on this branch
      const newChanges = this.migrationService.parseMigrationSchemaChanges(newMigrations);
      const changedTables = new Map<string, string>();
      for (const c of newChanges) { changedTables.set(c.tableName, c.type); }

      if (allTables.size > 0) {
        return Array.from(allTables.entries()).map(([name, info]) => {
          const item = new BranchItem(undefined, undefined, 'detail', name);
          const changeType = changedTables.get(name);
          const isChanged = !!changeType;

          if (changeType) {
            const icons: Record<string, string> = { created: 'diff-added', modified: 'diff-modified', removed: 'diff-removed' };
            const colors: Record<string, string> = { created: 'charts.green', modified: 'charts.yellow', removed: 'charts.red' };
            item.iconPath = new vscode.ThemeIcon(
              icons[changeType] || 'diff-modified',
              new vscode.ThemeColor(colors[changeType] || 'charts.yellow')
            );
            item.description = [
              changeType === 'created' ? 'new' : changeType,
              info.columns.length > 0 ? `${info.columns.length} columns` : ''
            ].filter(Boolean).join(' · ');
          } else {
            item.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('foreground'));
            item.description = info.columns.length > 0 ? `${info.columns.length} columns` : '';
          }

          const colList = info.columns.map(c => `${c.name}: ${c.dataType}`).join('\n');
          item.tooltip = new vscode.MarkdownString(
            `**${name}**${changeType ? ` (${changeType === 'created' ? 'new' : changeType})` : ''}\n\n` +
            (colList ? `\`\`\`\n${colList}\n\`\`\`` : 'No column data')
          );
          const cmdType = changeType === 'created' ? 'new' : changeType === 'modified' ? 'modified' : changeType === 'removed' ? 'removed' : 'unchanged';
          item.command = this.makeTableCommand(name, cmdType as any);
          return item;
        });
      }
    }

    const emptyItem = new BranchItem(undefined, undefined, 'detail', 'No table data available');
    emptyItem.iconPath = new vscode.ThemeIcon('info');
    emptyItem.tooltip = 'Run Review Branch or Branch Diff to populate table data';
    return [emptyItem];
  }

  private async getBranchFiles(branchName: string): Promise<BranchItem[]> {
    const isMain = isMainBranch(branchName, getConfig().trunkBranch);
    if (isMain) {
      const item = new BranchItem(undefined, undefined, 'detail', 'Default branch — no diff');
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    // Compute the diff for THIS specific branch, not the current working tree.
    // When the user expands a branch node in the sidebar they want to see what
    // that branch introduces vs trunk -- not what HEAD has uncommitted.
    try {
      const currentBranch = await this.gitService.getCurrentBranch();
      const forCurrentBranch = currentBranch === branchName;
      const changes = await this.gitService.getChangedFiles(
        forCurrentBranch ? undefined : branchName
      );
      if (changes.length === 0) {
        const item = new BranchItem(undefined, undefined, 'detail', 'No changes vs trunk');
        item.iconPath = new vscode.ThemeIcon('check');
        return [item];
      }

      // File paths from `git diff --name-status` are repo-root-relative; in a
      // monorepo the workspace folder is often a subdirectory of the repo, so
      // joining with the workspace folder produces a duplicated path that
      // doesn't exist on disk ("file not found" on click). Always build URIs
      // from the git top-level.
      const root = await this.gitService.getRepoRoot();
      const statusIcons: Record<string, string> = {
        added: 'diff-added', modified: 'diff-modified', deleted: 'diff-removed', renamed: 'diff-renamed'
      };
      const statusColors: Record<string, string> = {
        added: 'charts.green', modified: 'charts.yellow', deleted: 'charts.red', renamed: 'charts.blue'
      };

      return changes.map(file => {
        const fileName = file.path.split('/').pop() || file.path;
        const item = new BranchItem(undefined, undefined, 'detail', fileName);
        item.iconPath = new vscode.ThemeIcon(
          statusIcons[file.status] || 'file',
          new vscode.ThemeColor(statusColors[file.status] || 'foreground')
        );
        item.description = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';
        item.tooltip = `${file.status}: ${file.path}`;

        if (root && file.status !== 'deleted') {
          const fileUri = vscode.Uri.file(`${root}/${file.path}`);
          if (file.status === 'added') {
            item.command = { command: 'vscode.open', title: 'Open File', arguments: [fileUri] };
          } else {
            const diffPath = file.status === 'renamed' && file.oldPath ? file.oldPath : file.path;
            const baseUri = vscode.Uri.parse(`lakebase-git-base://merge-base/${diffPath}`);
            item.command = { command: 'vscode.diff', title: 'Show Diff', arguments: [baseUri, fileUri, `${file.path} (main ↔ branch)`] };
          }
        }

        return item;
      });
    } catch {
      const item = new BranchItem(undefined, undefined, 'detail', 'Unable to load files');
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item];
    }
  }

  private getStateThemeIcon(lb: LakebaseBranch | undefined): vscode.ThemeIcon {
    if (!lb) {
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    }
    if (lb.state === 'READY') {
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
    }
    if (lb.state === 'CREATING' || lb.state === 'PROVISIONING') {
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
    }
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
