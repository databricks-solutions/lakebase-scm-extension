import { strict as assert } from 'assert';
import * as sinon from 'sinon';
import { GitHubService } from '../../src/services/githubService';

describe('GitHubService', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('listSecretsText joins secret names', async () => {
    const service = new GitHubService();
    sinon.stub(service, 'listSecretNames').resolves(['DATABRICKS_HOST', 'DATABRICKS_TOKEN']);
    const text = await service.listSecretsText('acme/widget');
    assert.strictEqual(text, 'DATABRICKS_HOST\nDATABRICKS_TOKEN');
  });
});
