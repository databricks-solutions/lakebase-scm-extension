// Minimal vscode module mock for unit testing outside the extension host

class EventEmitter {
  constructor() { this._listeners = []; }
  get event() { return (fn) => { this._listeners.push(fn); return { dispose: () => {} }; }; }
  fire(data) { this._listeners.forEach(fn => fn(data)); }
  dispose() { this._listeners = []; }
}

class Uri {
  constructor(scheme, authority, path, query, fragment) {
    this.scheme = scheme || 'file';
    this.authority = authority || '';
    this.path = path || '';
    this.query = query || '';
    this.fragment = fragment || '';
    this.fsPath = path;
  }
  static file(p) { return new Uri('file', '', p, '', ''); }
  static parse(s) {
    const m = s.match(/^([^:]+):\/\/([^/]*)(\/[^?#]*)(?:\?([^#]*))?(?:#(.*))?$/);
    if (m) return new Uri(m[1], m[2], m[3], m[4] || '', m[5] || '');
    return new Uri('file', '', s, '', '');
  }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}

class ThemeIcon {
  constructor(id, color) { this.id = id; this.color = color; }
}

class ThemeColor {
  constructor(id) { this.id = id; }
}

class RelativePattern {
  constructor(base, pattern) { this.base = base; this.pattern = pattern; }
}

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const ProgressLocation = { Notification: 15, SourceControl: 1, Window: 10 };
const QuickPickItemKind = { Separator: -1, Default: 0 };

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState || 0;
  }
}

class Disposable {
  constructor(fn) { this._fn = fn; }
  dispose() { if (this._fn) this._fn(); }
  static from(...disposables) {
    return new Disposable(() => disposables.forEach(d => d.dispose()));
  }
}

// SCM stubs
function createSourceControl(id, label) {
  return {
    id, label,
    inputBox: { placeholder: '', visible: true },
    count: 0,
    createResourceGroup(groupId, groupLabel) {
      return {
        id: groupId, label: groupLabel,
        resourceStates: [],
        hideWhenEmpty: false,
        dispose() {},
      };
    },
    dispose() {},
  };
}

const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  createStatusBarItem: () => ({
    text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {},
  }),
  createTreeView: (id, opts) => ({
    selection: [],
    onDidChangeSelection: new EventEmitter().event,
    dispose() {},
  }),
  createWebviewPanel: (type, title, col, opts) => ({
    webview: { html: '' },
    title,
    reveal() {},
    onDidDispose: new EventEmitter().event,
    dispose() {},
  }),
  withProgress: async (opts, task) => task({ report() {} }),
  registerWebviewViewProvider: (id, provider) => ({ dispose() {} }),
  createTerminal: (opts) => ({ show() {}, sendText() {}, dispose() {} }),
  onDidCloseTerminal: new EventEmitter().event,
  createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
};

const workspace = {
  workspaceFolders: undefined,
  getConfiguration: (section) => ({
    get: (key, def) => def,
  }),
  createFileSystemWatcher: () => ({
    onDidCreate: new EventEmitter().event,
    onDidChange: new EventEmitter().event,
    onDidDelete: new EventEmitter().event,
    dispose() {},
  }),
  openTextDocument: async () => ({ getText() { return ''; } }),
  fs: { readFile: async () => Buffer.from('') },
  onDidChangeConfiguration: new EventEmitter().event,
  onDidSaveTextDocument: new EventEmitter().event,
  registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
};

const commands = {
  registerCommand: (id, handler) => ({ dispose() {} }),
  executeCommand: async () => {},
};

const scm = { createSourceControl };

const StatusBarAlignment = { Left: 1, Right: 2 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

module.exports = {
  EventEmitter,
  Uri,
  ThemeIcon,
  ThemeColor,
  ThemeColor,
  RelativePattern,
  TreeItem,
  TreeItemCollapsibleState,
  ProgressLocation,
  QuickPickItemKind,
  StatusBarAlignment,
  ViewColumn,
  Disposable,
  env: {
    openExternal: async () => true,
    clipboard: { writeText: async () => {}, readText: async () => '' },
  },
  window,
  workspace,
  commands,
  scm,
};
