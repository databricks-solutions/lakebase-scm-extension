import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RunnerService } from '../services/runnerService';
import { GitService } from '../services/gitService';
import { GitHubService } from '../services/githubService';
import { getConfig } from '../utils/config';

// FEIP-7480: the tree enumerates EVERY paired project this machine has,
// not just the currently-open workspace's project. Discovery:
//   - All directories under ~/.lakebase/runners/ are self-hosted runners
//     registered by the kit's setupRunner. Each is one top-level entry.
//   - If the currently-open workspace has a .env with LAKEBASE_PROJECT_ID
//     but is NOT in the runners dir, it's added as a github-hosted virtual
//     entry (the scaffold wired runs-on: ubuntu-latest, no local runner).
//
// Per-project entries are collapsible. Children are the existing per-
// project items (status, start/stop, logs, recent runs). Start/Stop
// actions are gated to the entry matching the open workspace's
// projectId since the underlying commands act on the workspace context.

type ProjectMode = 'self-hosted' | 'github-hosted';

class ProjectItem extends vscode.TreeItem {
  constructor(
    public readonly projectName: string,
    public readonly mode: ProjectMode,
    public readonly ownerRepo: string,
    public readonly isOpenWorkspace: boolean,
  ) {
    super(projectName, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = `lakebaseProject.${mode}`;
    this.description = mode === 'self-hosted' ? 'self-hosted' : 'github-hosted';
    this.iconPath = new vscode.ThemeIcon(
      mode === 'self-hosted' ? 'server' : 'cloud',
    );
    this.tooltip = ownerRepo
      ? `${projectName}\n${mode} CI · ${ownerRepo}`
      : `${projectName}\n${mode} CI`;
  }
}

class LeafItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly itemType: 'status' | 'action' | 'run' | 'info' | 'runs-group',
    public readonly parentProject?: ProjectItem,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsibleState);
  }
}

type AnyItem = ProjectItem | LeafItem;

const RUNNERS_ROOT = path.join(os.homedir(), '.lakebase', 'runners');

/** Read the actions-runner config in a runner dir to extract its repo URL. */
function readRunnerRepo(runnerDirPath: string): string {
  try {
    const cfg = path.join(runnerDirPath, '.runner');
    if (!fs.existsSync(cfg)) return '';
    const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8')) as { gitHubUrl?: string };
    const url = parsed.gitHubUrl ?? '';
    const m = url.match(/github\.com\/(.+?)\/?$/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** Best-effort discovery of self-hosted projects from ~/.lakebase/runners/. */
function discoverSelfHostedProjects(): Array<{ projectName: string; ownerRepo: string }> {
  if (!fs.existsSync(RUNNERS_ROOT)) return [];
  const out: Array<{ projectName: string; ownerRepo: string }> = [];
  for (const name of fs.readdirSync(RUNNERS_ROOT)) {
    const dir = path.join(RUNNERS_ROOT, name);
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({ projectName: name, ownerRepo: readRunnerRepo(dir) });
  }
  out.sort((a, b) => a.projectName.localeCompare(b.projectName));
  return out;
}

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
      return this.getRootProjects();
    }
    if (element instanceof ProjectItem) {
      return this.getProjectChildren(element);
    }
    if (element instanceof LeafItem && element.itemType === 'runs-group' && element.parentProject) {
      return this.getWorkflowRuns(element.parentProject);
    }
    return [];
  }

  /**
   * Top-level: one entry per project the user might care about.
   *   - Every dir under ~/.lakebase/runners/  -> self-hosted
   *   - The currently-open workspace's project (if not already in that
   *     dir + has a .env with LAKEBASE_PROJECT_ID) -> github-hosted virtual
   */
  private async getRootProjects(): Promise<AnyItem[]> {
    const items: AnyItem[] = [];
    const selfHosted = discoverSelfHostedProjects();
    const seen = new Set<string>();

    for (const sh of selfHosted) {
      items.push(new ProjectItem(sh.projectName, 'self-hosted', sh.ownerRepo, false));
      seen.add(sh.projectName);
    }

    const config = getConfig();
    if (config.lakebaseProjectId && !seen.has(config.lakebaseProjectId)) {
      let ownerRepo = '';
      try {
        const repoUrl = await this.gitService.getGitHubUrl();
        const m = repoUrl.match(/github\.com\/(.+?)\/?$/);
        if (m) ownerRepo = m[1];
      } catch {}
      items.push(
        new ProjectItem(config.lakebaseProjectId, 'github-hosted', ownerRepo, true),
      );
    } else if (config.lakebaseProjectId && seen.has(config.lakebaseProjectId)) {
      // The open workspace IS a self-hosted project; mark its existing
      // entry so start/stop actions can be gated on isOpenWorkspace.
      const existing = items.find(
        (it) => it instanceof ProjectItem && it.projectName === config.lakebaseProjectId,
      ) as ProjectItem | undefined;
      if (existing) {
        // Replace in place with an isOpenWorkspace-flagged copy.
        const replaced = new ProjectItem(
          existing.projectName,
          existing.mode,
          existing.ownerRepo,
          true,
        );
        const idx = items.indexOf(existing);
        items[idx] = replaced;
      }
    }

    if (items.length === 0) {
      const empty = new LeafItem('No paired projects found', 'info');
      empty.iconPath = new vscode.ThemeIcon('info');
      empty.tooltip =
        `Scan dir: ${RUNNERS_ROOT}\n\n` +
        'Run "Lakebase: Start CI Runner" in a paired workspace, or scaffold a new project with lakebase-create-project.';
      return [empty];
    }

    return items;
  }

  /**
   * Children of a top-level project entry. Mirrors the prior single-
   * project layout: status + start/stop action + logs + recent runs.
   */
  private getProjectChildren(project: ProjectItem): AnyItem[] {
    const items: LeafItem[] = [];

    if (project.mode === 'self-hosted') {
      const runnerService = new RunnerService(this.githubService);
      const info = runnerService.getRunnerInfo(project.projectName);

      if (!info) {
        const it = new LeafItem('Runner directory exists but config missing', 'info', project);
        it.iconPath = new vscode.ThemeIcon('warning');
        return [it];
      }

      // Status
      const statusItem = new LeafItem(info.online ? 'Running' : 'Stopped', 'status', project);
      statusItem.iconPath = new vscode.ThemeIcon(
        info.online ? 'pass-filled' : 'circle-slash',
        new vscode.ThemeColor(info.online ? 'charts.green' : 'charts.red'),
      );
      statusItem.description = info.online && info.pid ? `PID ${info.pid}` : '';
      statusItem.tooltip = info.online
        ? `Runner "${info.name}" is online and listening for workflow jobs`
        : `Runner "${info.name}" is stopped`;
      items.push(statusItem);

      // Start / Stop. Only show for the open workspace's project (the
      // underlying commands read getConfig() and act on the workspace
      // context; surfacing them on other projects would lie).
      if (project.isOpenWorkspace) {
        if (info.online) {
          const stopItem = new LeafItem('Stop Runner', 'action', project);
          stopItem.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('charts.red'));
          stopItem.command = { command: 'lakebaseSync.stopRunner', title: 'Stop Runner' };
          items.push(stopItem);
        } else {
          const startItem = new LeafItem('Start Runner', 'action', project);
          startItem.iconPath = new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green'));
          startItem.command = { command: 'lakebaseSync.startRunner', title: 'Start Runner' };
          items.push(startItem);
        }
      }

      // Remove Runner. Available on every self-hosted project entry so a
      // user can clean up stale runners for projects whose workspace they
      // no longer have open. The command itself confirms via a modal
      // dialog before stopping + deregistering + deleting on-disk dir.
      const removeItem = new LeafItem('Remove Runner', 'action', project);
      removeItem.iconPath = new vscode.ThemeIcon('trash', new vscode.ThemeColor('charts.red'));
      removeItem.tooltip = 'Stop, deregister from GitHub, and delete the runner directory';
      removeItem.command = {
        command: 'lakebaseSync.removeRunner',
        title: 'Remove Runner',
        arguments: [project.projectName, project.ownerRepo],
      };
      items.push(removeItem);

      // Logs
      const logFile = runnerService.getLatestLogFile(project.projectName);
      if (logFile) {
        const logItem = new LeafItem('Runner Log', 'action', project);
        logItem.iconPath = new vscode.ThemeIcon('output');
        logItem.tooltip = logFile;
        logItem.command = { command: 'vscode.open', title: 'Open Log', arguments: [vscode.Uri.file(logFile)] };
        items.push(logItem);
      }
      const workerLog = runnerService.getLatestWorkerLog(project.projectName);
      if (workerLog) {
        const workerItem = new LeafItem('Job Log', 'action', project);
        workerItem.iconPath = new vscode.ThemeIcon('terminal');
        workerItem.tooltip = workerLog;
        workerItem.command = { command: 'vscode.open', title: 'Open Worker Log', arguments: [vscode.Uri.file(workerLog)] };
        items.push(workerItem);
      }

      // Runner name
      const nameItem = new LeafItem(info.name, 'info', project);
      nameItem.iconPath = new vscode.ThemeIcon('server');
      nameItem.description = 'self-hosted';
      items.push(nameItem);
    } else {
      // github-hosted virtual entry. Status = last run conclusion (rendered
      // when Recent Runs expands; root-level just shows "github-hosted").
      const statusItem = new LeafItem('github-hosted pool', 'status', project);
      statusItem.iconPath = new vscode.ThemeIcon('cloud');
      statusItem.description = '(no local runner)';
      statusItem.tooltip =
        'Jobs run on GitHub-hosted runners. No local runner to start / stop.';
      items.push(statusItem);
    }

    // Recent Runs (collapsible). Always available when we have an ownerRepo.
    if (project.ownerRepo) {
      const runsItem = new LeafItem('Recent Runs', 'runs-group', project, vscode.TreeItemCollapsibleState.Collapsed);
      runsItem.iconPath = new vscode.ThemeIcon('history');
      items.push(runsItem);
    }

    return items;
  }

  private async getWorkflowRuns(project: ProjectItem): Promise<LeafItem[]> {
    if (!project.ownerRepo) {
      const item = new LeafItem('No GitHub remote', 'info', project);
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }
    const runnerService = new RunnerService(this.githubService);
    const runs = await runnerService.getRecentWorkflowRuns(project.ownerRepo, 5);
    if (runs.length === 0) {
      const item = new LeafItem('No workflow runs yet', 'info', project);
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    return runs.map((run) => {
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

      const runItem = new LeafItem(`${run.name} #${run.id.toString().slice(-4)}`, 'run', project);
      runItem.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      runItem.description = `${run.branch} · ${run.conclusion || run.status}`;
      runItem.tooltip = `${run.name}\nBranch: ${run.branch}\nEvent: ${run.event}\nStatus: ${run.status}\nConclusion: ${run.conclusion || 'pending'}`;
      runItem.command = {
        command: 'vscode.open',
        title: 'View Run',
        arguments: [vscode.Uri.parse(`https://github.com/${project.ownerRepo}/actions/runs/${run.id}`)],
      };
      return runItem;
    });
  }
}
