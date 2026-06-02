// Side-effect preload: tune substrate kit timeouts BEFORE any module
// that imports the substrate evaluates. The kit captures these env
// vars into a frozen `KIT_TIMEOUTS` constant at module-load time
// (`var KIT_TIMEOUTS = { pgConnect: intFromEnv(...) }`), so values
// set later in `activate()` have no effect on already-loaded kit
// code paths.
//
// This module must be imported FIRST in extension.ts, before any
// service module that pulls in `@databricks-solutions/lakebase-app-dev-kit`.

if (!process.env.LAKEBASE_KIT_TIMEOUT_PG_CONNECT_MS) {
  // Kit default is 10s, tuned for hermetic test flows where the
  // endpoint is already warm. In the IDE we routinely hit cold-start
  // Lakebase endpoints (idle compute paused, first wake takes longer
  // than 10s), which surfaces to users as the unhelpful
  // "Lakebase schema query failed: timeout expired" message.
  process.env.LAKEBASE_KIT_TIMEOUT_PG_CONNECT_MS = '60000';
}

if (!process.env.LAKEBASE_KIT_TIMEOUT_PG_STATEMENT_MS) {
  // Kit default is 15s. Schema-introspection queries against a freshly
  // woken endpoint can take longer than that, especially when the
  // catalog is large.
  process.env.LAKEBASE_KIT_TIMEOUT_PG_STATEMENT_MS = '30000';
}
