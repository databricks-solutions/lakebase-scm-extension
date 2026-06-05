import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RunnerService } from '../services/runnerService';
import { GitService } from '../services/gitService';
import { GitHubService } from '../services/githubService';
import { getConfig } from '../utils/config';
import { workflowRunStyle } from '../utils/statusPresentation';

// FEIP-7480: the runner pane shows ONLY the open workspace's project.
// Two sub-sections, each a top-level entry:
//
//   - "Self-hosted runner"  -> the kit-registered runner at
//                              ~/.lakebase/runners/<projectId>/. Status,
//                              Start/Stop, Remove, log links.
//   - "GitHub Actions"      -> recent workflow runs for this project's
//                              repo. Captures the GitHub-hosted side:
//                              github-hosted runners are ephemeral
//                              (spawned per-job from the shared pool),
//                              so 'currently running' on github surface
//                              as in_progress / queued workflow runs.
//
// If no project is configured in the workspace, both sections collapse
// into one "No project configured" hint.
//
// Auto-refresh: extension.ts watches ~/.lakebase/runners/<projectId>/
// for the open workspace's runner + the workspace's .env, both fire
// refresh() so externally-registered runners + projectId changes
// appear without manual action.

type SectionKind = 'self-hosted' | 'github-hosted';

class SectionItem extends vscode.TreeItem {
  constructor(
    public readonly kind: SectionKind,
    public readonly projectName: string,
    public readonly ownerRepo: string,
  ) {
    super(
      kind === 'self-hosted' ? 'Self-hosted runner' : 'GitHub Actions',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.contextValue = `lakebaseRunnerSection.${kind}`;
    this.iconPath = new vscode.ThemeIcon(kind === 'self-hosted' ? 'server' : 'cloud');
    this.description = projectName;
    this.tooltip =
      kind === 'self-hosted'
        ? `Local kit-registered runner for ${projectName}`
        : `GitHub Actions workflow runs for ${ownerRepo || projectName}`;
  }
}

class LeafItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly itemType: 'status' | 'action' | 'run' | 'info',
    public readonly parent?: SectionItem,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsibleState);
  }
}

type AnyItem = SectionItem | LeafItem;

export class RunnerTreeProvider implements vscode.TreeDataProvider<AnyItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AnyItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private gitService: GitService,
    private githubService: GitHubService,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: AnyItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AnyItem): Promise<AnyItem[]> {
    if (!element) {
      return this.getRootSections();
    }
    if (element instanceof SectionItem) {
      return element.kind === 'self-hosted'
        ? this.getSelfHostedChildren(element)
        : this.getGitHubChildren(element);
    }
    return [];
  }

  /**
   * Top level: two sections (self-hosted, github-hosted) scoped to the
   * open workspace's project. When no project is configured, return a
   * single info leaf instead of empty sections.
   */
  private async getRootSections(): Promise<AnyItem[]> {
    const config = getConfig();
    if (!config.lakebaseProjectId) {
      const item = new LeafItem('No project configured', 'info');
      item.iconPath = new vscode.ThemeIcon('info');
      item.tooltip =
        'Open a Lakebase-paired workspace (one with LAKEBASE_PROJECT_ID in .env) to see its CI runner status.';
      return [item];
    }

    let ownerRepo = '';
    try {
      ownerRepo = await this.gitService.getOwnerRepo();
    } catch {
      // best-effort; if there is no github remote, the github section
      // renders an inline "no remote" leaf rather than disappearing
    }

    return [
      new SectionItem('self-hosted', config.lakebaseProjectId, ownerRepo),
      new SectionItem('github-hosted', config.lakebaseProjectId, ownerRepo),
    ];
  }

  /**
   * Self-hosted runner section. Shows the kit-registered runner for this
   * project; status, Start / Stop, Remove, log links.
   */
  private getSelfHostedChildren(section: SectionItem): LeafItem[] {
    const items: LeafItem[] = [];
    const runnerService = new RunnerService(this.githubService);
    const info = runnerService.getRunnerInfo(section.projectName);

    if (!info) {
      const it = new LeafItem('No runner configured', 'info', section);
      it.iconPath = new vscode.ThemeIcon('info');
      it.tooltip =
        `No runner registered for "${section.projectName}".\n` +
        'Run "Lakebase: Start CI Runner" to register one with the kit.';
      it.command = { command: 'lakebaseSync.startRunner', title: 'Start Runner' };
      items.push(it);
      return items;
    }

    // Status
    const statusItem = new LeafItem(info.online ? 'Running' : 'Stopped', 'status', section);
    statusItem.iconPath = new vscode.ThemeIcon(
      info.online ? 'pass-filled' : 'circle-slash',
      new vscode.ThemeColor(info.online ? 'charts.green' : 'charts.red'),
    );
    statusItem.description = info.online && info.pid ? `PID ${info.pid}` : '';
    statusItem.tooltip = info.online
      ? `Runner "${info.name}" is online and listening for workflow jobs`
      : `Runner "${info.name}" is stopped`;
    items.push(statusItem);

    // Start / Stop
    if (info.online) {
      const stopItem = new LeafItem('Stop Runner', 'action', section);
      stopItem.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('charts.red'));
      stopItem.command = { command: 'lakebaseSync.stopRunner', title: 'Stop Runner' };
      items.push(stopItem);
    } else {
      const startItem = new LeafItem('Start Runner', 'action', section);
      startItem.iconPath = new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green'));
      startItem.command = { command: 'lakebaseSync.startRunner', title: 'Start Runner' };
      items.push(startItem);
    }

    // Remove (always available; the command confirms via modal)
    const removeItem = new LeafItem('Remove Runner', 'action', section);
    removeItem.iconPath = new vscode.ThemeIcon('trash', new vscode.ThemeColor('charts.red'));
    removeItem.tooltip = 'Stop, deregister from GitHub, and delete the runner directory';
    removeItem.command = {
      command: 'lakebaseSync.removeRunner',
      title: 'Remove Runner',
      arguments: [section.projectName, section.ownerRepo],
    };
    items.push(removeItem);

    // Logs
    const logFile = runnerService.getLatestLogFile(section.projectName);
    if (logFile) {
      const logItem = new LeafItem('Runner Log', 'action', section);
      logItem.iconPath = new vscode.ThemeIcon('output');
      logItem.tooltip = logFile;
      logItem.command = {
        command: 'vscode.open',
        title: 'Open Log',
        arguments: [vscode.Uri.file(logFile)],
      };
      items.push(logItem);
    }
    const workerLog = runnerService.getLatestWorkerLog(section.projectName);
    if (workerLog) {
      const workerItem = new LeafItem('Job Log', 'action', section);
      workerItem.iconPath = new vscode.ThemeIcon('terminal');
      workerItem.tooltip = workerLog;
      workerItem.command = {
        command: 'vscode.open',
        title: 'Open Worker Log',
        arguments: [vscode.Uri.file(workerLog)],
      };
      items.push(workerItem);
    }

    // Runner name
    const nameItem = new LeafItem(info.name, 'info', section);
    nameItem.iconPath = new vscode.ThemeIcon('server');
    nameItem.description = 'self-hosted';
    items.push(nameItem);

    return items;
  }

  /**
   * GitHub Actions section. Recent workflow runs for this project's
   * repo. Captures the github-hosted runner activity since github-hosted
   * runners are ephemeral (no persistent registration to enumerate);
   * what you see is in-progress / queued / completed runs.
   */
  private async getGitHubChildren(section: SectionItem): Promise<LeafItem[]> {
    if (!section.ownerRepo) {
      const item = new LeafItem('No GitHub remote', 'info', section);
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }
    const runnerService = new RunnerService(this.githubService);
    let runs: Awaited<ReturnType<RunnerService['getRecentWorkflowRuns']>> = [];
    try {
      runs = await runnerService.getRecentWorkflowRuns(section.ownerRepo, 5);
    } catch {
      const item = new LeafItem('Could not reach GitHub', 'info', section);
      item.iconPath = new vscode.ThemeIcon('warning');
      return [item];
    }
    if (runs.length === 0) {
      const item = new LeafItem('No workflow runs yet', 'info', section);
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    return runs.map((run) => {
      const { icon, color } = workflowRunStyle(run.status, run.conclusion);

      const runItem = new LeafItem(
        `${run.name} #${run.id.toString().slice(-4)}`,
        'run',
        section,
      );
      runItem.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color || 'foreground'));
      runItem.description = `${run.branch} · ${run.conclusion || run.status}`;
      runItem.tooltip = `${run.name}\nBranch: ${run.branch}\nEvent: ${run.event}\nStatus: ${run.status}\nConclusion: ${run.conclusion || 'pending'}`;
      runItem.command = {
        command: 'vscode.open',
        title: 'View Run',
        arguments: [vscode.Uri.parse(`https://github.com/${section.ownerRepo}/actions/runs/${run.id}`)],
      };
      return runItem;
    });
  }
}
