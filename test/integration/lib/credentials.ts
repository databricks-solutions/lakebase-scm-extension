/**
 * Pre-flight credential check for the destructive integration suites.
 *
 * The ecommerce and python-devloop tests create real GitHub repos and
 * Lakebase projects under the running contributor's account. Both must
 * be authenticated, and the contributor must explicitly choose which
 * Databricks workspace the tests run against – there is intentionally
 * no default. Defaulting silently to any one maintainer's workspace
 * would (a) silently bill that account for a contributor's runs, and
 * (b) prevent the test from catching workspace-specific regressions
 * that only manifest in the contributor's own environment.
 *
 * On missing credentials the assertion throws with copy-paste-ready
 * commands. The throw happens inside `before()` so mocha fails fast,
 * before any cloud resources are created.
 */

import { execFileSync } from "child_process";

export interface IntegrationCredentialsAssertion {
  /** The Databricks workspace URL to use for this run (post-validation). */
  databricksHost: string;
  /** The GitHub user the test will create repos under. */
  githubUser: string;
}

export function assertIntegrationCredentials(): IntegrationCredentialsAssertion {
  const host = (process.env.DATABRICKS_TEST_HOST || "").trim();
  if (!host) {
    throw new IntegrationSetupError([
      "DATABRICKS_TEST_HOST is not set.",
      "",
      "The integration suite is destructive – it creates a real Lakebase",
      "project and GitHub repo under YOUR accounts. You must explicitly",
      "choose the workspace it runs against; there is no default.",
      "",
      "Set up:",
      "  1. Pick a Databricks workspace where you can create Lakebase projects",
      "  2. export DATABRICKS_TEST_HOST=https://<your-workspace>.cloud.databricks.com",
      "  3. databricks auth login --host \"$DATABRICKS_TEST_HOST\"",
      "  4. gh auth status   # (and `gh auth login` if not authenticated)",
      "  5. Re-run the test.",
    ].join("\n"));
  }
  if (!/^https?:\/\//.test(host)) {
    throw new IntegrationSetupError(
      `DATABRICKS_TEST_HOST="${host}" must start with "https://" (or "http://" for local).`,
    );
  }

  // Verify Databricks auth resolves end-to-end for THIS host. We use a real
  // operation (`databricks postgres list-projects` with DATABRICKS_HOST
  // exported) as the probe rather than `databricks auth token`. Reason:
  // `auth token` requires a single profile to win the ambiguity resolution,
  // and ~/.databrickscfg commonly has multiple profiles pointing at the
  // same host (DEFAULT + a workspace-id-named profile). Real ops resolve
  // auth through a broader chain (env, oauth cache, fallback profile) that
  // works even when explicit `auth token --profile <p>` is stale. Probing
  // exactly what the tests will downstream-call avoids false negatives.
  try {
    execFileSync(
      "databricks",
      ["postgres", "list-projects", "-o", "json"],
      {
        stdio: "pipe",
        timeout: 15_000,
        env: { ...process.env, DATABRICKS_HOST: host },
      },
    );
  } catch (err: any) {
    const stderr =
      err?.stderr?.toString?.() || err?.message || String(err);
    throw new IntegrationSetupError([
      `Databricks auth is not configured for "${host}".`,
      "",
      `Run:  databricks auth login --host "${host}"`,
      "",
      "Underlying error from `databricks postgres list-projects`:",
      `  ${stderr.split("\n")[0].slice(0, 240)}`,
    ].join("\n"));
  }

  // Verify GitHub CLI is authenticated, and capture the user's login as
  // the owner the test will create repos under.
  let ghUser = "";
  try {
    ghUser = execFileSync("gh", ["api", "user", "--jq", ".login"], {
      stdio: "pipe",
      timeout: 10_000,
    })
      .toString()
      .trim();
  } catch (err: any) {
    const stderr =
      err?.stderr?.toString?.() || err?.message || String(err);
    throw new IntegrationSetupError([
      "GitHub CLI is not authenticated.",
      "",
      "Run:  gh auth login",
      "",
      "Underlying error from `gh api user`:",
      `  ${stderr.split("\n")[0].slice(0, 240)}`,
    ].join("\n"));
  }
  if (!ghUser) {
    throw new IntegrationSetupError(
      "`gh api user` returned an empty login. Run `gh auth status` to investigate.",
    );
  }

  return { databricksHost: host, githubUser: ghUser };
}

/** Distinguishable from real test failures – surfaces "setup needed" cleanly. */
export class IntegrationSetupError extends Error {
  constructor(message: string) {
    // Lead with a banner so the message stands out in mocha output.
    super(
      "\n\n" +
        "════════════════════════════════════════════════════════════════════\n" +
        "  Integration test setup needed\n" +
        "════════════════════════════════════════════════════════════════════\n" +
        message +
        "\n" +
        "════════════════════════════════════════════════════════════════════\n",
    );
    this.name = "IntegrationSetupError";
  }
}
