import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('refresh renders the primary quote before asynchronously enriching it with same-day holdings estimates', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const model = await readFile(new URL('../js/runtime/fund-model-enrichment.js', import.meta.url), 'utf8');
  const execution = await readFile(new URL('../js/runtime/refresh-execution.js', import.meta.url), 'utf8');
  const cache = await readFile(new URL('../js/runtime/refresh-resource-cache.js', import.meta.url), 'utf8');
  const securities = await readFile(new URL('../js/runtime/security-quote-batch.js', import.meta.url), 'utf8');

  assert.match(source, /holdings: \(code, signal\) => holdingModule\.fetchFundHoldings\(code, \{ signal \}\)/);
  assert.match(execution, /scope\.dispatch\('sinan-holdings-proxy', signal => clients\.holdings\(holding\.code, signal\)\)/);
  assert.match(source, /publish: \(holding, raw\) => commitRefreshedFund\(context, holding, buildFundData\(raw, holding, \{\}\)\)/);
  const publication = execution.indexOf('scope.commitUi(() => ui.publish(holding, primary))');
  const enrichment = execution.indexOf('const enrichment = Promise.all([getNav(holding), securityTask])');
  assert.ok(publication >= 0 && enrichment > publication, 'primary must be published before waiting for NAV/security enrichment');
  assert.match(execution, /const estimate = row \? await clients\.calculateHoldings\(items, row\.payload\.reportDate\) : null/);
  assert.match(source, /composeFundEnrichment\(raw, \{ officialNavMove, holdingsEstimate \}\)/);
  assert.match(source, /buildFundData\(enriched, holding, modelQuotes\)/);
  assert.match(execution, /await Promise\.allSettled\(\[\.\.\.enrichments, marketTask, securityTask, \.\.\.navTasks\.values\(\)\]\)/);
  assert.match(execution, /await Promise\.allSettled\(metadataTasks\)/);
  assert.match(execution, /observedMetadata\.catch\(\(\) => \{\}\)/);
  assert.match(execution, /const runStable = limited\(2\)/);
  assert.match(cache, /validateHoldingSet\(payload\.items, \{ reportDate: payload\.reportDate, now, wireVersion: payload\.wireVersion \}\)/);
  assert.match(source, /fields=f12,f13,f2,f3,f124/);
  assert.match(source, /normalizeTime: normalizeTencentQuoteTime/);
  assert.match(securities, /normalizeTime\(row\.sourceTimeRaw, row\.code\)/);
  assert.match(model, /if \(!fund \|\| fund\.est_realtime !== false\) return;/);
  assert.match(model, /var official = latestOfficialNavBase\(fund\);/);
  assert.match(model, /fund\.est_model_base_nav = modelBaseNav;/);
  assert.match(model, /fund\.est_model_base_date = modelBaseDate;/);
  assert.match(model, /fund\.est_model_target_date = period\.targetDate;/);
  assert.match(source, /最新可信数据 ['"] \+ createQuotePresentation\(latest\.quote, \{ now: Date\.now\(\) \}\)\.dataTimeLabel[\s\S]*今日估算 ['"] \+ todayCount/);
  assert.match(source, /createValuationPeriod\(f\.quote[\s\S]*\.isTodayEstimate/);
});
