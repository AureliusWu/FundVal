import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

test('service worker isolates its cache cleanup, claims clients during activation, and returns errors offline', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

  assert.match(source, /const CACHE_PREFIX = 'fuyu-v';/);
  assert.match(source, /key\.startsWith\(CACHE_PREFIX\) && key !== CACHE/);
  assert.doesNotMatch(source, /keys\.filter\(key => key !== CACHE\)/);
  assert.match(source, /await self\.clients\.claim\(\);/);
  assert.match(source, /event\.waitUntil\(\(async \(\) => \{/);
  for (const name of ['networkFirst', 'cacheFirst', 'staleWhileRevalidate']) {
    assert.match(functionBody(source, name), /Response\.error\(\)/, `${name} must return a Response when offline without a cache`);
  }
  assert.match(source, /async function cachePutBestEffort/);
  assert.match(functionBody(source, 'cachePutBestEffort'), /catch \(_\)[\s\S]*return false;/);
  assert.doesNotMatch(source, /if \(response\.ok\) \(await caches\.open\(CACHE\)\)\.put/);
  assert.match(source, /url\.pathname\.includes\('\/assets\/ocr\/'\)/);
  assert.match(functionBody(source, 'networkOnly'), /return await fetch\(request\)/);
});
