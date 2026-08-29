import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('startup, visibility, network recovery and manual refresh all route through the generation coordinator', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  for (const reason of ['startup', 'visibility', 'online', 'manual']) {
    assert.match(source, new RegExp(`force: true, reason: '${reason}'`));
  }
  assert.match(source, /return refreshCoordinator\.request\(/);
  assert.match(source, /coalesce: opts\.coalesce == null \? trigger === 'timer'/);
  assert.doesNotMatch(source, /refreshChain|refreshRequestId/);
  assert.match(source, /code: 'ALL_FUNDS_FAILED'/);
  assert.match(source, /fetchFundFull\(h\.code, opts\.force !== false, estimateMap\.get\(h\.code\), context\.signal\)/);
  assert.match(source, /scheduleFundEnrichment\([\s\S]*fetchLatestNavMove\(h\.code/);
  assert.match(source, /status: 'ok_official', last_nav: navMove\.prevNav,[\s\S]*est_kind: 'official_nav'/);
  assert.doesNotMatch(source, /`估算时间 \$\{pad\(now\.getHours\(\)\)/);
  const failureStart = source.indexOf('function commitRefreshFailure');
  const failureEnd = source.indexOf('\nfunction scheduleFundEnrichment', failureStart);
  assert.doesNotMatch(source.slice(failureStart, failureEnd), /saveCache\(/, 'failed refresh must not renew the cache TTL');
  assert.match(source, /fresh: cache\.fresh && navigator\.onLine !== false/);
});
