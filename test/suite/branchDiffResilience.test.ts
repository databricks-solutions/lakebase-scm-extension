// Branch Diff view resilience: two fixes for empty diffs caused by .env values
// the extension trusted without a fallback.
//  1. getProjectDatabase honors DB_NAME/PGDATABASE (the app's own db) before the
//     databricks_postgres default, so the schema diff queries the right database
//     even when DATABASE_URL points at the Lakebase default.
//  2. getChangedFiles must NOT diff against a configured base branch that does not
//     exist locally (e.g. LAKEBASE_BASE_BRANCH=staging in a repo whose tiers are
//     production/release) , that errors and silently shows "no changes".
import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { getProjectDatabase } from '../../src/utils/config';
import { GitService } from '../../src/services/gitService';

const cpModule = require('child_process');
const originalExec = cpModule.exec;
const originalGetConfiguration = (vscode.workspace as any).getConfiguration;

describe('getProjectDatabase precedence', () => {
  it('prefers DB_NAME over the DATABASE_URL db and the default', () => {
    assert.strictEqual(
      getProjectDatabase({ DB_NAME: 'recipe', DATABASE_URL: 'postgresql://u:p@h:5432/databricks_postgres?sslmode=require' }),
      'recipe',
    );
  });
  it('falls back to PGDATABASE when DB_NAME is absent', () => {
    assert.strictEqual(getProjectDatabase({ PGDATABASE: 'recipe' }), 'recipe');
  });
  it('parses the DATABASE_URL db when no DB_NAME/PGDATABASE', () => {
    assert.strictEqual(getProjectDatabase({ DATABASE_URL: 'postgresql://u:p@h:5432/myapp?sslmode=require' }), 'myapp');
  });
  it('defaults to databricks_postgres when nothing is set', () => {
    assert.strictEqual(getProjectDatabase({}), 'databricks_postgres');
  });
});

describe('getChangedFiles base-branch resilience', () => {
  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
    // Pin a base branch that will NOT exist locally (the dais case).
    (vscode.workspace as any).getConfiguration = () => ({
      get: (key: string, def: any) => (key === 'baseBranch' ? 'staging' : def),
    });
  });
  afterEach(() => {
    cpModule.exec = originalExec;
    (vscode.workspace as any).workspaceFolders = undefined;
    (vscode.workspace as any).getConfiguration = originalGetConfiguration;
  });

  it('does NOT diff against a configured base branch that does not exist locally', async () => {
    const commands: string[] = [];
    cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      commands.push(cmd);
      // The configured base (staging) is absent -> rev-parse --verify fails.
      if (/rev-parse --verify (staging|main|master)/.test(cmd)) { cb(new Error('unknown revision'), '', 'fatal'); return; }
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) { cb(null, 'feature-x\n', ''); return; }
      // No merge-base for any candidate (so it cannot resolve a parent).
      if (cmd.includes('merge-base')) { cb(new Error('no merge base'), '', 'fatal'); return; }
      cb(null, '', '');
    };

    const files = await new GitService().getChangedFiles();
    // It must not have run a diff against the nonexistent `staging` base.
    assert.ok(!commands.some((c) => /diff[^\n]*staging\.\.\./.test(c)), 'must not diff against absent staging base');
    // And it degrades gracefully (no throw) rather than surfacing a git error.
    assert.ok(Array.isArray(files));
  });
});
