import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('app uses safe persistence, cache-to-holding binding, timeout and merge guards', async () => {
  const [app, bootstrap, gistRemote, index, diagnostics, cloudArchive, execution, cache, securities] = await Promise.all([
    readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/bootstrap.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/storage/gist-remote.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../js/runtime/diagnostics-ui.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/storage/cloud-archive-ui.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/runtime/refresh-execution.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/runtime/refresh-resource-cache.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/runtime/security-quote-batch.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(app, /localStorage\s*\./);
  assert.match(app, /async function fetchWithTimeout/);
  assert.match(app, /fetchWithTimeout\([\s\S]*push2\.eastmoney\.com/);
  assert.match(app, /synchronizeHoldingsCloud/);
  assert.match(app, /pullHoldingsCloud/);
  assert.match(cloudArchive, /backupCloudSyncSnapshot/);
  assert.equal((app.match(/method:\s*'PATCH'/g) || []).length, 0);
  assert.equal((gistRemote.match(/method:\s*'PATCH'/g) || []).length, 1);
  assert.match(app, /cache\.holdingsHash !== holdingsHash\(holdings\)/);
  assert.match(app, /meta\.pending_hash/);
  assert.match(cloudArchive, /const uploadDocument = normalizeHoldingsDocumentV3\(holdingsDocument\)/);
  assert.match(cloudArchive, /finalizeCreatedArchiveState\([\s\S]*uploadDocument,[\s\S]*currentLoaded\.document/);
  assert.match(cloudArchive, /setSyncPending\(finalized\.pending\)/);
  assert.match(app, /import\('\.\/runtime\/quote-bridge-client\.js'\)/);
  assert.match(app, /function fetchLatestNavMoveRaw[\s\S]*bridge\.officialFundData/);
  assert.match(app, /return bridge\[operation\]\(codes, \{ signal, timeoutMs: TIMING\.INDEX_JSONP_TIMEOUT \}\)/);
  assert.match(app, /function fetchHoldingsQuotes[\s\S]*quotes\.executeDetailSecurityQuotes/);
  assert.match(app, /fetchEastmoney: fetchSecurityEastmoney, fetchBridge: fetchSecurityBridge/);
  assert.doesNotMatch(app, /fetchTencentHoldingQuotes|fetchAStockHoldingQuotes|changeMap\[item\.f12\]/);
  assert.match(app, /indices: async \(codes, signal\) =>[\s\S]*bridge\.indexQuotes\(codes, \{ signal, timeoutMs: TIMING\.INDEX_JSONP_TIMEOUT \}\)/);
  assert.match(app, /bridge: fetchSecurityBridge/);
  assert.match(app, /function fetchSecurityBridge[\s\S]*bridge\[operation\]\(codes, \{ signal, timeoutMs: TIMING\.INDEX_JSONP_TIMEOUT \}\)/);
  assert.match(securities, /\['overseasComponents', modelMissing, BRIDGE_LIMITS\.overseasCodes\]/);
  assert.match(securities, /\['securityQuotes', securityMissing, BRIDGE_LIMITS\.securityCodes\]/);
  assert.match(securities, /scope\.dispatch\('tencent-market-quote', signal => fetchBridge\(operation, permitted, signal\)\)/);
  assert.match(securities, /const permitted = permittedBatch\(batch\)/);
  assert.doesNotMatch(app, /queueTencentQuoteRequest/);
  assert.match(bootstrap, /await import\('\.\/migrations\.js'\)/);
  assert.match(bootstrap, /if \(!migration\.ok\) throw/);
  assert.match(bootstrap, /showStartupFailure/);
  assert.match(app, /overseasModelsPromise = loadOverseasModels\(\)/);
  assert.match(app, /d\.quoteCandidates = buildFundQuoteCandidates/);
  assert.match(app, /d\.quote = selectPreferredQuote/);
  assert.match(app, /d\.freshness = legacyFreshnessFromQuote\(d\.quote\)/);
  assert.match(app, /d\.today_is_latest_nav = d\.quote\.valueKind === 'official_nav'/);
  assert.doesNotMatch(app, /d\.today_is_latest_nav\s*=\s*true/);
  assert.match(app, /createQuotePresentation\(f\.quote, \{ now, shares: f\.shares, period: f\.period \}\)/);
  assert.match(app, /Object\.assign\(d, holdingQuoteAmounts\(d\.quote, h, d\.updatedAt\)\)/);
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
  assert.match(app, /toNonNegativeNumber\(document\.getElementById\('i-cost'\)\.value, \{ nullable: true \}\)/);
  assert.match(app, /function updateLatestSourceSummary[\s\S]*quote\.status === 'stale'[\s\S]*parseQuoteTimestamp/);
  assert.match(app, /function staleIndexItem[\s\S]*status: 'stale', cached: true/);
  assert.match(app, /class=\"index-stale\">旧/);
  assert.match(app, /function refreshDiagnosticsCenter/);
  assert.match(app, /function copyDiagnosticsSummary/);
  assert.match(app, /import\('\.\/runtime\/diagnostics-ui\.js'\)/);
  assert.match(diagnostics, /recentSafeDiagnostics[\s\S]*selectSafeDiagnosticEvents\(rows\)/);
  assert.match(diagnostics, /normalizeOcrDiagnosticForDisplay\(latest\)/);
  assert.match(diagnostics, /遥测异常/);
  assert.doesNotMatch(diagnostics, /GIST_TOKEN_KEY/);
  assert.doesNotMatch(app, /fund-name[^\n]+sourceTag|fund-name[^\n]+estimateTag/);
  assert.match(app, /const refreshCoordinator = new RefreshCoordinator/);
  assert.doesNotMatch(app, /refreshChain|refreshRequestId/);
  assert.match(app, /signal: context\.signal/);
  assert.match(app, /import\('\.\/runtime\/refresh-execution\.js'\)/);
  assert.match(app, /execution\.executeRefreshPlan\(/);
  assert.match(execution, /Promise\.all\(\[getNav\(holding\), securityTask\]\)/);
  assert.match(execution, /scope\.commitUi\(\(\) => ui\.enriched\(/);
  assert.equal((execution.match(/scope\.flushCache\(/g) || []).length, 1);
  assert.match(execution, /serialize: staged => serializeRefreshAggregate\(/);
  assert.match(cache, /if \(holdingsHash !== undefined\) output\.holdingsHash = holdingsHash/);
  assert.match(cache, /if \(fundAcquired\) \{[\s\S]*output\.fetchedAt = current/);
  assert.match(app, /context\.commit\(function\(\) \{\s*upsertFundData/);
  assert.equal((app.match(/reason: 'startup'/g) || []).length, 1);
  assert.doesNotMatch(app, /reason: 'overseas-models'/);
  assert.doesNotMatch(app, /loadOverseasModels\(\)\.catch\(function\(\) \{\}\)\.finally/);
  assert.doesNotMatch(index, /fonts\.(?:googleapis|gstatic)\.com/, 'app shell must not block startup on external fonts');
  assert.doesNotMatch(index, /assets\/ocr\//, 'OCR assets must stay out of the app shell');
});
