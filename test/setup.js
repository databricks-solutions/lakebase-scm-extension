// Mock the 'vscode' module before any imports, and route the substrate
// package through an override-aware proxy so equivalence tests (FEIP-7080)
// can swap per-call substrate behavior without hitting real Lakebase /
// GitHub. Default behavior delegates to the real substrate via getters.
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') {
    return require.resolve('./mocks/vscode');
  }
  if (request === '@databricks-solutions/lakebase-app-dev-kit') {
    return require.resolve('./mocks/substrate');
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
