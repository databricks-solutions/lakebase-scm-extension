// Smoke test for the packaged webpack bundle.
//
// Catches the class of regression hit in v0.5.7: a transitive dependency
// (tweetsodium) was externalized but not bundled in the vsix, so the
// extension threw "Cannot find module 'tweetsodium'" at activation. The
// bundled module-scope require graph reproduces that failure at require()
// time — long before VS Code calls activate() — so a bare require is
// sufficient to detect it.
//
// Skips when dist/extension.js is absent (fresh clone with no compile).
// `npm run package` always builds first, so this test is the gate for
// any vsix that leaves this repo.

import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";

const BUNDLE_PATH = path.resolve(__dirname, "../../dist/extension.js");

describe("bundle smoke", function () {
  before(function () {
    if (!fs.existsSync(BUNDLE_PATH)) {
      this.skip();
    }
  });

  it("dist/extension.js requires without throwing", () => {
    delete require.cache[BUNDLE_PATH];
    assert.doesNotThrow(() => {
      require(BUNDLE_PATH);
    }, "Bundle require failed — likely a missing transitive dep that was externalized in webpack but not allow-listed in .vscodeignore.");
  });

  it("exports an activate function", () => {
    const mod = require(BUNDLE_PATH);
    assert.equal(typeof mod.activate, "function", "Bundle must export activate(context).");
  });
});
