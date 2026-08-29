import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('fund valuation never falls back to an identically numbered stock quote', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /stock\/get\?secid=0\.\$\{code\}/);
  assert.doesNotMatch(app, /function fetchFromEastmoney\s*\(/);
  assert.doesNotMatch(app, /nav_change_amt\s*\*\s*d\.shares/);
});

test('the credential-bearing page does not execute third-party scripts', async () => {
  const [app, index] = await Promise.all([
    readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(app, /\.src\s*=\s*['"]https:\/\//);
  assert.doesNotMatch(app, /document\.head\.appendChild\(script\)/);
  assert.match(index, /Content-Security-Policy/);
  assert.match(index, /script-src 'self'/);
  assert.doesNotMatch(index, /\son(?:click|change|input|toggle|load)\s*=/i);
});

test('remote holdings fields are escaped even after schema validation', async () => {
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /esc\(s\.name\) \+ '<em>' \+ s\.code/);
  assert.match(app, /esc\(s\.code\)/);
});
