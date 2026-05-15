import * as vscode from 'vscode';
import { GitService } from './gitService';
import { SchemaMigrationService } from './schemaMigrationService';
import { getWorkspaceRoot } from '../utils/config';

export type DiffTuple = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

export interface DiffFileInfo {
  status: string;
  path: string;
  oldPath?: string;
}

type PaneMode = 'single' | 'two';

/**
 * Centralized service for building diff tuples used by vscode.changes.
 */
export class DiffService {
  constructor(
    private gitService: GitService,
    private migrationService: SchemaMigrationService,
  ) {}

  /**
   * Build diff tuples for a commit.
   * Two-pane: both sides always provided → green/red diff highlighting.
   * Migration SQL files sorted to end, with schema-content DDL diffs appended.
   */
  async reviewCommitTwoPane(sha: string): Promise<{ title: string; changes: DiffTuple[] } | undefined> {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }

    const commitFiles = await this.gitService.getCommitFiles(sha);
    if (!commitFiles.length) { return undefined; }

    const allTuples = this.buildCommitTuples(root, sha, commitFiles, 'two');
    const { code, migrations, migPaths } = this.sortMigrations(allTuples, commitFiles);
    const changes: DiffTuple[] = [...code, ...migrations];
    await this.appendSchemaDiffs(changes, migPaths, sha);

    const message = commitFiles.length > 0
      ? (await this.gitService.getFileAtRef(sha, '.git/COMMIT_EDITMSG')).trim() || sha
      : sha;

    return { title: `${sha.substring(0, 7)}: ${message.substring(0, 60)}`, changes };
  }

  /**
   * Build diff tuples for a commit.
   * Single-pane: added files show as new (no diff), deleted as removed.
   */
  async reviewCommitSinglePane(sha: string): Promise<{ title: string; changes: DiffTuple[] } | undefined> {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }

    const commitFiles = await this.gitService.getCommitFiles(sha);
    if (!commitFiles.length) { return undefined; }

    return {
      title: `${sha.substring(0, 7)}`,
      changes: this.buildCommitTuples(root, sha, commitFiles, 'single'),
    };
  }

  /**
   * Build diff tuples for the current branch vs main.
   * Single-pane: added = new file view, deleted = removed file view.
   */
  async reviewBranch(): Promise<{ title: string; changes: DiffTuple[] } | undefined> {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }

    const currentBranch = await this.gitService.getCurrentBranch();
    const fileChanges = await this.gitService.getChangedFiles();
    if (!fileChanges.length) { return undefined; }

    const changes: DiffTuple[] = fileChanges.map(file => {
      const diffPath = file.status === 'renamed' && file.oldPath ? file.oldPath : file.path;
      return this.buildTuple(
        file.status === 'added' ? file.status : file.status === 'deleted' ? file.status : 'modified',
        vscode.Uri.file(`${root}/${file.path}`),
        vscode.Uri.parse(`lakebase-git-base://merge-base/${diffPath}`),
        vscode.Uri.file(`${root}/${file.path}`),
        'single',
      );
    });

    return { title: `Branch Review: ${currentBranch}`, changes };
  }

  /**
   * Build diff tuples comparing a commit to the working tree or HEAD.
   */
  async compareRefs(fromSha: string, toRef: string | null): Promise<DiffTuple[]> {
    const root = getWorkspaceRoot();
    if (!root) { return []; }

    const files = await this.gitService.getDiffFiles(fromSha, toRef);
    return files.map(f => this.buildTuple(
      f.status,
      vscode.Uri.file(`${root}/${f.path}`),
      vscode.Uri.parse(`lakebase-commit://${fromSha}/${f.path}`),
      toRef ? vscode.Uri.parse(`lakebase-commit://${toRef}/${f.path}`) : vscode.Uri.file(`${root}/${f.path}`),
      'single',
    ));
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Build a single diff tuple with pane mode handling.
   * single: A → undefined orig, D → undefined mod
   * two: always both sides
   */
  private buildTuple(status: string, label: vscode.Uri, orig: vscode.Uri, mod: vscode.Uri, mode: PaneMode): DiffTuple {
    if (mode === 'single') {
      if (status === 'A' || status === 'added') { return [label, undefined, mod]; }
      if (status === 'D' || status === 'deleted') { return [label, orig, undefined]; }
    }
    return [label, orig, mod];
  }

  /**
   * Build commit diff tuples using lakebase-commit:// URIs.
   */
  private buildCommitTuples(root: string, sha: string, files: DiffFileInfo[], mode: PaneMode): DiffTuple[] {
    return files.map(f => this.buildTuple(
      f.status,
      vscode.Uri.file(`${root}/${f.path}`),
      vscode.Uri.parse(`lakebase-commit://${sha}~1/${f.path}`),
      vscode.Uri.parse(`lakebase-commit://${sha}/${f.path}`),
      mode,
    ));
  }

  /**
   * Sort tuples so migration SQL files appear at the end.
   */
  private sortMigrations(tuples: DiffTuple[], files: DiffFileInfo[]): { code: DiffTuple[]; migrations: DiffTuple[]; migPaths: Set<string> } {
    const migPaths = new Set(files.map(f => f.path).filter(fp => /V\d+.*\.sql$/i.test(fp)));
    const code: DiffTuple[] = [];
    const migrations: DiffTuple[] = [];
    for (const t of tuples) {
      const p = t[0].fsPath || t[0].path;
      if ([...migPaths].some(mp => p.includes(mp.split('/').pop() || ''))) {
        migrations.push(t);
      } else {
        code.push(t);
      }
    }
    return { code, migrations, migPaths };
  }

  /**
   * Append schema-content DDL diffs for tables affected by migration files.
   */
  private async appendSchemaDiffs(changes: DiffTuple[], migPaths: Set<string>, sha: string): Promise<void> {
    if (migPaths.size === 0) { return; }
    const seen = new Set<string>();
    for (const mf of [...migPaths]) {
      try {
        const sql = await this.gitService.getFileAtRef(sha, mf);
        for (const tc of SchemaMigrationService.parseSql(sql)) {
          if (tc.tableName === 'flyway_schema_history' || seen.has(tc.tableName)) { continue; }
          seen.add(tc.tableName);
          changes.push([
            vscode.Uri.parse(`lakebase-schema-content://branch/${tc.tableName}`),
            vscode.Uri.parse(`lakebase-schema-content://production/${tc.tableName}`),
            vscode.Uri.parse(`lakebase-schema-content://branch/${tc.tableName}`),
          ]);
        }
      } catch { /* skip */ }
    }
  }
}
