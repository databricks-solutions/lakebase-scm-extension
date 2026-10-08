// Pure version helpers — NO vscode / no I/O imports, so they're unit-testable under mocha without
// the editor host (and without tripping the mocha/Node ESM loader quirk that extensionless
// vscode-importing modules hit). Shared by the self-update check and the in-session upgrade watcher.

/** Numeric compare of dotted versions ("0.6.24" vs "0.6.23"): >0 if a is newer than b, 0 equal. */
export function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) { return (pa[i] || 0) - (pb[i] || 0); }
  }
  return 0;
}

/** Pure decision: offer an update iff `latest` is well-formed, strictly newer than `installed`, and
 *  not the exact version the user chose to skip. */
export function offerUpdateDecision(installed: string, latest: string | null | undefined, skipVersion: string | undefined): boolean {
  if (!latest || latest === skipVersion) { return false; }
  return cmpVersions(latest, installed) > 0;
}
