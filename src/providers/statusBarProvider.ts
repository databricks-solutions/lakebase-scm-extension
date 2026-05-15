import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { LakebaseService, LakebaseBranch } from '../services/lakebaseService';
import { SchemaMigrationService } from '../services/schemaMigrationService';
import { isMainBranch, isStagingBranch } from '../utils/theme';
import { getConfig } from '../utils/config';

type SyncState = 'synced' | 'pending' | 'error' | 'loading' | 'unavailable' | 'auth_error';

export class StatusBarProvider {
  private dbItem: vscode.StatusBarItem;
  private gitService: GitService;
  private lakebaseService: LakebaseService;
  private migrationService: SchemaMigrationService;
  private currentLakebaseBranch: LakebaseBranch | undefined;
  private _suppressRefresh = false;

  constructor(
    gitService: GitService,
    lakebaseService: LakebaseService,
    migrationService: SchemaMigrationService
  ) {
    this.gitService = gitService;
    this.lakebaseService = lakebaseService;
    this.migrationService = migrationService;

    this.dbItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      90
    );
    this.dbItem.command = 'lakebaseSync.showBranchStatus';
    this.dbItem.show();

    this.gitService.onBranchChanged(() => this.refresh());
  }

  set suppressRefresh(value: boolean) {
    this._suppressRefresh = value;
  }

  async refresh(): Promise<void> {
    if (this._suppressRefresh) {
      return;
    }
    const gitBranch = this.gitService.getCachedBranch() || await this.gitService.getCurrentBranch();

    if (!gitBranch) {
      this.setState('unavailable', 'No git branch');
      return;
    }

    this.setState('loading', gitBranch);

    try {
      const cfg = getConfig();
      const isMain = isMainBranch(gitBranch, cfg.trunkBranch);
      const isStaging = !isMain && isStagingBranch(gitBranch, cfg.stagingBranch);
      let lbBranch: LakebaseBranch | undefined;

      if (isMain) {
        lbBranch = await this.lakebaseService.getDefaultBranch();
      } else if (isStaging) {
        lbBranch = await this.lakebaseService.getBranchByName('staging');
      } else {
        lbBranch = await this.lakebaseService.getBranchByName(gitBranch);
      }

      this.currentLakebaseBranch = lbBranch;
      const migrationVersion = this.migrationService.getLatestVersion() || '?';

      if (lbBranch) {
        const state: SyncState = lbBranch.state === 'READY' ? 'synced' : 'pending';
        const label = isMain
          ? 'default'
          : isStaging
            ? 'staging'
            : this.lakebaseService.sanitizeBranchName(gitBranch);
        this.setState(state, label, `V${migrationVersion}`);
      } else {
        this.setState('error', this.lakebaseService.sanitizeBranchName(gitBranch), `V${migrationVersion}`);
      }
    } catch (err: any) {
      const isAuth = (err as any).isAuthError === true ||
        err.message?.includes('project id not found') ||
        err.message?.includes('not authenticated') ||
        err.message?.includes('401');
      if (isAuth) {
        this.setState('auth_error', gitBranch, undefined, 'Click to login: ' + err.message);
      } else {
        this.setState('error', gitBranch, undefined, err.message);
      }

    }
  }

  private setState(state: SyncState, branchLabel: string, version?: string, tooltip?: string): void {
    const icons: Record<SyncState, string> = {
      synced: '$(database)',
      pending: '$(loading~spin)',
      error: '$(warning)',
      loading: '$(loading~spin)',
      unavailable: '$(circle-slash)',
      auth_error: '$(key)',
    };

    const stateLabels: Record<SyncState, string> = {
      synced: 'Synced',
      pending: 'Pending',
      error: 'No DB Branch',
      loading: 'Loading...',
      unavailable: 'N/A',
      auth_error: 'Login Required',
    };

    const icon = icons[state];
    const versionSuffix = version ? ` | ${version}` : '';
    this.dbItem.text = `${icon} ${branchLabel}${versionSuffix} | ${stateLabels[state]}`;
    this.dbItem.tooltip = tooltip || `Lakebase: ${branchLabel} (${stateLabels[state]})`;

    this.dbItem.command = state === 'auth_error' ? 'lakebaseSync.connectWorkspace' : 'lakebaseSync.showBranchStatus';

    const colors: Partial<Record<SyncState, vscode.ThemeColor>> = {
      error: new vscode.ThemeColor('statusBarItem.warningBackground'),
      auth_error: new vscode.ThemeColor('statusBarItem.errorBackground'),
    };
    this.dbItem.backgroundColor = colors[state];
  }

  getCurrentLakebaseBranch(): LakebaseBranch | undefined {
    return this.currentLakebaseBranch;
  }

  dispose(): void {
    this.dbItem.dispose();
  }
}
