// Auth-propagation regression tests (partner-asset-tracker EMU report):
//   Bug 1 , the schema-diff/worker path must honor an explicit profile pin
//           (.env DATABRICKS_CONFIG_PROFILE / lakebaseSync.databricksProfile)
//           to break a host that several ~/.databrickscfg profiles match.
//   Bug 2 , the GitHub token used by the kit-delegated PR ops must honor an
//           explicit pin reachable to the extension host (the host does NOT
//           inherit the user's shell env), including the project .env.

import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LakebaseService, type DatabricksProfile } from "../../src/services/lakebaseService";
import { getConfiguredGitHubToken } from "../../src/utils/githubAuth";

const HOST = "https://dbc-b964587f-dd18.cloud.databricks.com";

function profile(name: string, host: string, valid = true): DatabricksProfile {
  return { name, host, cloud: "aws", authType: "oauth", valid };
}

// Drive getConfig()/getEnvConfig() via a temp project .env (getWorkspaceRoot
// falls back to LAKEBASE_PROJECT_DIR; getConfig has no setting in the mock).
const tmpDirs: string[] = [];
let savedProjectDir: string | undefined;
let savedGhToken: string | undefined;

function envProject(lines: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lbscm-authprop-"));
  tmpDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, ".env"),
    Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  );
  process.env.LAKEBASE_PROJECT_DIR = dir;
  return dir;
}

beforeEach(() => {
  savedProjectDir = process.env.LAKEBASE_PROJECT_DIR;
  savedGhToken = process.env.GITHUB_TOKEN;
});
afterEach(() => {
  if (savedProjectDir === undefined) { delete process.env.LAKEBASE_PROJECT_DIR; }
  else { process.env.LAKEBASE_PROJECT_DIR = savedProjectDir; }
  if (savedGhToken === undefined) { delete process.env.GITHUB_TOKEN; }
  else { process.env.GITHUB_TOKEN = savedGhToken; }
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
});

describe("Bug 1: effectiveProfileForHost honors the .env profile pin", () => {
  function svcWithProfiles(profiles: DatabricksProfile[]): LakebaseService {
    const svc = new LakebaseService();
    // Stub the ~/.databrickscfg read so the test is hermetic.
    (svc as unknown as { listProfiles: () => Promise<DatabricksProfile[]> }).listProfiles =
      async () => profiles;
    return svc;
  }

  it("pinned .env profile wins even when several valid profiles match the host", async () => {
    delete process.env.GITHUB_TOKEN;
    envProject({ DATABRICKS_CONFIG_PROFILE: "partner-demo-catalog" });
    const svc = svcWithProfiles([
      profile("DEFAULT", HOST),
      profile("registration-app", HOST),
      profile("partner-demo-catalog", HOST),
    ]);
    assert.strictEqual(await svc.effectiveProfileForHost(HOST), "partner-demo-catalog");
  });

  it("no pin + ambiguous host -> undefined (CLI resolves on its own)", async () => {
    envProject({}); // no profile pin
    const svc = svcWithProfiles([
      profile("DEFAULT", HOST),
      profile("registration-app", HOST),
    ]);
    assert.strictEqual(await svc.effectiveProfileForHost(HOST), undefined);
  });

  it("no pin + exactly one valid match -> that profile (unchanged behavior)", async () => {
    envProject({});
    const svc = svcWithProfiles([profile("only-one", HOST), profile("other", "https://elsewhere.cloud.databricks.com")]);
    assert.strictEqual(await svc.effectiveProfileForHost(HOST), "only-one");
  });

  it("pin naming a profile for a DIFFERENT host is ignored (no wrong-workspace auth)", async () => {
    envProject({ DATABRICKS_CONFIG_PROFILE: "for-other-host" });
    const svc = svcWithProfiles([
      profile("for-other-host", "https://elsewhere.cloud.databricks.com"),
      profile("a", HOST),
      profile("b", HOST),
    ]);
    // pin rejected (wrong host) -> falls back to host-match, which is ambiguous -> undefined
    assert.strictEqual(await svc.effectiveProfileForHost(HOST), undefined);
  });
});

describe("Bug 2: getConfiguredGitHubToken reads the project .env (EMU PAT)", () => {
  it("returns the .env GITHUB_TOKEN when no process env / setting is present", () => {
    delete process.env.GITHUB_TOKEN;
    envProject({ GITHUB_TOKEN: "emu-dotenv-token" });
    assert.strictEqual(getConfiguredGitHubToken(), "emu-dotenv-token");
  });

  it("process.env GITHUB_TOKEN takes precedence over .env", () => {
    process.env.GITHUB_TOKEN = "proc-token";
    envProject({ GITHUB_TOKEN: "emu-dotenv-token" });
    assert.strictEqual(getConfiguredGitHubToken(), "proc-token");
  });

  it("undefined when neither setting, process env, nor .env provides one", () => {
    delete process.env.GITHUB_TOKEN;
    envProject({});
    assert.strictEqual(getConfiguredGitHubToken(), undefined);
  });
});
