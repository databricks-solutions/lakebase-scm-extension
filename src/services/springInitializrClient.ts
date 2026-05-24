// Thin proxy: re-exports from @databricks-solutions/lakebase-app-dev-kit.
// Substrate source: scripts/lakebase/spring-initializr.ts.
// FEIP-7065 (publish_and_consume) – extension consumes substrate via the
// shared package's CJS build so webpack can bundle without ESM-interop pain.

export {
  SpringInitializrClient,
  InitializrNetworkError,
  InitializrParseError,
  isPrereleaseBootVersion,
  resolveLatestBootVersion,
  isLtsJavaVersion,
  resolveLatestLtsJavaVersion,
} from "@databricks-solutions/lakebase-app-dev-kit";

export type {
  SpringJvmLanguage,
  InitializrMetadata,
  GenerateMavenProjectOptions,
} from "@databricks-solutions/lakebase-app-dev-kit";
