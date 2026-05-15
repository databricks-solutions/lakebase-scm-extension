import { GitService } from './gitService';

export interface GraphCommit {
  sha: string;
  fullSha: string;
  parents: string[];
  refs: string[];
  message: string;
  fullMessage: string;
  author: string;
  authorEmail: string;
  date: string;
  time: string;
  stats: string;
  avatarUrl: string;
  isHead: boolean;
  isMerge: boolean;
  syncKind?: 'incoming' | 'outgoing';
}

export interface DiffFile {
  status: string;
  path: string;
}

export class GraphService {
  private ghUrlCache: string | null = null;

  constructor(private gitService: GitService) {}

  /**
   * Fetch commit history for the graph view.
   * Returns parsed commits with stats, refs, avatar URLs, and sync markers.
   */
  async getCommits(limit: number, refArgs: string): Promise<GraphCommit[]> {
    const REC = '\x1e';
    const FLD = '\x1f';
    const fmt = `%h${FLD}%H${FLD}%p${FLD}%d${FLD}%s${FLD}%an${FLD}%ae${FLD}%ar${FLD}%aD${FLD}%B${REC}`;

    try {
      const raw = await this.gitService.getLogRaw(fmt, limit, refArgs);
      if (!raw.trim()) { return []; }

      // Batch fetch shortstat
      const statRaw = await this.gitService.getLogShortstat(`${REC}%h`, limit, refArgs);
      const statsMap = new Map<string, string>();
      for (const block of statRaw.split(REC).filter(Boolean)) {
        const lines = block.trim().split('\n');
        const sha = lines[0]?.trim();
        const stat = lines.find((l: string) => l.includes('changed'));
        if (sha && stat) { statsMap.set(sha, stat.trim()); }
      }

      // Detect outgoing/incoming commits
      const outgoing = new Set(await this.gitService.getOutgoingCommits());
      const incoming = new Set(await this.gitService.getIncomingCommits());

      // Fetch GitHub avatar URLs
      const avatarCache = await this.fetchAvatars(limit);

      return raw.split(REC).filter((s: string) => s.trim()).map((record: string) => {
        const f = record.split(FLD);
        const refs: string[] = [];
        if (f[3]?.trim()) {
          for (const r of f[3].trim().replace(/^\(/, '').replace(/\)$/, '').split(',')) {
            if (r.trim()) refs.push(r.trim());
          }
        }
        const sha = f[0]?.trim() || '';
        const fullSha = f[1]?.trim() || '';
        const parents = (f[2] || '').split(' ').filter(Boolean);
        const subject = f[4] || '';
        const fullMessage = (f[9] || '').trim();
        const authorEmail = (f[6] || '').trim();
        const syncKind = outgoing.has(sha) ? 'outgoing' as const
          : incoming.has(sha) ? 'incoming' as const : undefined;
        const avatarUrl = avatarCache.get(sha) || '';

        return {
          sha, fullSha, parents, refs,
          message: subject,
          fullMessage: fullMessage || subject,
          author: f[5] || '', authorEmail,
          time: f[7] || '', date: f[8] || '',
          stats: statsMap.get(sha) || '',
          avatarUrl,
          isHead: refs.some((r: string) => r.includes('HEAD')),
          isMerge: parents.length > 1 || /^Merge (pull request|branch) /.test(subject),
          syncKind,
        };
      });
    } catch { return []; }
  }

  /**
   * Get diff files between a commit and a ref (or working tree).
   */
  async getDiffFiles(fromSha: string, toRef: string | null): Promise<DiffFile[]> {
    return this.gitService.getDiffFiles(fromSha, toRef);
  }

  /**
   * Get the normalized GitHub HTTPS URL for the origin remote (cached).
   */
  async getGitHubUrl(): Promise<string> {
    if (this.ghUrlCache !== null) { return this.ghUrlCache; }
    this.ghUrlCache = await this.gitService.getGitHubUrl();
    return this.ghUrlCache;
  }

  /**
   * Fetch GitHub avatar URLs for recent commits via gh API.
   */
  private async fetchAvatars(limit: number): Promise<Map<string, string>> {
    const cache = new Map<string, string>();
    try {
      const ghUrl = await this.getGitHubUrl();
      const match = ghUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) { return cache; }
      const [, owner, repo] = match;
      const currentBranch = await this.gitService.getCurrentBranch();
      const sha = currentBranch || 'HEAD';
      const apiOut = await this.gitService.ghApi(
        `repos/${owner}/${repo}/commits?sha=${sha}&per_page=${limit}`,
        undefined,
        '.[] | "\\(.sha[:7]) \\(.author.avatar_url // "")"'
      );
      for (const line of apiOut.split('\n').filter(Boolean)) {
        const sp = line.indexOf(' ');
        if (sp > 0) { cache.set(line.substring(0, sp), line.substring(sp + 1)); }
      }
    } catch { /* gh CLI not available */ }
    return cache;
  }
}
