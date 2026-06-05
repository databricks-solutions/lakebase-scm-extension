import * as vscode from 'vscode';
import { SchemaScmProvider } from './schemaScmProvider';

/** Pulls one SCM resource group (merges / migrations / lakebase) off the provider. */
type StateAccessor = (scm: SchemaScmProvider) => vscode.SourceControlResourceState[];

/** Derives the row label for one SCM resource state. */
type NameDeriver = (state: vscode.SourceControlResourceState) => string;

/** Default row label: last path segment, falling back to the full path. */
const defaultName: NameDeriver = (state) =>
  state.resourceUri.path.split('/').pop() || state.resourceUri.path;

/**
 * Map one SCM resource state to a flat TreeItem, passing through the
 * provider's decorations (icon/tooltip) and click command.
 */
export function scmStateToTreeItem(
  state: vscode.SourceControlResourceState,
  deriveName: NameDeriver = defaultName,
): vscode.TreeItem {
  const item = new vscode.TreeItem(deriveName(state), vscode.TreeItemCollapsibleState.None);
  item.resourceUri = state.resourceUri;
  item.iconPath = state.decorations?.iconPath;
  item.tooltip = state.decorations?.tooltip;
  item.command = state.command;
  return item;
}

/**
 * Shared base for the flat placeholder trees (merges, migrations, lakebase
 * schema) that each render one SCM resource group from SchemaScmProvider.
 * Previously three byte-identical classes differing only in which getter
 * they called and how they label rows; that body now lives here once.
 */
export class ScmStateTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private scmProvider: SchemaScmProvider,
    private readonly accessor: StateAccessor,
    private readonly deriveName: NameDeriver = defaultName,
  ) {
    scmProvider.onDidRefresh(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return this.accessor(this.scmProvider).map((state) => scmStateToTreeItem(state, this.deriveName));
  }
}
