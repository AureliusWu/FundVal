import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('app uses safe persistence, cache-to-holding binding, timeout and merge guards', async () => {
  const [app, bootstrap] = await Promise.all([
    readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/bootstrap.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(app, /localStorage\s*\./);
  assert.match(app, /async function fetchWithTimeout/);
  assert.match(app, /fetchWithTimeout\([\s\S]*push2\.eastmoney\.com/);
  assert.match(app, /mergeHoldingsByTimestamp\(holdings, cloudItems\)/);
  assert.match(app, /async function readCloudHoldings/);
  assert.match(app, /cache\.holdingsHash !== holdingsHash\(holdings\)/);
  assert.match(app, /meta\.pending_hash/);
  assert.match(app, /function queueTencentQuoteRequest/);
  assert.match(app, /function fetchTencentQuotes[\s\S]*queueTencentQuoteRequest/);
  assert.match(app, /function fetchTencentHoldingQuotes[\s\S]*queueTencentQuoteRequest/);
  assert.match(bootstrap, /await import\('\.\/migrations\.js'\)/);
  assert.match(bootstrap, /showStartupFailure/);
  assert.match(app, /var hasOverseasModel = snapshot\.some/);
  assert.match(app, /const activeOverseasModel = Boolean\(d\.est_model && !d\.est_model_stale\)/);
  assert.match(app, /model: Boolean\(activeOverseasModel \|\| d\.est_holdings_model\)/);
  assert.match(app, /refresh\(\{ force: true, reason: 'startup' \}\);[\s\S]*loadOverseasModels\(\)\.then/);
  assert.doesNotMatch(app, /loadOverseasModels\(\)\.catch\(function\(\) \{\}\)\.finally/);
});
