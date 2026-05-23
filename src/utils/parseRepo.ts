export interface OwnerRepo {
  owner: string;
  repo: string;
}

/** Parse owner/repo from a slug, HTTPS URL, or git SSH URL. */
export function parseOwnerRepo(urlOrSlug: string): OwnerRepo {
  const trimmed = urlOrSlug.trim().replace(/\.git$/, '');
  if (trimmed.includes('/')) {
    const slugMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+)/);
    if (slugMatch) {
      return { owner: slugMatch[1], repo: slugMatch[2] };
    }
    const parts = trimmed.split('/');
    if (parts.length >= 2) {
      return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
    }
  }
  throw new Error(`Invalid GitHub repo reference: ${urlOrSlug}`);
}

/** Build owner/repo slug from parts. */
export function formatOwnerRepo(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}
