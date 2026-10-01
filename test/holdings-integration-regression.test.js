import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('refresh renders the primary quote before asynchronously enriching it with same-day holdings estimates', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const model = await readFile(new URL('../js/runtime/fund-model-enrichment.js', import.meta.url), 'utf8');

  assert.match(source, /fetchHoldingsEstimateForFund\(h\.code, h\.name, \{[\s\S]*signal: context\.signal/);
  assert.match(source, /var built = buildFundData\(r, h, \{\}\);[\s\S]*commitRefreshedFund\(context, h, built\);[\s\S]*scheduleFundEnrichment/);
  assert.match(source, /holdingsEstimate = result\.value/);
  assert.match(source, /composeFundEnrichment\(rawFund, \{[\s\S]*officialNavMove:[\s\S]*holdingsEstimate:/);
  assert.match(source, /buildFundData\(enrichedRaw, holding, modelQuotes\)/);
  assert.match(source, /await Promise\.allSettled\(enrichmentTasks\)/);
  assert.match(source, /createRequestLimiter\(2\)/);
  assert.match(source, /fields=f12,f3,f124/);
  assert.match(source, /normalizeTencentQuoteTime\(quote\.sourceTimeRaw, item\.quoteCode\)/);
  assert.match(model, /if \(!fund \|\| fund\.est_realtime !== false\) return;/);
  assert.match(model, /var official = latestOfficialNavBase\(fund\);/);
  assert.match(model, /fund\.est_model_base_nav = modelBaseNav;/);
  assert.match(model, /fund\.est_model_base_date = modelBaseDate;/);
  assert.match(model, /fund\.est_model_target_date = period\.targetDate;/);
  assert.match(source, /最新可信数据 ['"] \+ createQuotePresentation\(latest\.quote, \{ now: Date\.now\(\) \}\)\.dataTimeLabel[\s\S]*今日估算 ['"] \+ todayCount/);
  assert.match(source, /createValuationPeriod\(f\.quote[\s\S]*\.isTodayEstimate/);
});
