import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('refresh renders the primary quote before asynchronously enriching it with same-day holdings estimates', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

  assert.match(source, /fetchHoldingsEstimateForFund\(h\.code, h\.name, \{[\s\S]*signal: context\.signal/);
  assert.match(source, /var built = buildFundData\(r, h, \{\}\);[\s\S]*commitRefreshedFund\(context, h, built\);[\s\S]*scheduleFundEnrichment/);
  assert.match(source, /applyHoldingsEstimate\(enrichedRaw, result\.value\)/);
  assert.match(source, /buildFundData\(\{ \.\.\.enrichedRaw \}, holding, modelQuotes\)/);
  assert.match(source, /await Promise\.allSettled\(enrichmentTasks\)/);
  assert.match(source, /createRequestLimiter\(2\)/);
  assert.match(source, /fields=f12,f3,f124/);
  assert.match(source, /normalizeTencentQuoteTime\(fields\[30\], quoteCode\)/);
  assert.match(source, /if \(!fund \|\| fund\.est_realtime !== false\) return;/);
  assert.match(source, /if \(latestMove && latestMove\.date\) fund\.nav_date = latestMove\.date;/);
  assert.match(source, /最新可信数据 ['"] \+ createQuotePresentation\(latest\.quote, \{ now: Date\.now\(\) \}\)\.dataTimeLabel[\s\S]*今日 ['"] \+ todayCount/);
});
