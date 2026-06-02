import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { ScaffoldService } from '../../src/services/scaffoldService';
import { SpringInitializrClient } from '../../src/services/springInitializrClient';

function makeInitializrZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile('demo/pom.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<project>
  <dependencies></dependencies>
  <build><plugins>
    <plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin>
  </plugins></build>
</project>`));
  zip.addFile('demo/mvnw', Buffer.from('#!/bin/sh\n'));
  return zip.toBuffer();
}

describe('ScaffoldService – Spring Initializr', () => {
  const extensionPath = path.resolve(__dirname, '../..');

  afterEach(() => {
    delete process.env.LAKEBASE_SCAFFOLD_FALLBACK;
  });

  for (const language of ['java', 'kotlin'] as const) {
    it(`scaffolds ${language} via Initializr and applies Lakebase overlays`, async () => {
      const mockClient = new SpringInitializrClient('https://start.spring.io', async (url) => {
        if (String(url).endsWith('/')) {
          return {
            ok: true,
            json: async () => ({
              bootVersion: { default: '3.5.6' },
              javaVersion: { default: '21' },
              type: { default: 'maven-project' },
            }),
          } as Response;
        }
        return {
          ok: true,
          arrayBuffer: async () => makeInitializrZip().buffer,
        } as Response;
      });

      const svc = new ScaffoldService(mockClient);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scaffold-${language}-`));

      await svc.deployLanguageProject(dir, language, 'demo-project');

      assert.ok(fs.existsSync(path.join(dir, 'pom.xml')));
      assert.match(fs.readFileSync(path.join(dir, 'pom.xml'), 'utf-8'), /flyway-maven-plugin/);
      assert.ok(fs.existsSync(path.join(dir, 'src/main/resources/application.properties')));
      assert.ok(fs.existsSync(path.join(dir, 'src/main/resources/db/migration/V1__init_placeholder.sql')));
      assert.match(
        fs.readFileSync(path.join(dir, 'src/main/resources/application.properties'), 'utf-8'),
        /spring\.flyway\.enabled=true/,
      );

      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it('uses bundled fallback when LAKEBASE_SCAFFOLD_FALLBACK=1', async () => {
    process.env.LAKEBASE_SCAFFOLD_FALLBACK = '1';
    const svc = new ScaffoldService();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-fallback-'));

    await svc.deployLanguageProject(dir, 'java', 'demo-project');

    assert.ok(fs.existsSync(path.join(dir, 'pom.xml')));
    assert.ok(fs.existsSync(path.join(dir, 'src/main/java/com/example/demo/DemoApplication.java')));
    assert.ok(fs.existsSync(path.join(dir, 'src/main/resources/application.properties')));

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
