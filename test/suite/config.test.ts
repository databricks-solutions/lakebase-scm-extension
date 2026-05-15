import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { parseEnvFile, getConfig, getEnvConfig, getWorkspaceRoot, updateEnvConnection } from '../../src/utils/config';

describe('Config Utilities', () => {
  afterEach(() => sinon.restore());

  describe('parseEnvFile', () => {
    it('returns empty object for non-existent file', () => {
      const result = parseEnvFile('/tmp/does-not-exist-' + Date.now());
      assert.deepStrictEqual(result, {});
    });

    it('parses key=value pairs', () => {
      const tmp = path.join('/tmp', `test-env-${Date.now()}`);
      fs.writeFileSync(tmp, 'FOO=bar\nBAZ=qux\n');
      try {
        const result = parseEnvFile(tmp);
        assert.strictEqual((result as any).FOO, 'bar');
        assert.strictEqual((result as any).BAZ, 'qux');
      } finally {
        fs.unlinkSync(tmp);
      }
    });

    it('skips comments and blank lines', () => {
      const tmp = path.join('/tmp', `test-env-${Date.now()}`);
      fs.writeFileSync(tmp, '# comment\n\nKEY=val\n');
      try {
        const result = parseEnvFile(tmp);
        assert.strictEqual((result as any).KEY, 'val');
        assert.strictEqual(Object.keys(result).length, 1);
      } finally {
        fs.unlinkSync(tmp);
      }
    });

    it('handles values with = signs', () => {
      const tmp = path.join('/tmp', `test-env-${Date.now()}`);
      fs.writeFileSync(tmp, 'URL=jdbc:postgresql://host:5432/db?ssl=require\n');
      try {
        const result = parseEnvFile(tmp);
        assert.strictEqual((result as any).URL, 'jdbc:postgresql://host:5432/db?ssl=require');
      } finally {
        fs.unlinkSync(tmp);
      }
    });
  });

  describe('getWorkspaceRoot', () => {
    it('returns undefined when no workspace folders', () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      assert.strictEqual(getWorkspaceRoot(), undefined);
    });

    it('returns first workspace folder path', () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: { fsPath: '/fake/root' } },
      ];
      const result = getWorkspaceRoot();
      assert.strictEqual(result, '/fake/root');
    });
  });

  describe('getEnvConfig', () => {
    it('reads .env from workspace root', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, '.env'), 'LAKEBASE_PROJECT_ID=proj123\nDATABRICKS_HOST=https://host.com\n');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];
      try {
        const env = getEnvConfig();
        assert.strictEqual(env.LAKEBASE_PROJECT_ID, 'proj123');
        assert.strictEqual(env.DATABRICKS_HOST, 'https://host.com');
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('returns empty object when no workspace', () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      const env = getEnvConfig();
      assert.deepStrictEqual(env, {});
    });
  });

  describe('updateEnvConnection', () => {
    it('writes connection info to .env with generic vars', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, '.env'), 'LAKEBASE_PROJECT_ID=proj123\n');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];

      try {
        updateEnvConnection({
          host: 'ep-test.cloud.databricks.com',
          branchId: 'feature-x',
          username: 'user@test.com',
          password: 'tok123',
        });

        const envContent = fs.readFileSync(path.join(tmp, '.env'), 'utf-8');
        assert.ok(envContent.includes('LAKEBASE_HOST=ep-test.cloud.databricks.com'));
        assert.ok(envContent.includes('LAKEBASE_BRANCH_ID=feature-x'));
        assert.ok(envContent.includes('DATABASE_URL=postgresql://'));
        assert.ok(envContent.includes('DB_USERNAME=user@test.com'));
        assert.ok(envContent.includes('DB_PASSWORD=tok123'));
        // Preserves existing keys
        assert.ok(envContent.includes('LAKEBASE_PROJECT_ID=proj123'));
        // Spring vars NOT in .env (only in application-local.properties for Java)
        assert.ok(!envContent.includes('SPRING_DATASOURCE_'));
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('writes application-local.properties for Java projects', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, '.env'), '');
      fs.writeFileSync(path.join(tmp, 'pom.xml'), '<project/>');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];

      try {
        updateEnvConnection({
          host: 'ep-test.cloud.databricks.com',
          branchId: 'feature-x',
          username: 'user@test.com',
          password: 'tok123',
        });

        const propsContent = fs.readFileSync(path.join(tmp, 'application-local.properties'), 'utf-8');
        assert.ok(propsContent.includes('spring.datasource.url='));
        assert.ok(propsContent.includes('spring.datasource.username=user@test.com'));
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('replaces existing connection keys', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, '.env'), 'LAKEBASE_HOST=old-host\nLAKEBASE_BRANCH_ID=old-branch\nOTHER=keep\n');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];

      try {
        updateEnvConnection({ host: 'new-host', branchId: 'new-branch', username: 'u', password: 'p' });
        const content = fs.readFileSync(path.join(tmp, '.env'), 'utf-8');
        assert.ok(!content.includes('old-host'));
        assert.ok(!content.includes('old-branch'));
        assert.ok(content.includes('LAKEBASE_HOST=new-host'));
        assert.ok(content.includes('OTHER=keep'));
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });
  });
});
