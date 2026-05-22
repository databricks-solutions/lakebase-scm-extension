import { strict as assert } from 'assert';
import {
  SpringInitializrClient,
  InitializrParseError,
  resolveLatestBootVersion,
  resolveLatestLtsJavaVersion,
  isPrereleaseBootVersion,
  isLtsJavaVersion,
} from '../../src/services/springInitializrClient';

const SAMPLE_METADATA = {
  bootVersion: {
    default: '4.0.6',
    values: [
      { id: '4.1.0-SNAPSHOT' },
      { id: '4.1.0-RC1' },
      { id: '4.0.7-SNAPSHOT' },
      { id: '4.0.6' },
      { id: '3.5.14' },
    ],
  },
  javaVersion: {
    default: '17',
    values: [{ id: '26' }, { id: '25' }, { id: '21' }, { id: '17' }],
  },
};

describe('SpringInitializrClient', () => {
  describe('resolveLatestBootVersion', () => {
    it('skips snapshots and RCs and picks the newest GA release', () => {
      assert.strictEqual(resolveLatestBootVersion(SAMPLE_METADATA.bootVersion), '4.0.6');
    });

    it('identifies prerelease versions', () => {
      assert.strictEqual(isPrereleaseBootVersion('4.1.0-SNAPSHOT'), true);
      assert.strictEqual(isPrereleaseBootVersion('4.1.0-RC1'), true);
      assert.strictEqual(isPrereleaseBootVersion('4.0.6'), false);
    });
  });

  describe('resolveLatestLtsJavaVersion', () => {
    it('picks the newest LTS, not the Initializr default or non-LTS releases', () => {
      assert.strictEqual(resolveLatestLtsJavaVersion(SAMPLE_METADATA.javaVersion), '25');
    });

    it('identifies LTS Java versions', () => {
      assert.strictEqual(isLtsJavaVersion('26'), false);
      assert.strictEqual(isLtsJavaVersion('25'), true);
      assert.strictEqual(isLtsJavaVersion('21'), true);
      assert.strictEqual(isLtsJavaVersion('17'), true);
    });
  });

  it('parses metadata defaults', async () => {
    const client = new SpringInitializrClient('https://start.spring.io', async () => ({
      ok: true,
      json: async () => SAMPLE_METADATA,
    } as Response));

    const metadata = await client.getMetadata(true);
    assert.strictEqual(metadata.bootVersion, '4.0.6');
    assert.strictEqual(metadata.javaVersion, '25');
  });

  it('fetches fresh metadata for each project generation', async () => {
    let metadataCalls = 0;
    const zipBytes = Buffer.from('PK\x03\x04');
    const client = new SpringInitializrClient('https://start.spring.io', async (url) => {
      if (String(url).endsWith('/')) {
        metadataCalls++;
        return { ok: true, json: async () => SAMPLE_METADATA } as Response;
      }
      return {
        ok: true,
        arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
      } as Response;
    });

    await client.getMetadata(true);
    await client.generateMavenProject({ language: 'java', artifactId: 'demo' });
    assert.strictEqual(metadataCalls, 2);
  });

  it('caches metadata within TTL when not forced', async () => {
    let calls = 0;
    const client = new SpringInitializrClient('https://start.spring.io', async () => {
      calls++;
      return { ok: true, json: async () => SAMPLE_METADATA } as Response;
    });

    await client.getMetadata(true);
    await client.getMetadata();
    assert.strictEqual(calls, 1);
  });

  it('builds starter.zip request with language and coordinates', async () => {
    let requestedUrl = '';
    const zipBytes = Buffer.from('PK\x03\x04');
    const client = new SpringInitializrClient('https://start.spring.io', async (url) => {
      requestedUrl = String(url);
      if (requestedUrl.endsWith('/')) {
        return { ok: true, json: async () => SAMPLE_METADATA } as Response;
      }
      return {
        ok: true,
        arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength),
      } as Response;
    });

    const zip = await client.generateMavenProject({
      language: 'kotlin',
      artifactId: 'My App',
      name: 'My App',
    });

    assert.ok(Buffer.isBuffer(zip));
    assert.match(requestedUrl, /starter\.zip\?/);
    assert.match(requestedUrl, /type=maven-project/);
    assert.match(requestedUrl, /language=kotlin/);
    assert.match(requestedUrl, /javaVersion=25/);
    assert.match(requestedUrl, /artifactId=my-app/);
    assert.match(requestedUrl, /bootVersion=4\.0\.6/);
  });

  it('throws InitializrParseError for invalid metadata', async () => {
    const client = new SpringInitializrClient('https://start.spring.io', async () => ({
      ok: true,
      json: async () => ({}),
    } as Response));

    await assert.rejects(
      () => client.getMetadata(true),
      (err: unknown) => err instanceof InitializrParseError,
    );
  });
});
