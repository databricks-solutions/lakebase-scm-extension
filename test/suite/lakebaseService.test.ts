import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { LakebaseService } from '../../src/services/lakebaseService';

const cpModule = require('child_process');
const originalExec = cpModule.exec;

describe('LakebaseService', () => {
  let service: LakebaseService;

  beforeEach(() => {
    service = new LakebaseService();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/fake/root' } }];
  });

  afterEach(() => {
    cpModule.exec = originalExec;
    sinon.restore();
  });

  function mockExec(stdout: string, stderr?: string, err?: Error) {
    cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
      if (typeof _opts === 'function') { cb = _opts; }
      if (err) {
        cb(err, '', stderr || err.message);
      } else {
        cb(null, stdout, stderr || '');
      }
    };
  }

  describe('isAvailable', () => {
    it('returns true when databricks CLI is found', async () => {
      mockExec('0.285.0');
      const result = await service.isAvailable();
      assert.strictEqual(result, true);
    });

    it('returns false when CLI not found', async () => {
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(new Error('command not found'), '', 'command not found');
      };
      const result = await service.isAvailable();
      assert.strictEqual(result, false);
    });
  });

  describe('sanitizeBranchName', () => {
    it('converts slashes to hyphens', () => {
      assert.strictEqual(service.sanitizeBranchName('feature/dev-sprint'), 'feature-dev-sprint');
    });

    it('lowercases and removes invalid chars', () => {
      assert.strictEqual(service.sanitizeBranchName('Feature_BRANCH!'), 'feature-branch-');
    });

    it('truncates to 63 chars', () => {
      const long = 'a'.repeat(100);
      assert.strictEqual(service.sanitizeBranchName(long).length, 63);
    });

    it('pads short names to 3 chars minimum', () => {
      assert.strictEqual(service.sanitizeBranchName('f5'), 'f5-x');
      assert.strictEqual(service.sanitizeBranchName('ab'), 'ab-x');
      assert.strictEqual(service.sanitizeBranchName('a'), 'a-x');
      assert.strictEqual(service.sanitizeBranchName('foo'), 'foo');
    });
  });

  describe('getEffectiveHost', () => {
    it('returns empty when nothing configured', () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      assert.strictEqual(service.getEffectiveHost(), '');
    });

    it('returns host override when set', () => {
      service.setHostOverride('https://override.databricks.com/');
      assert.strictEqual(service.getEffectiveHost(), 'https://override.databricks.com');
    });
  });

  describe('getLoginCommand', () => {
    it('includes the host', () => {
      const cmd = service.getLoginCommand('https://host.databricks.com');
      assert.ok(cmd.includes('databricks auth login'));
      assert.ok(cmd.includes('--host https://host.databricks.com'));
    });
  });

  describe('listBranches', () => {
    it('parses array response from CLI', async () => {
      const response = JSON.stringify([
        {
          uid: 'br-abc',
          name: 'projects/p1/branches/main',
          status: { current_state: 'READY', default: true },
        },
        {
          uid: 'br-def',
          name: 'projects/p1/branches/feature-x',
          status: { current_state: 'READY', default: false },
        },
      ]);
      mockExec(response);

      const branches = await service.listBranches();
      assert.strictEqual(branches.length, 2);
      assert.strictEqual(branches[0].branchId, 'main');
      assert.strictEqual(branches[0].isDefault, true);
      assert.strictEqual(branches[0].state, 'READY');
      assert.strictEqual(branches[1].branchId, 'feature-x');
      assert.strictEqual(branches[1].isDefault, false);
    });

    it('parses nested branches response', async () => {
      const response = JSON.stringify({
        branches: [
          { uid: 'br-1', name: 'projects/p1/branches/dev', status: { current_state: 'CREATING', default: false } },
        ],
      });
      mockExec(response);

      const branches = await service.listBranches();
      assert.strictEqual(branches.length, 1);
      assert.strictEqual(branches[0].state, 'CREATING');
    });
  });

  describe('getDefaultBranch', () => {
    it('returns the default branch', async () => {
      const response = JSON.stringify([
        { uid: 'br-1', name: 'projects/p1/branches/main', status: { current_state: 'READY', default: true } },
        { uid: 'br-2', name: 'projects/p1/branches/dev', status: { current_state: 'READY', default: false } },
      ]);
      mockExec(response);

      const branch = await service.getDefaultBranch();
      assert.ok(branch);
      assert.strictEqual(branch!.isDefault, true);
      assert.strictEqual(branch!.branchId, 'main');
    });
  });

  describe('getBranchByName', () => {
    it('finds branch by sanitized name', async () => {
      const response = JSON.stringify([
        { uid: 'br-1', name: 'projects/p1/branches/feature-x', status: { current_state: 'READY', default: false } },
      ]);
      mockExec(response);

      const branch = await service.getBranchByName('feature/x');
      assert.ok(branch);
      assert.strictEqual(branch!.branchId, 'feature-x');
    });

    it('returns undefined when not found', async () => {
      mockExec(JSON.stringify([]));
      const branch = await service.getBranchByName('nonexistent');
      assert.strictEqual(branch, undefined);
    });
  });

  describe('getEndpoint', () => {
    it('returns endpoint host and state', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('list-branches')) {
          cb(null, JSON.stringify([{ uid: 'br-1', name: 'projects/p1/branches/dev', status: { current_state: 'READY', default: false } }]), '');
        } else {
          cb(null, JSON.stringify([{ status: { hosts: { host: 'ep-test.cloud.databricks.com' }, current_state: 'ACTIVE' } }]), '');
        }
      };

      const ep = await service.getEndpoint('dev');
      assert.ok(ep);
      assert.strictEqual(ep!.host, 'ep-test.cloud.databricks.com');
    });

    it('returns undefined when no endpoints', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('list-branches')) {
          cb(null, JSON.stringify([{ uid: 'br-1', name: 'projects/p1/branches/dev', status: { current_state: 'READY', default: false } }]), '');
        } else {
          cb(null, '[]', '');
        }
      };

      const ep = await service.getEndpoint('dev');
      assert.strictEqual(ep, undefined);
    });
  });

  describe('getCredential', () => {
    it('returns token and email', async () => {
      cpModule.exec = (cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        if (cmd.includes('list-branches')) {
          cb(null, JSON.stringify([{ uid: 'br-1', name: 'projects/p1/branches/dev', status: { current_state: 'READY', default: false } }]), '');
        } else if (cmd.includes('generate-database-credential')) {
          cb(null, JSON.stringify({ token: 'secret-tok' }), '');
        } else {
          cb(null, JSON.stringify({ userName: 'user@test.com' }), '');
        }
      };

      const cred = await service.getCredential('dev');
      assert.strictEqual(cred.token, 'secret-tok');
      assert.strictEqual(cred.email, 'user@test.com');
    });
  });

  describe('checkAuth', () => {
    it('returns authenticated=true on success', async () => {
      // Set a host so checkAuth has something to check
      service.setHostOverride('https://host.databricks.com');
      mockExec(JSON.stringify({ userName: 'user@test.com' }));

      const status = await service.checkAuth();
      assert.strictEqual(status.authenticated, true);
      assert.strictEqual(status.mismatch, false);
    });

    it('returns authenticated=false on CLI error', async () => {
      service.setHostOverride('https://host.databricks.com');
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(new Error('not authenticated'), '', 'not authenticated');
      };

      const status = await service.checkAuth();
      assert.strictEqual(status.authenticated, false);
    });

    it('returns error when no host configured', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      const status = await service.checkAuth();
      assert.strictEqual(status.authenticated, false);
      assert.ok(status.error);
    });
  });

  describe('getConsoleUrl', () => {
    it('builds URL with host and project ID', async () => {
      service.setHostOverride('https://workspace.databricks.com');
      sinon.stub(service, 'getProjectUid').resolves('proj-abc');

      const url = await service.getConsoleUrl();
      assert.strictEqual(url, 'https://workspace.databricks.com/lakebase/projects/proj-abc');
    });

    it('appends branch UID when provided', async () => {
      service.setHostOverride('https://workspace.databricks.com');
      sinon.stub(service, 'getProjectUid').resolves('proj-abc');

      const url = await service.getConsoleUrl('br-feature-x');
      assert.strictEqual(url, 'https://workspace.databricks.com/lakebase/projects/proj-abc/branches/br-feature-x');
    });

    it('returns empty string when host not configured', async () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      assert.strictEqual(await service.getConsoleUrl(), '');
    });
  });
});
