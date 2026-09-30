import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CI validates every branch and PR, seals review candidates and has no production permission', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name: FundVal CI/);
  assert.match(workflow, /push:\s*\n\s+branches: \['\*\*'\]/);
  assert.match(workflow, /pull_request:\s*\n\s+branches: \[main\]/);
  assert.match(workflow, /name: candidate/);
  assert.match(workflow, /name: codeql/);
  assert.doesNotMatch(workflow, /pages: write|id-token: write|deploy-pages|upload-pages-artifact/);
  assert.match(workflow, /node-version-file: \.node-version/);
  assert.match(workflow, /npm@11\.9\.0 --ignore-scripts/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /node scripts\/dependency-install-policy\.mjs/);
  assert.match(workflow, /node node_modules\/esbuild\/install\.js/);
  assert.match(workflow, /npm audit --audit-level=high --registry=https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /npm test[\s\S]*npm run check[\s\S]*npm run build[\s\S]*npm run test:e2e[\s\S]*release-candidate\.mjs create/);
  assert.match(workflow, /test -s site\/js\/app-shell\.js/);
  assert.match(workflow, /test -s site\/js\/app-chunks\.json/);
  assert.match(workflow, /test -f site\/manifest\.json/);
  assert.match(workflow, /test -s site\/js\/update-compat\.js/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /name: fundval-candidate-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /CANDIDATE_EVENT: \$\{\{ github\.event_name \}\}/);
  assert.match(workflow, /CANDIDATE_BRANCH: \$\{\{ github\.head_ref \|\| github\.ref_name \}\}/);
  assert.match(workflow, /Preserve failed synthetic E2E diagnostics\s*\n\s+if: failure\(\)/);
  assert.match(workflow, /name: fundval-e2e-failure-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /path: site\/\.playwright-results\/\s*\n\s+include-hidden-files: true/);
  assert.doesNotMatch(workflow, /if:.*refs\/heads\/main/);
  assert.match(workflow, /github\/codeql-action\/init@[0-9a-f]{40}/);
  assert.match(workflow, /github\/codeql-action\/analyze@[0-9a-f]{40}/);
  assert.match(workflow, /languages: javascript-typescript/);
  assert.match(workflow, /security-events: write/);
  const config = await readFile(new URL('../.github/codeql-config.yml', import.meta.url), 'utf8');
  assert.match(config, /security-extended/);
  const npmrc = await readFile(new URL('../.npmrc', import.meta.url), 'utf8');
  assert.match(npmrc, /^ignore-scripts=true$/m);
  assert.equal((await readFile(new URL('../.node-version', import.meta.url), 'utf8')).trim(), '24.14.0');
});

test('deployment only accepts explicit verified origin candidates and never rebuilds them', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /candidate_run_id:/);
  assert.match(workflow, /candidate_sha:/);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|workflow_run):/m);
  assert.doesNotMatch(workflow, /npm (?:ci|install|run build)|build-site|build-paddle/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /node scripts\/resolve-release-candidate\.mjs/);
  assert.match(workflow, /node scripts\/release-candidate\.mjs verify/);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /repository: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /run-id: \$\{\{ steps\.provenance\.outputs\.run_id \}\}/);
  assert.match(workflow, /release_fingerprint:\s*\$\{\{ steps\.release_fingerprint\.outputs\.value \}\}/);
  assert.match(workflow, /EXPECTED_RELEASE_FINGERPRINT:\s*\$\{\{ needs\.verify\.outputs\.release_fingerprint \}\}/);
  assert.match(workflow, /environment:\s*\n\s+name: github-pages/);
  assert.match(workflow, /verify:[\s\S]*?permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.match(workflow, /deploy:[\s\S]*?permissions:[\s\S]*?pages: write[\s\S]*?id-token: write/);
  assert.match(workflow, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9\s+# v5\.0\.0/);
  assert.match(workflow, /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128\s+# v5\.0\.0/);
  assert.match(workflow, /Deployed release-critical files do not match the built Pages artifact/);
  assert.match(workflow, /--verify-app-chunks-directory/);
  assert.match(workflow, /--verify-ocr-directory/);
  assert.match(workflow, /Deployed legacy update bridge is missing or loads after app-shell\.js/);
  assert.match(workflow, /Deployed Service Worker is missing release-safe HTTP cache revalidation/);
  assert.match(workflow, /Deployed OCR page is missing partial-telemetry merge protection/);
  assert.match(workflow, /Deployed OCR wrapper is missing sanitized failure telemetry/);
  assert.match(workflow, /Deployed Paddle engine is missing backend fallback telemetry/);
});

test('all workflow actions remain pinned to immutable commit SHAs', async () => {
  for (const file of ['ci.yml', 'deploy.yml']) {
    const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    const actions = [...workflow.matchAll(/^\s+uses: (\S+)/gm)].map(match => match[1]);
    assert.ok(actions.length > 0);
    for (const action of actions) assert.match(action, /^[A-Za-z0-9_./-]+@[0-9a-f]{40}$/);
    assert.doesNotMatch(workflow, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/);
  }
});

test('Dependabot monitors npm and GitHub Actions on a bounded weekly schedule', async () => {
  const config = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(config, /package-ecosystem: npm/);
  assert.match(config, /package-ecosystem: github-actions/);
  assert.equal((config.match(/interval: weekly/g) || []).length, 2);
  assert.equal((config.match(/open-pull-requests-limit: 5/g) || []).length, 2);
});
