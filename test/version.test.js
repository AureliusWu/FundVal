import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_VERSION } from '../js/version.js';

test('runtime, release metadata and maintained documentation versions stay synchronized', async () => {
  const [sw, pkg, manifest, index, readme, agents, claude] = await Promise.all([
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../manifest.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8'),
  ]);
  assert.match(sw, new RegExp(`fuyu-v${APP_VERSION.replaceAll('.', '\\.')}`));
  assert.equal(pkg.version, APP_VERSION);
  assert.match(manifest.description, new RegExp(`v${APP_VERSION.replaceAll('.', '\\.')}`, 'i'));
  assert.match(index, new RegExp(`V${APP_VERSION.replaceAll('.', '\\.')}`));
  for (const document of [readme, agents, claude]) {
    assert.match(document, new RegExp(`(?:V|v)?${APP_VERSION.replaceAll('.', '\\.')}`));
  }
});
