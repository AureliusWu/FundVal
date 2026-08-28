import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('app uses safe persistence, cache-to-holding binding, timeout and merge guards', async () => {
  const [app, bootstrap, gistRemote, index] = await Promise.all([
    readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/bootstrap.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/storage/gist-remote.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(app, /localStorage\s*\./);
  assert.match(app, /async function fetchWithTimeout/);
  assert.match(app, /fetchWithTimeout\([\s\S]*push2\.eastmoney\.com/);
  assert.match(app, /synchronizeHoldingsCloud/);
  assert.match(app, /pullHoldingsCloud/);
  assert.match(app, /backupCloudSyncSnapshot/);
  assert.equal((app.match(/method:\s*'PATCH'/g) || []).length, 0);
  assert.equal((gistRemote.match(/method:\s*'PATCH'/g) || []).length, 1);
  assert.match(app, /cache\.holdingsHash !== holdingsHash\(holdings\)/);
  assert.match(app, /meta\.pending_hash/);
  assert.match(app, /function queueTencentQuoteRequest/);
  assert.match(app, /function fetchTencentQuotes[\s\S]*queueTencentQuoteRequest/);
  assert.match(app, /function fetchTencentHoldingQuotes[\s\S]*queueTencentQuoteRequest/);
  assert.match(bootstrap, /await import\('\.\/migrations\.js'\)/);
  assert.match(bootstrap, /if \(!migration\.ok\) throw/);
  assert.match(bootstrap, /showStartupFailure/);
  assert.match(app, /var hasOverseasModel = snapshot\.some/);
  assert.match(app, /d\.quoteCandidates = buildFundQuoteCandidates/);
  assert.match(app, /d\.quote = selectPreferredQuote/);
  assert.match(app, /d\.freshness = legacyFreshnessFromQuote\(d\.quote\)/);
  assert.match(app, /d\.today_is_latest_nav = d\.quote\.valueKind === 'official_nav'/);
  assert.doesNotMatch(app, /d\.today_is_latest_nav\s*=\s*true/);
  assert.match(app, /createQuotePresentation\(f\.quote, \{ now: Date\.now\(\) \}\)/);
  assert.match(app, /class="fund-card-toggle"[\s\S]*aria-expanded=/);
  assert.match(app, /data-fund-toggle=[\s\S]*aria-controls=/);
  assert.match(app, /focusedToggleCode[\s\S]*preventScroll: true/);
  assert.match(app, /renderQuoteDiagnostics\(presentation\)/);
  assert.match(app, /fmtQuoteNav\(currentNavValue\)/);
  assert.match(app, /function displayChangeOf\(fund\)[\s\S]*fund\.quote\.changePct/);
  const displayChangeBody = app.slice(app.indexOf('function displayChangeOf'), app.indexOf('\nfunction sortFunds'));
  assert.doesNotMatch(displayChangeBody, /primary_change|preferredDailyMove/);
  assert.match(app, /cost: h\.cost == null \? null : h\.cost/);
  assert.match(app, /cost: holding\.cost == null \? null : holding\.cost/);
  assert.doesNotMatch(app, /cost:\s*(?:h|holding)\.cost\s*\|\|\s*0/);
  assert.match(app, /d\.primary_base_nav = resolveQuoteBaseNav\(d, d\.quote\)/);
  assert.match(app, /var nav = isUsableNav\(d\.primary_nav\) \? d\.primary_nav : NaN/);
  assert.match(app, /toNonNegativeNumber\(document\.getElementById\('i-cost'\)\.value, \{ nullable: true \}\)/);
  assert.match(app, /function updateLatestSourceSummary[\s\S]*quote\.status === 'stale'[\s\S]*parseQuoteTimestamp/);
  assert.match(app, /function staleIndexItem[\s\S]*status: 'stale', cached: true/);
  assert.match(app, /class=\"index-stale\">旧/);
  assert.match(app, /function refreshDiagnosticsCenter/);
  assert.match(app, /function copyDiagnosticsSummary/);
  assert.match(app, /recentSafeDiagnostics[\s\S]*selectSafeDiagnosticEvents\(rows\)/);
  assert.match(app, /normalizeOcrDiagnosticForDisplay\(latest\)/);
  assert.doesNotMatch(app, /diagnosticsLastSummary[\s\S]{0,500}GIST_TOKEN_KEY/);
  assert.doesNotMatch(app, /fund-name[^\n]+sourceTag|fund-name[^\n]+estimateTag/);
  assert.match(app, /const refreshCoordinator = new RefreshCoordinator/);
  assert.doesNotMatch(app, /refreshChain|refreshRequestId/);
  assert.match(app, /signal: context\.signal/);
  assert.match(app, /function scheduleFundEnrichment/);
  assert.match(app, /context\.commit\(function\(\) \{\s*upsertFundData/);
  assert.match(app, /refresh\(\{ force: true, reason: 'startup' \}\);[\s\S]*loadOverseasModels\(\)\.then/);
  assert.doesNotMatch(app, /loadOverseasModels\(\)\.catch\(function\(\) \{\}\)\.finally/);
  assert.doesNotMatch(index, /fonts\.(?:googleapis|gstatic)\.com/, 'app shell must not block startup on external fonts');
  assert.doesNotMatch(index, /assets\/ocr\//, 'OCR assets must stay out of the app shell');
});
