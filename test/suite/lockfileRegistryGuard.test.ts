// Anti-recurrence guard: no tracked package-lock.json may pin the Databricks npm proxy.
//
// This extension ships its node_modules in full inside the .vsix (see .vscodeignore), so building
// the package runs `npm ci` against package-lock.json. If any "resolved" URL points at
// npm-proxy.cloud.databricks.com, a cold install / vsix build on a machine outside the Databricks
// network hangs indefinitely (the proxy host resolves but never accepts a TCP connection). Every
// resolved URL must come from the public registry (registry.npmjs.org).
//
// The fix, when this guard fails, is a pure host-swap of the "resolved" lines
// (npm-proxy.cloud.databricks.com -> registry.npmjs.org); integrity hashes are unchanged because the
// proxy is a passthrough mirror of the same tarballs.

import { strict as assert } from 'assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROXY_HOST = 'npm-proxy.cloud.databricks.com';

/** Every tracked package-lock.json (git-tracked, so node_modules is excluded by construction). */
function trackedLockfiles(): string[] {
  return execFileSync('git', ['ls-files', '*package-lock.json'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

describe('lockfiles resolve from the public npm registry (no Databricks proxy pins)', () => {
  const lockfiles = trackedLockfiles();

  it('tracks at least one package-lock.json (guard is actually covering something)', () => {
    assert.ok(lockfiles.length > 0, 'expected at least one tracked package-lock.json');
  });

  for (const lf of lockfiles) {
    it(`${lf} pins no ${PROXY_HOST} resolved hosts`, () => {
      const content = readFileSync(path.join(REPO_ROOT, lf), 'utf8');
      const hits = content.split('\n').filter((l) => l.includes(PROXY_HOST)).length;
      assert.equal(
        hits,
        0,
        `${lf} has ${hits} ${PROXY_HOST} reference(s); the extension ships node_modules in full, so a ` +
          `cold npm ci (vsix build) would hang off the Databricks network. Host-swap the "resolved" ` +
          `lines to https://registry.npmjs.org/ (integrity unchanged).`,
      );
    });
  }
});
