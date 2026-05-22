import { strict as assert } from 'assert';
import nacl from 'tweetnacl';

describe('GitHub secret encryption', () => {
  it('seals a secret with tweetsodium for GitHub Actions', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sodium = require('tweetsodium');
    const keypair = nacl.box.keyPair();
    const publicKeyB64 = Buffer.from(keypair.publicKey).toString('base64');
    const messageBytes = Buffer.from('dapi-test-token');
    const keyBytes = Buffer.from(publicKeyB64, 'base64');
    const encryptedBytes = sodium.seal(messageBytes, keyBytes);
    assert.ok(encryptedBytes.length > messageBytes.length);
  });
});
