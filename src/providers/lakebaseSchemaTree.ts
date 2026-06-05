import { SchemaScmProvider } from './schemaScmProvider';
import { ScmStateTreeProvider } from './scmStateTree';

export class LakebaseSchemaTreeProvider extends ScmStateTreeProvider {
  constructor(scmProvider: SchemaScmProvider) {
    super(scmProvider, (scm) => scm.getLakebase());
  }
}
