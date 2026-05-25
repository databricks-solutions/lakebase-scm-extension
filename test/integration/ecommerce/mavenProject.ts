/**
 * Maven project – secrets gitignore guard
 *
 * Substrate's `LAKEBASE_SCAFFOLD_FALLBACK=1` path (set in ecommerceScenarios.test.ts)
 * deploys the bundled static Java/Spring scaffold from
 * templates/project/java/fallback/ – that already ships every file the test
 * needs (pom.xml with data-jpa+flyway+postgres deps, mvnw, application.properties
 * with spring.config.import for application-local.properties, deterministic
 * DemoApplication.java, DemoApplicationTests, V1 placeholder migration).
 *
 * The only remaining test-side concern is that substrate's createProject Step 6
 * writes `.env` (with non-secret HOST + project-id) and commits it. Once tracked,
 * the post-checkout hook's rewrite of .env (with a real JWT) gets staged and
 * the Databricks pre-commit gitleaks hook blocks the commit.
 * `ensureSecretsGitignored` patches that by appending the entries to .gitignore
 * (idempotent) and `git rm --cached`ing the tracked copy.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

export function scaffoldMavenProject(projectDir: string): void {
  console.log('    [maven] Ensuring secret-bearing files are gitignored + untracked...');
  ensureSecretsGitignored(projectDir);
  console.log('    [maven] Done.');
}

function ensureSecretsGitignored(projectDir: string): void {
  const required = ['.env', 'application-local.properties'];
  const gitignorePath = path.join(projectDir, '.gitignore');
  let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const lines = new Set(content.split('\n').map((l) => l.trim()));
  const missing = required.filter((r) => !lines.has(r));
  if (missing.length > 0) {
    if (content.length > 0 && !content.endsWith('\n')) content += '\n';
    content += '\n# Lakebase: never commit branch-specific connection material\n';
    content += missing.join('\n') + '\n';
    fs.writeFileSync(gitignorePath, content);
  }
  for (const f of required) {
    try {
      cp.execSync(`git ls-files --error-unmatch "${f}"`, { cwd: projectDir, stdio: 'pipe' });
      cp.execSync(`git rm --cached -q "${f}"`, { cwd: projectDir, stdio: 'pipe' });
    } catch {
      // Not tracked – nothing to do.
    }
  }
}
