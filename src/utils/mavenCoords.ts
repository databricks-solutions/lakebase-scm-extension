/**
 * Sanitize a project name into a valid Maven artifactId.
 * Lowercase, hyphens only, no leading digits.
 */
export function sanitizeArtifactId(name: string): string {
  let id = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!id) {
    id = 'demo';
  }
  if (/^[0-9]/.test(id)) {
    id = `app-${id}`;
  }
  return id;
}
