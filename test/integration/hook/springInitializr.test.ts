/**
 * Small repro for the Spring Initializr scaffold path.
 *
 * The ecom integration test forces LAKEBASE_SCAFFOLD_FALLBACK=1 to use
 * the bundled static Java template, which means the Initializr extraction
 * path (start.spring.io fetch, zip extraction, file shadowing, Lakebase
 * pom overlay) has zero integration coverage. Real users hit Initializr
 * by default.
 *
 * This is a pure-scaffold test - no Lakebase project, no GitHub repo, no
 * hooks. Just provisions a temp dir, calls deploySpringStarter, and
 * asserts the file tree matches each mode's signature. Runs in ~10-20s.
 *
 * Pre-flight: network access to start.spring.io. No Databricks/GitHub
 * credentials needed.
 *
 * Run: npm run test:integration -- --grep "spring-initializr"
 */

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deploySpringStarter } from '@databricks-solutions/lakebase-app-dev-kit';

const NETWORK_TIMEOUT_MS = 30000;

describe('spring-initializr scaffold (small repro)', function () {
  this.timeout(120000);

  const tmpRoot = path.join(os.tmpdir(), `lb-initializr-${Date.now().toString(36)}`);
  const initializrDir = path.join(tmpRoot, 'initializr-path');
  const fallbackDir = path.join(tmpRoot, 'fallback-path');

  before(() => {
    fs.mkdirSync(initializrDir, { recursive: true });
    fs.mkdirSync(fallbackDir, { recursive: true });
    console.log(`\n  Temp root: ${tmpRoot}\n`);
  });

  it('Initializr path: fetches from start.spring.io and applies Lakebase overlay', async function () {
    this.timeout(NETWORK_TIMEOUT_MS);
    // Explicitly unset the fallback env so the substrate goes through the
    // Initializr network path. (Mocha runs all tests in the same process,
    // so the fallback test below would otherwise leak its env in.)
    const prior = process.env.LAKEBASE_SCAFFOLD_FALLBACK;
    delete process.env.LAKEBASE_SCAFFOLD_FALLBACK;
    try {
      await deploySpringStarter({
        targetDir: initializrDir,
        language: 'java',
        projectName: 'demo-initializr',
      });
    } finally {
      if (prior !== undefined) process.env.LAKEBASE_SCAFFOLD_FALLBACK = prior;
    }

    // Initializr fingerprints - the bundled fallback template does NOT
    // ship these files, so their presence proves we went through the
    // start.spring.io fetch + zip extraction path.
    assert.ok(
      fs.existsSync(path.join(initializrDir, 'HELP.md')),
      'HELP.md should exist (Initializr-only artifact, never in fallback)',
    );
    assert.ok(
      fs.existsSync(path.join(initializrDir, '.mvn', 'wrapper', 'maven-wrapper.properties')),
      '.mvn/wrapper/maven-wrapper.properties should exist (Initializr ships it)',
    );

    // pom.xml carries the artifactId we passed (Initializr substitutes
    // it into the generated pom; fallback would use {{PROJECT_NAME}}
    // unless the substrate also substituted, but the artifactId test
    // pins that the request actually reached start.spring.io).
    const pom = fs.readFileSync(path.join(initializrDir, 'pom.xml'), 'utf-8');
    assert.match(pom, /<artifactId>demo-initializr<\/artifactId>/, 'pom must carry the requested artifactId');

    // Lakebase overlay must have been applied AFTER extraction:
    // patchPomForLakebase adds flyway-pg, flyway-maven-plugin, and the
    // postgresql JDBC dep. None of those come from Initializr by default.
    assert.match(pom, /flyway-database-postgresql|flyway-pg/, 'Lakebase overlay must add the flyway-postgresql dep');
    assert.match(pom, /flyway-maven-plugin/, 'Lakebase overlay must add the flyway-maven-plugin');
    assert.match(pom, /<artifactId>postgresql<\/artifactId>/, 'Lakebase overlay must add the postgresql driver');
  });

  it('Fallback path: skips network, uses bundled template (regression guard for env gate)', async function () {
    // Setting the env makes the substrate skip start.spring.io entirely.
    // Even if network is available, this code path must not touch it.
    const prior = process.env.LAKEBASE_SCAFFOLD_FALLBACK;
    process.env.LAKEBASE_SCAFFOLD_FALLBACK = '1';
    try {
      await deploySpringStarter({
        targetDir: fallbackDir,
        language: 'java',
        projectName: 'demo-fallback',
      });
    } finally {
      if (prior === undefined) delete process.env.LAKEBASE_SCAFFOLD_FALLBACK;
      else process.env.LAKEBASE_SCAFFOLD_FALLBACK = prior;
    }

    // Fallback path must NOT produce Initializr artifacts. If a future
    // refactor moves HELP.md into the fallback template, the
    // Initializr test above stops distinguishing the two paths and this
    // assertion catches it.
    assert.ok(
      !fs.existsSync(path.join(fallbackDir, 'HELP.md')),
      'HELP.md must NOT appear in the fallback path',
    );

    // pom.xml must still exist and carry the Lakebase overlay (same
    // dependencies as Initializr path - the overlay is shared).
    const pom = fs.readFileSync(path.join(fallbackDir, 'pom.xml'), 'utf-8');
    assert.match(pom, /<artifactId>demo-fallback<\/artifactId>/, 'fallback pom must substitute the project name');
    assert.match(pom, /flyway-database-postgresql|flyway-pg/, 'fallback also applies Lakebase overlay');
  });

  after(() => {
    if (process.env.LB_INITIALIZR_NO_TEARDOWN === '1') {
      console.log(`  [teardown] skipped (LB_INITIALIZR_NO_TEARDOWN=1). Preserved: ${tmpRoot}`);
      return;
    }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
