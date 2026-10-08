import * as vscode from 'vscode';
import { offerUpdateDecision } from './utils/versionCheck';

// Self-update nudge. The extension ships as a .vsix off GitHub releases (NOT the marketplace), so
// VS Code's built-in auto-update never sees it — nothing tells a user their install is stale. This
// checks GitHub (once/day) for a newer release and, if behind, offers to open the release page so
// they can download + Install-from-VSIX. All failures are swallowed; it never blocks activation.
// Pure version compare + the offer decision live in ./version (unit-tested there).

const REPO = 'databricks-solutions/lakebase-scm-extension';
const RELEASES_LATEST_URL = `https://github.com/${REPO}/releases/latest`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once/day
const LAST_KEY = 'lakebaseSync.lastUpdateCheckAt';
const SKIP_KEY = 'lakebaseSync.skipUpdateVersion';

/** Fire-and-forget on activation: throttled to once/day, ask GitHub for the latest release tag and,
 *  if this install is behind (and the user hasn't skipped that version), offer "View release" /
 *  "Skip this version". Gated by `lakebaseSync.checkForUpdates`. Swallows every error. */
export async function checkForLatestRelease(context: vscode.ExtensionContext): Promise<void> {
  try {
    if (!vscode.workspace.getConfiguration('lakebaseSync').get<boolean>('checkForUpdates', true)) { return; }
    const last = context.globalState.get<number>(LAST_KEY) ?? 0;
    if (Date.now() - last < CHECK_INTERVAL_MS) { return; }
    const installed = (context.extension.packageJSON as { version?: string }).version || '0.0.0';

    let latest: string | null = null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const res = await fetch(LATEST_RELEASE_API, {
        signal: ctl.signal,
        headers: { 'User-Agent': `lakebase-scm-extension/${installed}`, Accept: 'application/vnd.github+json' },
      });
      if (res.ok) {
        const body = (await res.json()) as { tag_name?: string };
        latest = body.tag_name ? body.tag_name.replace(/^v/, '') : null;
      }
    } finally {
      clearTimeout(timer);
    }

    // Record the attempt either way so a flaky network throttles to once/day, not every activation.
    await context.globalState.update(LAST_KEY, Date.now());

    const skip = context.globalState.get<string>(SKIP_KEY);
    if (!offerUpdateDecision(installed, latest, skip)) { return; }

    const choice = await vscode.window.showInformationMessage(
      `Lakebase SCM ${latest} is available (you have ${installed}). It installs from a .vsix, not the marketplace.`,
      { modal: false },
      'View release',
      'Skip this version',
    );
    if (choice === 'View release') {
      void vscode.env.openExternal(vscode.Uri.parse(RELEASES_LATEST_URL));
    } else if (choice === 'Skip this version') {
      await context.globalState.update(SKIP_KEY, latest);
    }
  } catch {
    /* a self-update nudge must never block or break activation */
  }
}
