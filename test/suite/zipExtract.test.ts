import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { extractZipToDir } from '../../src/utils/zipExtract';

describe('zipExtract', () => {
  it('hoists a single top-level directory into targetDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extract-'));
    const zip = new AdmZip();
    zip.addFile('demo/pom.xml', Buffer.from('<project/>'));
    zip.addFile('demo/src/main/App.java', Buffer.from('class App {}'));
    const zipBuffer = zip.toBuffer();

    extractZipToDir(zipBuffer, dir);

    assert.ok(fs.existsSync(path.join(dir, 'pom.xml')));
    assert.ok(fs.existsSync(path.join(dir, 'src', 'main', 'App.java')));

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
