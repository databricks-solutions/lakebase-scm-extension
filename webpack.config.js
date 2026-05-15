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
    // the native path is never hit — but webpack still tries to resolve it.
    // Mark it external so the bundle doesn't warn, and nothing loads it at
    // runtime unless pg.native is explicitly imported (which we don't).
    'pg-native': 'commonjs pg-native',
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
