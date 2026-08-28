import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('deployment workflow uses least privilege, pinned Node 24 actions and dependency auditing', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\s+# v7\.0\.1/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\s+# v7\.0\.0/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /npm audit --audit-level=high --registry=https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /test -s site\/js\/app-shell\.js/);
  assert.match(workflow, /paths=\([\s\S]*"js\/app-shell\.js"/);
  assert.match(workflow, /Deployed index does not exclusively load app-shell\.js/);
  assert.match(workflow, /Deployed Service Worker CORE still contains the source module graph/);
  assert.match(workflow, /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9\s+# v5\.0\.0/);
  assert.match(workflow, /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128\s+# v5\.0\.0/);
  assert.match(workflow, /build:[\s\S]*?permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /deploy:[\s\S]*?permissions:[\s\S]*?pages: write[\s\S]*?id-token: write/);
});

test('Dependabot monitors npm and GitHub Actions on a bounded weekly schedule', async () => {
  const config = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(config, /package-ecosystem: npm/);
  assert.match(config, /package-ecosystem: github-actions/);
  assert.equal((config.match(/interval: weekly/g) || []).length, 2);
  assert.equal((config.match(/open-pull-requests-limit: 5/g) || []).length, 2);
});
