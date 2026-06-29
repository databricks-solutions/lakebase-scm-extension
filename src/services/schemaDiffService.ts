// SchemaDiffService – VS Code-aware shell over the substrate's schema-diff.
//
// FEIP-7065 (publish_and_consume): the core "compare two Lakebase branches"
// logic lives in @databricks-solutions/lakebase-app-dev-kit. This
// service keeps:
//   - Per-branch cache (mtime + age) – pure VS Code perf optimization
//   - parseMarkdownDiff / generateDiff / readCachedDiff – legacy schema-diff.md
//     support (the scaffolded prepare-schema-diff.sh writes a markdown file;
//     agents don't need this path)
//
// As the legacy markdown flow ages out we can collapse this service further.

import * as fs from "fs";
import * as path from "path";
import { getWorkspaceRoot, getEnvConfig, getConfig, getProjectDatabase } from "../utils/config";
import { LakebaseService } from "./lakebaseService";
import { projectProtectedTierNames } from "../utils/tiers";
import { normalizeBranchName } from "../utils/branchParsing";

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

    // Invalidate against the project's ACTUAL migration filename pattern, not a
    // hardcoded Flyway glob. config.migrationPattern is auto-detected per language
    // (Flyway V*.sql, knex/Node <timestamp>_*.js|ts, Alembic versions/*.py, ...).
    // The old `/^V\d+.*\.sql$/i` returned 0 for every non-Flyway project, so the
    // "a migration appeared" cache fast-path never fired and the Schema Changes
    // panel served a stale "In Sync" until the 10-minute age TTL.
    let latest = 0;
    let matched = 0;
    let newestAny = 0;
    for (const f of fs.readdirSync(migrationDir)) {
      let mtime: number;
      try {
        const st = fs.statSync(path.join(migrationDir, f));
        if (!st.isFile()) { continue; }
        mtime = st.mtimeMs;
      } catch { continue; }
      if (mtime > newestAny) { newestAny = mtime; }
      if (config.migrationPattern.test(f)) {
        matched++;
        if (mtime > latest) { latest = mtime; }
      }
    }
    // If the detected pattern matched nothing but the directory has files, fall
    // back to the newest file's mtime rather than silently reporting "no migration
    // ever changed" (which would pin the cache to the TTL for an unrecognized layout).
    return matched > 0 ? latest : newestAny;
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

  /**
   * Compute a fresh schema diff for the current branch via the kit's
   * substrate (FEIP-7494). Previously this method shelled to
   * ./scripts/prepare-schema-diff.sh, read the markdown file it
   * produced, and parsed the text back into structured fields - that
   * round trip is gone now. The substrate's getSchemaDiff returns the
   * structured shape directly; this method is a thin alias over
   * compareBranchSchemas with force=true for the "always recompute"
   * UX the legacy generateDiff guaranteed.
   */
  async generateDiff(): Promise<SchemaDiffResult> {
    const root = getWorkspaceRoot();
    if (!root) { throw new Error("No workspace root"); }
    return this.compareBranchSchemas(undefined, /* force */ true);
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

  /**
   * Scan column lines under a table header in the markdown diff. Single
   * source of truth for parseColumns / parseAddedColumns, which differed
   * only in the line marker regex (`L ` for existing vs `+ ` for added).
   */
  private parseColumnLines(
    text: string,
    startPos: number,
    lineRe: RegExp,
  ): Array<{ name: string; dataType: string }> {
    const columns: Array<{ name: string; dataType: string }> = [];
    const lines = text.substring(startPos).split("\n");
    for (const line of lines) {
      const colMatch = line.match(lineRe);
      if (colMatch) {
        columns.push({ name: colMatch[1], dataType: colMatch[2] });
      } else if (line.trim() && !line.startsWith("  ")) { break; }
    }
    return columns;
  }

  private parseColumns(text: string, startPos: number): Array<{ name: string; dataType: string }> {
    return this.parseColumnLines(text, startPos, /^\s+L (\S+) (.+)$/);
  }

  private parseAddedColumns(text: string, startPos: number): Array<{ name: string; dataType: string }> {
    return this.parseColumnLines(text, startPos, /^\s+\+ (\S+) (.+)$/);
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
   * Compare a branch's live schema against its parent – routes through the
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

    // Route the substrate diff through LakebaseService.getSchemaDiff, which
    // runs the kit call in a WORKER thread. The kit resolves the endpoint /
    // credential via synchronous databricks CLI calls; in-process they froze
    // the host event loop during an SCM-view refresh (a click mid-refresh then
    // failed with "command not found"). The worker applies host + profile env
    // per call, so the old withHostEnv wrapper is no longer needed here.
    let result: SchemaDiffResult;
    try {
      const comparisonBranch = await this.resolveComparisonBranch(branchId);
      const sub = await this.lakebaseService.getSchemaDiff({
        instance: this.projectInstance(),
        branch: branchId,
        database: getProjectDatabase(),
        ...(comparisonBranch ? { comparisonBranch } : {}),
      });
      result = { ...sub, timestamp: sub.timestamp || new Date().toISOString() };
    } catch (err: any) {
      result = this.emptyResult(`Schema diff failed: ${err?.message || err}`);
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

  /**
   * Pick the comparison branch the diff should be computed against. Substrate's
   * getSchemaDiff defaults to the project's default branch (typically
   * production), which is wrong for feature/test/uat/perf branches that fork
   * from staging. Resolution order:
   *   1. If substrate already knows the parent (target.sourceBranchId set),
   *      return undefined so substrate's own resolver kicks in.
   *   2. If the target IS a long-running tier (main/staging/uat/perf), return
   *      undefined – the default-branch comparison is correct for tiers.
   *   3. Otherwise prefer the configured stagingBranch (PSA convention).
   *   4. Fall through to substrate's default.
   */
  private async resolveComparisonBranch(branchId: string): Promise<string | undefined> {
    const cfg = getConfig();
    // A protected tier (default set + this project's overrides, per the
    // kit-backed resolver) compares against the default branch, not a
    // per-feature base. Covers trunk/staging/base + lakebaseSync.tierNames.
    if (projectProtectedTierNames().has(normalizeBranchName(branchId))) { return undefined; }

    try {
      const target = await this.lakebaseService.getBranchByName(branchId);
      if (target?.sourceBranchId) { return undefined; }
    } catch { /* substrate already returns undefined if metadata missing */ }

    if (cfg.stagingBranch) { return cfg.stagingBranch; }
    return undefined;
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
