import * as vscode from 'vscode';
import { SchemaScmProvider } from './schemaScmProvider';
import { ScmStateTreeProvider } from './scmStateTree';

/** Merges rows label off the decoration tooltip's first line when present. */
const mergeName = (state: vscode.SourceControlResourceState): string =>
  state.decorations?.tooltip?.toString().split('\n')[0] ||
  state.resourceUri.path.split('/').pop() ||
  '';

export class MergesTreeProvider extends ScmStateTreeProvider {
  constructor(scmProvider: SchemaScmProvider) {
    super(scmProvider, (scm) => scm.getMerges(), mergeName);
  }
}
