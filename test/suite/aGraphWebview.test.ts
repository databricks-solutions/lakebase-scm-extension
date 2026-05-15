import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GraphWebviewProvider } from '../../src/providers/graphWebview';
import { LakebaseService, LakebaseBranch } from '../../src/services/lakebaseService';
import { GitService } from '../../src/services/gitService';
import * as config from '../../src/utils/config';

function mkView() {
  const o: any = {
    _handler: null, viewType: 'lakebaseGraph',
    webview: { html: '', options: {} as any, cspSource: '',
      onDidReceiveMessage: (fn: any) => { o._handler = fn; return { dispose() {} }; },
      postMessage: async () => true, asWebviewUri: (u: any) => u },
    title: 'G', visible: true,
    onDidDispose: () => ({dispose(){}}), onDidChangeVisibility: () => ({dispose(){}}),
    show() {}, dispose() {} };
  return o;
}

function mkBranch(id: string, def = false): LakebaseBranch {
  return { uid: 'b-' + id, name: 'p/b/' + id, branchId: id, state: 'READY', isDefault: def };
}

// Check for actual DB icon element (not just the CSS class)
const DB_ICON_MARKER = 'title="Lakebase branch"';

describe('GraphWebviewProvider', () => {
  let p: GraphWebviewProvider, ls: sinon.SinonStubbedInstance<LakebaseService>, gwr: sinon.SinonStub, v: any;
  beforeEach(() => { ls = sinon.createStubInstance(LakebaseService); ls.listBranches.resolves([]); p = new GraphWebviewProvider((vscode as any).Uri.file('/t'), ls as any, new GitService()); gwr = sinon.stub(config, 'getWorkspaceRoot').returns(process.cwd()); v = mkView(); });
  afterEach(() => sinon.restore());

  it('enableScripts', () => { p.resolveWebviewView(v, {} as any, {} as any); assert.strictEqual(v.webview.options.enableScripts, true); });
  it('renders HTML', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('<!DOCTYPE html>')); });
  it('msg col', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('class="msg"')); });
  it('author col', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('class="author"')); });
  it('author col', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('class="author"')); });
  it('HEAD badge', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('badge head')); });
  it('SVGs', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok((v.webview.html.match(/<svg class="g"/g) || []).length > 0); });
  it('circles', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok((v.webview.html.match(/<circle/g) || []).length > 0); });
  it('sel row', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('class="row sel"')); });
  it('no inline toolbar', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(!v.webview.html.includes('id="refFilter"')); });
  it('sentinel', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('id="sentinel"')); });
  it('loadMore', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); await v._handler({ type: 'loadMore' }); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('<!DOCTYPE html>')); });
  it('ctx container', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('id="ctx"')); });
  it('ctx all items', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); for (const i of ['Open Changes','Open in Cursor Blame','Open on GitHub','Checkout','Checkout (Detached)','Create Branch...','Delete Branch','Create Tag...','Cherry Pick','Copy Commit ID','Copy Commit Message']) assert.ok(v.webview.html.includes(i), i); });
  it('ctx seps', async () => { p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok((v.webview.html.match(/class="ctx-sep"/g) || []).length >= 4); });
  it('copy SHA', async () => { const cs = sinon.stub(vscode.env.clipboard, 'writeText').resolves(); sinon.stub(vscode.window, 'showInformationMessage').resolves(); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); await v._handler({ type: 'copy', sha: 'abc' }); assert.ok(cs.calledWith('abc')); });
  it('copyMessage', async () => { const cs = sinon.stub(vscode.env.clipboard, 'writeText').resolves(); sinon.stub(vscode.window, 'showInformationMessage').resolves(); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); await v._handler({ type: 'copyMessage', sha: 'a', msg: 'hi' }); assert.ok(cs.calledWith('hi')); });
  it('checkout err', async () => { sinon.stub(vscode.window, 'showInformationMessage').resolves(); const se = sinon.stub(vscode.window, 'showErrorMessage').resolves(); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); await v._handler({ type: 'checkout', sha: 'nonexist000' }); assert.ok(se.calledOnce); });
  it('revert err', async () => { sinon.stub(vscode.window, 'showInformationMessage').resolves(); const se = sinon.stub(vscode.window, 'showErrorMessage').resolves(); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); await v._handler({ type: 'revert', sha: 'nonexist000' }); assert.ok(se.calledOnce); });
  it('cherry err', async () => { sinon.stub(vscode.window, 'showInformationMessage').resolves(); const se = sinon.stub(vscode.window, 'showErrorMessage').resolves(); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); await v._handler({ type: 'cherryPick', sha: 'nonexist000' }); assert.ok(se.calledOnce); });
  it('branch cancel', async () => { sinon.stub(vscode.window, 'showInputBox').resolves(undefined); sinon.stub(vscode.window, 'showInformationMessage').resolves(); const se = sinon.stub(vscode.window, 'showErrorMessage').resolves(); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); await v._handler({ type: 'createBranch', sha: 'a' }); assert.ok(!se.called); });
  it('tag cancel', async () => { sinon.stub(vscode.window, 'showInputBox').resolves(undefined); sinon.stub(vscode.window, 'showInformationMessage').resolves(); const se = sinon.stub(vscode.window, 'showErrorMessage').resolves(); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); await v._handler({ type: 'createTag', sha: 'a' }); assert.ok(!se.called); });
  it('no root shows error', async () => { gwr.returns(undefined); sinon.stub(vscode.window, 'showInformationMessage').resolves(); const se = sinon.stub(vscode.window, 'showErrorMessage').resolves(); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); await v._handler({ type: 'checkout', sha: 'a' }); assert.ok(se.calledOnce, 'Should show error when no workspace root'); });
  it('lb icon when main matches', async () => { ls.listBranches.resolves([mkBranch('main', true)]); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes(DB_ICON_MARKER)); });
  it('lb no icon when unmatched', async () => { ls.listBranches.resolves([mkBranch('xyz-no-match-999')]); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(!v.webview.html.includes(DB_ICON_MARKER)); });
  it('lb fail safe', async () => { ls.listBranches.rejects(new Error('x')); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(!v.webview.html.includes(DB_ICON_MARKER)); });
  it('no view refresh', async () => { const p2 = new GraphWebviewProvider((vscode as any).Uri.file('/t'), ls as any, new GitService()); await p2.refresh(); });
  it('no root empty', async () => { gwr.returns(undefined); p.resolveWebviewView(v, {} as any, {} as any); await new Promise(r => setTimeout(r, 2000)); assert.ok(v.webview.html.includes('No commits')); });
});
