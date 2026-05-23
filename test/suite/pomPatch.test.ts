import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { patchPomForLakebase } from '../../src/utils/pomPatch';

const MINIMAL_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
    <dependencies>
        <dependency>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-core</artifactId>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>`;

describe('pomPatch', () => {
  it('adds flyway-database-postgresql, surefire, and flyway-maven-plugin', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pom-patch-'));
    const pomPath = path.join(dir, 'pom.xml');
    fs.writeFileSync(pomPath, MINIMAL_POM);

    patchPomForLakebase(pomPath);
    const patched = fs.readFileSync(pomPath, 'utf-8');

    assert.match(patched, /flyway-database-postgresql/);
    assert.match(patched, /flyway-maven-plugin/);
    assert.match(patched, /maven-surefire-plugin/);
    assert.match(patched, /baselineOnMigrate/);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
