import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('fund details do not delete the non-configurable apidata global', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /delete\s+window\.apidata/);
  assert.doesNotMatch(source, /type=(?:jjxx|jjfl)/);
  assert.match(source, /fundDetailQueue/);
});
