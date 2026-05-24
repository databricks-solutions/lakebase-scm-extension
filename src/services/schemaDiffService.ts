// SchemaDiffService — VS Code-aware shell over the substrate's schema-diff.
//
// FEIP-7065 (publish_and_consume): the core "compare two Lakebase branches"
// logic lives in @databricks-solutions/lakebase-scm-workflow-scripts. This
// service keeps:
//   - Per-branch cache (mtime + age) — pure VS Code perf optimization
//   - parseMarkdownDiff / generateDiff / readCachedDiff — legacy schema-diff.md
//     support (the scaffolded prepare-schema-diff.sh writes a markdown file;
//     agents don't need this path)
//
// As the legacy markdown flow ages out we can collapse this service further.

import * as fs from "fs";
import * as path from "path";
import { getWorkspaceRoot, getEnvConfig, getConfig } from "../utils/config";
import { exec } from "../utils/exec";
import { LakebaseService } from "./lakebaseService";
import { getSchemaDiff as substrateGetSchemaDiff } from "@databricks-solutions/lakebase-scm-workflow-scripts";

export interface SchemaObject {
  type: "TABLE" | "INDEX";
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
  /** The Lakebase branch this diff was computed AGAINST (the parent / source). */
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
  migrationMtime: number;
  createdAt: number;
}

export class SchemaDiffService {
  private lakebaseService: LakebaseService;
  /** Per-branch cache: branchId → { result, migrationMtime, createdAt } */
  private cache: Map<string, BranchCacheEntry> = new Map();

  private static readonly CACHE_MAX_AGE_MS = 10 * 60 * 1000;

  constructor(lakebaseService: LakebaseService) {
    this.lakebaseService = lakebaseService;
  }

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

  getCachedDiff(branchId?: string): SchemaDiffResult | undefined {
    if (!branchId) { branchId = this.getCurrentBranchId(); }
    if (!branchId) { return undefined; }

    const entry = this.cache.get(branchId);
    if (!entry || entry.result.error) { return undefined; }

    if (Date.now() - entry.createdAt > SchemaDiffService.CACHE_MAX_AGE_MS) {
      this.cache.delete(branchId);
      return undefined;
    }

    const latestMigration = this.getLatestMigrationMtime();
    if (latestMigration > entry.migrationMtime) { return undefined; }

    return entry.result;
  }

  clearCache(branchId?: string): void {
    if (branchId) { this.cache.delete(branchId); }
    else { this.cache.clear(); }
  }

  private getCurrentBranchId(): string | undefined {
    return getEnvConfig().LAKEBASE_BRANCH_ID || undefined;
  }

  /** Run the bundled prepare-schema-diff.sh and parse its markdown output. */
  async generateDiff(): Promise<SchemaDiffResult> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error("No workspace root"); }
    const host = this.lakebaseService.getEffectiveHost();
    const env: Record<string, string> = {};
    if (host) { env.DATABRICKS_HOST = host; }

    try {
      await exec("./scripts/prepare-schema-diff.sh", root, env);
    } catch {
      // Script may fail but still produce schema-diff.md
    }

    const diffPath = path.join(root, "schema-diff.md");
    if (!fs.existsSync(diffPath)) {
      return this.emptyResult("Schema diff script produced no output");
    }
    return this.parseMarkdownDiff(fs.readFileSync(diffPath, "utf-8"));
  }

  private parseMarkdownDiff(raw: string): SchemaDiffResult {
    const result: SchemaDiffResult = {
      branchName: "",
      timestamp: new Date().toISOString(),
      migrations: [],
      created: [],
      modified: [],
      removed: [],
      branchTables: [],
      inSync: false,
      rawDiff: raw,
    };

    const branchMatch = raw.match(/Lakebase branch `([^`]+)`/);
    if (branchMatch) { result.branchName = branchMatch[1]; }

    const migrationRegex = /\| V(\d+) \| (.+?) \|/g;
    let m;
    while ((m = migrationRegex.exec(raw)) !== null) {
      result.migrations.push({ version: m[1], description: m[2] });
    }

    const schemaSection = raw.split("**SCHEMA CHANGES")[1] || "";

    const createdRegex = /^\+ (TABLE|INDEX) (\S+) \(CREATED\)/gm;
    while ((m = createdRegex.exec(schemaSection)) !== null) {
      const obj: SchemaObject = { type: m[1] as "TABLE" | "INDEX", name: m[2] };
      if (m[1] === "TABLE") {
        obj.columns = this.parseColumns(schemaSection, m.index! + m[0].length);
      }
      result.created.push(obj);
    }

    const modifiedRegex = /^~ (TABLE) (\S+) \(MODIFIED\)/gm;
    while ((m = modifiedRegex.exec(schemaSection)) !== null) {
      const addedColumns = this.parseAddedColumns(schemaSection, m.index! + m[0].length);
      result.modified.push({
        type: "TABLE", name: m[2],
        addedColumns, removedColumns: [], prodColumns: [],
      });
    }

    const removedRegex = /^- (TABLE|INDEX) (\S+) \(REMOVED\)/gm;
    while ((m = removedRegex.exec(schemaSection)) !== null) {
      result.removed.push({ type: m[1] as "TABLE" | "INDEX", name: m[2] });
    }

    result.inSync = raw.includes("No schema changes (in sync)") || raw.includes("In sync");
    if (raw.includes("pg_dump failed") || raw.includes("could not be resolved")) {
      result.error = raw.match(/# (.+)/)?.[1] || "Schema diff failed";
    }

    return result;
  }

  private parseColumns(text: string, startPos: number): Array<{ name: string; dataType: string }> {
    const columns: Array<{ name: string; dataType: string }> = [];
    const lines = text.substring(startPos).split("\n");
    for (const line of lines) {
      const colMatch = line.match(/^\s+L (\S+) (.+)$/);
      if (colMatch) {
        columns.push({ name: colMatch[1], dataType: colMatch[2] });
      } else if (line.trim() && !line.startsWith("  ")) { break; }
    }
    return columns;
  }

  private parseAddedColumns(text: string, startPos: number): Array<{ name: string; dataType: string }> {
    const columns: Array<{ name: string; dataType: string }> = [];
    const lines = text.substring(startPos).split("\n");
    for (const line of lines) {
      const colMatch = line.match(/^\s+\+ (\S+) (.+)$/);
      if (colMatch) {
        columns.push({ name: colMatch[1], dataType: colMatch[2] });
      } else if (line.trim() && !line.startsWith("  ")) { break; }
    }
    return columns;
  }

  private emptyResult(error: string): SchemaDiffResult {
    return {
      branchName: "",
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
   * Compare a branch's live schema against its parent — routes through the
   * substrate's getSchemaDiff, then caches the result against migration mtime.
   */
  async compareBranchSchemas(targetBranchId?: string, force = false): Promise<SchemaDiffResult> {
    const branchId = targetBranchId || getEnvConfig().LAKEBASE_BRANCH_ID;
    if (!branchId) {
      return this.emptyResult("LAKEBASE_BRANCH_ID not configured in .env");
    }

    if (!force) {
      const cached = this.getCachedDiff(branchId);
      if (cached) { return cached; }
    }

    // Mutate DATABRICKS_HOST to the effective extension host around the call —
    // substrate's CLI invocations read it from env.
    const host = this.lakebaseService.getEffectiveHost();
    const prior = process.env.DATABRICKS_HOST;
    if (host) { process.env.DATABRICKS_HOST = host; }

    let result: SchemaDiffResult;
    try {
      const sub = await substrateGetSchemaDiff({
        instance: this.projectInstance(),
        branch: branchId,
      });
      result = { ...sub, timestamp: sub.timestamp || new Date().toISOString() };
    } catch (err: any) {
      result = this.emptyResult(`Schema diff failed: ${err?.message || err}`);
    } finally {
      if (prior === undefined) { delete process.env.DATABRICKS_HOST; }
      else { process.env.DATABRICKS_HOST = prior; }
    }

    if (!result.error) {
      this.cache.set(branchId, {
        result,
        migrationMtime: this.getLatestMigrationMtime(),
        createdAt: Date.now(),
      });
    }
    return result;
  }

  private projectInstance(): string {
    return getConfig().lakebaseProjectId;
  }

  /** Read existing schema-diff.md without regenerating. */
  readCachedDiff(): SchemaDiffResult | undefined {
    const root = getWorkspaceRoot();
    if (!root) { return undefined; }
    const diffPath = path.join(root, "schema-diff.md");
    if (!fs.existsSync(diffPath)) { return undefined; }
    return this.parseMarkdownDiff(fs.readFileSync(diffPath, "utf-8"));
  }
}
