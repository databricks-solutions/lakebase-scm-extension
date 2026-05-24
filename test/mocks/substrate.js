// Mock module for @databricks-solutions/lakebase-scm-workflow-scripts.
//
// The real substrate, built by tsup with __esModule named exports, has
// non-configurable property descriptors. sinon.stub and direct
// defineProperty both fail on those. We route the test process's
// `require('@databricks-solutions/...')` through this module (see
// test/setup.js) and expose each substrate export via a getter that
// consults an `__overrides` map.
//
// Bypassing self-referential require: the test/setup.js hook redirects
// the substrate package name globally, including from inside this
// module. We resolve the real package by absolute path (built dist/) so
// the hook doesn't fire — request shape is a filesystem path, not the
// package name.
//
// Why getter instead of static value? Compiled-from-TS named imports in
// the proxy services look like `substrate_1.listBranches(...)` — a
// property access at every call site, so a getter intercepts each call
// individually and an updated override is seen immediately.

const path = require('path');
const PACKAGE_DIR = path.resolve(
  __dirname,
  '../../node_modules/@databricks-solutions/lakebase-scm-workflow-scripts'
);
const PKG = require(path.join(PACKAGE_DIR, 'package.json'));
const MAIN_REL = PKG.main || 'index.js';
// require by absolute filesystem path → not the package name → the
// setup.js resolution hook ignores it → we get the real module.
const REAL = require(path.join(PACKAGE_DIR, MAIN_REL));

const OVERRIDES = Object.create(null);

const mock = {};
for (const key of Object.keys(REAL)) {
  Object.defineProperty(mock, key, {
    configurable: true,
    enumerable: true,
    get() {
      return key in OVERRIDES ? OVERRIDES[key] : REAL[key];
    },
  });
}

// Test-facing API (under __ to avoid colliding with real substrate names).
mock.__overrides = OVERRIDES;
mock.__real = REAL;
mock.__hasOverride = (name) => name in OVERRIDES;

module.exports = mock;
