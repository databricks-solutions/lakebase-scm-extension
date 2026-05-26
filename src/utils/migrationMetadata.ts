// Names of tables that migration tools maintain to track which
// migrations have been applied. These are NOT user schema; views that
// surface user schema (schema-diff, branch tree, migration parser)
// exclude them.
//
// They are also not "repair" candidates: the extension does not
// mutate flyway_schema_history. If a real schema_history corruption
// case ever needs handling (failed migration, checksum mismatch),
// add it as a substrate primitive on the Flyway migrate runner –
// don't grow ad-hoc mutations here.

export const MIGRATION_METADATA_TABLES: ReadonlySet<string> = new Set([
  "flyway_schema_history",
]);

export function isMigrationMetadataTable(tableName: string): boolean {
  return MIGRATION_METADATA_TABLES.has(tableName);
}
