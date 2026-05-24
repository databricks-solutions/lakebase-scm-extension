import * as vscode from 'vscode';
import { SchemaDiffService, SchemaDiffResult, SchemaObject } from '../services/schemaDiffService';
import { GitService, GitFileChange } from '../services/gitService';
import { SchemaMigrationService } from '../services/schemaMigrationService';
import { getConfig } from '../utils/config';

export class SchemaDiffProvider {
  private schemaDiffService: SchemaDiffService;
  private gitService: GitService | undefined;
  private migrationService: SchemaMigrationService | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private tablePanels: Map<string, vscode.WebviewPanel> = new Map();

  constructor(schemaDiffService: SchemaDiffService, gitService?: GitService, migrationService?: SchemaMigrationService) {
    this.schemaDiffService = schemaDiffService;
    this.gitService = gitService;
    this.migrationService = migrationService;
  }

  async showDiff(forceRefresh: boolean = false, fileChanges: GitFileChange[] = [], branchId?: string): Promise<void> {
    let diff: SchemaDiffResult | undefined;

    if (!forceRefresh) {
      // Use in-memory cache if migrations haven't changed for this branch
      diff = this.schemaDiffService.getCachedDiff(branchId);
    }

    if (!diff) {
      // No cache available (or force refresh requested) — run pg_dump
      diff = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Comparing branch schemas...',
          cancellable: false,
        },
        () => this.schemaDiffService.compareBranchSchemas(branchId, true)
      );
    }

    if (!diff) {
      vscode.window.showWarningMessage('No diff available. Run "Lakebase: Branch Diff Summary" to generate one.');
      return;
    }

    // Historical note: there used to be a "migration file supplement" here
    // that fired when diff.inSync was true. It compared migration FILES on
    // the current git branch vs trunk and pushed any file-level deltas into
    // diff.created/modified/removed as if they were live DB diffs. Three
    // bugs conspired to make it user-hostile:
    //   1. The underlying listMigrationsOnBranch defaulted to the Flyway
    //      regex `/^V\d+.*\.sql$/i`, so Alembic/Knex projects always saw
    //      trunk as empty and classified EVERY migration file as "new".
    //   2. Trunk was hardcoded to 'main' instead of config.trunkBranch.
    //   3. The spread-copy `diff = { ...diff, inSync: false }` left array
    //      references pointing at the cached result, so subsequent
    //      `diff.modified.push(...)` calls mutated the cached state while
    //      the cached inSync flag stayed `true` — every re-open of the
    //      panel doubled the entries.
    // Trust the live DB query instead; the diff the `compareBranchSchemas`
    // call produces is authoritative. Pending-migration awareness is
    // already surfaced by the SCM Code/Staged panels.

    const branchName = diff.branchName || 'current branch';

    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'lakebaseBranchDiff',
        `Branch Diff Summary: ${branchName}`,
        vscode.ViewColumn.Active,
        { enableScripts: false }
      );
      this.panel.onDidDispose(() => { this.panel = undefined; });
    }

    this.panel.title = `Branch Diff Summary: ${branchName}`;
    this.panel.webview.html = this.renderHtml(diff, fileChanges);
  }

  private renderHtml(diff: SchemaDiffResult, fileChanges: GitFileChange[]): string {
    const branchName = diff.branchName || 'current branch';
    const timestamp = new Date(diff.timestamp).toLocaleString();

    // --- Left column: Code changes ---
    const added = fileChanges.filter(f => f.status === 'added');
    const modified = fileChanges.filter(f => f.status === 'modified');
    const deleted = fileChanges.filter(f => f.status === 'deleted');
    const renamed = fileChanges.filter(f => f.status === 'renamed');
    const totalCodeChanges = fileChanges.length;

    const codeBadge = totalCodeChanges === 0
      ? '<span class="badge sync">No Changes</span>'
      : `<span class="badge changes">${totalCodeChanges} file${totalCodeChanges !== 1 ? 's' : ''}</span>`;

    let codeHtml = '';
    if (totalCodeChanges === 0) {
      codeHtml = '<p class="sync-msg">No code changes vs main.</p>';
    } else {
      if (added.length > 0) {
        codeHtml += this.renderFileGroup('Added', 'created', '+', added.map(f => f.path));
      }
      if (modified.length > 0) {
        codeHtml += this.renderFileGroup('Modified', 'modified', '~', modified.map(f => f.path));
      }
      if (renamed.length > 0) {
        codeHtml += this.renderFileGroup('Renamed', 'modified', '→', renamed.map(f => `${f.oldPath} → ${f.path}`));
      }
      if (deleted.length > 0) {
        codeHtml += this.renderFileGroup('Deleted', 'removed', '−', deleted.map(f => f.path));
      }
    }

    // --- Right column: Schema changes ---
    const totalSchemaChanges = diff.created.length + diff.modified.length + diff.removed.length;
    const schemaBadge = diff.inSync
      ? '<span class="badge sync">In Sync</span>'
      : diff.error
        ? '<span class="badge error">Error</span>'
        : `<span class="badge changes">${totalSchemaChanges} change${totalSchemaChanges !== 1 ? 's' : ''}</span>`;

    let schemaHtml = '';

    if (diff.error) {
      schemaHtml += `<div class="error-box">${esc(diff.error)}</div>`;
    }

    if (diff.inSync && !diff.error) {
      const targetName = diff.comparisonBranchName || 'production';
      schemaHtml += `<p class="sync-msg">No schema changes — branch and ${esc(targetName)} are in sync.</p>`;
    }

    for (const obj of diff.created) {
      schemaHtml += `<div class="change created">
        <div class="change-header">+ ${obj.type} <strong>${esc(obj.name)}</strong> <span class="tag">CREATED</span></div>`;
      if (obj.columns && obj.columns.length > 0) {
        schemaHtml += '<table class="columns"><tr><th>Column</th><th>Type</th></tr>';
        for (const col of obj.columns) {
          schemaHtml += `<tr><td>${esc(col.name)}</td><td>${esc(col.dataType)}</td></tr>`;
        }
        schemaHtml += '</table>';
      }
      schemaHtml += '</div>';
    }

    for (const obj of diff.modified) {
      schemaHtml += `<div class="change modified">
        <div class="change-header">~ TABLE <strong>${esc(obj.name)}</strong> <span class="tag mod">MODIFIED</span></div>`;
      if (obj.addedColumns.length > 0) {
        schemaHtml += '<table class="columns"><tr><th>Added Column</th><th>Type</th></tr>';
        for (const col of obj.addedColumns) {
          schemaHtml += `<tr><td class="added">+ ${esc(col.name)}</td><td>${esc(col.dataType)}</td></tr>`;
        }
        schemaHtml += '</table>';
      }
      schemaHtml += '</div>';
    }

    for (const obj of diff.removed) {
      schemaHtml += `<div class="change removed">
        <div class="change-header">- ${obj.type} <strong>${esc(obj.name)}</strong> <span class="tag del">REMOVED</span></div>
      </div>`;
    }

    if (diff.rawDiff) {
      schemaHtml += `<details class="raw-section">
        <summary>Raw diff output</summary>
        <pre>${esc(diff.rawDiff)}</pre>
      </details>`;
    }

    return `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    margin: 0;
    line-height: 1.5;
  }
  .header {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  h1 { font-size: 1.4em; margin: 0 0 4px 0; }
  .subtitle { color: var(--vscode-descriptionForeground); }
  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    min-height: 0;
  }
  .col {
    min-width: 0;
    overflow: hidden;
  }
  .col-title {
    font-size: 1.1em;
    font-weight: 600;
    margin: 0 0 8px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 0.8em; font-weight: 600;
  }
  .badge.sync { background: var(--vscode-testing-iconPassed, #388e3c); color: #fff; }
  .badge.changes { background: var(--vscode-editorWarning-foreground, #f9a825); color: #000; }
  .badge.error { background: var(--vscode-errorForeground, #d32f2f); color: #fff; }
  .file-group {
    margin: 10px 0; padding: 8px 12px; border-radius: 4px;
    border-left: 3px solid var(--vscode-panel-border);
  }
  .file-group.created { border-left-color: var(--vscode-testing-iconPassed, #4caf50); background: rgba(76,175,80,0.06); }
  .file-group.modified { border-left-color: var(--vscode-editorWarning-foreground, #ff9800); background: rgba(255,152,0,0.06); }
  .file-group.removed { border-left-color: var(--vscode-errorForeground, #f44336); background: rgba(244,67,54,0.06); }
  .file-group-title {
    font-size: 0.85em; font-weight: 600; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); margin-bottom: 4px;
  }
  .file-list { list-style: none; margin: 0; padding: 0; }
  .file-list li {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    padding: 2px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-list .prefix { opacity: 0.6; margin-right: 6px; }
  .change {
    margin: 10px 0; padding: 8px 12px; border-radius: 4px;
    border-left: 3px solid var(--vscode-panel-border);
  }
  .change.created { border-left-color: var(--vscode-testing-iconPassed, #4caf50); background: rgba(76,175,80,0.06); }
  .change.modified { border-left-color: var(--vscode-editorWarning-foreground, #ff9800); background: rgba(255,152,0,0.06); }
  .change.removed { border-left-color: var(--vscode-errorForeground, #f44336); background: rgba(244,67,54,0.06); }
  .change-header { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.95em; }
  .tag { font-size: 0.75em; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
  .tag { background: rgba(76,175,80,0.15); color: var(--vscode-testing-iconPassed, #4caf50); }
  .tag.mod { background: rgba(255,152,0,0.15); color: var(--vscode-editorWarning-foreground, #ff9800); }
  .tag.del { background: rgba(244,67,54,0.15); color: var(--vscode-errorForeground, #f44336); }
  .added { color: var(--vscode-testing-iconPassed, #4caf50); font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  th, td { text-align: left; padding: 4px 10px; border: 1px solid var(--vscode-panel-border); }
  th { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
  .columns { width: auto; }
  .columns td, .columns th { padding: 2px 10px; }
  .error-box {
    background: rgba(244,67,54,0.08); border: 1px solid var(--vscode-errorForeground);
    padding: 8px 12px; border-radius: 4px; margin: 8px 0;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
  }
  .sync-msg { color: var(--vscode-testing-iconPassed, #4caf50); font-weight: 600; }
  .raw-section { margin-top: 16px; }
  .raw-section summary {
    cursor: pointer; color: var(--vscode-descriptionForeground);
    font-size: 0.9em; margin-bottom: 4px;
  }
  .raw-section pre {
    background: var(--vscode-textBlockQuote-background);
    padding: 12px; border-radius: 4px; overflow-x: auto;
    font-size: 0.85em; line-height: 1.4;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>Branch Diff Summary</h1>
    <div class="subtitle">${esc(branchName)} vs ${esc(diff.comparisonBranchName || 'production')} &mdash; ${timestamp}</div>
  </div>

  <div class="two-col">
    <div class="col">
      <div class="col-title">Code Changes ${codeBadge}</div>
      ${codeHtml}
    </div>
    <div class="col">
      <div class="col-title">Schema Changes ${schemaBadge}</div>
      ${schemaHtml}
    </div>
  </div>
</body>
</html>`;
  }

  private renderFileGroup(title: string, cssClass: string, prefix: string, files: string[]): string {
    const items = files.map(f =>
      `<li><span class="prefix">${esc(prefix)}</span>${esc(f)}</li>`
    ).join('');
    return `<div class="file-group ${cssClass}">
      <div class="file-group-title">${esc(title)} (${files.length})</div>
      <ul class="file-list">${items}</ul>
    </div>`;
  }

  /** Show schema diff for a single table */
  async showTableDiff(tableName: string, diffType: 'created' | 'modified' | 'removed', diff?: SchemaDiffResult): Promise<void> {
    if (!diff) {
      diff = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading schema for ${tableName}...`,
          cancellable: false,
        },
        () => this.schemaDiffService.compareBranchSchemas()
      );
    }

    if (!diff || diff.error) {
      vscode.window.showErrorMessage(diff?.error || 'Could not load schema diff');
      return;
    }

    const existing = this.tablePanels.get(tableName);
    if (existing) {
      existing.reveal();
      existing.webview.html = this.renderTableDiffHtml(tableName, diffType, diff);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'lakebaseTableDiff',
      `Schema Diff: ${tableName}`,
      vscode.ViewColumn.Active,
      { enableScripts: false }
    );
    panel.onDidDispose(() => { this.tablePanels.delete(tableName); });
    this.tablePanels.set(tableName, panel);
    panel.webview.html = this.renderTableDiffHtml(tableName, diffType, diff);
  }

  private renderTableDiffHtml(tableName: string, diffType: string, diff: SchemaDiffResult): string {
    const branchName = diff.branchName || 'current branch';
    const timestamp = new Date(diff.timestamp).toLocaleString();

    const typeLabels: Record<string, string> = { created: 'CREATED', modified: 'MODIFIED', removed: 'REMOVED' };
    const label = typeLabels[diffType] || diffType.toUpperCase();

    // Build side-by-side rows: { left, right } where each is an HTML string for one table row
    type Row = { left: string; right: string };
    const rows: Row[] = [];
    const targetName = diff.comparisonBranchName || 'production';
    let leftTitle = esc(targetName.charAt(0).toUpperCase() + targetName.slice(1));
    let rightTitle = `Branch: ${esc(branchName)}`;
    let leftTableClass = '';
    let rightTableClass = '';
    let leftCount = 0;
    let rightCount = 0;

    // For created/removed, use independent left/right content (no row alignment needed)
    let useRows = true;

    // Independent left/right column HTML for created/removed (no row alignment)
    let leftIndependent = '';
    let rightIndependent = '';

    if (diffType === 'created') {
      useRows = false;
      const obj = diff.created.find(o => o.name === tableName);
      leftTableClass = 'empty-pane';
      leftCount = 0;
      rightCount = obj?.columns?.length || 0;
      leftIndependent = `<div class="empty-msg">Table does not exist in ${esc(targetName)}</div>`;
      if (obj?.columns && obj.columns.length > 0) {
        rightIndependent = `<table><tr><th></th><th>Column</th><th>Type</th></tr>`;
        for (const col of obj.columns) {
          rightIndependent += `<tr class="row-added"><td class="indicator">+</td><td>${esc(col.name)}</td><td>${esc(col.dataType)}</td></tr>`;
        }
        rightIndependent += `</table>`;
      }
    } else if (diffType === 'removed') {
      useRows = false;
      const obj = diff.removed.find(o => o.name === tableName);
      rightTableClass = 'empty-pane';
      leftCount = obj?.columns?.length || 0;
      rightCount = 0;
      rightIndependent = `<div class="empty-msg">Table does not exist on branch</div>`;
      // For removed tables, we need to find columns from the diff's raw data
      // The removed SchemaObject may not have columns populated — use pg_dump prod data if available
      const prodCols = obj?.columns || [];
      if (prodCols.length > 0) {
        leftIndependent = `<table><tr><th></th><th>Column</th><th>Type</th></tr>`;
        for (const col of prodCols) {
          leftIndependent += `<tr class="row-removed"><td class="indicator">−</td><td>${esc(col.name)}</td><td>${esc(col.dataType)}</td></tr>`;
        }
        leftIndependent += `</table>`;
      } else {
        leftIndependent = `<div class="empty-msg">Column details unavailable</div>`;
      }
    } else if (diffType === 'modified') {
      const obj = diff.modified.find(o => o.name === tableName);
      if (obj) {
        const prodCols = obj.prodColumns || [];
        const branchCols = obj.columns || [];
        const branchByName = new Map(branchCols.map(c => [c.name, c]));
        const prodByName = new Map(prodCols.map(c => [c.name, c]));
        const removedNames = new Set(obj.removedColumns.map(c => c.name));
        const addedNames = new Set(obj.addedColumns.map(c => c.name));

        leftCount = obj.removedColumns.length;
        rightCount = obj.addedColumns.length;
        // Count type changes
        for (const pc of prodCols) {
          const bc = branchByName.get(pc.name);
          if (bc && bc.dataType !== pc.dataType) {
            leftCount++;
            rightCount++;
          }
        }

        // Walk through prod columns in order
        const emittedBranch = new Set<string>();
        for (const pc of prodCols) {
          const bc = branchByName.get(pc.name);
          if (!bc) {
            // Removed column — show on left in red, empty on right
            rows.push({
              left:  `<tr class="row-removed"><td class="indicator">−</td><td>${esc(pc.name)}</td><td>${esc(pc.dataType)}</td></tr>`,
              right: `<tr class="row-empty"><td class="indicator"></td><td class="muted">&nbsp;</td><td class="muted"></td></tr>`,
            });
          } else if (bc.dataType !== pc.dataType) {
            // Type changed — yellow on both sides
            rows.push({
              left:  `<tr class="row-changed"><td class="indicator">~</td><td>${esc(pc.name)}</td><td>${esc(pc.dataType)}</td></tr>`,
              right: `<tr class="row-changed"><td class="indicator">~</td><td>${esc(bc.name)}</td><td>${esc(bc.dataType)}</td></tr>`,
            });
            emittedBranch.add(bc.name);
          } else {
            // Unchanged
            rows.push({
              left:  `<tr><td class="indicator"></td><td>${esc(pc.name)}</td><td>${esc(pc.dataType)}</td></tr>`,
              right: `<tr><td class="indicator"></td><td>${esc(bc.name)}</td><td>${esc(bc.dataType)}</td></tr>`,
            });
            emittedBranch.add(bc.name);
          }
        }

        // Added columns — empty on left, green on right
        for (const bc of branchCols) {
          if (!emittedBranch.has(bc.name) && !prodByName.has(bc.name)) {
            rows.push({
              left:  `<tr class="row-empty"><td class="indicator"></td><td class="muted">&nbsp;</td><td class="muted"></td></tr>`,
              right: `<tr class="row-added"><td class="indicator">+</td><td>${esc(bc.name)}</td><td>${esc(bc.dataType)}</td></tr>`,
            });
          }
        }
      }
    }

    // Build the left and right table bodies
    const leftRows = rows.map(r => r.left).join('\n');
    const rightRows = rows.map(r => r.right).join('\n');

    // Table name styling
    const leftNameClass = diffType === 'removed' ? 'table-name-removed' : '';
    const rightNameClass = diffType === 'created' ? 'table-name-created' : '';
    const leftBadge = leftCount > 0 ? `<span class="badge badge-red">${leftCount}</span>` : '';
    const rightBadge = rightCount > 0
      ? `<span class="badge badge-green">${rightCount}</span>`
      : (diffType === 'created' ? `<span class="badge badge-green">NEW</span>` : '');

    return `<!DOCTYPE html>
<html>
<head>
<style>
  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    margin: 0;
    line-height: 1.5;
  }
  .header {
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  h1 { font-size: 1.3em; margin: 0 0 4px 0; }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .col { min-width: 0; }
  .col-title {
    font-size: 1em; font-weight: 600; margin: 0 0 6px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-family: var(--vscode-editor-font-family, monospace);
    display: flex; align-items: center; gap: 8px;
  }
  .table-name-removed { color: var(--vscode-errorForeground, #f44336); text-decoration: line-through; }
  .table-name-created { color: var(--vscode-testing-iconPassed, #4caf50); }
  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 10px;
    font-size: 0.75em; font-weight: 600; color: #fff;
  }
  .badge-red { background: var(--vscode-errorForeground, #f44336); }
  .badge-green { background: var(--vscode-testing-iconPassed, #4caf50); }
  .badge-yellow { background: var(--vscode-editorWarning-foreground, #ff9800); color: #000; }
  table { border-collapse: collapse; width: 100%; margin: 0; }
  th, td { text-align: left; padding: 4px 10px; border: 1px solid var(--vscode-panel-border); }
  th {
    background: var(--vscode-editor-inactiveSelectionBackground);
    font-weight: 600; font-size: 0.85em;
  }
  .indicator {
    width: 20px; text-align: center; font-weight: 700;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .row-added { background: rgba(76,175,80,0.08); }
  .row-added .indicator { color: var(--vscode-testing-iconPassed, #4caf50); }
  .row-removed { background: rgba(244,67,54,0.08); }
  .row-removed .indicator { color: var(--vscode-errorForeground, #f44336); }
  .row-changed { background: rgba(255,152,0,0.08); }
  .row-changed .indicator { color: var(--vscode-editorWarning-foreground, #ff9800); }
  .row-empty { background: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.4; }
  .muted { color: var(--vscode-descriptionForeground); }
  .center { text-align: center; }
  .empty-pane-col {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 4px;
    opacity: 0.6;
  }
  .empty-msg {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    text-align: center;
    padding: 24px;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>Schema Diff <span class="badge badge-yellow">${label}</span></h1>
    <div class="subtitle">${esc(branchName)} vs ${esc(diff.comparisonBranchName || 'production')} &mdash; ${timestamp}</div>
  </div>
  <div class="two-col">
    <div class="col">
      <div class="col-title">
        <span class="${leftNameClass}">${esc(tableName)}</span>
        <span class="muted" style="font-weight:normal; font-size:0.85em">${esc(targetName)}</span>
        ${leftBadge}
      </div>
      ${useRows
        ? `<table><tr><th></th><th>Column</th><th>Type</th></tr>${leftRows}</table>`
        : (leftTableClass === 'empty-pane'
            ? `<div class="empty-pane-col">${leftIndependent}</div>`
            : leftIndependent)}
    </div>
    <div class="col">
      <div class="col-title">
        <span class="${rightNameClass}">${esc(tableName)}</span>
        <span class="muted" style="font-weight:normal; font-size:0.85em">${esc(branchName)}</span>
        ${rightBadge}
      </div>
      ${useRows
        ? `<table><tr><th></th><th>Column</th><th>Type</th></tr>${rightRows}</table>`
        : (rightTableClass === 'empty-pane'
            ? `<div class="empty-pane-col">${rightIndependent}</div>`
            : rightIndependent)}
    </div>
  </div>
</body>
</html>`;
  }

  /** Re-render the Branch Diff Summary panel if it is currently open.
   *  Always fetches fresh code changes; uses cached schema if available. */
  async refresh(): Promise<void> {
    if (!this.panel) { return; }
    const fileChanges = this.gitService ? await this.gitService.getChangedFiles() : [];
    await this.showDiff(false, fileChanges);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const p of this.tablePanels.values()) { p.dispose(); }
    this.tablePanels.clear();
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
