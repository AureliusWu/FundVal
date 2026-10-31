import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = (await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const receiptStep = workflow.match(/      - name: Preserve successful synthetic E2E receipts\n([\s\S]*?)(?=      - name:|\n  [a-z]|$)/)?.[1];

test('successful E2E receipts are retained separately with the already pinned action', () => {
  assert.ok(receiptStep, 'missing successful-run receipt artifact');
  assert.match(receiptStep, /if: success\(\)/);
  assert.match(receiptStep, /uses: actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/);
  assert.match(receiptStep, /name: fundval-e2e-receipts-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(receiptStep, /include-hidden-files: true/);
  assert.match(receiptStep, /if-no-files-found: error/);
  assert.match(receiptStep, /retention-days: 14/);
});

test('green receipt archive includes only named synthetic JSON, not runtime or general user files', () => {
  assert.ok(receiptStep, 'missing successful-run receipt artifact');
  const paths = [...receiptStep.matchAll(/^            (site\/[^\r\n]+)$/gm)].map(match => match[1]);
  assert.deepEqual(paths, [
    'site/.playwright-results/**/actual-paddle-synthetic-receipt.json',
    'site/.playwright-results/**/actual-paddle-cancel-receipt.json',
    'site/.playwright-results/**/offline-shell-evidence.json',
    'site/.playwright-results/**/native-built-app-update-guards.json',
    'site/.playwright-results/**/subpath-preload-evidence.json',
    'site/.playwright-results/**/native-create-intent-reload-receipt.json',
    'site/.playwright-results/**/native-panel-navigation-receipt.json',
  ]);
  assert.doesNotMatch(receiptStep, /continue-on-error|candidate\/site\.tar|\.env|\*\.png|\*\.zip/);
});

test('failure diagnostics and deployable-candidate exclusion stay independent', () => {
  assert.match(workflow, /Preserve failed synthetic E2E diagnostics\s*\n\s+if: failure\(\)/);
  assert.match(workflow, /name: fundval-e2e-failure-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /Enforce actual app startup budget\s*\n\s+run: node scripts\/release-fingerprint\.mjs --assert-app-bundle-budget site/);
});
