import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { GitService } from '../../src/services/gitService';

// cp.exec is non-configurable in newer Node, so we intercept via the module's internal reference
const cpModule = require('child_process');
const originalExec = cpModule.exec;

describe('GitService', () => {
  let service: GitService;

  beforeEach(() => {
    service = new GitService();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    sinon.restore();
  });

  function mockExec(stdout: string) {
    cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      cb(null, stdout, '');
    };
  }

  describe('getCurrentBranch', () => {
    it('returns the current branch name', async () => {
      mockExec('feature/dev-sprint-1\n');
      const branch = await service.getCurrentBranch();
      assert.strictEqual(branch, 'feature/dev-sprint-1');
    });

    it('trims whitespace', async () => {
      mockExec('  main  \n');
      const branch = await service.getCurrentBranch();
      assert.strictEqual(branch, 'main');
    });
  });

  describe('listLocalBranches', () => {
    it('parses branch output with tracking info', async () => {
      // listLocalBranches calls getCurrentBranch first, then git branch --format
      let callCount = 0;
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        callCount++;
        if (cmd.includes('rev-parse') || callCount === 1) {
          cb(null, 'main', '');
        } else {
          // --format="%(refname:short)|%(upstream:short)|%(upstream:track)"
          cb(null, [
            'main|origin/main|',
            'feature-x|origin/feature-x|[ahead 2, behind 1]',
            'orphan||',
          ].join('\n'), '');
        }
      };

      const branches = await service.listLocalBranches();
      assert.strictEqual(branches.length, 3);

      const main = branches.find(b => b.name === 'main');
      assert.ok(main);
      assert.strictEqual(main!.isCurrent, true);

      const feature = branches.find(b => b.name === 'feature-x');
      assert.ok(feature);
      assert.strictEqual(feature!.ahead, 2);
      assert.strictEqual(feature!.behind, 1);
      assert.strictEqual(feature!.tracking, 'origin/feature-x');
    });
  });

  describe('getChangedFiles', () => {
    it('parses diff output into file changes', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('merge-base')) {
          cb(null, 'abc123', '');
        } else if (cmd.includes('ls-files')) {
          cb(null, '', '');
        } else {
          cb(null, 'A\tsrc/new-file.ts\nM\tsrc/changed.ts\nD\tsrc/removed.ts\n', '');
        }
      };

      const files = await service.getChangedFiles();
      assert.strictEqual(files.length, 3);

      const added = files.find(f => f.path === 'src/new-file.ts');
      assert.ok(added);
      assert.strictEqual(added!.status, 'added');

      const modified = files.find(f => f.path === 'src/changed.ts');
      assert.strictEqual(modified!.status, 'modified');

      const deleted = files.find(f => f.path === 'src/removed.ts');
      assert.strictEqual(deleted!.status, 'deleted');
    });

    it('handles renamed files', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('merge-base')) {
          cb(null, 'abc123', '');
        } else if (cmd.includes('ls-files')) {
          cb(null, '', '');
        } else {
          cb(null, 'R100\told-name.ts\tnew-name.ts\n', '');
        }
      };

      const files = await service.getChangedFiles();
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].status, 'renamed');
      assert.strictEqual(files[0].path, 'new-name.ts');
      assert.strictEqual(files[0].oldPath, 'old-name.ts');
    });

    it('includes untracked files as added', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('merge-base')) {
          cb(null, 'abc123', '');
        } else if (cmd.includes('ls-files')) {
          cb(null, 'src/untracked-new.ts\nsrc/another-new.ts\n', '');
        } else if (cmd.includes('diff')) {
          cb(null, 'M\tsrc/existing.ts\n', '');
        } else {
          cb(null, '', '');
        }
      };

      const files = await service.getChangedFiles();
      assert.strictEqual(files.length, 3);
      const untracked = files.filter(f => f.path.includes('untracked') || f.path.includes('another'));
      assert.strictEqual(untracked.length, 2);
      assert.strictEqual(untracked[0].status, 'added');
      assert.strictEqual(untracked[1].status, 'added');
    });

    it('does not duplicate files already in diff', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('merge-base')) {
          cb(null, 'abc123', '');
        } else if (cmd.includes('ls-files')) {
          cb(null, 'src/new-file.ts\n', ''); // same as diff output
        } else if (cmd.includes('diff')) {
          cb(null, 'A\tsrc/new-file.ts\n', '');
        } else {
          cb(null, '', '');
        }
      };

      const files = await service.getChangedFiles();
      assert.strictEqual(files.length, 1); // no duplicate
    });
  });

  describe('getStagedFiles', () => {
    it('returns list of staged file paths', async () => {
      mockExec('src/file1.ts\nsrc/file2.ts\n');
      const staged = await service.getStagedFiles();
      assert.deepStrictEqual(staged, ['src/file1.ts', 'src/file2.ts']);
    });

    it('returns empty array when nothing staged', async () => {
      mockExec('');
      const staged = await service.getStagedFiles();
      assert.deepStrictEqual(staged, []);
    });
  });

  describe('getCachedBranch', () => {
    it('returns empty string initially', () => {
      assert.strictEqual(service.getCachedBranch(), '');
    });
  });

  describe('listMigrationsOnBranch', () => {
    it('lists V*.sql files from git ls-tree', async () => {
      mockExec('V1__init.sql\nV2__create_table.sql\nREADME.md\n');
      const migs = await service.listMigrationsOnBranch('main', 'src/main/resources/db/migration');
      assert.deepStrictEqual(migs, ['V1__init.sql', 'V2__create_table.sql']);
    });
  });
});
