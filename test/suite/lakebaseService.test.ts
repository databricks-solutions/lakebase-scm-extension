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

  describe('resolveProfileForHost (valid + exactly-one-match, mirrors kit selectProfileForHost)', () => {
    const HOST = 'https://fevm-serverless-stable-ecparr.cloud.databricks.com';
    const profiles = (arr: Array<Record<string, unknown>>) => mockExec(JSON.stringify({ profiles: arr }));

    it('returns the unique valid profile matching the host', async () => {
      profiles([
        { name: 'DEFAULT', host: 'https://adb-123.azuredatabricks.net', valid: true },
        { name: 'ecparr', host: HOST, valid: true },
      ]);
      assert.strictEqual(await service.resolveProfileForHost(HOST), 'ecparr');
    });

    it('returns null when only a different-host profile is valid (the original bug)', async () => {
      profiles([{ name: 'DEFAULT', host: 'https://adb-123.azuredatabricks.net', valid: true }]);
      assert.strictEqual(await service.resolveProfileForHost(HOST), null);
    });

    it('excludes invalid profiles even when their host matches', async () => {
      profiles([
        { name: 'stale', host: HOST, valid: false },
        { name: 'good', host: HOST, valid: true },
      ]);
      assert.strictEqual(await service.resolveProfileForHost(HOST), 'good');
    });

    it('returns null when the only host match is invalid', async () => {
      profiles([{ name: 'stale', host: HOST, valid: false }]);
      assert.strictEqual(await service.resolveProfileForHost(HOST), null);
    });

    it('returns null on ambiguous match (>1 distinct valid profile for the host)', async () => {
      profiles([
        { name: 'ecparr-a', host: HOST, valid: true },
        { name: 'ecparr-b', host: HOST, valid: true },
      ]);
      assert.strictEqual(await service.resolveProfileForHost(HOST), null);
    });

    it('normalizes trailing slashes on both sides', async () => {
      profiles([{ name: 'ecparr', host: `${HOST}/`, valid: true }]);
      assert.strictEqual(await service.resolveProfileForHost(`${HOST}///`), 'ecparr');
    });

    it('returns null for an empty host', async () => {
      assert.strictEqual(await service.resolveProfileForHost(''), null);
    });

    // Self-heal: a profile invalid at first-cache time (e.g. an expired OAuth
    // refresh token) can become valid after an EXTERNAL `databricks auth login`
    // the extension never saw. A stale "no profile for this host" cache then
    // kept the IDE broken until a full window reload. resolveProfileForHost
    // now rebuilds once on a MISS, so the next call after any re-auth recovers.
    it('rebuilds on a miss so a profile that became valid is picked up (no reload needed)', async () => {
      // Per-call exec outputs: first build sees the profile INVALID, a later
      // rebuild sees it VALID (the external re-login landed in between).
      const outputs = [
        JSON.stringify({ profiles: [{ name: 'ecparr', host: HOST, valid: false }] }),
        JSON.stringify({ profiles: [{ name: 'ecparr', host: HOST, valid: true }] }),
      ];
      let calls = 0;
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        cb(null, outputs[Math.min(calls++, outputs.length - 1)], '');
      };

      // Call 1: profile is invalid -> miss -> caches host->[] (no rebuild on the
      // very first build) -> null.
      assert.strictEqual(await service.resolveProfileForHost(HOST), null);
      // Call 2: cache present + miss -> rebuild picks up the now-valid profile.
      assert.strictEqual(await service.resolveProfileForHost(HOST), 'ecparr');
    });

    it('does NOT re-exec on a cache HIT (resolves from the cached map)', async () => {
      let calls = 0;
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        calls++;
        cb(null, JSON.stringify({ profiles: [{ name: 'ecparr', host: HOST, valid: true }] }), '');
      };
      assert.strictEqual(await service.resolveProfileForHost(HOST), 'ecparr');
      assert.strictEqual(await service.resolveProfileForHost(HOST), 'ecparr');
      assert.strictEqual(calls, 1, 'a cache hit must not rebuild the profile map');
    });

    it('invalidateProfileCache forces a fresh listProfiles on the next resolve', async () => {
      let calls = 0;
      cpModule.exec = (_cmd: string, _opts: any, cb: Function) => {
        if (typeof _opts === 'function') { cb = _opts; }
        calls++;
        cb(null, JSON.stringify({ profiles: [{ name: 'ecparr', host: HOST, valid: true }] }), '');
      };
      assert.strictEqual(await service.resolveProfileForHost(HOST), 'ecparr');
      service.invalidateProfileCache();
      assert.strictEqual(await service.resolveProfileForHost(HOST), 'ecparr');
      assert.strictEqual(calls, 2, 'invalidateProfileCache must drop the cache so the next resolve rebuilds');
    });
  });

  describe('envReflectsBranch (skip redundant sync when the hook already wrote .env)', () => {
    const fs = require('fs');
    const os = require('os');
    const pathMod = require('path');
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'env-reflects-'));
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: dir } }];
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const writeEnv = (s: string) => fs.writeFileSync(pathMod.join(dir, '.env'), s);

    it('true when LAKEBASE_BRANCH_ID matches and DATABASE_URL is populated', () => {
      writeEnv('LAKEBASE_BRANCH_ID=feature-x\nDATABASE_URL=postgresql://u:p@h:5432/db?sslmode=require\n');
      assert.equal(service.envReflectsBranch('feature-x'), true);
    });

    it('sanitizes the branch before comparing (git slash -> hyphen)', () => {
      writeEnv('LAKEBASE_BRANCH_ID=feature-x\nDATABASE_URL=postgresql://u:p@h/db\n');
      assert.equal(service.envReflectsBranch('feature/x'), true);
    });

    it('false when the branch does not match', () => {
      writeEnv('LAKEBASE_BRANCH_ID=other\nDATABASE_URL=postgresql://u:p@h/db\n');
      assert.equal(service.envReflectsBranch('feature-x'), false);
    });

    it('false when DATABASE_URL is empty/pending', () => {
      writeEnv('LAKEBASE_BRANCH_ID=feature-x\nDATABASE_URL=\n');
      assert.equal(service.envReflectsBranch('feature-x'), false);
    });

    it('false when .env is absent', () => {
      assert.equal(service.envReflectsBranch('feature-x'), false);
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
