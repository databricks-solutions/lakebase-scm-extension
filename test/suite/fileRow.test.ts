import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { buildFileDiffCommand } from '../../src/utils/fileRow';

const fileUri = vscode.Uri.file('/repo/src/app.ts');

describe('fileRow.buildFileDiffCommand (single source for the open/diff dispatch)', () => {
  it('added -> open the working file', () => {
    const cmd = buildFileDiffCommand({ status: 'added', path: 'src/app.ts' }, fileUri, { labelSuffix: '(main ↔ branch)' });
    assert.equal(cmd?.command, 'vscode.open');
    assert.equal(cmd?.title, 'Open File');
    assert.deepEqual(cmd?.arguments, [fileUri]);
  });

  it('modified -> diff merge-base vs working file, label = "<path> <suffix>"', () => {
    const cmd = buildFileDiffCommand({ status: 'modified', path: 'src/app.ts' }, fileUri, { labelSuffix: '(base ↔ PR)' });
    assert.equal(cmd?.command, 'vscode.diff');
    assert.equal((cmd?.arguments?.[0] as vscode.Uri).toString().includes('lakebase-git-base://merge-base/src/app.ts'), true);
    assert.equal(cmd?.arguments?.[1], fileUri);
    assert.equal(cmd?.arguments?.[2], 'src/app.ts (base ↔ PR)');
  });

  it('renamed -> diff uses oldPath for the base side', () => {
    const cmd = buildFileDiffCommand(
      { status: 'renamed', path: 'src/new.ts', oldPath: 'src/old.ts' },
      fileUri,
      { labelSuffix: '(main ↔ branch)' },
    );
    assert.equal((cmd?.arguments?.[0] as vscode.Uri).toString().includes('merge-base/src/old.ts'), true);
    assert.equal(cmd?.arguments?.[2], 'src/new.ts (main ↔ branch)');
  });

  it('deleted default -> open base version', () => {
    const cmd = buildFileDiffCommand({ status: 'deleted', path: 'src/gone.ts' }, fileUri, {
      labelSuffix: '(main ↔ branch)',
      deletedTitle: 'View Deleted',
    });
    assert.equal(cmd?.command, 'vscode.open');
    assert.equal(cmd?.title, 'View Deleted');
    assert.equal((cmd?.arguments?.[0] as vscode.Uri).toString().includes('merge-base/src/gone.ts'), true);
  });

  it('deleted with deleted:none -> no command (caller gates it out)', () => {
    const cmd = buildFileDiffCommand({ status: 'deleted', path: 'src/gone.ts' }, fileUri, {
      labelSuffix: '(x)',
      deleted: 'none',
    });
    assert.equal(cmd, undefined);
  });
});
