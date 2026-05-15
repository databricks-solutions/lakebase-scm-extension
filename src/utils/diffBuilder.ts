import * as vscode from 'vscode';

export type DiffTuple = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

export interface DiffBuilderOpts {
  makeOrigUri: (filePath: string) => vscode.Uri | undefined;
  makeModUri: (filePath: string) => vscode.Uri | undefined;
  makeLabelUri: (filePath: string) => vscode.Uri;
}

/**
 * Build diff tuples for vscode.changes from a list of changed files.
 * Each call site provides its own URI-building functions for orig/mod/label.
 */
export function buildDiffTuples(
  files: Array<{ status: string; path: string }>,
  opts: DiffBuilderOpts
): DiffTuple[] {
  return files.map(f => [
    opts.makeLabelUri(f.path),
    opts.makeOrigUri(f.path),
    opts.makeModUri(f.path),
  ]);
}

/**
 * Sort diff tuples so migration SQL files appear at the end.
 */
export function sortMigrationsToEnd(tuples: DiffTuple[]): { code: DiffTuple[]; migrations: DiffTuple[] } {
  const code: DiffTuple[] = [];
  const migrations: DiffTuple[] = [];
  for (const t of tuples) {
    const p = t[0].fsPath || t[0].path;
    if (/V\d+.*\.sql$/i.test(p)) {
      migrations.push(t);
    } else {
      code.push(t);
    }
  }
  return { code, migrations };
}
