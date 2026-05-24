import * as vscode from 'vscode';
import { SchemaScmProvider } from './schemaScmProvider';

class ChangeTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly groupId?: 'staged' | 'unstaged' | 'sync' | 'lakebase',
    public readonly resourceState?: vscode.SourceControlResourceState,
    /** For tree mode: folder path relative to workspace root */
    public readonly folderPath?: string,
    /** For tree mode: which group this folder belongs to */
    public readonly folderGroup?: 'staged' | 'unstaged'
  ) {
    super(label, collapsibleState);
  }
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ChangeTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _viewAsTree = false;

  constructor(private scmProvider: SchemaScmProvider) {
    scmProvider.onDidRefresh(() => this._onDidChangeTreeData.fire(undefined));
  }

  get viewAsTree(): boolean {
    return this._viewAsTree;
  }

  toggleViewMode(): void {
    this._viewAsTree = !this._viewAsTree;
    vscode.commands.executeCommand('setContext', 'lakebaseChanges.viewAsTree', this._viewAsTree);
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ChangeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChangeTreeItem): ChangeTreeItem[] {
    if (!element) {
      return this.getRootItems();
    }
    if (element.groupId === 'sync') {
      return this.getSyncChildren();
    }
    if (element.folderPath && element.folderGroup) {
      return this.getFolderChildren(element.folderGroup, element.folderPath);
    }
    if (element.groupId === 'staged' || element.groupId === 'unstaged') {
      const states = element.groupId === 'staged'
        ? this.scmProvider.getStaged()
        : this.scmProvider.getCode();
      if (this._viewAsTree) {
        return this.buildFolderTree(states, element.groupId);
      }
      return this.buildFileItems(states, element.groupId);
    }
    if (element.groupId === 'lakebase') {
      return this.getLakebaseChildren();
    }
    return [];
  }

  private getRootItems(): ChangeTreeItem[] {
    const items: ChangeTreeItem[] = [];

    const sync = this.scmProvider.getSync();
    if (sync.length > 0) {
      const item = new ChangeTreeItem(
        'Sync Changes',
        vscode.TreeItemCollapsibleState.Expanded,
        'sync'
      );
      item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue'));
      const state = sync[0];
      item.tooltip = state.decorations?.tooltip;
      item.description = state.decorations?.tooltip?.toString().split('\n')[0].replace('Sync Changes: ', '') || '';
      item.contextValue = 'syncGroup';
      items.push(item);
    }

    const staged = this.scmProvider.getStaged();
    if (staged.length > 0) {
      const item = new ChangeTreeItem(
        'Staged',
        vscode.TreeItemCollapsibleState.Expanded,
        'staged'
      );
      item.description = `${staged.length}`;
      item.contextValue = 'stagedGroup';
      items.push(item);
    }

    const unstaged = this.scmProvider.getCode();
    const codeItem = new ChangeTreeItem(
      'Code',
      unstaged.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      'unstaged'
    );
    codeItem.description = `${unstaged.length}`;
    codeItem.contextValue = 'unstagedGroup';
    items.push(codeItem);

    const lakebase = this.scmProvider.getLakebase();
    // Filter out status items (lakebase-prod://status/*) — only count actual schema changes
    const schemaChanges = lakebase.filter(s => !s.resourceUri.toString().includes('lakebase-prod://'));
    const lbItem = new ChangeTreeItem(
      'Lakebase',
      schemaChanges.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      'lakebase'
    );
    lbItem.description = `${schemaChanges.length}`;
    items.push(lbItem);

    return items;
  }

  private getLakebaseChildren(): ChangeTreeItem[] {
    return this.scmProvider.getLakebase().filter(s => !s.resourceUri.toString().includes('lakebase-prod://')).map(state => {
      const name = state.resourceUri.path.split('/').pop() || state.resourceUri.path;
      const item = new ChangeTreeItem(name, vscode.TreeItemCollapsibleState.None, undefined, state);
      item.resourceUri = state.resourceUri;
      item.iconPath = state.decorations?.iconPath;
      item.tooltip = state.decorations?.tooltip;
      item.command = state.command;
      return item;
    });
  }

  private getSyncChildren(): ChangeTreeItem[] {
    return this.scmProvider.getSync().map(state => {
      const item = new ChangeTreeItem(
        state.decorations?.tooltip?.toString().split('\n')[0] || 'Sync',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        state
      );
      item.iconPath = state.decorations?.iconPath;
      item.tooltip = state.decorations?.tooltip;
      item.command = state.command;
      return item;
    });
  }

  /**
   * Build file items that mirror SCM resource state rendering:
   * - resourceUri drives the label (filename), file-type icon, and file decoration (M/A/D letter)
   * - description shows the relative directory path
   * - command opens the diff (same as SCM click)
   * - contextValue enables inline stage/unstage/discard buttons
   */
  private buildFileItems(states: vscode.SourceControlResourceState[], group: 'staged' | 'unstaged'): ChangeTreeItem[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    return states.map(state => {
      const item = new ChangeTreeItem(
        state.resourceUri.path.split('/').pop() || '',
        vscode.TreeItemCollapsibleState.None,
        undefined,
        state
      );

      // Set resourceUri so VS Code uses file-type icon and applies file decorations (M, A, D badges)
      item.resourceUri = state.resourceUri;

      // Show relative directory path as description (matches SCM behavior)
      if (root) {
        const relative = state.resourceUri.fsPath.replace(root + '/', '');
        const dir = relative.includes('/') ? relative.substring(0, relative.lastIndexOf('/')) : '';
        if (dir) { item.description = dir; }
      }

      item.tooltip = state.decorations?.tooltip;
      item.command = state.command;
      item.contextValue = group === 'staged' ? 'stagedFile' : 'unstagedFile';
      return item;
    });
  }

  /** Tree mode: group files by directory, collapsing single-child chains */
  private buildFolderTree(states: vscode.SourceControlResourceState[], group: 'staged' | 'unstaged'): ChangeTreeItem[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const folders = new Map<string, vscode.SourceControlResourceState[]>();
    const rootFiles: vscode.SourceControlResourceState[] = [];

    for (const state of states) {
      const relative = root ? state.resourceUri.fsPath.replace(root + '/', '') : state.resourceUri.path;
      const slashIdx = relative.indexOf('/');
      if (slashIdx === -1) {
        rootFiles.push(state);
      } else {
        const topDir = relative.substring(0, slashIdx);
        if (!folders.has(topDir)) { folders.set(topDir, []); }
        folders.get(topDir)!.push(state);
      }
    }

    const items: ChangeTreeItem[] = [];

    for (const [dir, dirStates] of folders) {
      const collapsed = this.collapseFolderPath(dir, dirStates, root);
      const folderItem = new ChangeTreeItem(
        collapsed.path,
        vscode.TreeItemCollapsibleState.Expanded,
        undefined, undefined,
        collapsed.path, group
      );
      folderItem.iconPath = vscode.ThemeIcon.Folder;
      folderItem.description = `${collapsed.states.length}`;
      items.push(folderItem);
    }

    for (const state of rootFiles) {
      const fileItem = this.makeFileItem(state, group, root);
      items.push(fileItem);
    }

    return items;
  }

  private collapseFolderPath(dir: string, states: vscode.SourceControlResourceState[], root: string): { path: string; states: vscode.SourceControlResourceState[] } {
    const relatives = states.map(s => {
      const full = root ? s.resourceUri.fsPath.replace(root + '/', '') : s.resourceUri.path;
      return full.substring(dir.length + 1);
    });
    if (relatives.length > 0 && relatives.every(r => r.includes('/'))) {
      const firstParts = relatives[0].split('/');
      let commonDepth = 0;
      for (let i = 0; i < firstParts.length - 1; i++) {
        if (relatives.every(r => r.split('/')[i] === firstParts[i])) {
          commonDepth = i + 1;
        } else { break; }
      }
      if (commonDepth > 0) {
        return { path: dir + '/' + firstParts.slice(0, commonDepth).join('/'), states };
      }
    }
    return { path: dir, states };
  }

  private getFolderChildren(group: 'staged' | 'unstaged', folderPath: string): ChangeTreeItem[] {
    const states = group === 'staged' ? this.scmProvider.getStaged() : this.scmProvider.getCode();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const prefix = folderPath + '/';

    const matching = states.filter(s => {
      const relative = root ? s.resourceUri.fsPath.replace(root + '/', '') : s.resourceUri.path;
      return relative.startsWith(prefix);
    });

    const subFolders = new Map<string, vscode.SourceControlResourceState[]>();
    const directFiles: vscode.SourceControlResourceState[] = [];

    for (const state of matching) {
      const relative = root ? state.resourceUri.fsPath.replace(root + '/', '') : state.resourceUri.path;
      const rest = relative.substring(prefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx === -1) {
        directFiles.push(state);
      } else {
        const fullSubDir = folderPath + '/' + rest.substring(0, slashIdx);
        if (!subFolders.has(fullSubDir)) { subFolders.set(fullSubDir, []); }
        subFolders.get(fullSubDir)!.push(state);
      }
    }

    const items: ChangeTreeItem[] = [];

    for (const [subDir, subStates] of subFolders) {
      const collapsed = this.collapseFolderPath(subDir, subStates, root);
      const dirName = collapsed.path.substring(collapsed.path.lastIndexOf('/') + 1);
      const folderItem = new ChangeTreeItem(
        dirName,
        vscode.TreeItemCollapsibleState.Expanded,
        undefined, undefined,
        collapsed.path, group
      );
      folderItem.iconPath = vscode.ThemeIcon.Folder;
      folderItem.description = `${collapsed.states.length}`;
      items.push(folderItem);
    }

    for (const state of directFiles) {
      items.push(this.makeFileItem(state, group, root));
    }

    return items;
  }

  /** Single file item — matches SCM rendering. No description in tree mode (folder provides context). */
  private makeFileItem(state: vscode.SourceControlResourceState, group: 'staged' | 'unstaged', root: string): ChangeTreeItem {
    const item = new ChangeTreeItem(
      state.resourceUri.path.split('/').pop() || '',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      state
    );
    item.resourceUri = state.resourceUri;
    item.tooltip = state.decorations?.tooltip;
    item.command = state.command;
    item.contextValue = group === 'staged' ? 'stagedFile' : 'unstagedFile';
    return item;
  }

  getChangeCount(): number {
    const schemaChanges = this.scmProvider.getLakebase().filter(s => !s.resourceUri.toString().includes('lakebase-prod://'));
    return this.scmProvider.getStaged().length +
      this.scmProvider.getCode().length +
      schemaChanges.length;
  }
}
