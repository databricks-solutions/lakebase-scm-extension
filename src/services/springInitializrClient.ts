import { sanitizeArtifactId } from '../utils/mavenCoords';

export type SpringJvmLanguage = 'java' | 'kotlin';

export interface InitializrMetadata {
  bootVersion: string;
  javaVersion: string;
}

const MAVEN_PROJECT_TYPE = 'maven-project';

export interface GenerateMavenProjectOptions {
  language: SpringJvmLanguage;
  artifactId: string;
  name?: string;
  groupId?: string;
  packageName?: string;
  description?: string;
}

export class InitializrNetworkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'InitializrNetworkError';
  }
}

export class InitializrParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitializrParseError';
  }
}

type FetchFn = typeof fetch;

interface MetadataCache {
  metadata: InitializrMetadata;
  fetchedAt: number;
}

const METADATA_ACCEPT = 'application/vnd.initializr.v2.3+json';
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_BASE_URL = 'https://start.spring.io';
const DEPENDENCIES = 'web,data-jpa,postgresql,flyway';

/** True for SNAPSHOT, RC, milestone, alpha/beta Spring Boot versions. */
export function isPrereleaseBootVersion(version: string): boolean {
  const upper = version.toUpperCase();
  return upper.includes('SNAPSHOT')
    || /-(RC|M)\d/i.test(version)
    || /-(ALPHA|BETA)\d/i.test(version);
}

/**
 * Pick the newest GA Spring Boot version from Initializr metadata.
 * Initializr lists versions newest-first; we take the first non-prerelease id.
 */
export function resolveLatestBootVersion(section: unknown): string {
  if (!section || typeof section !== 'object') {
    throw new InitializrParseError('Missing bootVersion in Spring Initializr metadata');
  }

  const bootSection = section as { default?: unknown; values?: Array<{ id?: string }> };
  const values = bootSection.values || [];
  for (const entry of values) {
    if (typeof entry.id === 'string' && entry.id && !isPrereleaseBootVersion(entry.id)) {
      return entry.id;
    }
  }

  if (typeof bootSection.default === 'string' && bootSection.default) {
    return bootSection.default;
  }

  throw new InitializrParseError('No Spring Boot version found in Initializr metadata');
}

/** Java 8/11 and every fourth release from 17 (17, 21, 25, …) are LTS. */
export function isLtsJavaVersion(version: string): boolean {
  const n = Number.parseInt(version, 10);
  if (Number.isNaN(n)) { return false; }
  if (n === 8 || n === 11) { return true; }
  return n >= 17 && (n - 17) % 4 === 0;
}

/** Pick the newest LTS Java version that Initializr supports for this Boot release. */
export function resolveLatestLtsJavaVersion(section: unknown): string {
  if (!section || typeof section !== 'object') {
    throw new InitializrParseError('Missing javaVersion in Spring Initializr metadata');
  }

  const javaSection = section as { default?: unknown; values?: Array<{ id?: string }> };
  const available = new Set<string>();
  if (typeof javaSection.default === 'string' && javaSection.default) {
    available.add(javaSection.default);
  }
  for (const entry of javaSection.values || []) {
    if (typeof entry.id === 'string' && entry.id) {
      available.add(entry.id);
    }
  }

  let latest = -1;
  let latestId = '';
  for (const id of available) {
    if (!isLtsJavaVersion(id)) { continue; }
    const n = Number.parseInt(id, 10);
    if (n > latest) {
      latest = n;
      latestId = id;
    }
  }
  if (latestId) { return latestId; }

  if (typeof javaSection.default === 'string' && javaSection.default) {
    return javaSection.default;
  }

  throw new InitializrParseError('No Java version found in Initializr metadata');
}

export class SpringInitializrClient {
  private metadataCache?: MetadataCache;

  constructor(
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  ) {}

  async getMetadata(forceRefresh = false): Promise<InitializrMetadata> {
    if (!forceRefresh && this.metadataCache && Date.now() - this.metadataCache.fetchedAt < CACHE_TTL_MS) {
      return this.metadataCache.metadata;
    }

    const url = this.baseUrl.replace(/\/$/, '') + '/';
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { Accept: METADATA_ACCEPT },
      });
    } catch (err) {
      throw new InitializrNetworkError(`Failed to reach Spring Initializr at ${this.baseUrl}`, err);
    }

    if (!response.ok) {
      throw new InitializrNetworkError(`Spring Initializr metadata request failed (${response.status})`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new InitializrParseError('Spring Initializr metadata response was not valid JSON');
    }

    const metadata = this.parseMetadata(body);
    this.metadataCache = { metadata, fetchedAt: Date.now() };
    return metadata;
  }

  async generateMavenProject(opts: GenerateMavenProjectOptions): Promise<Buffer> {
    // Always fetch fresh metadata when scaffolding so we pick up newly released versions.
    const metadata = await this.getMetadata(true);
    const artifactId = sanitizeArtifactId(opts.artifactId);
    const params = new URLSearchParams({
      type: MAVEN_PROJECT_TYPE,
      language: opts.language,
      bootVersion: metadata.bootVersion,
      javaVersion: metadata.javaVersion,
      packaging: 'jar',
      dependencies: DEPENDENCIES,
      groupId: opts.groupId || 'com.example',
      artifactId,
      name: opts.name || artifactId,
      packageName: opts.packageName || 'com.example.demo',
      description: opts.description || 'Spring Boot + JPA + PostgreSQL with Flyway; database branches via Lakebase.',
      version: '1.0.0-SNAPSHOT',
    });

    const url = `${this.baseUrl.replace(/\/$/, '')}/starter.zip?${params.toString()}`;
    let response: Response;
    try {
      response = await this.fetchFn(url);
    } catch (err) {
      throw new InitializrNetworkError(`Failed to download project from Spring Initializr`, err);
    }

    if (!response.ok) {
      throw new InitializrNetworkError(`Spring Initializr project generation failed (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private parseMetadata(body: unknown): InitializrMetadata {
    if (!body || typeof body !== 'object') {
      throw new InitializrParseError('Spring Initializr metadata response was empty');
    }

    const doc = body as Record<string, unknown>;
    const bootVersion = resolveLatestBootVersion(doc.bootVersion);
    const javaVersion = resolveLatestLtsJavaVersion(doc.javaVersion);

    return { bootVersion, javaVersion };
  }

  private readDefault(section: unknown, label: string): string {
    if (!section || typeof section !== 'object') {
      throw new InitializrParseError(`Missing ${label} in Spring Initializr metadata`);
    }
    const value = (section as { default?: unknown }).default;
    if (typeof value !== 'string' || !value) {
      throw new InitializrParseError(`Missing default ${label} in Spring Initializr metadata`);
    }
    return value;
  }
}
