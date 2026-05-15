import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getWorkspaceRoot } from '../utils/config';
import { LakebaseService, LakebaseBranch } from '../services/lakebaseService';
import { GitService } from '../services/gitService';
import { GraphService } from '../services/graphService';
import { SchemaMigrationService } from '../services/schemaMigrationService';
import { buildDiffTuples, sortMigrationsToEnd, DiffTuple } from '../utils/diffBuilder';

interface Commit {
  sha: string;
  fullSha: string;
  parents: string[];
  refs: string[];
  message: string;
  fullMessage: string;
  author: string;
  authorEmail: string;
  date: string;       // absolute date string
  time: string;       // relative time ("3 days ago")
  stats: string;      // e.g. "3 files changed, 10 insertions(+), 2 deletions(-)"
  avatarUrl: string;  // GitHub avatar or Gravatar fallback
  isHead: boolean;
  isMerge: boolean;
  syncKind?: 'incoming' | 'outgoing';
}

interface SwimlaneNode { id: string; color: string; }

interface RowVM {
  commit: Commit;
  inputSwimlanes: SwimlaneNode[];
  outputSwimlanes: SwimlaneNode[];
  kind: 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes';
}

// VS Code exact constants
const SLH = 22;  // SWIMLANE_HEIGHT
const SLW = 11;  // SWIMLANE_WIDTH
const SCR = 5;   // SWIMLANE_CURVE_RADIUS
const CR = 4;    // CIRCLE_RADIUS
const CSW = 2;   // CIRCLE_STROKE_WIDTH

// VS Code graph colors + chartsBlue for current branch
const LANE_COLORS = ['#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF'];
const CHARTS_BLUE = '#4FC1FF';  // chartsBlue — used for HEAD/current ref

function rot(i: number): number { return ((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length; }

export class GraphWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lakebaseService: LakebaseService;
  private gitService: GitService;
  private graphService: GraphService;
  showAllRefs = false;
  graphFilterRefs: string[] | null = null;
  private searchFilter = '';
  private pageSize = 50;
  private loadedCount = 50;

  constructor(private extensionUri: vscode.Uri, lakebaseService: LakebaseService, gitService: GitService) {
    this.lakebaseService = lakebaseService;
    this.gitService = gitService;
    this.graphService = new GraphService(gitService);
  }

  resolveWebviewView(v: vscode.WebviewView): void {
    this.view = v;
    v.webview.options = { enableScripts: true };
    v.webview.onDidReceiveMessage(async (msg) => {
      const root = getWorkspaceRoot();
      switch (msg.type) {
        case 'copy':
          await vscode.env.clipboard.writeText(msg.sha);
          vscode.window.showInformationMessage(`Copied ${msg.sha}`);
          break;
        case 'copyMessage':
          await vscode.env.clipboard.writeText(msg.msg);
          vscode.window.showInformationMessage('Copied commit message');
          break;
        case 'review':
          await this.reviewCommit(msg.sha, msg.msg);
          break;
        case 'getBranches':
          try {
            const branchList = await this.gitService.getBranchesAtCommit(msg.sha);
            if (this.view) { this.view.webview.postMessage({ type: 'branchesData', branches: branchList }); }
          } catch {
            if (this.view) { this.view.webview.postMessage({ type: 'branchesData', branches: [] }); }
          }
          break;
        case 'checkoutBranch':
          if (!msg.branch) break;
          try {
            const branch = msg.branch.replace(/^origin\//, '');
            await this.gitService.checkoutBranch(branch);
            vscode.window.showInformationMessage(`Checked out ${branch}`);
            this.refresh();
          } catch (err: any) { vscode.window.showErrorMessage(`Checkout failed: ${err.message}`); }
          break;
        case 'deleteBranchName':
          if (!msg.branch) break;
          try {
            const confirmDel = await vscode.window.showWarningMessage(`Delete branch "${msg.branch}"?`, { modal: true }, 'Delete');
            if (confirmDel === 'Delete') {
              await this.gitService.deleteBranch(msg.branch);
              vscode.window.showInformationMessage(`Deleted branch ${msg.branch}`);
              this.refresh();
            }
          } catch (err: any) { vscode.window.showErrorMessage(`Delete failed: ${err.message}`); }
          break;
        case 'checkout':
          try {
            await this.gitService.checkoutBranch(msg.sha);
            vscode.window.showInformationMessage(`Checked out ${msg.sha}`);
            this.refresh();
          } catch (err: any) { vscode.window.showErrorMessage(`Checkout failed: ${err.message}`); }
          break;
        case 'checkoutDetached':
          try {
            await this.gitService.checkoutDetached(msg.sha);
            vscode.window.showInformationMessage(`Detached HEAD at ${msg.sha}`);
            this.refresh();
          } catch (err: any) { vscode.window.showErrorMessage(`Checkout failed: ${err.message}`); }
          break;
        case 'openBlame':
          if (!root) break;
          try {
            const commitFiles = await this.gitService.getCommitFiles(msg.sha);
            if (commitFiles.length > 0) {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${root}/${commitFiles[0].path}`));
              await vscode.window.showTextDocument(doc);
              await vscode.commands.executeCommand('gitlens.toggleFileBlame');
            }
          } catch { /* blame not available */ }
          break;
        case 'openGithubCommit':
          try {
            const ghUrlCommit = await this.graphService.getGitHubUrl();
            if (ghUrlCommit) { await vscode.env.openExternal(vscode.Uri.parse(`${ghUrlCommit}/commit/${msg.sha}`)); }
          } catch { /* no remote */ }
          break;
        case 'revert':
          try {
            await this.gitService.revert(msg.sha);
            vscode.window.showInformationMessage(`Reverted ${msg.sha}`);
            this.refresh();
          } catch (err: any) { vscode.window.showErrorMessage(`Revert failed: ${err.message}`); }
          break;
        case 'cherryPick':
          try {
            await this.gitService.cherryPick(msg.sha);
            vscode.window.showInformationMessage(`Cherry-picked ${msg.sha}`);
            this.refresh();
          } catch (err: any) { vscode.window.showErrorMessage(`Cherry-pick failed: ${err.message}`); }
          break;
        case 'createBranch': {
          const name = await vscode.window.showInputBox({ prompt: `Create branch from ${msg.sha}`, placeHolder: 'branch-name' });
          if (!name) break;
          try {
            await this.gitService.checkoutBranch(name, true, msg.sha);
            vscode.window.showInformationMessage(`Created branch ${name}`);
            this.refresh();
          } catch (err: any) { vscode.window.showErrorMessage(`Create branch failed: ${err.message}`); }
          break;
        }
        case 'createTag': {
          const tag = await vscode.window.showInputBox({ prompt: `Create tag at ${msg.sha}`, placeHolder: 'tag-name' });
          if (!tag) break;
          try {
            await this.gitService.createTag(tag, undefined, msg.sha);
            vscode.window.showInformationMessage(`Created tag ${tag}`);
            this.refresh();
          } catch (err: any) { vscode.window.showErrorMessage(`Create tag failed: ${err.message}`); }
          break;
        }
        case 'compareWorking':
          if (!root) break;
          await vscode.commands.executeCommand('vscode.changes', `${msg.sha.substring(0, 7)} ↔ Working Tree`,
            await this.buildComparisonTuples(root, msg.sha, null));
          break;
        case 'compareHead':
          if (!root) break;
          await vscode.commands.executeCommand('vscode.changes', `${msg.sha.substring(0, 7)} ↔ HEAD`,
            await this.buildComparisonTuples(root, msg.sha, 'HEAD'));
          break;
        case 'openGithub':
          try {
            const ghUrlOpen = await this.graphService.getGitHubUrl();
            if (ghUrlOpen) { await vscode.env.openExternal(vscode.Uri.parse(`${ghUrlOpen}/commit/${msg.sha}`)); }
          } catch { /* no remote */ }
          break;
        case 'mailto':
          if (msg.email) { await vscode.env.openExternal(vscode.Uri.parse(`mailto:${msg.email}`)); }
          break;
        case 'fetchSchema':
          if (!root) break;
          try {
            const tables: Array<{name: string; status: string; columns: Array<{name: string; type: string; change: string}>}> = [];
            let noChanges = false;
            let found = false;

            // 1. Try CI comment from PR
            if (msg.pr) {
              try {
                const commentsRaw = await this.gitService.ghApi(`repos/${(await this.gitService.getGitHubUrl()).match(/github\.com\/(.+)/)?.[1] || ''}/issues/${msg.pr}/comments`, undefined, '.[].body');
                const prComments = commentsRaw;
                const schemaComment = prComments.split('\n').find((line: string) =>
                  line.includes('CREATED') || line.includes('MODIFIED') || line.includes('REMOVED') ||
                  line.includes('No schema changes') || line.includes('schema diff'));
                if (schemaComment) {
                  found = true;
                  if (schemaComment.includes('No schema changes')) { noChanges = true; }
                  else {
                    for (const line of prComments.split('\n')) {
                      const tblMatch = line.match(/^[+~-]\s*TABLE\s+(\w+)\s+\((\w+)\)/);
                      if (tblMatch) { tables.push({ name: tblMatch[1], status: tblMatch[2], columns: [] }); continue; }
                      const colMatch = line.match(/^\s+([+-])\s+(\w+)\s+(.+)/);
                      if (colMatch && tables.length > 0) { tables[tables.length - 1].columns.push({ name: colMatch[2], type: colMatch[3], change: colMatch[1] === '+' ? 'add' : 'del' }); continue; }
                      const newColMatch = line.match(/^\s{4}(\w+)\s+(.+)/);
                      if (newColMatch && tables.length > 0) { tables[tables.length - 1].columns.push({ name: newColMatch[1], type: newColMatch[2], change: 'add' }); }
                    }
                  }
                }
              } catch { /* PR comment fetch failed */ }
            }

            // 2. Fallback: parse migration SQL from the commit
            if (!found && msg.sha) {
              const allFiles = await this.gitService.getCommitFiles(msg.sha);
              const migFiles = allFiles.filter((f: any) => /V\d+.*\.sql$/i.test(f.path));

              if (migFiles.length === 0) { noChanges = true; found = true; }
              else {
                found = true;
                const seen = new Set<string>();
                for (const mf of migFiles) {
                  try {
                    const sql = await this.gitService.getFileAtRef(msg.sha, mf.path);
                    const changes = SchemaMigrationService.parseSql(sql);
                    for (const c of changes) {
                      if (seen.has(c.tableName)) {
                        // Merge columns into existing table entry (e.g. ALTER on already-seen table)
                        const existing = tables.find((t: any) => t.name === c.tableName);
                        if (existing && c.columns.length > 0) {
                          existing.columns.push(...c.columns.map(col => ({ name: col.name, type: col.dataType, change: c.type === 'removed' ? 'del' : 'add' })));
                        }
                      } else {
                        seen.add(c.tableName);
                        tables.push({
                          name: c.tableName,
                          status: c.type === 'created' ? 'CREATED' : c.type === 'modified' ? 'MODIFIED' : 'REMOVED',
                          columns: c.columns.map(col => ({ name: col.name, type: col.dataType, change: c.type === 'removed' ? 'del' : 'add' })),
                        });
                      }
                    }
                  } catch { /* skip file */ }
                }
                if (tables.length === 0) { noChanges = true; }
              }
            }

            if (this.view) {
              this.view.webview.postMessage({ type: 'schemaData', sha: msg.sha, tables, noChanges });
            }
          } catch {
            if (this.view) { this.view.webview.postMessage({ type: 'schemaData', sha: msg.sha, tables: [], noChanges: false, error: true }); }
          }
          break;
        case 'openPR':
          if (!msg.number) break;
          try {
            const ghUrlPR = await this.graphService.getGitHubUrl();
            if (ghUrlPR) { await vscode.env.openExternal(vscode.Uri.parse(`${ghUrlPR}/pull/${msg.number}`)); }
          } catch { /* no remote */ }
          break;
        case 'jsError':
          vscode.window.showErrorMessage(`Graph webview JS error: ${msg.msg} (line ${msg.line})`);
          break;
        case 'toggleAllRefs':
          this.showAllRefs = !!msg.value;
          this.refresh();
          break;
        case 'search':
          this.searchFilter = (msg.value || '').toLowerCase();
          this.refresh();
          break;
        case 'loadMore':
          this.loadedCount += this.pageSize;
          this.refresh();
          break;
        case 'refresh':
          this.loadedCount = this.pageSize;
          this.refresh();
          break;
      }
    });
    this.refresh();
  }

  goToCurrent(): void {
    if (!this.view) { return; }
    this.view.webview.postMessage({ type: 'goToCurrent' });
  }

  async refresh(): Promise<void> {
    if (!this.view) { return; }
    let refArgs = '';
    if (this.graphFilterRefs && this.graphFilterRefs.length > 0) {
      refArgs = ' ' + this.graphFilterRefs.map(r => `"${r}"`).join(' ');
    } else if (this.showAllRefs) {
      refArgs = ' --all';
    }
    let commits = await this.graphService.getCommits(this.loadedCount, refArgs);
    if (this.searchFilter) {
      const q = this.searchFilter;
      commits = commits.filter(c =>
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.sha.toLowerCase().includes(q) ||
        c.refs.some(r => r.toLowerCase().includes(q))
      );
    }

    // Fetch Lakebase branch names for DB indicator
    let lakebaseBranchIds: Set<string> = new Set();
    try {
      const lbBranches = await this.lakebaseService.listBranches();
      lakebaseBranchIds = new Set(lbBranches.map(b => b.branchId));
    } catch { /* no Lakebase connection — skip indicators */ }

    const viewModels = this.buildViewModels(commits);
    this.view.webview.html = this.html(viewModels, lakebaseBranchIds);
  }


  /**
   * Build view models matching VS Code's toISCMHistoryItemViewModelArray logic.
   * Each row has inputSwimlanes and outputSwimlanes with id + color.
   */
  private buildViewModels(commits: Commit[]): RowVM[] {
    let colorIndex = -1;
    const vms: RowVM[] = [];

    for (const commit of commits) {
      const kind: RowVM['kind'] = commit.isHead ? 'HEAD'
        : commit.syncKind === 'outgoing' ? 'outgoing-changes'
        : commit.syncKind === 'incoming' ? 'incoming-changes'
        : 'node';
      const inputSwimlanes = (vms.at(-1)?.outputSwimlanes ?? []).map(n => ({ ...n }));
      const outputSwimlanes: SwimlaneNode[] = [];

      let firstParentAdded = false;

      // Process input swimlanes: if a lane matches this commit, replace it with first parent
      if (commit.parents.length > 0) {
        for (const node of inputSwimlanes) {
          if (node.id === commit.sha) {
            if (!firstParentAdded) {
              // First parent inherits lane — use blue for HEAD, otherwise keep lane color
              const color = commit.isHead ? CHARTS_BLUE : node.color;
              outputSwimlanes.push({ id: commit.parents[0], color });
              firstParentAdded = true;
            }
            continue; // skip duplicate entries of this commit
          }
          outputSwimlanes.push({ ...node });
        }
      }

      // Add remaining parents (first parent if not yet added, plus additional parents)
      for (let i = firstParentAdded ? 1 : 0; i < commit.parents.length; i++) {
        let color: string;
        if (i === 0 && commit.isHead) {
          color = CHARTS_BLUE;
        } else {
          colorIndex = rot(colorIndex + 1);
          color = LANE_COLORS[colorIndex];
        }
        outputSwimlanes.push({ id: commit.parents[i], color });
      }

      vms.push({ commit, inputSwimlanes, outputSwimlanes, kind });
    }

    return vms;
  }

  /**
   * Render SVG for a single row — matching VS Code's renderSCMHistoryItemGraph.
   */
  private renderRowSvg(vm: RowVM): { svg: string; width: number } {
    const { commit, inputSwimlanes, outputSwimlanes, kind } = vm;

    // Find circle position
    const inputIndex = inputSwimlanes.findIndex(n => n.id === commit.sha);
    const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
    const circleColor = circleIndex < outputSwimlanes.length ? outputSwimlanes[circleIndex].color
      : circleIndex < inputSwimlanes.length ? inputSwimlanes[circleIndex].color : CHARTS_BLUE;

    const paths: string[] = [];

    // Process input swimlanes
    let outputSwimlaneIndex = 0;
    for (let index = 0; index < inputSwimlanes.length; index++) {
      const color = inputSwimlanes[index].color;

      if (inputSwimlanes[index].id === commit.sha) {
        // This lane holds the current commit
        if (index !== circleIndex) {
          // Merge-in: / arc (one SLW left) then horizontal - to circle
          // VS Code: M SLW*(index+1) 0, A SLW SLW 0 0 1 SLW*index SLW, H SLW*(circleIndex+1)
          const x = SLW * (index + 1);
          const ax = SLW * index;  // arc ends one SLW to the left of start
          const hx = SLW * (circleIndex + 1);
          paths.push(`<path d="M ${x} 0 A ${SLW} ${SLW} 0 0 1 ${ax} ${SLW} H ${hx}" fill="none" stroke="${color}" stroke-width="1" stroke-linecap="round"/>`);
        } else {
          outputSwimlaneIndex++;
        }
      } else {
        // Not the current commit — check if it maps to an output lane
        if (outputSwimlaneIndex < outputSwimlanes.length &&
          inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id) {
          if (index === outputSwimlaneIndex) {
            // Same column — straight |
            paths.push(`<path d="M ${SLW*(index+1)} 0 V ${SLH}" fill="none" stroke="${color}" stroke-width="1" stroke-linecap="round"/>`);
          } else {
            // Lane shifts column (always left in VS Code): | → / → - → / → |
            // VS Code: M fromX 0, V 6, A SCR SCR 0 0 1 fromX-SCR midY, H toX+SCR, A SCR SCR 0 0 0 toX midY+SCR, V SLH
            const fromX = SLW * (index + 1);
            const toX = SLW * (outputSwimlaneIndex + 1);
            const midY = SLH / 2;
            paths.push(`<path d="M ${fromX} 0 V 6 A ${SCR} ${SCR} 0 0 1 ${fromX - SCR} ${midY} H ${toX + SCR} A ${SCR} ${SCR} 0 0 0 ${toX} ${midY + SCR} V ${SLH}" fill="none" stroke="${color}" stroke-width="1" stroke-linecap="round"/>`);
          }
          outputSwimlaneIndex++;
        }
      }
    }

    // Additional parents — branch-out: horizontal - then \ arc
    for (let i = 1; i < commit.parents.length; i++) {
      const parentIdx = this.findLastIndex(outputSwimlanes, commit.parents[i]);
      if (parentIdx === -1) continue;
      const pc = outputSwimlanes[parentIdx].color;
      const px = SLW * parentIdx;
      const px1 = SLW * (parentIdx + 1);
      const cx = SLW * (circleIndex + 1);
      const midY = SLH / 2;
      // \ arc: from (px, midY) curving down to (px1, SLH)
      // - horizontal: from (px, midY) to circle
      paths.push(`<path d="M ${px} ${midY} A ${SLW} ${SLW} 0 0 1 ${px1} ${SLH} M ${px} ${midY} H ${cx}" fill="none" stroke="${pc}" stroke-width="1" stroke-linecap="round"/>`);
    }

    // Vertical line above circle (| to *)
    if (inputIndex !== -1) {
      paths.push(`<path d="M ${SLW*(circleIndex+1)} 0 V ${SLW}" fill="none" stroke="${inputSwimlanes[inputIndex].color}" stroke-width="1" stroke-linecap="round"/>`);
    }

    // Vertical line below circle (* to |)
    if (commit.parents.length > 0) {
      paths.push(`<path d="M ${SLW*(circleIndex+1)} ${SLW} V ${SLH}" fill="none" stroke="${circleColor}" stroke-width="1" stroke-linecap="round"/>`);
    }

    // Circle — matches VS Code's renderSCMHistoryItemGraph exactly
    const cx = SLW * (circleIndex + 1);
    const cy = SLW;
    if (kind === 'HEAD') {
      // Hollow ring — stroke only, no fill
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${CR+2}" fill="none" stroke="${circleColor}" stroke-width="${CSW}" style="stroke-width:${CSW}px"/>`);
    } else if (kind === 'incoming-changes' || kind === 'outgoing-changes') {
      // Filled circle + unfilled stroke ring + dashed outer ring
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${CR+3}" fill="${circleColor}" stroke-width="${CSW}" style="stroke-width:${CSW}px"/>`);
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${CR+1}" fill="none" stroke="${circleColor}" stroke-width="${CSW+1}" style="stroke-width:${CSW+1}px"/>`);
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${CR+1}" fill="none" stroke="${circleColor}" stroke-width="${CSW-1}" stroke-dasharray="4,2" style="stroke-width:${CSW-1}px;stroke-dasharray:4,2"/>`);
    } else if (commit.isMerge) {
      // Concentric circles: outer ring + background gap + inner filled dot
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${CR+2}" fill="none" stroke="${circleColor}" stroke-width="${CSW}" style="stroke-width:${CSW}px"/>`);
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${CR-1}" fill="${circleColor}" stroke-width="0"/>`);
    } else {
      // Single filled circle
      paths.push(`<circle cx="${cx}" cy="${cy}" r="${CR+1}" fill="${circleColor}" stroke-width="${CSW}" style="stroke-width:${CSW}px"/>`);
    }

    const maxLanes = Math.max(inputSwimlanes.length, outputSwimlanes.length, 1);
    const width = SLW * (maxLanes + 1);
    return { svg: paths.join(''), width };
  }

  private findLastIndex(nodes: SwimlaneNode[], id: string): number {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].id === id) return i;
    }
    return -1;
  }

  private html(viewModels: RowVM[], lakebaseBranchIds: Set<string> = new Set()): string {
    let maxWidth = 0;
    const rows = viewModels.map((vm) => {
      const { svg, width } = this.renderRowSvg(vm);
      if (width > maxWidth) maxWidth = width;
      const c = vm.commit;

      // Check if any ref on this commit matches a Lakebase branch
      const hasLakebase = c.refs.some(r => {
        const clean = r.replace('HEAD -> ', '').replace('origin/', '').replace('tag: ', '');
        return lakebaseBranchIds.has(clean);
      });

      const ccIcon = '<svg class="b-icon" width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="5" r="1.5" fill="currentColor"/></svg>';
      const cloudIcon = '<svg class="b-icon" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M11.5 4a3.5 3.5 0 0 0-3.47 3.03A2.5 2.5 0 0 0 4.5 9.5a2.5 2.5 0 0 0 0 5h7a3 3 0 0 0 .5-5.96A3.5 3.5 0 0 0 11.5 4z"/></svg>';
      // Row badges: first ref gets icon + name label; remaining refs get icon only
      let firstBadge = true;
      const badges = c.refs.map(r => {
        const d = r.replace('HEAD -> ', '');
        const isHead = r.includes('HEAD');
        const isTag = r.startsWith('tag: ');
        const isRemote = r.includes('origin/');
        if (d === 'origin/HEAD') { return ''; }
        const isRemoteMain = isRemote && (d === 'origin/main' || d === 'origin/master');
        const cls = isTag ? 'badge tag' : isRemoteMain ? 'badge remote-main' : isRemote ? 'badge remote' : isHead ? 'badge head' : 'badge local';
        const icon = isRemote ? cloudIcon : ccIcon;
        const label = isTag ? d.replace('tag: ', '') : d;
        const showLabel = firstBadge && !isRemote;
        if (showLabel) { firstBadge = false; }
        return showLabel
          ? `<span class="${cls}" title="${this.e(label)}">${icon}<span class="b-label">${this.e(label)}</span></span>`
          : `<span class="${cls}" title="${this.e(label)}">${icon}</span>`;
      }).join('');
      const dbIcon = hasLakebase ? '<span class="db-icon" title="Lakebase branch">&#x1F5C3;</span>' : '';

      return `<div class="row${c.isHead ? ' sel' : ''}"${c.isHead ? ' data-head="true"' : ''} data-s="${c.sha}" data-m="${this.e(c.message)}" data-fs="${this.e(c.fullSha)}" data-au="${this.e(c.author)}" data-ae="${this.e(c.authorEmail)}" data-av="${this.e(c.avatarUrl)}" data-dt="${this.e(c.date)}" data-rt="${this.e(c.time)}" data-fm="${this.e(c.fullMessage)}" data-st="${this.e(c.stats)}" data-rf="${this.e(c.refs.join(', '))}">
<svg class="g" width="${width}" height="${SLH}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>
${dbIcon}<span class="msg">${this.e(c.message)}</span><span class="author">${this.e(c.author)}</span><span class="spacer"></span>${c.isHead && badges ? `<span class="badges">${badges}</span>` : ''}
</div>`;
    }).join('\n');

    return `<!DOCTYPE html><html><head><style>
:root{--bg:var(--vscode-sideBar-background,#1e1e1e)}
*{box-sizing:border-box;margin:0;padding:0}
body{font:12px var(--vscode-font-family,system-ui);color:var(--vscode-foreground);background:var(--bg);position:relative}
.row{display:flex;align-items:center;height:${SLH}px;gap:6px;padding-right:10px;cursor:pointer;white-space:nowrap;overflow:hidden}
.row:hover{background:var(--vscode-list-hoverBackground)}
.row.sel{background:var(--vscode-list-inactiveSelectionBackground)}
.g{flex-shrink:0}
.bg-fill{fill:var(--bg)}
.badges{flex-shrink:0;display:inline-flex;gap:3px;max-width:50%;overflow:hidden}
.badge{display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;white-space:nowrap;vertical-align:middle;max-width:120px}
.b-icon{flex-shrink:0;vertical-align:middle}
.b-label{overflow:hidden;text-overflow:ellipsis}
.badge:only-child .b-label{max-width:100px}
.badge:not(:only-child) .b-label{max-width:60px}
.badge.head{background:#007ACC;color:#000}
.badge.local{background:#4FC1FF;color:#fff}
.badge.remote-main{background:#B180D7;color:var(--vscode-editor-background,#1e1e1e)}
.badge.remote{background:#4FC1FF;color:#fff}
.badge.tag{background:var(--vscode-badge-background,#4D4D4D);color:var(--vscode-foreground,#CCCCCC)}
.db-icon{flex-shrink:0;font-size:12px;opacity:0.85;cursor:default}
.msg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex-shrink:1}
.row.sel .msg{font-weight:600}
.author{flex-shrink:0;color:var(--vscode-descriptionForeground);font-size:11px;margin-left:4px;white-space:nowrap}
.spacer{flex:1}
.empty{color:var(--vscode-descriptionForeground);padding:20px;text-align:center}
.tip{position:absolute;z-index:998;background:var(--vscode-editorHoverWidget-background,#252526);border:1px solid var(--vscode-editorHoverWidget-border,#454545);border-radius:6px;padding:10px 14px;width:340px;right:0;box-shadow:0 2px 8px rgba(0,0,0,.36);display:none;font-size:12.5px;line-height:1.5;white-space:normal;word-wrap:break-word}
.tip.show{display:block}
.tip-hdr{margin-bottom:4px}
.tip-hdr-text{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px}
.tip-name{font-weight:700;color:#4FC1FF;cursor:pointer;text-decoration:none}
.tip-name:hover{text-decoration:underline}
.tip-avatar{width:20px;height:20px;border-radius:50%;cursor:pointer;vertical-align:middle;margin-right:4px}
.tip-date{color:var(--vscode-descriptionForeground);font-size:11.5px}
.tip-subject{color:var(--vscode-foreground);margin:2px 0}
.tip-body{color:var(--vscode-descriptionForeground);white-space:pre-wrap;margin:4px 0;font-size:12px;max-height:150px;overflow-y:auto}
.tip-hr{border:none;border-top:1px solid var(--vscode-editorHoverWidget-border,#454545);margin:8px 0}
.tip-stats{font-size:12px}
.tip-stats .add{color:#4EC9B0}
.tip-stats .del{color:#E8875A}
.tip-schema{font-size:11.5px;margin-top:4px}
.tip-schema-title{font-weight:600;margin-bottom:4px;color:var(--vscode-foreground)}
.tip-schema-table{margin:4px 0;padding:4px 8px;border-radius:4px;background:var(--vscode-textBlockQuote-background,rgba(255,255,255,.04))}
.tip-schema-table .tbl-name{font-weight:600}
.tip-schema-table .tbl-created{color:#4EC9B0}
.tip-schema-table .tbl-modified{color:#E8875A}
.tip-schema-table .tbl-removed{color:#c74e39}
.tip-schema-table .col{font-size:11px;color:var(--vscode-descriptionForeground);margin-left:12px}
.tip-schema-table .col-add{color:#4EC9B0}
.tip-schema-table .col-del{color:#c74e39}
.tip-schema-loading{color:var(--vscode-descriptionForeground);font-size:11px;font-style:italic}
.tip-refs{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
.tip-refs .badge{font-size:10.5px;padding:2px 8px}
.tip-footer{display:flex;align-items:center;gap:12px;font-size:12px}
.tip-link{color:#4FC1FF;cursor:pointer;display:inline-flex;align-items:center;gap:3px;text-decoration:none}
.tip-link:hover{text-decoration:underline}
.ctx{position:fixed;z-index:999;background:#e8e8e8;border:1px solid #c0c0c0;border-radius:6px;padding:4px 0;min-width:210px;box-shadow:0 4px 16px rgba(0,0,0,.25);display:none;font-size:13px;color:#1e1e1e}
.ctx.show{display:block}
.ctx-item{padding:6px 24px 6px 12px;cursor:pointer;color:#1e1e1e;position:relative;white-space:nowrap}
.ctx-item:hover{background:#0060c0;color:#fff;border-radius:3px;margin:0 4px;padding-left:8px;padding-right:20px}
.ctx-sep{height:1px;margin:4px 8px;background:#c0c0c0}
.ctx-sub{position:relative}
.ctx-sub::after{content:'\\203A';position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:14px;opacity:0.5}
.ctx-submenu{position:absolute;left:100%;top:-4px;background:#e8e8e8;border:1px solid #c0c0c0;border-radius:6px;padding:4px 0;min-width:160px;box-shadow:0 4px 16px rgba(0,0,0,.25);display:none;color:#1e1e1e}
.ctx-sub:hover .ctx-submenu{display:block}
.ctx-submenu .ctx-item{padding:6px 12px;color:#1e1e1e}
</style></head><body>
<div class="tip" id="tip"></div>
<div class="ctx" id="ctx">
  <div class="ctx-item" data-a="review">Open Changes</div>
  <div class="ctx-item" data-a="openBlame">Open in Cursor Blame</div>
  <div class="ctx-item" data-a="openGithubCommit">Open on GitHub</div>
  <div class="ctx-sep"></div>
  <div class="ctx-sub ctx-item" id="ctx-checkout">Checkout<div class="ctx-submenu" id="ctx-checkout-sub"></div></div>
  <div class="ctx-item" data-a="checkoutDetached">Checkout (Detached)</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" data-a="createBranch">Create Branch...</div>
  <div class="ctx-sub ctx-item" id="ctx-delete">Delete Branch<div class="ctx-submenu" id="ctx-delete-sub"></div></div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" data-a="createTag">Create Tag...</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" data-a="cherryPick">Cherry Pick</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" data-a="copy">Copy Commit ID</div>
  <div class="ctx-item" data-a="copyMessage">Copy Commit Message</div>
</div>
${viewModels.length ? rows + '<div id="sentinel" style="height:1px"></div>' : '<div class="empty">No commits</div>'}
<script>
const v=acquireVsCodeApi();
window.onerror=function(msg,src,line,col,err){v.postMessage({type:'jsError',msg:msg+'',line:line,src:src});};
window.addEventListener('message',function(ev){
  var msg=ev.data;
  if(msg.type==='branchesData'){
    var coSub=document.getElementById('ctx-checkout-sub');
    var delSub=document.getElementById('ctx-delete-sub');
    var coEl=document.getElementById('ctx-checkout');
    var delEl=document.getElementById('ctx-delete');
    if(coSub)coSub.innerHTML='';if(delSub)delSub.innerHTML='';
    var branches=msg.branches||[];
    if(branches.length===0){
      if(coEl)coEl.style.display='none';
      if(delEl)delEl.style.display='none';
    }else{
      if(coEl)coEl.style.display='';
      if(delEl)delEl.style.display='';
      branches.forEach(function(b,idx){
        if(coSub){if(idx>0){var cs=document.createElement('div');cs.className='ctx-sep';coSub.appendChild(cs)}var ci=document.createElement('div');ci.className='ctx-item';ci.textContent=b;ci.addEventListener('click',function(e){e.stopPropagation();ctx.classList.remove('show');v.postMessage({type:'checkoutBranch',branch:b})});coSub.appendChild(ci)}
        if(delSub){if(idx>0){var ds=document.createElement('div');ds.className='ctx-sep';delSub.appendChild(ds)}var di=document.createElement('div');di.className='ctx-item';di.textContent=b;di.addEventListener('click',function(e){e.stopPropagation();ctx.classList.remove('show');v.postMessage({type:'deleteBranchName',branch:b})});delSub.appendChild(di)}
      });
    }
    return;
  }
  if(msg.type==='goToCurrent'){
    var head=document.querySelector('.row[data-head="true"]');
    if(!head){head=document.querySelector('.row')}
    if(head){head.scrollIntoView({behavior:'smooth',block:'center'});document.querySelectorAll('.row.sel').forEach(function(r){r.classList.remove('sel')});head.classList.add('sel')}
    return;
  }
  if(msg.type==='schemaData'){
    var el=document.getElementById('tip-schema');
    if(!el)return;
    if(msg.error){el.innerHTML='<span class="tip-schema-loading">Schema info unavailable</span>';return}
    if(msg.noChanges){el.innerHTML='<div class="tip-schema-title">Database Schema</div><span style="color:var(--vscode-descriptionForeground)">No schema changes</span>';return}
    if(!msg.tables||msg.tables.length===0){el.innerHTML='';return}
    var h='<div class="tip-schema-title">Database Schema Changes</div>';
    msg.tables.forEach(function(t){
      var cls=t.status==='CREATED'?'tbl-created':t.status==='MODIFIED'?'tbl-modified':'tbl-removed';
      h+='<div class="tip-schema-table"><span class="tbl-name '+cls+'">'+(t.status==='CREATED'?'+ ':t.status==='REMOVED'?'- ':'~ ')+t.name+' ('+t.status+')</span>';
      if(t.columns&&t.columns.length>0){t.columns.forEach(function(c){h+='<div class="col col-'+c.change+'">'+(c.change==='add'?'+ ':'- ')+c.name+' '+c.type+'</div>'})}
      h+='</div>';
    });
    el.innerHTML=h;
  }
});
const sentinel=document.getElementById('sentinel');
if(sentinel){const obs=new IntersectionObserver((entries)=>{if(entries[0].isIntersecting)v.postMessage({type:'loadMore'})},{rootMargin:'200px'});obs.observe(sentinel)}
document.querySelectorAll('.row').forEach(e=>{
  e.addEventListener('click',(ev)=>{document.querySelectorAll('.row.sel').forEach(r=>r.classList.remove('sel'));e.classList.add('sel');v.postMessage({type:'review',sha:e.dataset.s,msg:e.dataset.m})});
  e.addEventListener('contextmenu',ev=>{ev.preventDefault();showCtx(ev,e.dataset.s,e.dataset.m)});
});
document.querySelectorAll('.sha').forEach(e=>{
  e.addEventListener('click',(ev)=>{ev.stopPropagation();v.postMessage({type:'copy',sha:e.closest('.row').dataset.s})});
});
// Tooltip — positioned to the right of the hovered row
const tip=document.getElementById('tip');
let tipTimer=null,tipRow=null;
function showTip(row){
  const d=row.dataset;
  const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Header: clickable avatar + clickable author name + date
  let h='<div class="tip-hdr"><div class="tip-hdr-text">';
  if(d.av){h+='<img class="tip-avatar" src="'+d.av+'" data-mailto="'+esc(d.ae)+'"/>';}
  if(d.ae){h+='<a class="tip-name" data-mailto="'+esc(d.ae)+'">'+esc(d.au)+'</a>, ';}
  else{h+='<span class="tip-name" style="color:var(--vscode-foreground);cursor:default">'+esc(d.au)+'</span>, ';}
  h+='<span class="tip-date">&#x1F551; '+esc(d.rt)+' ('+esc(d.dt)+')</span>';
  h+='</div></div>';
  // Subject — linkify PR numbers (#N)
  var subjectHtml=linkifyPR(esc(d.m));
  h+='<div class="tip-subject">'+subjectHtml+'</div>';
  // Body beyond subject
  const body=(d.fm||'').split(String.fromCharCode(92)+'n').join(String.fromCharCode(10)).trim();
  const subj=(d.m||'').trim();
  if(body&&body!==subj){const extra=body.startsWith(subj)?body.substring(subj.length).trim():body;if(extra)h+='<div class="tip-body">'+esc(extra)+'</div>'}
  // Stats
  if(d.st){h+='<hr class="tip-hr"/><div class="tip-stats">'+colorStats(d.st)+'</div>'}
  // Schema changes — fetch async from CI comments or migration files
  var prMatch=d.m?d.m.match(/#([0-9]+)/):null;
  h+='<div id="tip-schema" class="tip-schema"><span class="tip-schema-loading">Loading schema changes...</span></div>';
  setTimeout(function(){v.postMessage({type:'fetchSchema',pr:prMatch?prMatch[1]:null,sha:d.s})},0);
  // Refs
  if(d.rf){const refs=d.rf.split(', ').filter(Boolean).filter(r=>r.replace('HEAD -> ','')!=='origin/HEAD');if(refs.length){h+='<div class="tip-refs">';refs.forEach(r=>{const isTag=r.startsWith('tag: ');const isRemote=r.includes('origin/');const label=isTag?r.replace('tag: ',''):r.replace('HEAD -> ','');const isRemoteMain=isRemote&&(label==='origin/main'||label==='origin/master');const isHead=r.includes('HEAD');const cls=isTag?'badge tag':isRemoteMain?'badge remote-main':isRemote?'badge remote':isHead?'badge head':'badge local';const ccSvg='<svg width="10" height="10" viewBox="0 0 10 10" style="vertical-align:middle;margin-right:2px"><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="5" r="1.5" fill="currentColor"/></svg>';const icon=isTag?'&#x1F3F7;&#xFE0F;':isRemote?'<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" style="vertical-align:middle;margin-right:2px"><path d="M11.5 4a3.5 3.5 0 0 0-3.47 3.03A2.5 2.5 0 0 0 4.5 9.5a2.5 2.5 0 0 0 0 5h7a3 3 0 0 0 .5-5.96A3.5 3.5 0 0 0 11.5 4z"/></svg>':ccSvg;h+='<span class="'+cls+'">'+icon+esc(label)+'</span>'});h+='</div>'}}
  // Footer
  h+='<hr class="tip-hr"/><div class="tip-footer">';
  h+='<span class="tip-link" data-copy="'+esc(d.fs)+'"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#4FC1FF" stroke-width="1.2" style="vertical-align:middle;margin-right:3px"><rect x="5" y="4" width="8" height="10" rx="1"/><path d="M3 12V3a1 1 0 0 1 1-1h7"/></svg>'+esc(d.s)+'</span>';
  h+='<span class="tip-link" data-gh="'+esc(d.fs)+'"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg> Open on GitHub</span>';
  h+='</div>';
  tip.innerHTML=h;
  // Position: right-aligned to the row, vertically centered on the row
  const rect=row.getBoundingClientRect();
  const scrollY=window.scrollY;
  tip.style.display='block';
  const tipH=tip.offsetHeight;
  let top=rect.top+scrollY-Math.max(0,(tipH-rect.height)/2);
  if(top<scrollY)top=scrollY;
  tip.style.top=top+'px';
  tip.style.right='0px';
  tip.classList.add('show');
  // Wire footer actions
  tip.querySelectorAll('[data-copy]').forEach(el=>el.addEventListener('click',()=>v.postMessage({type:'copy',sha:el.getAttribute('data-copy')})));
  tip.querySelectorAll('[data-gh]').forEach(el=>el.addEventListener('click',()=>v.postMessage({type:'openGithub',sha:el.getAttribute('data-gh')})));
  tip.querySelectorAll('[data-mailto]').forEach(el=>el.addEventListener('click',()=>v.postMessage({type:'mailto',email:el.getAttribute('data-mailto')})));
  tip.querySelectorAll('[data-pr]').forEach(el=>el.addEventListener('click',()=>v.postMessage({type:'openPR',number:el.getAttribute('data-pr')})));
}
function colorStats(s){
  var parts=s.split(', '),out=[];
  for(var i=0;i<parts.length;i++){
    var p=parts[i].trim();
    if(p.indexOf('insertion')!==-1)out.push('<span class="add">'+p+'</span>');
    else if(p.indexOf('deletion')!==-1)out.push('<span class="del">'+p+'</span>');
    else out.push('<span>'+p+'</span>');
  }
  return out.join(', ');
}
function linkifyPR(s){
  var out='',i=0;
  while(i<s.length){
    if(s[i]==='#'){
      var j=i+1,num='';
      while(j<s.length&&s[j]>='0'&&s[j]<='9'){num+=s[j];j++}
      if(num.length>0){out+='<span class="tip-link" data-pr="'+num+'">#'+num+'</span>';i=j;continue}
    }
    out+=s[i];i++;
  }
  return out;
}
function hideTip(){tip.classList.remove('show');tip.style.display='none';tipRow=null}
document.querySelectorAll('.row').forEach(e=>{
  e.addEventListener('mouseenter',()=>{clearTimeout(tipTimer);tipRow=e;tipTimer=setTimeout(()=>{if(tipRow===e)showTip(e)},400)});
  e.addEventListener('mouseleave',()=>{clearTimeout(tipTimer);if(tipRow===e){tipRow=null;setTimeout(()=>{if(!tipRow)hideTip()},200)}});
});
tip.addEventListener('mouseenter',()=>{clearTimeout(tipTimer);tipRow=tip});
tip.addEventListener('mouseleave',()=>{tipRow=null;hideTip()});
tip.addEventListener('click',ev=>ev.stopPropagation());

const ctx=document.getElementById('ctx');
let ctxSha='',ctxMsg='';
function showCtx(ev,sha,msg){
  ctxSha=sha;ctxMsg=msg;
  ctx.style.left=ev.clientX+'px';ctx.style.top=ev.clientY+'px';
  ctx.classList.add('show');
  // Request branches at this commit for submenus
  v.postMessage({type:'getBranches',sha:sha});
}
document.addEventListener('click',()=>ctx.classList.remove('show'));
document.addEventListener('contextmenu',(ev)=>{if(!ev.target.closest('.row'))ctx.classList.remove('show')});
ctx.querySelectorAll('.ctx-item').forEach(el=>{
  el.addEventListener('click',(ev)=>{ev.stopPropagation();ctx.classList.remove('show');const a=el.dataset.a;
    if(a==='review')v.postMessage({type:'review',sha:ctxSha,msg:ctxMsg});
    else if(a==='copyMessage')v.postMessage({type:'copyMessage',sha:ctxSha,msg:ctxMsg});
    else v.postMessage({type:a,sha:ctxSha,msg:ctxMsg});
  });
});
</script></body></html>`;
  }

  private async reviewCommit(sha: string, message: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) return;
    try {
      const commitFiles = await this.gitService.getCommitFiles(sha);
      if (!commitFiles.length) { vscode.window.showInformationMessage('No file changes in this commit.'); return; }
      const allTuples = buildDiffTuples(commitFiles, {
        makeOrigUri: (p) => vscode.Uri.parse(`lakebase-commit://${sha}~1/${p}`),
        makeModUri: (p) => vscode.Uri.parse(`lakebase-commit://${sha}/${p}`),
        makeLabelUri: (p) => vscode.Uri.file(`${root}/${p}`),
      });

      // Sort: code first, migrations at end, then append schema DDL diffs
      const { code, migrations } = sortMigrationsToEnd(allTuples);
      const changes: DiffTuple[] = [...code, ...migrations];
      const migPaths = new Set(commitFiles.map(f => f.path).filter(fp => /V\d+.*\.sql$/i.test(fp)));
      if (migPaths.size > 0) {

        // Append table-level DDL diffs using the same URI format as branch review
        // For HEAD commit: schema-content provider has live data from cached diff
        // For historical commits: schema-content provider falls back to migration parsing
        const seen = new Set<string>();
        for (const mf of [...migPaths]) {
          try {
            const sql = await this.gitService.getFileAtRef(sha, mf);
            const tableRegex = /(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:public\.)?(\w+)/gi;
            let tm: RegExpExecArray | null;
            while ((tm = tableRegex.exec(sql)) !== null) {
              const table = tm[1];
              if (table === 'flyway_schema_history' || seen.has(table)) { continue; }
              seen.add(table);
              const label = vscode.Uri.parse(`lakebase-schema-content://branch/${table}`);
              const prodUri = vscode.Uri.parse(`lakebase-schema-content://production/${table}`);
              const branchUri = vscode.Uri.parse(`lakebase-schema-content://branch/${table}`);
              changes.push([label, prodUri, branchUri]);
            }
          } catch { /* skip */ }
        }
      }

      await vscode.commands.executeCommand('vscode.changes', `${sha.substring(0, 7)}: ${(message || '').substring(0, 60)}`, changes);
    } catch (err: any) { vscode.window.showErrorMessage(`Review failed: ${err.message}`); }
  }

  private async buildComparisonTuples(root: string, fromSha: string, toRef: string | null): Promise<DiffTuple[]> {
    const files = await this.graphService.getDiffFiles(fromSha, toRef);
    return buildDiffTuples(files, {
      makeOrigUri: (p) => vscode.Uri.parse(`lakebase-commit://${fromSha}/${p}`),
      makeModUri: (p) => toRef
        ? vscode.Uri.parse(`lakebase-commit://${toRef}/${p}`)
        : vscode.Uri.file(`${root}/${p}`),
      makeLabelUri: (p) => vscode.Uri.file(`${root}/${p}`),
    });
  }

  private e(t: string): string { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\r\n]+/g, '\\n'); }
}
