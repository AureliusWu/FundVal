import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('startup, visibility, network recovery and manual refresh all force a new request', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  for (const reason of ['startup', 'visibility', 'online', 'manual']) {
    assert.match(source, new RegExp(`force: true, reason: '${reason}'`));
  }
  assert.match(source, /refreshChain\.then/);
  assert.doesNotMatch(source, /`估算时间 \$\{pad\(now\.getHours\(\)\)/);
});
