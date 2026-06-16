'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
const config = {
  target: 'node',
  mode: 'none',
  entry: {
    // Main extension bundle -> dist/extension.js (package.json "main").
    extension: './src/extension.ts',
    // Substrate worker thread -> dist/substrateWorker.js. Runs the kit's
    // synchronous-CLI substrate calls off the host's main thread.
    substrateWorker: './src/services/substrateWorker.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode',
    // The substrate kit must NOT be bundled. When webpack inlines it,
    // the kit's template self-location (tsup's import.meta.url shim,
    // which resolves to __filename) points at the EXTENSION's dist
    // instead of node_modules/.../templates/project, so scaffold /
    // adopt / createProject fail with "Could not locate templates/
    // project tree relative to <ext>/dist". Externalizing makes it a
    // runtime require() of the kit's .cjs build from the vsix-shipped
    // node_modules, where __filename is correct and templates resolve.
    // (We already ship full node_modules per .vscodeignore.)
    '@databricks-solutions/lakebase-app-dev-kit':
      'commonjs @databricks-solutions/lakebase-app-dev-kit',
    // pg has an optional native binding (via 'pg-native') that needs a
    // compiled C library. The extension only uses the pure-JS driver, so
    // the native path is never hit – but webpack still tries to resolve it.
    // Mark it external so the bundle doesn't warn, and nothing loads it at
    // runtime unless pg.native is explicitly imported (which we don't).
    'pg-native': 'commonjs pg-native',
    // tweetsodium does `module.exports.overheadLength = nacl.box.overheadLength
    // + nacl.box.publicKeyLength` at module load. webpack's CJS wrapper
    // `(e=n.hmd(e)).exports` returns undefined under this module-graph
    // shape, throwing "Cannot set properties of undefined (setting
    // 'overheadLength')" during activate() and killing the entire extension
    // (no commands, no tree providers). Externalize so it's `require()`d
    // from the vsix-shipped node_modules at runtime, where module.exports
    // is intact. The dep travels via substrate's github/secrets.ts (GitHub
    // Actions secret encryption).
    tweetsodium: 'commonjs tweetsodium',
    // adm-zip also gets externalized as belt-and-suspenders: it has the
    // same class-of-bug potential (prototype-property assignments at
    // module load). The dep travels via substrate's spring-initializr.ts.
    'adm-zip': 'commonjs adm-zip',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }],
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
};

module.exports = config;
