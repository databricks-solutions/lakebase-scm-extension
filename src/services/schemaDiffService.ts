import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot, getEnvConfig, getConfig, getProjectDatabase } from '../utils/config';
import { exec } from '../utils/exec';
import { LakebaseService, LakebaseBranch } from './lakebaseService';

export interface SchemaObject {
  type: 'TABLE' | 'INDEX';
  name: string;
  columns?: Array<{ name: string; dataType: string }>;
}

export interface ModifiedSchemaObject extends SchemaObject {
  addedColumns: Array<{ name: string; dataType: string }>;
  removedColumns: Array<{ name: string; dataType: string }>;
  prodColumns: Array<{ name: string; dataType: string }>;
}

export interface SchemaDiffResult {
  branchName: string;
  /** The Lakebase branch this diff was computed AGAINST (the parent / source).
   *  Empty string when unknown or when comparing the default branch itself. */
  comparisonBranchName?: string;
  timestamp: string;
  migrations: Array<{ version: string; description: string }>;
  created: SchemaObject[];
  modified: ModifiedSchemaObject[];
  removed: SchemaObject[];
  /** All tables on the branch (for full inventory display) */
  branchTables: SchemaObject[];
  inSync: boolean;
  error?: string;
  rawDiff?: string;
}


export interface BranchCacheEntry {
  result: SchemaDiffResult;
  /** Latest migration mtime when this entry was built */
  migrationMtime: number;
  /** When this entry was created (ms since epoch) */
  createdAt: number;
}

export class SchemaDiffService {
  private lakebaseService: LakebaseService;
  /** Per-branch cache: branchId → { result, migrationMtime, createdAt } */
  private cache: Map<string, BranchCacheEntry> = new Map();

  /** Max age for cache entries (ms). After this, pg_dump re-runs even if migrations unchanged.
   *  Guards against serving stale results after credential expiry or external schema changes. */
  private static readonly CACHE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

  constructor(lakebaseService: LakebaseService) {
    this.lakebaseService = lakebaseService;
  }

  /**
   * Return the latest mtime (ms) across all Flyway migration files,
   * or 0 if none exist.
   */
  private getLatestMigrationMtime(): number {
    const root = getWorkspaceRoot();
    if (!root) { return 0; }
    const config = getConfig();
    const migrationDir = path.join(root, config.migrationPath);
    if (!fs.existsSync(migrationDir)) { return 0; }

    let latest = 0;
    for (const f of fs.readdirSync(migrationDir)) {
      if (!/^V\d+.*\.sql$/i.test(f)) { continue; }
      const mtime = fs.statSync(path.join(migrationDir, f)).mtimeMs;
      if (mtime > latest) { latest = mtime; }
    }
    return latest;
  }

  /**
   * Return a cached diff for the given branch without running pg_dump.
   * Returns undefined if:
   * - No cache entry for this branch
   * - The cached entry has an error
   * - A migration file is newer than when the cache was built
   * - The entry is older than CACHE_MAX_AGE_MS
   */
  getCachedDiff(branchId?: string): SchemaDiffResult | undefined {
    if (!branchId) {
      branchId = this.getCurrentBranchId();
    }
    if (!branchId) { return undefined; }

    const entry = this.cache.get(branchId);
    if (!entry || entry.result.error) { return undefined; }

    // Reject entries older than max age (guards against stale results after auth expiry)
    if (Date.now() - entry.createdAt > SchemaDiffService.CACHE_MAX_AGE_MS) {
      this.cache.delete(branchId);
      return undefined;
    }

    const latestMigration = this.getLatestMigrationMtime();
    if (latestMigration > entry.migrationMtime) { return undefined; }

    return entry.result;
  }

  /** Clear cache for a specific branch, or all branches if no id given */
  clearCache(branchId?: string): void {
    if (branchId) {
      this.cache.delete(branchId);
    } else {
      this.cache.clear();
    }
  }

  private getCurrentBranchId(): string | undefined {
    const envConfig = getEnvConfig();
    return envConfig.LAKEBASE_BRANCH_ID || undefined;
  }

  /** Run the existing prepare-schema-diff.sh and parse its output */
  async generateDiff(): Promise<SchemaDiffResult> {
    const root = getWorkspaceRoot();
    if (!root) {
      throw new Error('No workspace root');
    }

    const envConfig = getEnvConfig();
    const host = this.lakebaseService.getEffectiveHost();
    const env: Record<string, string> = {};
    if (host) {
      env.DATABRICKS_HOST = host;
    }

    // Run the existing script
    try {
      await exec('./scripts/prepare-schema-diff.sh', root, env);
    } catch (err: any) {
      // Script may fail but still produce schema-diff.md
    }

    const diffPath = path.join(root, 'schema-diff.md');
    if (!fs.existsSync(diffPath)) {
      return this.emptyResult('Schema diff script produced no output');
    }

    const raw = fs.readFileSync(diffPath, 'utf-8');
    return this.parseMarkdownDiff(raw);
  }

  /** Parse the schema-diff.md output into structured data */
  private parseMarkdownDiff(raw: string): SchemaDiffResult {
    const result: SchemaDiffResult = {
      branchName: '',
      timestamp: new Date().toISOString(),
      migrations: [],
      created: [],
      modified: [],
      removed: [],
      branchTables: [],
      inSync: false,
      rawDiff: raw,
    };

    // Extract branch name
    const branchMatch = raw.match(/Lakebase branch `([^`]+)`/);
    if (branchMatch) {
      result.branchName = branchMatch[1];
    }

    // Extract migrations table
    const migrationRegex = /\| V(\d+) \| (.+?) \|/g;
    let m;
    while ((m = migrationRegex.exec(raw)) !== null) {
      result.migrations.push({ version: m[1], description: m[2] });
    }

    // Parse SCHEMA CHANGES section
    const schemaSection = raw.split('**SCHEMA CHANGES')[1] || '';

    // Created tables/indexes
    const createdRegex = /^\+ (TABLE|INDEX) (\S+) \(CREATED\)/gm;
    while ((m = createdRegex.exec(schemaSection)) !== null) {
      const obj: SchemaObject = { type: m[1] as 'TABLE' | 'INDEX', name: m[2] };
      if (m[1] === 'TABLE') {
        obj.columns = this.parseColumns(schemaSection, m.index! + m[0].length);
      }
      result.created.push(obj);
    }

    // Modified tables
    const modifiedRegex = /^~ (TABLE) (\S+) \(MODIFIED\)/gm;
    while ((m = modifiedRegex.exec(schemaSection)) !== null) {
      const addedColumns = this.parseAddedColumns(schemaSection, m.index! + m[0].length);
      result.modified.push({
        type: 'TABLE',
        name: m[2],
        addedColumns,
        removedColumns: [],
        prodColumns: [],
      });
    }

    // Removed tables/indexes
    const removedRegex = /^- (TABLE|INDEX) (\S+) \(REMOVED\)/gm;
    while ((m = removedRegex.exec(schemaSection)) !== null) {
      result.removed.push({ type: m[1] as 'TABLE' | 'INDEX', name: m[2] });
    }

    result.inSync = raw.includes('No schema changes (in sync)') ||
                    raw.includes('In sync');

    if (raw.includes('pg_dump failed') || raw.includes('could not be resolved')) {
      result.error = raw.match(/# (.+)/)?.[1] || 'Schema diff failed';
    }

    return result;
  }

  private parseColumns(text: string, startPos: number): Array<{ name: string; dataType: string }> {
    const columns: Array<{ name: string; dataType: string }> = [];
    const lines = text.substring(startPos).split('\n');
    for (const line of lines) {
      const colMatch = line.match(/^\s+L (\S+) (.+)$/);
      if (colMatch) {
        columns.push({ name: colMatch[1], dataType: colMatch[2] });
      } else if (line.trim() && !line.startsWith('  ')) {
        break;
      }
    }
    return columns;
  }

  private parseAddedColumns(text: string, startPos: number): Array<{ name: string; dataType: string }> {
    const columns: Array<{ name: string; dataType: string }> = [];
    const lines = text.substring(startPos).split('\n');
    for (const line of lines) {
      const colMatch = line.match(/^\s+\+ (\S+) (.+)$/);
      if (colMatch) {
        columns.push({ name: colMatch[1], dataType: colMatch[2] });
      } else if (line.trim() && !line.startsWith('  ')) {
        break;
      }
    }
    return columns;
  }

  private emptyResult(error: string): SchemaDiffResult {
    return {
      branchName: '',
      timestamp: new Date().toISOString(),
      migrations: [],
      created: [],
      modified: [],
      removed: [],
      branchTables: [],
      inSync: false,
      error,
    };
  }

  /**
   * Query both Lakebase branches (target + default) via pg_dump to discover
   * tables that exist on the branch but not production, and vice versa.
   * @param targetBranchId — branch to compare against production; defaults to LAKEBASE_BRANCH_ID from .env
   * @param force — bypass the per-branch cache
   */
  async compareBranchSchemas(targetBranchId?: string, force: boolean = false): Promise<SchemaDiffResult> {
    const root = getWorkspaceRoot();
    if (!root) {
      return this.emptyResult('No workspace root');
    }

    const branchId = targetBranchId || getEnvConfig().LAKEBASE_BRANCH_ID;

    if (!branchId) {
      return this.emptyResult('LAKEBASE_BRANCH_ID not configured in .env');
    }

    // Check per-branch cache
    if (!force) {
      const cached = this.getCachedDiff(branchId);
      if (cached) { return cached; }
    }

    // Primary: query actual schema via information_schema (fast, reliable).
    // Fallback: pg_dump --schema-only (slower, requires pg_dump on PATH).
    type TableList = { tables: Array<{ name: string; columns: Array<{ name: string; dataType: string }> }>; error?: string };
    let branchTables: TableList;
    let prodTables: TableList;

    // Resolve the comparison target. Default is the CURRENT BRANCH'S parent
    // (its source_branch in Lakebase metadata) — for a feature forked from
    // staging, that means diff vs staging, not vs production. Falls back to
    // the project's default branch when source can't be resolved (e.g. for
    // staging itself, or branches whose source has been deleted).
    let comparisonTarget: LakebaseBranch | undefined;
    let branchObj: LakebaseBranch | undefined;
    try {
      branchObj = await this.lakebaseService.getBranchByName(branchId);
    } catch { /* ignore */ }
    if (branchObj?.sourceBranchId) {
      try {
        comparisonTarget = await this.lakebaseService.getBranchByName(branchObj.sourceBranchId);
      } catch { /* fall through */ }
    }
    if (!comparisonTarget) {
      try {
        comparisonTarget = await this.lakebaseService.getDefaultBranch();
      } catch { /* ignore */ }
    }
    if (!comparisonTarget) {
      return this.emptyResult('Could not resolve a comparison target Lakebase branch');
    }

    try {
      const branchSchema = await this.lakebaseService.queryBranchSchema(branchId);
      const targetSchema = await this.lakebaseService.queryBranchSchema(comparisonTarget.uid);
      branchTables = { tables: branchSchema.filter(t => t.name !== 'flyway_schema_history') };
      prodTables = { tables: targetSchema.filter(t => t.name !== 'flyway_schema_history') };
    } catch (err: any) {
      // Fallback: fetch credentials and use pg_dump
      try {
        let branchEp = await this.lakebaseService.getEndpoint(branchId);
        if (!branchEp?.host) {
          await new Promise(r => setTimeout(r, 5000));
          branchEp = await this.lakebaseService.getEndpoint(branchId);
        }
        if (!branchEp?.host) {
          return this.emptyResult(`No endpoint for branch "${branchId}". Try again in a few seconds.`);
        }
        const branchCred = await this.lakebaseService.getCredential(branchId);
        let targetEp = await this.lakebaseService.getEndpoint(comparisonTarget.branchId);
        if (!targetEp?.host) {
          await new Promise(r => setTimeout(r, 5000));
          targetEp = await this.lakebaseService.getEndpoint(comparisonTarget.branchId);
        }
        if (!targetEp?.host) {
          return this.emptyResult(`No endpoint for comparison target branch "${comparisonTarget.branchId}"`);
        }
        const targetCred = await this.lakebaseService.getCredential(comparisonTarget.branchId);
        const dbName = getProjectDatabase();
        branchTables = await this.listTables(branchEp.host, '5432', dbName, branchCred.email, branchCred.token);
        prodTables = await this.listTables(targetEp.host, '5432', dbName, targetCred.email, targetCred.token);
      } catch (fallbackErr: any) {
        return this.emptyResult(`Cannot fetch schema: ${err.message}. Fallback also failed: ${fallbackErr.message}`);
      }
    }

    if (branchTables.error && prodTables.error) {
      return this.emptyResult(`Branch: ${branchTables.error}\nProduction: ${prodTables.error}`);
    }

    const prodSet = new Set(prodTables.tables.map(t => t.name));
    const branchSet = new Set(branchTables.tables.map(t => t.name));

    const created: SchemaObject[] = branchTables.tables
      .filter(t => !prodSet.has(t.name))
      .map(t => ({ type: 'TABLE' as const, name: t.name, columns: t.columns }));

    const removed: SchemaObject[] = prodTables.tables
      .filter(t => !branchSet.has(t.name))
      .map(t => ({ type: 'TABLE' as const, name: t.name }));

    // Detect modified tables (same name, different column sets)
    const modified: ModifiedSchemaObject[] = [];
    for (const bt of branchTables.tables) {
      if (!prodSet.has(bt.name)) { continue; }
      const pt = prodTables.tables.find(t => t.name === bt.name);
      if (!pt) { continue; }
      const prodColSet = new Set(pt.columns.map(c => `${c.name}:${c.dataType}`));
      const branchColSet = new Set(bt.columns.map(c => `${c.name}:${c.dataType}`));
      const addedColumns = bt.columns.filter(c => !prodColSet.has(`${c.name}:${c.dataType}`));
      const removedColumns = pt.columns.filter(c => !branchColSet.has(`${c.name}:${c.dataType}`));
      if (addedColumns.length > 0 || removedColumns.length > 0) {
        modified.push({
          type: 'TABLE', name: bt.name, columns: bt.columns,
          addedColumns, removedColumns, prodColumns: pt.columns,
        });
      }
    }

    const branchName = branchId;
    const totalChanges = created.length + modified.length + removed.length;

    // All tables on the branch (full inventory)
    const branchTableObjects: SchemaObject[] = branchTables.tables.map(t => ({
      type: 'TABLE' as const, name: t.name, columns: t.columns,
    }));

    const result: SchemaDiffResult = {
      branchName,
      comparisonBranchName: comparisonTarget.branchId,
      timestamp: new Date().toISOString(),
      migrations: [],
      created,
      modified,
      removed,
      branchTables: branchTableObjects,
      inSync: totalChanges === 0,
    };

    // Store in per-branch cache (only cache successful results)
    if (!result.error) {
      this.cache.set(branchId, {
        result,
        migrationMtime: this.getLatestMigrationMtime(),
        createdAt: Date.now(),
      });
    }
    return result;
  }

  private parseJdbc(url: string): { host: string; port: string; db: string } | undefined {
    const match = url.match(/jdbc:postgresql:\/\/([^:\/]+):?(\d+)?\/([^?]+)/);
    if (!match) { return undefined; }
    return { host: match[1], port: match[2] || '5432', db: match[3] };
  }

  private async listTables(
    host: string, port: string, db: string, user: string, pass: string
  ): Promise<{ tables: Array<{ name: string; columns: Array<{ name: string; dataType: string }> }>; error?: string }> {
    const root = getWorkspaceRoot();
    // Use pg_dump --schema-only, parse CREATE TABLE statements
    try {
      const raw = await exec(
        `pg_dump -h "${host}" -p "${port}" -U "${user}" -d "${db}" --schema-only --no-owner --no-privileges`,
        root,
        { PGPASSWORD: pass, PGSSLMODE: 'require' }
      );
      return { tables: this.parsePgDumpTables(raw) };
    } catch (err: any) {
      // Try common macOS Homebrew paths
      for (const pgPath of ['/opt/homebrew/opt/libpq/bin', '/usr/local/opt/libpq/bin']) {
        try {
          const raw = await exec(
            `"${pgPath}/pg_dump" -h "${host}" -p "${port}" -U "${user}" -d "${db}" --schema-only --no-owner --no-privileges`,
            root,
            { PGPASSWORD: pass, PGSSLMODE: 'require' }
          );
          return { tables: this.parsePgDumpTables(raw) };
        } catch {
          continue;
        }
      }
      return { tables: [], error: String(err.message).split('\n')[0] };
    }
  }

  private parsePgDumpTables(raw: string): Array<{ name: string; columns: Array<{ name: string; dataType: string }> }> {
    const tables: Array<{ name: string; columns: Array<{ name: string; dataType: string }> }> = [];
    // Match CREATE TABLE public.name ( ... );
    const tableRegex = /CREATE TABLE (?:public\.)?(\w+)\s*\(([\s\S]*?)\);/g;
    let match;
    while ((match = tableRegex.exec(raw)) !== null) {
      const tableName = match[1];
      // Skip flyway history and system tables
      if (tableName === 'flyway_schema_history') { continue; }
      const columns: Array<{ name: string; dataType: string }> = [];
      const body = match[2];
      for (const line of body.split('\n')) {
        const colMatch = line.trim().match(/^(\w+)\s+(.+?)(?:,?\s*$)/);
        if (colMatch && !colMatch[2].startsWith('CONSTRAINT') && !colMatch[2].startsWith('PRIMARY') &&
            !colMatch[2].startsWith('FOREIGN') && !colMatch[2].startsWith('UNIQUE') && !colMatch[2].startsWith('CHECK')) {
          columns.push({ name: colMatch[1], dataType: colMatch[2].replace(/,\s*$/, '') });
        }
      }
      tables.push({ name: tableName, columns });
    }
    return tables;
  }

  /** Read existing schema-diff.md without regenerating */
  readCachedDiff(): SchemaDiffResult | undefined {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }
    const diffPath = path.join(root, 'schema-diff.md');
    if (!fs.existsSync(diffPath)) { return undefined; }
    const raw = fs.readFileSync(diffPath, 'utf-8');
    return this.parseMarkdownDiff(raw);
  }
}
