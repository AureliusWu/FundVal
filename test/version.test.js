import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_VERSION } from '../js/version.js';

test('app and service worker cache versions stay synchronized', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, new RegExp(`fuyu-v${APP_VERSION.replaceAll('.', '\\.')}`));
});
