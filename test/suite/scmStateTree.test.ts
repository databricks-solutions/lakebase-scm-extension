import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { ScmStateTreeProvider, scmStateToTreeItem } from '../../src/providers/scmStateTree';
import { MergesTreeProvider } from '../../src/providers/mergesTree';
import { MigrationsTreeProvider } from '../../src/providers/migrationsTree';
import { LakebaseSchemaTreeProvider } from '../../src/providers/lakebaseSchemaTree';

function state(path: string, tooltip?: string): vscode.SourceControlResourceState {
  return {
    resourceUri: vscode.Uri.parse(`lakebase-scm://group/${path}`),
    decorations: {
      iconPath: new vscode.ThemeIcon('diff-modified'),
      tooltip,
    },
    command: { command: 'vscode.open', title: 'Open', arguments: [] },
  } as unknown as vscode.SourceControlResourceState;
}

/** Minimal SchemaScmProvider stand-in: just the surface the base touches. */
function fakeScm(rows: Record<string, vscode.SourceControlResourceState[]>) {
  return {
    onDidRefresh: (_fn: () => void) => ({ dispose() {} }),
    getMerges: () => rows.merges || [],
    getMigrations: () => rows.migrations || [],
    getLakebase: () => rows.lakebase || [],
  } as any;
}

describe('scmStateTree (single source for the flat SCM placeholder trees)', () => {
  describe('scmStateToTreeItem', () => {
    it('passes through resourceUri, icon, tooltip and command; labels by last path segment', () => {
      const item = scmStateToTreeItem(state('001_init.sql', 'tip'));
      assert.equal(item.label, '001_init.sql');
      assert.equal((item.iconPath as vscode.ThemeIcon).id, 'diff-modified');
      assert.equal(item.tooltip, 'tip');
      assert.equal(item.command?.command, 'vscode.open');
      assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    });

    it('honors a custom name deriver', () => {
      const item = scmStateToTreeItem(state('x.sql', 'First line\nSecond'), (s) =>
        s.decorations?.tooltip?.toString().split('\n')[0] || '',
      );
      assert.equal(item.label, 'First line');
    });
  });

  describe('ScmStateTreeProvider', () => {
    it('renders rows from the supplied accessor', () => {
      const scm = fakeScm({ migrations: [state('a.sql'), state('b.sql')] });
      const provider = new ScmStateTreeProvider(scm, (s) => s.getMigrations());
      const items = provider.getChildren();
      assert.deepEqual(items.map((i) => i.label), ['a.sql', 'b.sql']);
    });
  });

  describe('the three concrete trees', () => {
    it('MigrationsTreeProvider reads getMigrations + default labels', () => {
      const scm = fakeScm({ migrations: [state('20240101_add_col.sql')] });
      assert.deepEqual(new MigrationsTreeProvider(scm).getChildren().map((i) => i.label), ['20240101_add_col.sql']);
    });

    it('LakebaseSchemaTreeProvider reads getLakebase + default labels', () => {
      const scm = fakeScm({ lakebase: [state('public.users')] });
      assert.deepEqual(new LakebaseSchemaTreeProvider(scm).getChildren().map((i) => i.label), ['public.users']);
    });

    it('MergesTreeProvider reads getMerges + labels off the tooltip first line', () => {
      const scm = fakeScm({ merges: [state('m1', 'feature/foo into main\nmore detail')] });
      assert.deepEqual(new MergesTreeProvider(scm).getChildren().map((i) => i.label), ['feature/foo into main']);
    });

    it('MergesTreeProvider falls back to the path segment when no tooltip', () => {
      const scm = fakeScm({ merges: [state('m2')] });
      assert.deepEqual(new MergesTreeProvider(scm).getChildren().map((i) => i.label), ['m2']);
    });
  });
});
