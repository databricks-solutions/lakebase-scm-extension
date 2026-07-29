import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { hasProjectId } from '../../src/utils/config';
import type { LakebaseConfig } from '../../src/utils/config';

// A minimal LakebaseConfig; only lakebaseProjectId matters here.
function cfg(overrides: Partial<LakebaseConfig> = {}): LakebaseConfig {
  return {
    databricksHost: '', databricksProfile: '', lakebaseProjectId: '', autoCreateBranch: true,
    autoCreateLocalBranchesFromOrigin: true,
    autoRefreshCredentials: true, migrationPath: '', migrationPattern: /x/,
    migrationGlob: '*', language: 'python', showUnifiedRepo: true,
    productionReadOnly: true, trunkBranch: '', stagingBranch: '', baseBranch: '',
    tierNames: [], gitBranchPrefix: '', databricksAuthStorage: '',
    ...overrides,
  };
}

describe('utils/config hasProjectId (drives the first-time-setup welcome view)', () => {
  it('accepts an explicit config (so callers with a cfg in hand avoid a re-read)', () => {
    assert.equal(hasProjectId(cfg({ lakebaseProjectId: 'x' })), true);
    assert.equal(hasProjectId(cfg({ lakebaseProjectId: '' })), false);
  });

  // The no-arg path re-reads config (hence .env) on every call. Drive it through
  // a real temp workspace via LAKEBASE_PROJECT_DIR (getWorkspaceRoot's fallback),
  // so we exercise the actual runtime re-read, not a stub.
  describe('no-arg path re-reads .env each call (the env-watcher recompute)', () => {
    let dir: string;
    let prevProjectDir: string | undefined;
    // getWorkspaceRoot prefers vscode.workspace.workspaceFolders over the
    // LAKEBASE_PROJECT_DIR fallback we drive this test with. The vscode mock is a
    // shared singleton other suites mutate, so clear workspaceFolders here (and
    // restore it) to keep this test order-independent.
    let prevFolders: unknown;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpid-'));
      prevProjectDir = process.env.LAKEBASE_PROJECT_DIR;
      process.env.LAKEBASE_PROJECT_DIR = dir;
      prevFolders = (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders;
      (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
    });
    afterEach(() => {
      if (prevProjectDir === undefined) { delete process.env.LAKEBASE_PROJECT_DIR; }
      else { process.env.LAKEBASE_PROJECT_DIR = prevProjectDir; }
      (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = prevFolders;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('is false when .env has no LAKEBASE_PROJECT_ID', () => {
      fs.writeFileSync(path.join(dir, '.env'), 'DATABRICKS_HOST=https://x\n');
      assert.equal(hasProjectId(), false);
    });

    it('flips to true after .env gains LAKEBASE_PROJECT_ID (the bug: it used to stick false until reload)', () => {
      fs.writeFileSync(path.join(dir, '.env'), 'DATABRICKS_HOST=https://x\n');
      assert.equal(hasProjectId(), false); // at activation, before scaffold wrote the id
      // A scaffold / branch resync / external write adds the project id later:
      fs.writeFileSync(path.join(dir, '.env'), 'DATABRICKS_HOST=https://x\nLAKEBASE_PROJECT_ID=stockflow-123\n');
      assert.equal(hasProjectId(), true); // recomputed on the next call, no reload needed
    });
  });
});
