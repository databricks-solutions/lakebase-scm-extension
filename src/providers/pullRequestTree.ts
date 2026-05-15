import * as vscode from 'vscode';
import { SchemaScmProvider } from './schemaScmProvider';
import { GitService, PullRequestInfo, PullRequestCheck, PullRequestReview, PullRequestFile } from '../services/gitService';

type PrItemType = 'status' | 'checks' | 'check' | 'files' | 'file' | 'reviews' | 'review' | 'ciBranch';

class PrTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly prItemType?: PrItemType
  ) {
    super(label, collapsibleState);
  }
}

export class PullRequestTreeProvider implements vscode.TreeDataProvider<PrTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PrTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private cachedPr: PullRequestInfo | undefined;

  constructor(
    private scmProvider: SchemaScmProvider,
    private gitService?: GitService
  ) {
    scmProvider.onDidRefresh(() => {
      this.cachedPr = undefined;
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  /** Force refresh — clears cache and re-fetches PR data immediately */
  async forceRefresh(): Promise<void> {
    this.cachedPr = undefined;
    if (this.gitService) {
      this.cachedPr = await this.gitService.getPullRequest();
      vscode.commands.executeCommand('setContext', 'lakebaseSync.hasPR', !!this.cachedPr);
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PrTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PrTreeItem): Promise<PrTreeItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    if (element.prItemType === 'checks') {
      return this.getCheckItems();
    }
    if (element.prItemType === 'files') {
      return this.getFileItems();
    }
    if (element.prItemType === 'reviews') {
      return this.getReviewItems();
    }
    return [];
  }

  private async getPr(): Promise<PullRequestInfo | undefined> {
    if (this.cachedPr) { return this.cachedPr; }
    if (!this.gitService) { return undefined; }
    this.cachedPr = await this.gitService.getPullRequest();
    vscode.commands.executeCommand('setContext', 'lakebaseSync.hasPR', !!this.cachedPr);
    return this.cachedPr;
  }

  private async getRootItems(): Promise<PrTreeItem[]> {
    const pr = await this.getPr();
    if (!pr) { return []; }

    // Also get SCM resource states for the CI branch item
    const states = this.scmProvider.getPr();
    const items: PrTreeItem[] = [];

    // PR status item
    if (pr) {
      const draftPrefix = pr.isDraft ? 'Draft: ' : '';
      const label = `${draftPrefix}PR #${pr.number} — ${pr.title}`;
      const statusItem = new PrTreeItem(label, vscode.TreeItemCollapsibleState.None, 'status');

      const ciIcons: Record<string, string> = { pending: 'loading~spin', success: 'pass-filled', failure: 'error', unknown: 'question' };
      const ciColors: Record<string, string> = { pending: 'charts.yellow', success: 'charts.green', failure: 'charts.red', unknown: 'foreground' };

      statusItem.iconPath = new vscode.ThemeIcon(
        pr.isDraft ? 'git-pull-request-draft' : ciIcons[pr.ciStatus] || 'question',
        new vscode.ThemeColor(pr.isDraft ? 'disabledForeground' : (ciColors[pr.ciStatus] || 'foreground'))
      );

      const reviewLabel = pr.reviewDecision === 'APPROVED' ? '✓ Approved'
        : pr.reviewDecision === 'CHANGES_REQUESTED' ? '✗ Changes requested'
        : pr.reviewDecision === 'REVIEW_REQUIRED' ? '⧖ Review required'
        : '';

      const statsLabel = (pr.additions !== undefined || pr.deletions !== undefined)
        ? `+${pr.additions || 0} −${pr.deletions || 0} (${pr.changedFiles || 0} files)`
        : '';

      statusItem.description = [reviewLabel, statsLabel].filter(Boolean).join(' · ');
      statusItem.tooltip = `${label}\n${reviewLabel}\n${statsLabel}\nClick to open on GitHub`;
      statusItem.command = { command: 'vscode.open', title: 'Open PR', arguments: [vscode.Uri.parse(pr.url)] };
      items.push(statusItem);
    }

    // CI Checks — collapsible
    if (pr && pr.checks.length > 0) {
      const passed = pr.checks.filter(c => c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED').length;
      const failed = pr.checks.filter(c => c.conclusion === 'FAILURE' || c.conclusion === 'ERROR').length;
      const pending = pr.checks.length - passed - failed;

      let checksLabel = `Checks: ${passed}/${pr.checks.length} passed`;
      if (failed > 0) { checksLabel += `, ${failed} failed`; }
      if (pending > 0) { checksLabel += `, ${pending} pending`; }

      const checksItem = new PrTreeItem(checksLabel, vscode.TreeItemCollapsibleState.Collapsed, 'checks');
      if (failed > 0) {
        checksItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
      } else if (pending > 0) {
        checksItem.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.yellow'));
      } else {
        checksItem.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
      }
      items.push(checksItem);
    }

    // Changed Files — collapsible
    if (pr && pr.changedFiles && pr.changedFiles > 0) {
      const filesItem = new PrTreeItem(
        `Files changed: ${pr.changedFiles}`,
        vscode.TreeItemCollapsibleState.Collapsed,
        'files'
      );
      filesItem.iconPath = new vscode.ThemeIcon('files');
      filesItem.description = `+${pr.additions || 0} −${pr.deletions || 0}`;
      items.push(filesItem);
    }

    // Reviews — collapsible
    if (pr) {
      const reviewsItem = new PrTreeItem(
        'Reviews',
        vscode.TreeItemCollapsibleState.Collapsed,
        'reviews'
      );
      const reviewIcons: Record<string, string> = {
        APPROVED: 'pass-filled',
        CHANGES_REQUESTED: 'error',
        REVIEW_REQUIRED: 'request-changes',
      };
      const reviewColors: Record<string, string> = {
        APPROVED: 'charts.green',
        CHANGES_REQUESTED: 'charts.red',
        REVIEW_REQUIRED: 'charts.yellow',
      };
      reviewsItem.iconPath = new vscode.ThemeIcon(
        reviewIcons[pr.reviewDecision || ''] || 'comment-discussion',
        pr.reviewDecision ? new vscode.ThemeColor(reviewColors[pr.reviewDecision] || 'foreground') : undefined
      );
      reviewsItem.description = pr.reviewDecision
        ? pr.reviewDecision.replace(/_/g, ' ').toLowerCase()
        : '';
      items.push(reviewsItem);
    }

    // Lakebase CI branch — from SCM state (second item)
    if (states.length > 1) {
      const ciState = states[1];
      const name = decodeURIComponent(ciState.resourceUri.path.split('/').pop() || '');
      const ciItem = new PrTreeItem(name, vscode.TreeItemCollapsibleState.None, 'ciBranch');
      ciItem.iconPath = ciState.decorations?.iconPath;
      ciItem.tooltip = ciState.decorations?.tooltip;
      ciItem.command = ciState.command;
      items.push(ciItem);
    }

    return items;
  }

  private async getCheckItems(): Promise<PrTreeItem[]> {
    const pr = await this.getPr();
    if (!pr) { return []; }

    return pr.checks.map(check => {
      const item = new PrTreeItem(check.name, vscode.TreeItemCollapsibleState.None, 'check');

      const conclusionIcons: Record<string, string> = {
        SUCCESS: 'pass-filled', NEUTRAL: 'pass', SKIPPED: 'debug-step-over',
        FAILURE: 'error', ERROR: 'error', ACTION_REQUIRED: 'warning',
      };
      const conclusionColors: Record<string, string> = {
        SUCCESS: 'charts.green', NEUTRAL: 'foreground', SKIPPED: 'disabledForeground',
        FAILURE: 'charts.red', ERROR: 'charts.red', ACTION_REQUIRED: 'charts.yellow',
      };

      const conclusion = check.conclusion || check.status;
      item.iconPath = new vscode.ThemeIcon(
        conclusionIcons[conclusion] || 'loading~spin',
        new vscode.ThemeColor(conclusionColors[conclusion] || 'charts.yellow')
      );
      item.description = (conclusion || 'pending').toLowerCase();
      item.tooltip = `${check.name}: ${(conclusion || 'pending').toLowerCase()}`;

      if (check.detailsUrl) {
        item.command = { command: 'vscode.open', title: 'View Details', arguments: [vscode.Uri.parse(check.detailsUrl)] };
      }

      return item;
    });
  }

  private async getFileItems(): Promise<PrTreeItem[]> {
    if (!this.gitService) { return []; }

    try {
      const files = await this.gitService.getPullRequestFiles();
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

      return files.map(file => {
        const fileName = file.path.split('/').pop() || file.path;
        const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';
        const item = new PrTreeItem(fileName, vscode.TreeItemCollapsibleState.None, 'file');

        const statusIcons: Record<string, string> = { added: 'diff-added', modified: 'diff-modified', deleted: 'diff-removed', renamed: 'diff-renamed' };
        const statusColors: Record<string, string> = { added: 'charts.green', modified: 'charts.yellow', deleted: 'charts.red', renamed: 'charts.blue' };

        item.iconPath = new vscode.ThemeIcon(
          statusIcons[file.status] || 'file',
          new vscode.ThemeColor(statusColors[file.status] || 'foreground')
        );
        item.description = dir;
        item.tooltip = `${file.status}: ${file.path}\n+${file.additions} −${file.deletions}`;

        // Open diff for the file
        if (root && file.status !== 'deleted') {
          const fileUri = vscode.Uri.file(`${root}/${file.path}`);
          if (file.status === 'added') {
            item.command = { command: 'vscode.open', title: 'Open File', arguments: [fileUri] };
          } else {
            const baseUri = vscode.Uri.parse(`lakebase-git-base://merge-base/${file.path}`);
            item.command = { command: 'vscode.diff', title: 'Show Diff', arguments: [baseUri, fileUri, `${file.path} (base ↔ PR)`] };
          }
        } else if (file.status === 'deleted') {
          const baseUri = vscode.Uri.parse(`lakebase-git-base://merge-base/${file.path}`);
          item.command = { command: 'vscode.open', title: 'View Deleted', arguments: [baseUri] };
        }

        return item;
      });
    } catch {
      return [new PrTreeItem('Unable to load files', vscode.TreeItemCollapsibleState.None)];
    }
  }

  private async getReviewItems(): Promise<PrTreeItem[]> {
    if (!this.gitService) { return []; }

    try {
      const reviews = await this.gitService.getPullRequestReviews();
      if (reviews.length === 0) {
        const item = new PrTreeItem('No reviews yet', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('comment', new vscode.ThemeColor('disabledForeground'));
        return [item];
      }

      return reviews.map(review => {
        const stateLabels: Record<string, string> = {
          APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested',
          COMMENTED: 'commented', PENDING: 'pending', DISMISSED: 'dismissed',
        };
        const stateIcons: Record<string, string> = {
          APPROVED: 'pass-filled', CHANGES_REQUESTED: 'error',
          COMMENTED: 'comment', PENDING: 'loading~spin', DISMISSED: 'circle-slash',
        };
        const stateColors: Record<string, string> = {
          APPROVED: 'charts.green', CHANGES_REQUESTED: 'charts.red',
          COMMENTED: 'foreground', PENDING: 'charts.yellow', DISMISSED: 'disabledForeground',
        };

        const label = `${review.author}`;
        const item = new PrTreeItem(label, vscode.TreeItemCollapsibleState.None, 'review');
        item.iconPath = new vscode.ThemeIcon(
          stateIcons[review.state] || 'comment',
          new vscode.ThemeColor(stateColors[review.state] || 'foreground')
        );
        item.description = stateLabels[review.state] || review.state.toLowerCase();
        if (review.body) {
          item.tooltip = `${review.author} (${item.description}):\n${review.body}`;
        } else {
          item.tooltip = `${review.author}: ${item.description}`;
        }
        return item;
      });
    } catch {
      return [new PrTreeItem('Unable to load reviews', vscode.TreeItemCollapsibleState.None)];
    }
  }
}
