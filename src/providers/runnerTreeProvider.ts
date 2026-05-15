import * as vscode from 'vscode';
import { RunnerService } from '../services/runnerService';
import { GitService } from '../services/gitService';
import { getConfig } from '../utils/config';

class RunnerItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly itemType: 'status' | 'action' | 'run' | 'info',
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
  }
}

export class RunnerTreeProvider implements vscode.TreeDataProvider<RunnerItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RunnerItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private gitService: GitService) {}

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  getTreeItem(element: RunnerItem): vscode.TreeItem { return element; }

  async getChildren(element?: RunnerItem): Promise<RunnerItem[]> {
    if (element?.itemType === 'info' && element.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
      return this.getWorkflowRuns();
    }
    if (element) { return []; }
    return this.getRootItems();
  }

  private getRootItems(): RunnerItem[] {
    const config = getConfig();
    if (!config.lakebaseProjectId) {
      const item = new RunnerItem('No project configured', 'info');
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    const runnerService = new RunnerService();
    const info = runnerService.getRunnerInfo(config.lakebaseProjectId);
    const items: RunnerItem[] = [];

    if (!info) {
      const item = new RunnerItem('No runner configured', 'info');
      item.iconPath = new vscode.ThemeIcon('info');
      item.tooltip = 'Run "Lakebase: Start CI Runner" to set up a runner';
      item.command = { command: 'lakebaseSync.startRunner', title: 'Start Runner' };
      items.push(item);
      return items;
    }

    // Status
    const statusItem = new RunnerItem(info.online ? 'Running' : 'Stopped', 'status');
    statusItem.iconPath = new vscode.ThemeIcon(
      info.online ? 'pass-filled' : 'circle-slash',
      new vscode.ThemeColor(info.online ? 'charts.green' : 'charts.red')
    );
    statusItem.description = info.online && info.pid ? `PID ${info.pid}` : '';
    statusItem.tooltip = info.online
      ? `Runner "${info.name}" is online and listening for workflow jobs`
      : `Runner "${info.name}" is stopped`;
    items.push(statusItem);

    // Start / Stop action
    if (info.online) {
      const stopItem = new RunnerItem('Stop Runner', 'action');
      stopItem.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('charts.red'));
      stopItem.command = { command: 'lakebaseSync.stopRunner', title: 'Stop Runner' };
      items.push(stopItem);
    } else {
      const startItem = new RunnerItem('Start Runner', 'action');
      startItem.iconPath = new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green'));
      startItem.command = { command: 'lakebaseSync.startRunner', title: 'Start Runner' };
      items.push(startItem);
    }

    // Runner log
    const logFile = runnerService.getLatestLogFile(config.lakebaseProjectId);
    if (logFile) {
      const logItem = new RunnerItem('Runner Log', 'action');
      logItem.iconPath = new vscode.ThemeIcon('output');
      logItem.tooltip = logFile;
      logItem.command = { command: 'vscode.open', title: 'Open Log', arguments: [vscode.Uri.file(logFile)] };
      items.push(logItem);
    }

    // Worker log
    const workerLog = runnerService.getLatestWorkerLog(config.lakebaseProjectId);
    if (workerLog) {
      const workerItem = new RunnerItem('Job Log', 'action');
      workerItem.iconPath = new vscode.ThemeIcon('terminal');
      workerItem.tooltip = workerLog;
      workerItem.command = { command: 'vscode.open', title: 'Open Worker Log', arguments: [vscode.Uri.file(workerLog)] };
      items.push(workerItem);
    }

    // Recent Runs (collapsible)
    const runsItem = new RunnerItem('Recent Runs', 'info', vscode.TreeItemCollapsibleState.Collapsed);
    runsItem.iconPath = new vscode.ThemeIcon('history');
    items.push(runsItem);

    // Runner name
    const nameItem = new RunnerItem(info.name, 'info');
    nameItem.iconPath = new vscode.ThemeIcon('server');
    nameItem.description = 'self-hosted';
    items.push(nameItem);

    return items;
  }

  private async getWorkflowRuns(): Promise<RunnerItem[]> {
    let fullRepoName = '';
    try {
      const repoUrl = await this.gitService.getGitHubUrl();
      const m = repoUrl.match(/github\.com\/(.+)/);
      if (m) { fullRepoName = m[1]; }
    } catch {}

    if (!fullRepoName) {
      const item = new RunnerItem('No GitHub remote', 'info');
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    const runnerService = new RunnerService();
    const runs = runnerService.getRecentWorkflowRuns(fullRepoName, 5);
    if (runs.length === 0) {
      const item = new RunnerItem('No workflow runs yet', 'info');
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    return runs.map(run => {
      const statusIcons: Record<string, string> = {
        completed: run.conclusion === 'success' ? 'pass' : run.conclusion === 'failure' ? 'error' : 'warning',
        in_progress: 'loading~spin',
        queued: 'clock',
      };
      const statusColors: Record<string, string> = {
        success: 'charts.green',
        failure: 'charts.red',
        cancelled: 'charts.yellow',
      };
      const icon = statusIcons[run.status] || 'circle-outline';
      const color = statusColors[run.conclusion] || 'foreground';

      const runItem = new RunnerItem(`${run.name} #${run.id.toString().slice(-4)}`, 'run');
      runItem.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      runItem.description = `${run.branch} · ${run.conclusion || run.status}`;
      runItem.tooltip = `${run.name}\nBranch: ${run.branch}\nEvent: ${run.event}\nStatus: ${run.status}\nConclusion: ${run.conclusion || 'pending'}`;
      runItem.command = {
        command: 'vscode.open',
        title: 'View Run',
        arguments: [vscode.Uri.parse(`https://github.com/${fullRepoName}/actions/runs/${run.id}`)],
      };
      return runItem;
    });
  }
}
