import { Octokit, RequestError } from 'octokit';
import { getGitHubToken, GITHUB_SCOPES } from '../utils/githubAuth';
import { listRepoSecretNames, setRepoSecret, setRepoSecrets } from '../utils/githubSecrets';
import { formatOwnerRepo, parseOwnerRepo } from '../utils/parseRepo';
import type {
  PullRequestCheck,
  PullRequestFile,
  PullRequestInfo,
  PullRequestReview,
} from './gitService';

export class GitHubServiceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubServiceError';
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
 * GitHub platform API via Octokit.js and VS Code authentication.
 *
 * Replaces the former `gh` CLI subprocess calls that lived on {@link GitService}
 * (repo CRUD, PRs, Actions secrets, runners, workflow runs, commit avatars).
 * Git subprocess operations remain on GitService.
 *
 * Auth: {@link getGitHubToken} — VS Code GitHub sign-in first, then
 * `lakebaseSync.githubToken` / `GITHUB_TOKEN` fallback.
 */
export class GitHubService {
  private octokit: Octokit | undefined;

  private async getOctokit(): Promise<Octokit> {
    if (!this.octokit) {
      const token = await getGitHubToken(GITHUB_SCOPES, false);
      this.octokit = new Octokit({ auth: token });
    }
    return this.octokit;
  }

  /** Clear cached client (e.g. after auth change). */
  resetAuth(): void {
    this.octokit = undefined;
  }

  private wrapError(err: unknown, context: string): never {
    if (err instanceof RequestError) {
      throw new GitHubServiceError(`${context}: ${err.message}`, err.status);
    }
    if (err instanceof Error) {
      throw new GitHubServiceError(`${context}: ${err.message}`);
    }
    throw new GitHubServiceError(context);
  }

  /** Get the currently authenticated GitHub username (login). */
  async getCurrentUser(): Promise<string> {
    try {
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.users.getAuthenticated();
      return data.login;
    } catch (err) {
      this.wrapError(err, 'GitHub authentication failed');
    }
  }

  /**
   * Create a new GitHub repository via the REST API.
   * @param name - Repo name (e.g. "my-app") or "owner/my-app"
   * @param opts - Options: private (default true), description
   * @returns The created repo HTML URL
   */
  async createRepo(
    name: string,
    opts?: { private?: boolean; description?: string },
  ): Promise<string> {
    try {
      const octokit = await this.getOctokit();
      const isPrivate = opts?.private !== false;
      const description = opts?.description;

      if (name.includes('/')) {
        const { owner, repo } = parseOwnerRepo(name);
        const login = await this.getCurrentUser();
        let data;
        if (owner.toLowerCase() === login.toLowerCase()) {
          ({ data } = await octokit.rest.repos.createForAuthenticatedUser({
            name: repo,
            private: isPrivate,
            description,
          }));
        } else {
          ({ data } = await octokit.rest.repos.createInOrg({
            org: owner,
            name: repo,
            private: isPrivate,
            description,
          }));
        }
        return data.html_url || `https://github.com/${formatOwnerRepo(owner, repo)}`;
      }

      const { data } = await octokit.rest.repos.createForAuthenticatedUser({
        name,
        private: isPrivate,
        description,
      });
      return data.html_url || `https://github.com/${data.full_name}`;
    } catch (err) {
      this.wrapError(err, `Failed to create repository "${name}"`);
    }
  }

  /**
   * Delete a GitHub repository. Requires `delete_repo` OAuth scope.
   * @param name - Full repo name (e.g. "owner/my-app")
   */
  async deleteRepo(name: string): Promise<void> {
    try {
      const { owner, repo } = parseOwnerRepo(name);
      const octokit = await this.getOctokit();
      await octokit.rest.repos.delete({ owner, repo });
    } catch (err) {
      this.wrapError(err, `Failed to delete repository "${name}"`);
    }
  }

  /** Check whether a repository exists and is visible to the authenticated user. */
  async repoExists(name: string): Promise<boolean> {
    try {
      const { owner, repo } = parseOwnerRepo(name);
      const octokit = await this.getOctokit();
      await octokit.rest.repos.get({ owner, repo });
      return true;
    } catch (err) {
      if (err instanceof RequestError && err.status === 404) {
        return false;
      }
      this.wrapError(err, `Failed to check repository "${name}"`);
    }
  }

  /**
   * Resolve the canonical full name (`owner/repo`) for a repository.
   * Used after create to poll until the repo is visible (SAML/propagation delays).
   */
  async getRepoFullName(name: string): Promise<string> {
    try {
      const { owner, repo } = parseOwnerRepo(name);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return data.full_name || formatOwnerRepo(owner, repo);
    } catch (err) {
      this.wrapError(err, `Repository "${name}" is not visible`);
    }
  }

  /**
   * Set a single GitHub Actions repository secret (NaCl-encrypted via repo public key).
   * @param ownerRepo - Full repo name (e.g. "owner/my-app")
   */
  async setRepoSecret(ownerRepo: string, secretName: string, secretValue: string): Promise<void> {
    try {
      const octokit = await this.getOctokit();
      await setRepoSecret(octokit, ownerRepo, secretName, secretValue);
    } catch (err) {
      this.wrapError(err, `Failed to set secret ${secretName}`);
    }
  }

  /** Set multiple GitHub Actions repository secrets in one call. */
  async setRepoSecrets(ownerRepo: string, secrets: Record<string, string>): Promise<void> {
    try {
      const octokit = await this.getOctokit();
      await setRepoSecrets(octokit, ownerRepo, secrets);
    } catch (err) {
      this.wrapError(err, 'Failed to set repository secrets');
    }
  }

  /**
   * List GitHub Actions secret names configured on a repository.
   * @param ownerRepo - Full repo name (e.g. "owner/my-app")
   */
  async listSecretNames(ownerRepo: string): Promise<string[]> {
    try {
      const octokit = await this.getOctokit();
      return await listRepoSecretNames(octokit, ownerRepo);
    } catch {
      return [];
    }
  }

  /** Newline-separated secret names (health check / legacy callers). */
  async listSecretsText(ownerRepo: string): Promise<string> {
    const names = await this.listSecretNames(ownerRepo);
    return names.join('\n');
  }

  /** Find the open PR whose head branch matches `headBranch` (same-repo head ref). */
  private async findOpenPullRequest(
    owner: string,
    repo: string,
    headBranch: string,
  ): Promise<{ number: number; data: Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'] } | undefined> {
    const octokit = await this.getOctokit();
    const { data: pulls } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${headBranch}`,
      per_page: 1,
    });
    if (pulls.length === 0) { return undefined; }
    const summary = pulls[0];
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: summary.number,
    });
    return { number: summary.number, data };
  }

  /**
   * Derive aggregate CI status from check runs.
   * Deduplicates by check name and uses the latest run per name (GitHub returns retries).
   */
  private parseCiStatus(rawChecks: Array<{ name?: string | null; status?: string | null; conclusion?: string | null }>): PullRequestInfo['ciStatus'] {
    if (rawChecks.length === 0) { return 'pending'; }
    const latestByName = new Map<string, { conclusion?: string | null; status?: string | null }>();
    for (const c of rawChecks) {
      latestByName.set(c.name || 'unknown', c);
    }
    const states = Array.from(latestByName.values()).map(c => (c.conclusion || c.status || '').toUpperCase());
    if (states.some(s => s === 'FAILURE' || s === 'ERROR' || s === 'ACTION_REQUIRED')) {
      return 'failure';
    }
    if (states.every(s => s === 'SUCCESS' || s === 'NEUTRAL' || s === 'SKIPPED')) {
      return 'success';
    }
    return 'pending';
  }

  /**
   * Get open PR info for a head branch, including CI check rollup.
   * @param ownerRepo - Full repo name (e.g. "owner/my-app")
   * @param headBranch - Local branch name (must match PR head ref)
   */
  async getPullRequest(ownerRepo: string, headBranch: string): Promise<PullRequestInfo | undefined> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const found = await this.findOpenPullRequest(owner, repo, headBranch);
      if (!found) { return undefined; }

      const octokit = await this.getOctokit();
      const pr = found.data;
      if (pr.state !== 'open') { return undefined; }

      let rawChecks: PullRequestCheck[] = [];
      let ciStatus: PullRequestInfo['ciStatus'] = 'pending';
      const headSha = pr.head?.sha;
      if (headSha) {
        try {
          const { data: checksData } = await octokit.rest.checks.listForRef({
            owner,
            repo,
            ref: headSha,
          });
          const checkRuns = checksData.check_runs || [];
          rawChecks = checkRuns.map(c => ({
            name: c.name || 'unknown',
            status: (c.status || '').toUpperCase(),
            conclusion: (c.conclusion || '').toUpperCase(),
            detailsUrl: c.details_url || undefined,
          }));
          ciStatus = this.parseCiStatus(checkRuns);
        } catch {
          ciStatus = 'pending';
        }
      }

      return {
        number: pr.number,
        title: pr.title,
        url: pr.html_url || '',
        state: (pr.state || 'open').toUpperCase(),
        isDraft: pr.draft || false,
        ciStatus,
        checks: rawChecks,
        headBranch: pr.head?.ref || headBranch,
        baseBranch: pr.base?.ref || '',
        body: pr.body || undefined,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
      };
    } catch {
      return undefined;
    }
  }

  /** Get PR reviews (approvals, change requests, comments). */
  async getPullRequestReviews(ownerRepo: string, pullNumber: number): Promise<PullRequestReview[]> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.pulls.listReviews({ owner, repo, pull_number: pullNumber });
      return data.map(r => ({
        author: r.user?.login || 'unknown',
        state: r.state || 'COMMENTED',
        body: r.body || '',
        submittedAt: r.submitted_at || undefined,
      }));
    } catch {
      return [];
    }
  }

  /** Get files changed in a pull request. */
  async getPullRequestFiles(ownerRepo: string, pullNumber: number): Promise<PullRequestFile[]> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.pulls.listFiles({ owner, repo, pull_number: pullNumber });
      const statusMap: Record<string, PullRequestFile['status']> = {
        added: 'added', removed: 'deleted', modified: 'modified', renamed: 'renamed',
      };
      return data.map(f => ({
        path: f.filename || '',
        status: statusMap[(f.status || '').toLowerCase()] || 'modified',
        additions: f.additions || 0,
        deletions: f.deletions || 0,
      }));
    } catch {
      return [];
    }
  }

  /** Get issue/PR comments (e.g. CI schema diff comment from GitHub Actions). */
  async getPullRequestComments(ownerRepo: string, pullNumber: number): Promise<Array<{ author: string; body: string }>> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.issues.listComments({ owner, repo, issue_number: pullNumber });
      return data.map(c => ({
        author: c.user?.login || 'unknown',
        body: c.body || '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Create a pull request via the REST API. Returns the PR HTML URL.
   * Caller should push the head branch first ({@link GitService.pushCurrentBranchForPr}).
   * @param baseBranch - Target branch; defaults to the repo's default branch when omitted.
   *   Explicit base is required for 3-tier flows (feature → staging → main).
   */
  async createPullRequest(
    ownerRepo: string,
    headBranch: string,
    title: string,
    body: string,
    baseBranch?: string,
  ): Promise<string> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      let base = baseBranch;
      if (!base) {
        const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
        base = repoData.default_branch || 'main';
      }
      const { data } = await octokit.rest.pulls.create({
        owner,
        repo,
        title,
        head: headBranch,
        base,
        body,
      });
      return data.html_url || '';
    } catch (err) {
      this.wrapError(err, 'Failed to create pull request');
    }
  }

  /**
   * Merge a pull request and optionally delete the remote head branch.
   * @param method - merge, squash, or rebase
   */
  async mergePullRequest(
    ownerRepo: string,
    pullNumber: number,
    method: 'merge' | 'squash' | 'rebase' = 'merge',
    deleteRemoteBranch = true,
  ): Promise<string> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: pullNumber,
        merge_method: method,
      });
      if (deleteRemoteBranch) {
        try {
          const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
          const headRef = pr.data.head.ref;
          await octokit.rest.git.deleteRef({
            owner,
            repo,
            ref: `heads/${headRef}`,
          });
        } catch { /* branch may already be gone */ }
      }
      return data.message || `Merged PR #${pullNumber}`;
    } catch (err) {
      this.wrapError(err, 'Failed to merge pull request');
    }
  }

  /**
   * List recent commits on a ref; used for graph avatar enrichment.
   * @returns Short SHAs mapped to author avatar URLs
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
      return data.map(c => ({
        sha: (c.sha || '').slice(0, 7),
        avatarUrl: c.author?.avatar_url || c.commit?.author?.name || '',
      }));
    } catch {
      return [];
    }
  }

  /** List issue comment bodies (PR schema diff, bot comments, etc.). */
  async listIssueComments(ownerRepo: string, issueNumber: number): Promise<string[]> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.issues.listComments({ owner, repo, issue_number: issueNumber });
      return data.map(c => c.body || '').filter(Boolean);
    } catch {
      return [];
    }
  }

  /** List self-hosted runners registered on a repository. */
  async listRepoRunners(ownerRepo: string): Promise<Array<{ id: number; name: string; status: string }>> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.actions.listSelfHostedRunnersForRepo({ owner, repo });
      return (data.runners || []).map(r => ({
        id: r.id,
        name: r.name || '',
        status: r.status || 'offline',
      }));
    } catch (err) {
      this.wrapError(err, 'Failed to list runners');
    }
  }

  /** Resolve a runner id by its display name on the repo. */
  async getRunnerIdByName(ownerRepo: string, runnerName: string): Promise<number | undefined> {
    const runners = await this.listRepoRunners(ownerRepo);
    return runners.find(r => r.name === runnerName)?.id;
  }

  /** Online/offline status for a named self-hosted runner. */
  async getRunnerStatus(ownerRepo: string, runnerName: string): Promise<string | undefined> {
    const runners = await this.listRepoRunners(ownerRepo);
    return runners.find(r => r.name === runnerName)?.status;
  }

  /**
   * Create a short-lived registration token for `config.sh`.
   * Surfaces a clear error when the signed-in user cannot see the repo (404 / SAML).
   */
  async createRegistrationToken(ownerRepo: string): Promise<string> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.actions.createRegistrationTokenForRepo({ owner, repo });
      if (!data.token) {
        throw new GitHubServiceError('Registration token missing from GitHub response');
      }
      return data.token;
    } catch (err) {
      if (err instanceof GitHubServiceError) { throw err; }
      if (err instanceof RequestError && err.status === 404) {
        let activeUser = '<unknown>';
        try { activeUser = await this.getCurrentUser(); } catch { /* ignore */ }
        const owner = parseOwnerRepo(ownerRepo).owner;
        throw new GitHubServiceError(
          `GitHub returned 404 for "${ownerRepo}". The signed-in user "${activeUser}" can't see this repo — it's likely private and owned by a different account. Sign in to GitHub as ${owner} in VS Code and retry.`,
          404,
        );
      }
      this.wrapError(err, 'Failed to create runner registration token');
    }
  }

  /** Deregister a self-hosted runner from the repo (best-effort). */
  async deleteRunner(ownerRepo: string, runnerId: number): Promise<void> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      await octokit.rest.actions.deleteSelfHostedRunnerFromRepo({ owner, repo, runner_id: runnerId });
    } catch { /* best-effort deregister */ }
  }

  /** Alias for {@link listWorkflowRuns}. */
  getRecentWorkflowRuns(ownerRepo: string, limit = 5): Promise<WorkflowRunSummary[]> {
    return this.listWorkflowRuns(ownerRepo, limit);
  }

  /** List recent GitHub Actions workflow runs for a repository. */
  async listWorkflowRuns(ownerRepo: string, limit = 5): Promise<WorkflowRunSummary[]> {
    try {
      const { owner, repo } = parseOwnerRepo(ownerRepo);
      const octokit = await this.getOctokit();
      const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        per_page: limit,
      });
      return (data.workflow_runs || []).map(r => ({
        id: r.id,
        name: r.name || '',
        status: r.status || '',
        conclusion: r.conclusion || '',
        branch: r.head_branch || '',
        event: r.event || '',
      }));
    } catch {
      return [];
    }
  }
}
