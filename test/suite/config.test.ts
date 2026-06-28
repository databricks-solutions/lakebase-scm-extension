import { strict as assert } from 'assert';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { parseEnvFile, getConfig, getEnvConfig, getWorkspaceRoot, updateEnvConnection, detectLanguage } from '../../src/utils/config';

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

  describe('detectLanguage', () => {
    it('detects kotlin from src/main/kotlin', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}`);
      fs.mkdirSync(path.join(tmp, 'src', 'main', 'kotlin'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'pom.xml'), '<project/>');
      try {
        assert.strictEqual(detectLanguage(tmp), 'kotlin');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('detects kotlin from kotlin-maven-plugin in pom.xml', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'pom.xml'), '<project><build><plugins><plugin><artifactId>kotlin-maven-plugin</artifactId></plugin></plugins></build></project>');
      try {
        assert.strictEqual(detectLanguage(tmp), 'kotlin');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  // Monorepo-aware language resolution (root descent, overrides, invalid-input
  // handling) is owned + unit-tested by the kit's migration-layout module. The
  // extension exercises it end-to-end through getConfig below.

  describe('getConfig migration overrides', () => {
    function stubConfig(values: Record<string, unknown>) {
      sinon.stub(vscode.workspace, 'getConfiguration').returns({
        get: (key: string, def: unknown) => (key in values ? values[key] : def),
      } as any);
    }

    it('monorepo: resolves nodejs from migrationPath subdir so the knex .js pattern matches', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(path.join(tmp, 'recipe-app', 'migrations'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'recipe-app', 'package.json'), '{}');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];
      stubConfig({ migrationPath: 'recipe-app/migrations' });
      try {
        const cfg = getConfig();
        assert.strictEqual(cfg.language, 'nodejs');
        assert.strictEqual(cfg.migrationPath, 'recipe-app/migrations');
        // The exact files that previously matched zero (Flyway default).
        assert.ok(cfg.migrationPattern.test('20260101120000_create_recipes.js'));
        assert.ok(!cfg.migrationPattern.test('V1__init.sql'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('explicit language + migrationPattern + migrationGlob win over detection', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}'); // would detect nodejs
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];
      stubConfig({ language: 'python', migrationPattern: '^\\d+_.*\\.js$', migrationGlob: '*.js' });
      try {
        const cfg = getConfig();
        assert.strictEqual(cfg.language, 'python');
        assert.strictEqual(cfg.migrationGlob, '*.js');
        assert.ok(cfg.migrationPattern.test('001_init.js'));
        assert.ok(!cfg.migrationPattern.test('init.py'));
        // path not configured -> python default
        assert.strictEqual(cfg.migrationPath, 'alembic/versions');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('invalid migrationPattern falls back to the language default', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];
      stubConfig({ migrationPattern: '([unclosed' });
      try {
        const cfg = getConfig();
        assert.ok(cfg.migrationPattern.test('001_init.js')); // nodejs default still applies
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
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

    it('writes a source-able .env when the endpoint is not ready (no host)', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, '.env'), 'LAKEBASE_PROJECT_ID=proj123\n');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];

      try {
        // The not-ready re-sync path (lakebaseService): empty host/username/password.
        updateEnvConnection({
          host: '', branchId: 'production', username: '', password: '',
          comment: '# Connection pending at 2026-01-01T00:00:00.000Z. If this persists, run: git checkout - && git checkout <branch>',
        });

        const envPath = path.join(tmp, '.env');
        const envContent = fs.readFileSync(envPath, 'utf-8');

        // No assignment may carry a "#..." right-hand side: a sourced shell treats
        // the word after "KEY=#" as a command, which aborts `set -e` callers.
        for (const line of envContent.split('\n')) {
          assert.ok(!/^[A-Za-z_][A-Za-z0-9_]*=\s*#/.test(line), `unsourceable line in .env: ${line}`);
        }
        // The keys are emitted EMPTY (valid to source), not as a #-string.
        assert.ok(/^DATABASE_URL=\s*$/m.test(envContent), 'DATABASE_URL should be empty, not a #-string');
        assert.ok(!/DATABASE_URL=#/.test(envContent), 'DATABASE_URL must never be a "#..." value');

        // The exact reported failure mode: the file must source cleanly under set -e.
        execSync(`bash -c 'set -e; set -a; source "${envPath}"'`, { stdio: 'pipe' });
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });

    it('writes a valid application-local.properties when not ready (Java)', () => {
      const tmp = path.join('/tmp', `ws-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, '.env'), '');
      fs.writeFileSync(path.join(tmp, 'pom.xml'), '<project/>');
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmp } }];

      try {
        updateEnvConnection({ host: '', branchId: 'production', username: '', password: '' });
        const propsContent = fs.readFileSync(path.join(tmp, 'application-local.properties'), 'utf-8');
        // Empty value is a valid property; a "#..." value is the bug we fixed.
        assert.ok(/^spring\.datasource\.url=\s*$/m.test(propsContent), 'datasource.url should be empty when not ready');
        assert.ok(!/spring\.datasource\.url=#/.test(propsContent), 'datasource.url must never be a "#..." value');
      } finally {
        fs.rmSync(tmp, { recursive: true });
      }
    });
  });
});
