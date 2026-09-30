import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest, discoverNpmCli, parseCoverage, parseNodeSummary, timingSummary } from '../scripts/collect-baseline.mjs';

function syntheticRealpath(entries) {
  return async candidate => {
    if (Object.hasOwn(entries, candidate)) return entries[candidate];
    const error = new Error('Synthetic path does not exist');
    error.code = 'ENOENT';
    throw error;
  };
}

test('npm CLI discovery honors a valid npm_execpath without a shell', async () => {
  const cli = '/opt/custom/npm/bin/npm-cli.js';
  assert.equal(await discoverNpmCli({ platform: 'linux', nodeExecutable: '/usr/bin/node',
    environment: { npm_execpath: cli, PATH: '/usr/bin' }, realpathFn: syntheticRealpath({ [cli]: cli }) }), cli);
});

test('direct Linux collectors discover NVM and setup-node lib layouts with npm_execpath unset', async () => {
  for (const root of ['/home/runner/.nvm/versions/node/v24.14.0', '/opt/hostedtoolcache/node/24.14.0/x64']) {
    const cli = `${root}/lib/node_modules/npm/bin/npm-cli.js`;
    assert.equal(await discoverNpmCli({ platform: 'linux', nodeExecutable: `${root}/bin/node`,
      environment: {}, realpathFn: syntheticRealpath({ [cli]: cli }) }), cli);
  }
});

test('Linux PATH npm symlinks discover distro CLI layouts instead of assuming a node sibling', async () => {
  const cli = '/usr/share/nodejs/npm/bin/npm-cli.js';
  assert.equal(await discoverNpmCli({ platform: 'linux', nodeExecutable: '/usr/bin/node',
    environment: { npm_execpath: '/stale/npm-cli.js', PATH: '/usr/local/bin:/usr/bin' },
    realpathFn: syntheticRealpath({ '/usr/bin/npm': cli }) }), cli);
});

test('Windows npm.cmd PATH discovers adjacent CLI safely with spaces, quotes and mixed-case Path', async () => {
  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  assert.equal(await discoverNpmCli({ platform: 'win32', nodeExecutable: 'C:\\runtime\\node.exe',
    environment: { Path: 'C:\\other;"C:\\Program Files\\nodejs"' },
    realpathFn: syntheticRealpath({ 'C:\\Program Files\\nodejs\\npm': 'C:\\Program Files\\nodejs\\npm.cmd', [cli]: cli }) }), cli);
});

test('Windows direct collector discovers npm beside node and rejects an npm.cmd-only installation', async () => {
  const cli = 'C:\\runtime\\node_modules\\npm\\bin\\npm-cli.js';
  assert.equal(await discoverNpmCli({ platform: 'win32', nodeExecutable: 'C:\\runtime\\node.exe',
    environment: {}, realpathFn: syntheticRealpath({ [cli]: cli }) }), cli);
  await assert.rejects(() => discoverNpmCli({ platform: 'win32', nodeExecutable: 'C:\\runtime\\node.exe',
    environment: { npm_execpath: 'C:\\tools\\npm.cmd', Path: 'C:\\tools' },
    realpathFn: syntheticRealpath({ 'C:\\tools\\npm.cmd': 'C:\\tools\\npm.cmd', 'C:\\tools\\npm': 'C:\\tools\\npm.cmd' }) }), /Cannot locate npm-cli\.js/);
});

test('baseline parsing preserves missing evidence and the original Node test totals', () => {
  assert.deepEqual(parseNodeSummary('ℹ tests 410\nℹ suites 0\nℹ pass 410\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 1234.5\n'), {
    tests: 410, suites: 0, pass: 410, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 1234.5,
  });
  assert.equal(parseNodeSummary('').tests, null);
  assert.equal(parseCoverage('').line, null);
  assert.equal(parseCoverage('').status, 'UNAVAILABLE');
  const coverage = parseCoverage('ℹ notification-controller.js | 22.58 | 50.00 | 66.67 |\nℹ all files | 89.83 | 76.80 | 92.57 |\n');
  assert.equal(coverage.line, 89.83);
  assert.equal(coverage.modules[0].line, 22.58);
  assert.match(coverage.scope, /unimported modules are not included/);
});

test('baseline timing never claims a stable p95 from three runs', () => {
  assert.deepEqual(timingSummary([{ ms: 3 }, { ms: 1 }, { ms: 2 }, { ms: null }], 'ms'), {
    samples: 3, median: 2, maximum: 3, p95: null, p95Reason: 'Three observations do not support a stable p95 estimate.',
  });
  assert.equal(timingSummary([], 'ms'), null);
});

test('network counters distinguish stable data, batched quotes and cloud writes', () => {
  assert.equal(classifyRequest('http://127.0.0.1:4173/__fundval_dev/estimates?codes=005844'), 'estimateBatch');
  assert.equal(classifyRequest('https://sinan-estimate-push.ligugu69.workers.dev/holdings?code=005844'), 'holdingsSnapshot');
  assert.equal(classifyRequest('https://fund.eastmoney.com/pingzhongdata/005844.js?v=1'), 'officialNav');
  assert.equal(classifyRequest('https://qt.gtimg.cn/q=sz000001&_t=1'), 'securityQuotes');
  assert.equal(classifyRequest('https://qt.gtimg.cn/q=sh000001,usNDX&_t=1'), 'indexQuotes');
  assert.equal(classifyRequest('https://api.github.com/gists/example', 'PATCH'), 'gistWrite');
  assert.equal(classifyRequest('https://unknown.invalid/index.html'), 'otherExternalBlocked');
});
