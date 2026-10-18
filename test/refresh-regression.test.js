import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('startup, visibility, network recovery and manual refresh all route through the generation coordinator', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const execution = await readFile(new URL('../js/runtime/refresh-execution.js', import.meta.url), 'utf8');
  const cache = await readFile(new URL('../js/runtime/refresh-resource-cache.js', import.meta.url), 'utf8');
  for (const reason of ['startup', 'visibility', 'online', 'manual']) {
    assert.match(source, new RegExp(`force: true, reason: '${reason}'`));
  }
  assert.match(source, /return refreshCoordinator\.request\(/);
  assert.match(source, /coalesce: opts\.coalesce == null \? trigger === 'timer'/);
  assert.doesNotMatch(source, /refreshChain|refreshRequestId/);
  assert.match(source, /return await execution\.executeRefreshPlan\(/);
  assert.match(execution, /code: 'ALL_FUNDS_FAILED'/);
  assert.match(execution, /const official = raw\?\.status === 'ok' \? null : await getNav\(holding\)/);
  assert.match(execution, /const primary = ui\.primary\(holding, raw, official\)/);
  assert.match(execution, /if \(navTasks\.has\(holding\.code\)\) return navTasks\.get\(holding\.code\)/);
  assert.match(execution, /const runOfficial = limited\(2\)/);
  assert.match(execution, /const requestOfficial = code => runOfficial\(\(\) => scope\.dispatch\('eastmoney-official-nav', signal => clients\.nav\(code, signal\)\)\)/);
  assert.equal((execution.match(/await requestOfficial\(holding\.code\)/g) || []).length, 2,
    'NAV fallback and metadata-only acquisition must both use the bounded official lane');
  assert.equal((execution.match(/clients\.nav\(/g) || []).length, 1,
    'Only the generation-guarded official lane may enter the NAV client');
  assert.match(execution, /Promise\.all\(\[getNav\(holding\), securityTask\]\)/);
  assert.match(source, /status: 'ok_official', last_nav: navMove\.prevNav,[\s\S]*est_kind: 'official_nav'/);
  assert.doesNotMatch(source, /`估算时间 \$\{pad\(now\.getHours\(\)\)/);
  const failureStart = source.indexOf('function commitRefreshFailure');
  const failureEnd = source.indexOf('\nasync function runRefresh', failureStart);
  assert.ok(failureStart >= 0 && failureEnd > failureStart, 'failure guard must examine the actual callback, not an empty slice');
  assert.doesNotMatch(source.slice(failureStart, failureEnd), /saveCache\(/, 'failed refresh must not renew the cache TTL');
  assert.match(execution, /if \(value && valid\(key, value\)\) \{ acquired\.set\(key, value\)/);
  assert.match(execution, /value && acquired\.get\(key\) === value\) scope\.stageCache/);
  assert.match(cache, /if \(!entry \|\| entry\.cacheState !== 'fresh'/);
  assert.match(cache, /if \(fundAcquired\) \{[\s\S]*output\.fetchedAt = current/);
  assert.match(source, /fresh: cache\.fresh && navigator\.onLine !== false/);
});
