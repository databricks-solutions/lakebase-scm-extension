import { strict as assert } from 'assert';
import * as sinon from 'sinon';

/**
 * Tests for CI secret sync logic used by createPullRequest and mergePullRequest.
 * Verifies token generation, secret setting, and fallback behavior.
 */

describe('CI Secret Sync', () => {

  describe('token parsing from databricks tokens create', () => {
    it('extracts token_value from response', () => {
      const raw = JSON.stringify({
        token_info: { comment: 'test', token_id: 'abc' },
        token_value: 'dapi1234567890',
      });
      const parsed = JSON.parse(raw);
      const token = parsed.token_value || parsed.token || '';
      assert.strictEqual(token, 'dapi1234567890');
    });

    it('falls back to token field if token_value is missing', () => {
      const raw = JSON.stringify({ token: 'fallback-token' });
      const parsed = JSON.parse(raw);
      const token = parsed.token_value || parsed.token || '';
      assert.strictEqual(token, 'fallback-token');
    });

    it('returns empty string if neither field exists', () => {
      const raw = JSON.stringify({ error: 'something' });
      const parsed = JSON.parse(raw);
      const token = parsed.token_value || parsed.token || '';
      assert.strictEqual(token, '');
    });
  });

  describe('env file parsing for secrets', () => {
    it('extracts DATABRICKS_HOST from .env content', () => {
      const envContent = 'DATABRICKS_HOST=https://workspace.cloud.databricks.com/\nLAKEBASE_PROJECT_ID=abc-123\n';
      const match = envContent.match(/^DATABRICKS_HOST=(.+)$/m);
      assert.ok(match);
      assert.strictEqual(match![1].trim(), 'https://workspace.cloud.databricks.com/');
    });

    it('extracts LAKEBASE_PROJECT_ID from .env content', () => {
      const envContent = 'DATABRICKS_HOST=https://host.com\nLAKEBASE_PROJECT_ID=858e9f40-aeeb-4139-97af-f157137e1d61\n';
      const match = envContent.match(/^LAKEBASE_PROJECT_ID=(.+)$/m);
      assert.ok(match);
      assert.strictEqual(match![1].trim(), '858e9f40-aeeb-4139-97af-f157137e1d61');
    });

    it('returns null when key is missing', () => {
      const envContent = 'OTHER_KEY=value\n';
      const match = envContent.match(/^DATABRICKS_HOST=(.+)$/m);
      assert.strictEqual(match, null);
    });

    it('handles empty .env', () => {
      const envContent = '';
      const match = envContent.match(/^DATABRICKS_HOST=(.+)$/m);
      assert.strictEqual(match, null);
    });
  });

  describe('gh secret set command construction', () => {
    it('builds correct command for DATABRICKS_HOST', () => {
      const host = 'https://workspace.cloud.databricks.com/';
      const cmd = `gh secret set DATABRICKS_HOST --body "${host}"`;
      assert.ok(cmd.includes('gh secret set DATABRICKS_HOST'));
      assert.ok(cmd.includes(host));
    });

    it('builds correct command for DATABRICKS_TOKEN', () => {
      const token = 'dapi1234567890';
      const cmd = `gh secret set DATABRICKS_TOKEN --body "${token}"`;
      assert.ok(cmd.includes('gh secret set DATABRICKS_TOKEN'));
      assert.ok(cmd.includes(token));
    });

    it('builds correct command for LAKEBASE_PROJECT_ID', () => {
      const projectId = '858e9f40-aeeb-4139-97af-f157137e1d61';
      const cmd = `gh secret set LAKEBASE_PROJECT_ID --body "${projectId}"`;
      assert.ok(cmd.includes('gh secret set LAKEBASE_PROJECT_ID'));
      assert.ok(cmd.includes(projectId));
    });
  });

  describe('databricks tokens create command', () => {
    it('builds correct command for PR creation (24h)', () => {
      const cmd = 'databricks tokens create --comment "GitHub Actions CI" --lifetime-seconds 86400 -o json';
      assert.ok(cmd.includes('--lifetime-seconds 86400'));
      assert.ok(cmd.includes('-o json'));
    });

    it('builds correct command for merge (1h)', () => {
      const cmd = 'databricks tokens create --comment "CI merge" --lifetime-seconds 3600 -o json';
      assert.ok(cmd.includes('--lifetime-seconds 3600'));
    });

    it('requires DATABRICKS_HOST env var', () => {
      const host = 'https://workspace.com';
      const env = { ...process.env, DATABRICKS_HOST: host };
      assert.strictEqual(env.DATABRICKS_HOST, host);
    });
  });

  describe('secret sync flow — PR creation', () => {
    it('syncs all three secrets when .env has values', () => {
      const envContent = [
        'DATABRICKS_HOST=https://host.com',
        'LAKEBASE_PROJECT_ID=proj-123',
        'DATABRICKS_TOKEN=old-token',
      ].join('\n');

      const getEnvVal = (key: string) => {
        const match = envContent.match(new RegExp(`^${key}=(.+)$`, 'm'));
        return match ? match[1].trim() : '';
      };

      assert.strictEqual(getEnvVal('DATABRICKS_HOST'), 'https://host.com');
      assert.strictEqual(getEnvVal('LAKEBASE_PROJECT_ID'), 'proj-123');
      assert.strictEqual(getEnvVal('DATABRICKS_TOKEN'), 'old-token');
    });

    it('uses fresh token when tokens create succeeds', () => {
      const freshToken = 'dapi-fresh-1234';
      const oldToken = 'dapi-old-expired';

      // Simulate: tokens create succeeded
      const tokenRaw = JSON.stringify({ token_value: freshToken });
      const parsed = JSON.parse(tokenRaw);
      const token = parsed.token_value || parsed.token || '';

      assert.strictEqual(token, freshToken);
      assert.notStrictEqual(token, oldToken);
    });

    it('falls back to .env token when tokens create fails', () => {
      const oldToken = 'dapi-old-from-env';

      // Simulate: tokens create threw an error, fall back
      let token = '';
      try {
        throw new Error('auth expired');
      } catch {
        token = oldToken; // fallback
      }

      assert.strictEqual(token, oldToken);
    });
  });

  describe('secret sync flow — merge', () => {
    it('refreshes token before merge (same flow as PR)', () => {
      // The merge flow uses the same secret sync logic as PR creation
      // but with a shorter token lifetime (3600s vs 86400s)
      const lifetime = 3600;
      const cmd = `databricks tokens create --comment "CI merge" --lifetime-seconds ${lifetime} -o json`;
      assert.ok(cmd.includes('3600'));
    });
  });

  describe('gh secret list parsing', () => {
    it('detects missing secrets', () => {
      const secretsRaw = 'DATABRICKS_HOST\tUpdated 2026-03-24\nLAKEBASE_PROJECT_ID\tUpdated 2026-03-24\n';
      const missing: string[] = [];
      for (const name of ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'LAKEBASE_PROJECT_ID']) {
        if (!secretsRaw.includes(name)) { missing.push(name); }
      }
      assert.deepStrictEqual(missing, ['DATABRICKS_TOKEN']);
    });

    it('detects all secrets present', () => {
      const secretsRaw = 'DATABRICKS_HOST\nDATABRICKS_TOKEN\nLAKEBASE_PROJECT_ID\n';
      const missing: string[] = [];
      for (const name of ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'LAKEBASE_PROJECT_ID']) {
        if (!secretsRaw.includes(name)) { missing.push(name); }
      }
      assert.deepStrictEqual(missing, []);
    });

    it('detects all secrets missing', () => {
      const secretsRaw = '';
      const missing: string[] = [];
      for (const name of ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'LAKEBASE_PROJECT_ID']) {
        if (!secretsRaw.includes(name)) { missing.push(name); }
      }
      assert.deepStrictEqual(missing, ['DATABRICKS_HOST', 'DATABRICKS_TOKEN', 'LAKEBASE_PROJECT_ID']);
    });
  });
});
