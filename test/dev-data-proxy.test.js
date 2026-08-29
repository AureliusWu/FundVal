import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDevProxyTarget } from '../scripts/dev-data-proxy.mjs';
import { fundDataApiUrl } from '../js/config.js';

test('local runtime uses only the two same-origin development endpoints', () => {
  assert.equal(fundDataApiUrl('estimates', { hostname: '127.0.0.1' }), '/__fundval_dev/estimates');
  assert.equal(fundDataApiUrl('holdings', { hostname: 'localhost' }), '/__fundval_dev/holdings');
  assert.equal(
    fundDataApiUrl('estimates', { hostname: 'aureliuswu.github.io' }),
    'https://sinan-estimate-push.ligugu69.workers.dev/estimates',
  );
  assert.throws(() => fundDataApiUrl('arbitrary-url', { hostname: 'localhost' }));
});

test('development proxy accepts only strict read-only fund requests', () => {
  const estimates = resolveDevProxyTarget('http://127.0.0.1/__fundval_dev/estimates?codes=005844,012920&_=123');
  assert.equal(estimates.ok, true);
  assert.equal(estimates.target.origin, 'https://sinan-estimate-push.ligugu69.workers.dev');
  assert.equal(estimates.target.pathname, '/estimates');
  assert.equal(resolveDevProxyTarget('http://127.0.0.1/__fundval_dev/holdings?code=005844').ok, true);
  assert.equal(resolveDevProxyTarget('http://127.0.0.1/__fundval_dev/holdings?code=005844', 'POST').status, 405);
});

test('development proxy rejects arbitrary URLs, extra parameters and malformed codes', () => {
  for (const url of [
    'http://127.0.0.1/__fundval_dev/proxy?url=https://evil.example',
    'http://127.0.0.1/__fundval_dev/estimates?codes=005844&url=https://evil.example',
    'http://127.0.0.1/__fundval_dev/estimates?codes=005844,005844',
    'http://127.0.0.1/__fundval_dev/estimates?codes=../../etc/passwd',
    'http://127.0.0.1/__fundval_dev/holdings?code=1',
  ]) assert.equal(resolveDevProxyTarget(url).ok, false, url);
});
