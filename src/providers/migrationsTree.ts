import { SchemaScmProvider } from './schemaScmProvider';
import { ScmStateTreeProvider } from './scmStateTree';

export class MigrationsTreeProvider extends ScmStateTreeProvider {
  constructor(scmProvider: SchemaScmProvider) {
    super(scmProvider, (scm) => scm.getMigrations());
  }
}
