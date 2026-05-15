// Mock the 'vscode' module before any imports
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') {
    return require.resolve('./mocks/vscode');
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
