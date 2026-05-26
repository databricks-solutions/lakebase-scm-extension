'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
const config = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
  externals: {
    vscode: 'commonjs vscode',
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
