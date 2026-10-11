import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SchemaMigrationService } from '../../src/services/schemaMigrationService';
import { isMigrationMetadataTable } from '../../src/utils/migrationMetadata';

const EF_CSPROJ = '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup>'
  + '<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.4" />'
  + '</ItemGroup></Project>';

describe('.NET support', () => {
  let tmpDir: string;
  const service = new SchemaMigrationService();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-ext-'));
    fs.writeFileSync(path.join(tmpDir, 'App.sln'), '');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('lists EF Core migrations from the project Migrations/ dir, skipping Designer and snapshot files', () => {
    const migDir = path.join(tmpDir, 'src', 'App', 'Migrations');
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App', 'App.csproj'), EF_CSPROJ);
    for (const f of [
      '20261012090000_AddMemberPhone.cs',
      '20261012090000_AddMemberPhone.Designer.cs',
      '20261011225448_InitialCreate.cs',
      '20261011225448_InitialCreate.Designer.cs',
      'AppDbContextModelSnapshot.cs',
    ]) {
      fs.writeFileSync(path.join(migDir, f), '');
    }

    const result = service.listMigrations();
    assert.deepStrictEqual(result.map(m => m.version), ['20261011225448', '20261012090000']);
    assert.strictEqual(result[1].description, 'Add Member Phone');
  });

  it('lists .NET Flyway migrations from db/migrations/', () => {
    const migDir = path.join(tmpDir, 'db', 'migrations');
    fs.mkdirSync(migDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'App'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'App', 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web" />');
    fs.writeFileSync(path.join(migDir, 'V2__add_email.sql'), '');
    fs.writeFileSync(path.join(migDir, 'V1__init.sql'), '');
    fs.writeFileSync(path.join(migDir, 'README.md'), '');

    assert.deepStrictEqual(service.listMigrations().map(m => m.version), ['1', '2']);
  });

  it('routes .NET migrations through flyway-migrate.sh with a token refresh', () => {
    const { name, cmd } = service.buildMigrateCommand('dotnet');
    assert.strictEqual(name, '.NET Migrate');
    assert.strictEqual(cmd, './scripts/refresh-token.sh ./scripts/flyway-migrate.sh');
  });

  it("treats EF Core's __EFMigrationsHistory as migration metadata, not user schema", () => {
    assert.strictEqual(isMigrationMetadataTable('__EFMigrationsHistory'), true);
  });
});
