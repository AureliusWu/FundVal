import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('refresh applies same-day holdings estimates before fund display calculation', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

  assert.match(source, /fetchHoldingsEstimateForFund\(h\.code, h\.name\)/);
  assert.match(source, /applyHoldingsEstimate\(r, holdingsEstimate\);[\s\S]*buildFundData\(r, h, quotes\)/);
  assert.match(source, /fields=f12,f3,f124/);
  assert.match(source, /normalizeTencentQuoteTime\(fields\[30\], quoteCode\)/);
  assert.match(source, /if \(!fund \|\| fund\.est_realtime !== false\) return;/);
  assert.match(source, /最新行情 ['"] \+ latest \+ ['"] · 今日 ['"] \+ todayCount/);
});
