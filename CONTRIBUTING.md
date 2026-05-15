# Contributing

Thanks for your interest in contributing to the Lakebase SCM Extension. This is a [Databricks Labs](https://github.com/databrickslabs) project — community-supported, not officially supported by Databricks.

## Development setup

Prerequisites:
- Node.js 18+ and npm
- VS Code 1.85 or newer
- The [`vsce`](https://github.com/microsoft/vscode-vsce) CLI (installed as a devDependency; use `./node_modules/.bin/vsce`)
- The [Databricks CLI](https://docs.databricks.com/dev-tools/cli/) authenticated to a workspace with Lakebase enabled (only required for live testing against Lakebase)

```bash
git clone https://github.com/databrickslabs/lakebase-scm-extension
cd lakebase-scm-extension
npm install
```

## Running locally

Open the repo in VS Code and press `F5` (`Run → Start Debugging`). VS Code launches an Extension Development Host with this extension loaded. Make changes in `src/`, reload the host (`Ctrl/Cmd+R` in the host window) to pick them up.

## Building a VSIX

```bash
./node_modules/.bin/vsce package
```

Produces `lakebase-scm-extension-<version>.vsix` at the repo root. Sideload with:

```bash
code --install-extension lakebase-scm-extension-<version>.vsix --force
```

then `Developer: Reload Window` in the host to pick up new menu wiring / commands.

## Project structure

```
src/
  extension.ts            # command registrations and activation
  providers/              # tree views + SCM provider + webviews
  services/               # Lakebase, git, schema diff, runner, etc.
  utils/                  # config, exec, theme, diff helpers
templates/project/common/ # files copied into scaffolded user projects
  scripts/                # post-checkout, refresh-token, etc.
  scripts/ci/             # CI helpers used by pr.yml / merge.yml
  .github/workflows/      # pr.yml, merge.yml, cleanup-orphans.yml
```

The extension has two parallel surfaces that must stay in sync:
- **Shell hooks** (`templates/project/common/scripts/*.sh`) — fire from terminal `git` operations.
- **TypeScript services** (`src/services/lakebaseService.ts` etc.) — invoked by VS Code UI commands.

When you change branch lifecycle behavior (fork source, connection target, credential mint), update both paths in the same PR.

## Testing

There's no automated test suite at the moment. PRs that change behavior should describe the manual scenarios you exercised:
- Which extension command(s) you triggered
- Which view(s) you observed (Project tree, Branch Diff Summary, Changes panel, etc.)
- What you saw before and after

If your change touches CI templates (`templates/project/common/.github/workflows/*.yml`), it's helpful to run a PR through them in a downstream project that's already scaffolded.

## Pull requests

- Branch off `main`. Branch names: `fix/<short>`, `feat/<short>`, etc.
- One logical change per PR. Keep commits small and squashable.
- Commit messages: short subject (≤72 chars), then a body explaining *why*. Code already shows *what*.
- Run `./node_modules/.bin/vsce package` and confirm it produces `DONE Packaged: ...` (no `ERROR ...` lines) before pushing. The build is the only automated check today.
- Update `CHANGELOG.md` for any user-visible change.
- If your PR adds a new command, hook event, or setting, also update the relevant section of `README.md`.

## Reporting issues

Use the issue templates under `.github/ISSUE_TEMPLATE/`. Include the extension version, VS Code version, OS, and the exact command you ran. For schema-diff or branch-tree bugs, the workspace's `.env` (with secrets redacted) and the output of `databricks postgres list-branches "<project-path>"` are usually decisive.

## Code of conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/) — see `CODE_OF_CONDUCT.md`.
