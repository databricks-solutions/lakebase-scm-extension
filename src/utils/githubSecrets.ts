/**
 * GitHub Actions secret encryption helpers.
 * Uses the repo's LibSodium public key (NaCl box seal) — same wire format as
 * `gh secret set`, without shelling out to the CLI.
 */
import type { Octokit } from 'octokit';
import sodium from 'tweetsodium';
import { formatOwnerRepo, parseOwnerRepo } from './parseRepo';

/** Encrypt a plaintext secret with the repo's base64-encoded public key. */
function encryptSecret(publicKey: string, secretValue: string): string {
  const keyBytes = Buffer.from(publicKey, 'base64');
  const messageBytes = Buffer.from(secretValue);
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  return Buffer.from(encryptedBytes).toString('base64');
}

/** Create or update a single GitHub Actions repository secret. */
export async function setRepoSecret(
  octokit: Octokit,
  ownerRepo: string,
  secretName: string,
  secretValue: string,
): Promise<void> {
  const { owner, repo } = parseOwnerRepo(ownerRepo);
  const { data: keyData } = await octokit.rest.actions.getRepoPublicKey({
    owner,
    repo,
  });
  const encryptedValue = encryptSecret(keyData.key, secretValue);
  await octokit.rest.actions.createOrUpdateRepoSecret({
    owner,
    repo,
    secret_name: secretName,
    encrypted_value: encryptedValue,
    key_id: keyData.key_id,
  });
}

/** Set multiple repository secrets in sequence. */
export async function setRepoSecrets(
  octokit: Octokit,
  ownerRepo: string,
  secrets: Record<string, string>,
): Promise<void> {
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) {
      throw new Error(`Missing value for secret ${name}`);
    }
    await setRepoSecret(octokit, ownerRepo, name, value);
  }
}

/** List secret names configured on a repository. */
export async function listRepoSecretNames(octokit: Octokit, ownerRepo: string): Promise<string[]> {
  const { owner, repo } = parseOwnerRepo(ownerRepo);
  const names: string[] = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.rest.actions.listRepoSecrets({
      owner,
      repo,
      per_page: 100,
      page,
    });
    for (const s of data.secrets) {
      names.push(s.name);
    }
    if (data.secrets.length < 100) { break; }
    page += 1;
  }
  return names;
}

export { formatOwnerRepo };
