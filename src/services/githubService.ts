// GitHubService – thin proxy over @databricks-solutions/lakebase-app-dev-kit.
//
// All operations except `listCommits` (extension-specific avatar enrichment
// for the graph view) and the local `octokit` cache for it now delegate to
// the substrate. FEIP-7065 + FEIP-7076.

import { Octokit, RequestError } from "octokit";
import { getGitHubToken, getConfiguredGitHubToken, GITHUB_SCOPES } from "../utils/githubAuth";
import {
  parseOwnerRepo,
  // Repo
  createRepo as substrateCreateRepo,
  deleteRepo as substrateDeleteRepo,
  repoExists as substrateRepoExists,
  getRepoFullName as substrateGetRepoFullName,
  getCurrentUser as substrateGetCurrentUser,
  // Secrets
  setRepoSecret as substrateSetRepoSecret,
  setRepoSecrets as substrateSetRepoSecrets,
  listSecretNames as substrateListSecretNames,
  // Runner
  listRepoRunners as substrateListRepoRunners,
  getRunnerIdByName as substrateGetRunnerIdByName,
  getRunnerStatus as substrateGetRunnerStatus,
  createRegistrationToken as substrateCreateRegistrationToken,
  deleteRunner as substrateDeleteRunner,
  getActionsEnabled as substrateGetActionsEnabled,
  // PR flow (FEIP-7076)
  createPullRequest as substrateCreatePullRequest,
  getPullRequest as substrateGetPullRequest,
  getPullRequestReviews as substrateGetPullRequestReviews,
  getPullRequestFiles as substrateGetPullRequestFiles,
  getPullRequestComments as substrateGetPullRequestComments,
  listIssueComments as substrateListIssueComments,
  listWorkflowRuns as substrateListWorkflowRuns,
  mergePullRequest as substrateMergePullRequest,
} from "@databricks-solutions/lakebase-app-dev-kit";
import type {
  PullRequestFile,
  PullRequestInfo,
  PullRequestReview,
} from "./gitService";

export class GitHubServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubServiceError";
  }
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  branch: string;
  event: string;
}

/**
 * GitHub platform API. All ops delegate to the substrate except
 * `listCommits` (avatar enrichment for the graph view stays inline).
 */
export class GitHubService {
  private octokit: Octokit | undefined;

  /** Backwards-compat cache reset for callers that previously held this service. */
  resetAuth(): void {
    this.octokit = undefined;
  }

  // ── Substrate-routed: repo + user ───────────────────────────────

  async getCurrentUser(): Promise<string> {
    return substrateGetCurrentUser();
  }

  async createRepo(
    name: string,
    opts?: { private?: boolean; description?: string },
  ): Promise<string> {
    return substrateCreateRepo(name, opts);
  }

  async deleteRepo(name: string): Promise<void> {
    return substrateDeleteRepo(name);
  }

  async repoExists(name: string): Promise<boolean> {
    return substrateRepoExists(name);
  }

  async getRepoFullName(name: string): Promise<string> {
    return substrateGetRepoFullName(name);
  }

  // ── Substrate-routed: secrets ──────────────────────────────────

  async setRepoSecret(ownerRepo: string, secretName: string, secretValue: string): Promise<void> {
    return substrateSetRepoSecret(ownerRepo, secretName, secretValue);
  }

  async setRepoSecrets(ownerRepo: string, secrets: Record<string, string>): Promise<void> {
    return substrateSetRepoSecrets(ownerRepo, secrets);
  }

  async listSecretNames(ownerRepo: string): Promise<string[]> {
    return substrateListSecretNames(ownerRepo);
  }

  /** Newline-separated secret names (health check / legacy callers). */
  async listSecretsText(ownerRepo: string): Promise<string> {
    const names = await this.listSecretNames(ownerRepo);
    return names.join("\n");
  }

  // ── Substrate-routed: runners ──────────────────────────────────

  async listRepoRunners(ownerRepo: string): Promise<Array<{ id: number; name: string; status: string }>> {
    return substrateListRepoRunners(ownerRepo);
  }

  async getRunnerIdByName(ownerRepo: string, runnerName: string): Promise<number | undefined> {
    return substrateGetRunnerIdByName(ownerRepo, runnerName);
  }

  async getRunnerStatus(ownerRepo: string, runnerName: string): Promise<string | undefined> {
    return substrateGetRunnerStatus(ownerRepo, runnerName);
  }

  async createRegistrationToken(ownerRepo: string): Promise<string> {
    return substrateCreateRegistrationToken(ownerRepo);
  }

  async deleteRunner(ownerRepo: string, runnerId: number): Promise<void> {
    return substrateDeleteRunner(ownerRepo, runnerId);
  }

  // ── Substrate-routed: PR flow (FEIP-7076) ──────────────────────

  /**
   * Run a substrate GitHub op with an EXPLICIT pinned token injected as
   * GITHUB_TOKEN, so the kit's resolver (GITHUB_TOKEN env -> editor session ->
   * gh) uses it FIRST. Without this, the kit takes the editor's GitHub session,
   * which on a private EMU repo is the wrong identity and 404s -- and because a
   * session exists it never falls through to a correctly-authed `gh`. The
   * extension host does not inherit the user's shell env, so the pin comes from
   * the `lakebaseSync.githubToken` setting or the project `.env` GITHUB_TOKEN
   * (see getConfiguredGitHubToken). When no pin is set, the kit's own chain runs
   * unchanged. Save/restore keeps overlapping ops from leaking the override.
   */
  private async withGitHubAuth<T>(fn: () => Promise<T>): Promise<T> {
    const token = getConfiguredGitHubToken();
    if (!token) { return fn(); }
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = token;
    try {
      return await fn();
    } finally {
      if (saved === undefined) { delete process.env.GITHUB_TOKEN; }
      else { process.env.GITHUB_TOKEN = saved; }
    }
  }

  async getPullRequest(ownerRepo: string, headBranch: string): Promise<PullRequestInfo | undefined> {
    return this.withGitHubAuth(() => substrateGetPullRequest(ownerRepo, headBranch));
  }

  async getPullRequestReviews(ownerRepo: string, pullNumber: number): Promise<PullRequestReview[]> {
    return this.withGitHubAuth(() => substrateGetPullRequestReviews(ownerRepo, pullNumber));
  }

  async getPullRequestFiles(ownerRepo: string, pullNumber: number): Promise<PullRequestFile[]> {
    return this.withGitHubAuth(() => substrateGetPullRequestFiles(ownerRepo, pullNumber));
  }

  async getPullRequestComments(ownerRepo: string, pullNumber: number): Promise<Array<{ author: string; body: string }>> {
    return this.withGitHubAuth(() => substrateGetPullRequestComments(ownerRepo, pullNumber));
  }

  async createPullRequest(
    ownerRepo: string,
    headBranch: string,
    title: string,
    body: string,
    baseBranch?: string,
  ): Promise<string> {
    return this.withGitHubAuth(() => substrateCreatePullRequest({ ownerRepo, headBranch, title, body, baseBranch }));
  }

  async mergePullRequest(
    ownerRepo: string,
    pullNumber: number,
    method: "merge" | "squash" | "rebase" = "merge",
    deleteRemoteBranch = true,
  ): Promise<string> {
    return this.withGitHubAuth(() => substrateMergePullRequest({ ownerRepo, pullNumber, method, deleteRemoteBranch }));
  }

  async listIssueComments(ownerRepo: string, issueNumber: number): Promise<string[]> {
    return this.withGitHubAuth(() => substrateListIssueComments(ownerRepo, issueNumber));
  }

  /**
   * Whether GitHub Actions is enabled for the repo. Returns undefined when it
   * can't be determined (no token, repo invisible). Wrapped in withGitHubAuth so
   * the explicit token pin is used , without it a private EMU repo reads as
   * invisible (undefined) rather than its true enabled/disabled state.
   */
  async getActionsEnabled(ownerRepo: string): Promise<boolean | undefined> {
    return this.withGitHubAuth(() => substrateGetActionsEnabled(ownerRepo));
  }

  /** Alias for {@link listWorkflowRuns}. */
  getRecentWorkflowRuns(ownerRepo: string, limit = 5): Promise<WorkflowRunSummary[]> {
    return this.listWorkflowRuns(ownerRepo, limit);
  }

  async listWorkflowRuns(ownerRepo: string, limit = 5): Promise<WorkflowRunSummary[]> {
    return this.withGitHubAuth(() => substrateListWorkflowRuns(ownerRepo, limit));
  }

  // ── Inline: extension-specific avatar enrichment ───────────────

  private async getOctokit(): Promise<Octokit> {
    if (!this.octokit) {
      const token = await getGitHubToken(GITHUB_SCOPES, false);
      this.octokit = new Octokit({ auth: token });
    }
    return this.octokit;
  }

  /**
   * Short SHAs + author avatar URLs for the graph view. Extension-specific
   * shape (per-author avatar URLs); not in substrate.
   */
  async listCommits(
    ownerRepo: string,
    sha: string,
    perPage: number,
  ): Promise<Array<{ sha: string; avatarUrl: string }>> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.repos.listCommits({ owner, repo, sha, per_page: perPage });
      // Annotating structurally instead of importing the full RestEndpointMethodTypes
      // chain – Octokit's listCommits response is large enough that tsc gives up
      // on inferring the element type, surfacing as implicit-any on `c`. We only
      // touch four fields here; declaring just those keeps the surface minimal.
      type CommitItem = {
        sha?: string;
        author?: { avatar_url?: string } | null;
        commit?: { author?: { name?: string } | null };
      };
      return data.map((c: CommitItem) => ({
        sha: (c.sha || "").slice(0, 7),
        avatarUrl: c.author?.avatar_url || c.commit?.author?.name || "",
      }));
    } catch (err) {
      if (err instanceof RequestError) {
        throw new GitHubServiceError(`Failed to list commits: ${err.message}`, err.status);
      }
      throw err;
    }
  }
}
