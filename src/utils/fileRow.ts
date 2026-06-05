import * as vscode from 'vscode';

/** Minimal shape of a changed file needed to build its open/diff command. */
export interface FileRowChange {
  status: string;
  path: string;
  oldPath?: string;
}

export interface FileDiffCommandOpts {
  /**
   * Trailing label for the diff title, e.g. `(main ↔ branch)`,
   * `(base ↔ PR)`. Rendered as `${file.path} ${labelSuffix}`.
   */
  labelSuffix: string;
  /**
   * How a deleted file is handled:
   *  - 'open-base' (default): open the merge-base version (with `deletedTitle`).
   *  - 'none': no command (caller's tree gates deleted files out).
   */
  deleted?: 'open-base' | 'none';
  /** Title for the deleted-file open command. */
  deletedTitle?: string;
}

/**
 * Single source of truth for the "added -> open file; deleted -> open
 * base; otherwise -> diff against merge-base (honoring renamed.oldPath)"
 * command dispatch. Previously hand-rolled in schemaScmProvider
 * (makeDiffCommand), branchTreeProvider (inline), and pullRequestTree
 * (getFileItems), differing only in the diff label and how deleted files
 * are handled.
 */
export function buildFileDiffCommand(
  file: FileRowChange,
  fileUri: vscode.Uri,
  opts: FileDiffCommandOpts,
): vscode.Command | undefined {
  const baseUriFor = (p: string) => vscode.Uri.parse(`lakebase-git-base://merge-base/${p}`);

  if (file.status === 'added') {
    return { command: 'vscode.open', title: 'Open File', arguments: [fileUri] };
  }
  if (file.status === 'deleted') {
    if ((opts.deleted ?? 'open-base') === 'none') { return undefined; }
    return {
      command: 'vscode.open',
      title: opts.deletedTitle || 'Open Base Version',
      arguments: [baseUriFor(file.path)],
    };
  }
  const diffPath = file.status === 'renamed' && file.oldPath ? file.oldPath : file.path;
  return {
    command: 'vscode.diff',
    title: 'Show Diff',
    arguments: [baseUriFor(diffPath), fileUri, `${file.path} ${opts.labelSuffix}`],
  };
}
