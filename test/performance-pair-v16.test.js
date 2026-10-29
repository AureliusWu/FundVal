import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as sampler from '../scripts/measure-performance-pair.mjs';
import { artifactFingerprint, balancedOrder, classifyHermeticRequest, median, METRICS, nearestRank, normalizedLock,
  captureRendererSnapshot, installServiceWorkerBlock, parseOptions, RENDERER_COUNTERS, rendererDelta, requestFailureCategory, requestRole,
  summarizePairs, validateOrigin, V15_REFERENCE } from '../scripts/measure-performance-pair.mjs';

function pairs(count = 60, before = 100, after = 110) {
  return balancedOrder(count).map((order, index) => ({ index, order,
    reference: Object.fromEntries(METRICS.map(metric => [metric, typeof before === 'function' ? before(index) : before])),
    current: Object.fromEntries(METRICS.map(metric => [metric, typeof after === 'function' ? after(index) : after])) }));
}
const statistics = { bootstrap: 1000, seed: 160003 };

async function reportFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fundval-report-reservation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'report.json') };
}
async function privilegedOperation(t, operation) {
  try { await operation(); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`Platform denied synthetic link/rename operation: ${error.code}`); return false; }
    throw error;
  }
}

test('report reservation is exclusive before measurement: two concurrent creators cannot overwrite', async t => {
  const fixture = await reportFixture(t);
  const results = await Promise.allSettled([sampler.reserveReportFile(fixture.path), sampler.reserveReportFile(fixture.path)]);
  const successful = results.filter(result => result.status === 'fulfilled');
  try {
    assert.equal(successful.length, 1);
    const failure = results.find(result => result.status === 'rejected');
    assert.equal(failure.reason.code, 'EEXIST');
    assert.equal(await readFile(fixture.path, 'utf8'), '', 'reservation remains empty until final descriptor write');
    if (process.platform !== 'win32') assert.equal((await stat(fixture.path)).mode & 0o777, 0o600);
  } finally { await Promise.all(successful.map(result => result.value.handle.close())); }
});

test('report reservation refuses an existing report without changing its content', async t => {
  const fixture = await reportFixture(t);
  await writeFile(fixture.path, 'existing synthetic evidence');
  await assert.rejects(() => sampler.reserveReportFile(fixture.path), { code: 'EEXIST' });
  await assert.rejects(() => sampler.main(['--output', fixture.path]), { code: 'EEXIST' });
  assert.equal(await readFile(fixture.path, 'utf8'), 'existing synthetic evidence');
});

test('report reservation supports new date directories and missing forbidden directories', async t => {
  const fixture = await reportFixture(t);
  const path = join(fixture.directory, 'new-date', 'nested', 'report.json');
  const reservation = await sampler.reserveReportFile(path, [join(fixture.directory, 'not-built-site')]);
  await sampler.writeReservedReport(reservation, { status: 'INCONCLUSIVE' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { status: 'INCONCLUSIVE' });
  const missingSite = join(fixture.directory, 'another-missing-site');
  await assert.rejects(() => sampler.reserveReportFile(join(missingSite, 'evidence', 'report.json'), [missingSite]), { code: 'REPORT_IN_DEPLOYABLE_SITE' });
  await assert.rejects(() => stat(missingSite), { code: 'ENOENT' });
});

test('report reservation refuses existing file and dangling symlinks without following them', async t => {
  const fixture = await reportFixture(t);
  const target = join(fixture.directory, 'target.json');
  await writeFile(target, 'untouched synthetic target');
  if (!await privilegedOperation(t, () => symlink(target, fixture.path, 'file'))) return;
  await assert.rejects(() => sampler.reserveReportFile(fixture.path), error => ['EEXIST', 'ELOOP'].includes(error.code));
  assert.equal(await readFile(target, 'utf8'), 'untouched synthetic target');
  const dangling = join(fixture.directory, 'dangling.json');
  const missing = join(fixture.directory, 'missing.json');
  if (!await privilegedOperation(t, () => symlink(missing, dangling, 'file'))) return;
  await assert.rejects(() => sampler.reserveReportFile(dangling), error => ['EEXIST', 'ELOOP'].includes(error.code));
  await assert.rejects(() => stat(missing), { code: 'ENOENT' });
});

test('report reservation rejects site aliases before creating output directories', async t => {
  const fixture = await reportFixture(t);
  const site = join(fixture.directory, 'site'), alias = join(fixture.directory, 'site-alias');
  await mkdir(site);
  if (!await privilegedOperation(t, () => symlink(site, alias, process.platform === 'win32' ? 'junction' : 'dir'))) return;
  await assert.rejects(() => sampler.reserveReportFile(join(alias, 'new', 'report.json'), [site]), { code: 'REPORT_IN_DEPLOYABLE_SITE' });
  await assert.rejects(() => stat(join(site, 'new')), { code: 'ENOENT' });
});

test('final report writes only the reserved descriptor and closes it', async t => {
  const fixture = await reportFixture(t);
  const reservation = await sampler.reserveReportFile(fixture.path);
  await sampler.writeReservedReport(reservation, { status: 'INCONCLUSIVE', rawPairs: [] });
  assert.deepEqual(JSON.parse(await readFile(fixture.path, 'utf8')), { status: 'INCONCLUSIVE', rawPairs: [] });
  await assert.rejects(() => reservation.handle.stat(), { code: 'EBADF' });
});

test('pathname replacement cannot redirect descriptor writes and is not reported as a saved path', async t => {
  const fixture = await reportFixture(t);
  const reservation = await sampler.reserveReportFile(fixture.path);
  const held = join(fixture.directory, 'held-reservation.json');
  try {
    if (!await privilegedOperation(t, () => rename(fixture.path, held))) return;
    await writeFile(fixture.path, 'replacement belongs to another synthetic writer');
    await assert.rejects(() => sampler.writeReservedReport(reservation, { status: 'INCONCLUSIVE' }), { code: 'REPORT_PATH_IDENTITY_CHANGED' });
    assert.equal(await readFile(fixture.path, 'utf8'), 'replacement belongs to another synthetic writer');
    assert.deepEqual(JSON.parse(await readFile(held, 'utf8')), { status: 'INCONCLUSIVE' });
    await assert.rejects(() => reservation.handle.stat(), { code: 'EBADF' });
  } finally { await reservation.handle.close(); }
});

test('a replacement symlink cannot redirect final report writes into its target', async t => {
  const fixture = await reportFixture(t);
  const reservation = await sampler.reserveReportFile(fixture.path);
  const held = join(fixture.directory, 'held-reservation.json'), target = join(fixture.directory, 'other.json');
  try {
    if (!await privilegedOperation(t, () => rename(fixture.path, held))) return;
    await writeFile(target, 'untouched replacement link target');
    if (!await privilegedOperation(t, () => symlink(target, fixture.path, 'file'))) return;
    await assert.rejects(() => sampler.writeReservedReport(reservation, { status: 'INCONCLUSIVE' }), { code: 'REPORT_PATH_IDENTITY_CHANGED' });
    assert.equal(await readFile(target, 'utf8'), 'untouched replacement link target');
    assert.deepEqual(JSON.parse(await readFile(held, 'utf8')), { status: 'INCONCLUSIVE' });
  } finally { await reservation.handle.close(); }
});

test('report finalization closes the descriptor even when JSON serialization fails', async () => {
  const report = {}; report.circular = report;
  let closes = 0, writes = 0;
  const handle = { writeFile: async () => { writes += 1; }, close: async () => { closes += 1; } };
  await assert.rejects(() => sampler.writeReservedReport({ handle, path: 'synthetic-only' }, report), { code: 'REPORT_SERIALIZATION_FAILED' });
  assert.equal(closes, 1); assert.equal(writes, 0);
});

test('report finalization closes the descriptor even when descriptor writing fails', async () => {
  let closes = 0, writes = 0;
  const handle = { writeFile: async () => { writes += 1; throw new Error('synthetic private write detail'); }, close: async () => { closes += 1; } };
  await assert.rejects(() => sampler.writeReservedReport({ handle, path: 'synthetic-only' }, { status: 'INCONCLUSIVE' }), { code: 'REPORT_WRITE_FAILED' });
  assert.equal(closes, 1); assert.equal(writes, 1);
});

test('report finalization sanitizes close failures and never claims a saved report', async () => {
  let closes = 0;
  const report = {}; report.circular = report;
  const handle = { close: async () => { closes += 1; throw new Error('synthetic private close detail'); } };
  await assert.rejects(() => sampler.writeReservedReport({ handle, path: 'synthetic-only' }, report), { code: 'REPORT_CLOSE_FAILED' });
  assert.equal(closes, 1);
});

test('main preserves an INCONCLUSIVE setup-failure report before any browser or snapshot starts', async t => {
  const fixture = await reportFixture(t), originalExitCode = process.exitCode;
  try {
    const report = await sampler.main(['--reference', '0'.repeat(40), '--output', fixture.path]);
    assert.equal(process.exitCode, 2);
    assert.equal(report.status, 'INCONCLUSIVE');
    assert.equal(report.failure.stage, 'referenceIdentity');
    assert.deepEqual(report.observed, { retainedCompletePairs: 0, warmupCompletePairs: 0, failedPairs: 0 });
    assert.deepEqual(report.cleanup, []);
    assert.equal(report.lifecycle, undefined);
    assert.equal(report.environment.chromeVersion, undefined);
    assert.deepEqual(JSON.parse(await readFile(fixture.path, 'utf8')), report);
    // Rename is an extra portability check, not a universal proof of fd close;
    // finalizer tests above separately assert EBADF after the exact close path.
    const moved = join(fixture.directory, 'finished-report.json');
    await rename(fixture.path, moved);
    assert.deepEqual(JSON.parse(await readFile(moved, 'utf8')), report);
  } finally { process.exitCode = originalExitCode; }
});

test('nearest-rank p95 uses all 60 raw samples, while an even median averages its middle values', () => {
  const values = Array.from({ length: 60 }, (_, index) => index + 1).reverse();
  assert.equal(nearestRank(values, 0.95), 57);
  assert.equal(nearestRank(values, 1), 60);
  assert.equal(nearestRank(values, 0.01), 1);
  assert.equal(nearestRank([3, 1, 2], 0.95), 3);
  assert.equal(median(values), 30.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([0, 0]), 0);
  assert.equal(values[0], 60, 'statistics must not sort or mutate raw samples in place');
});

test('statistical input validation never filters away missing, negative or nonfinite samples', () => {
  for (const values of [[], null, [null], [undefined], ['1'], [-1], [Infinity], [NaN], [1, null], [1, -1]]) {
    assert.throws(() => median(values), /nonempty array/);
    assert.throws(() => nearestRank(values, 0.95), /nonempty array/);
  }
  for (const quantile of [0, -1, 1.1, NaN, Infinity, '0.95']) assert.throws(() => nearestRank([1], quantile), /Quantile/);
});

test('a balanced plan alternates AB and BA rather than running all reference samples first', () => {
  assert.deepEqual(balancedOrder(4), [['reference', 'current'], ['current', 'reference'], ['reference', 'current'], ['current', 'reference']]);
  const order = balancedOrder(60);
  assert.equal(order.filter(pair => pair[0] === 'reference').length, 30);
  assert.equal(order.filter(pair => pair[0] === 'current').length, 30);
  for (const count of [0, 1, 3, 60.5, NaN, '60']) assert.throws(() => balancedOrder(count), /even integer/);
});

test('deterministic paired bootstrap preserves correlated pairs and reports tight stable confidence', () => {
  const data = pairs(60, index => 100 + index, index => 100 + index);
  const saved = structuredClone(data);
  const a = summarizePairs(data, statistics), b = summarizePairs(data, statistics);
  assert.deepEqual(a, b, 'the recorded bootstrap seed must exactly reproduce inference');
  assert.deepEqual(data, saved, 'no raw pair may be modified or removed');
  assert.equal(a.verdict, 'PASS');
  assert.deepEqual(a.orderCounts, { AB: 30, BA: 30 });
  for (const metric of METRICS) {
    assert.deepEqual(a.metrics[metric].confidenceIntervals95.medianRatio, [1, 1]);
    assert.deepEqual(a.metrics[metric].confidenceIntervals95.p95Ratio, [1, 1]);
    assert.equal(a.metrics[metric].passConfidence, 1);
    assert.equal(a.metrics[metric].p95Stable, true);
    assert.equal(a.metrics[metric].reference.samples, 60);
  }
});

test('a stable +10% increase passes but +16% median and +21% p95 each fail their separate gates', () => {
  const pass = summarizePairs(pairs(), statistics);
  assert.equal(pass.verdict, 'PASS');
  assert.ok(Math.abs(pass.metrics.coldReadyMs.medianDeltaPercent - 10) < 1e-10);
  assert.deepEqual(pass.metrics.coldReadyMs.confidenceIntervals95.p95Ratio, [1.1, 1.1]);
  assert.equal(summarizePairs(pairs(60, 100, 116), statistics).verdict, 'FAIL');
  assert.equal(summarizePairs(pairs(60, 100, 115), statistics).verdict, 'PASS', 'an exactly met median gate is not a regression');
  const tail = pairs(60, 100, 100);
  for (let index = 54; index < 60; index += 1) for (const metric of METRICS) tail[index].current[metric] = 121;
  const result = summarizePairs(tail, statistics);
  assert.equal(result.metrics.saveUiMs.current.median, 100);
  assert.equal(result.metrics.saveUiMs.current.p95, 121);
  // With only six tail samples, bootstrap lower p95 can be 100: point failure
  // alone is not silently promoted into a confident regression or a PASS.
  assert.notEqual(result.verdict, 'PASS');
  assert.equal(summarizePairs(tail, { ...statistics, p95Limit: 1 }).verdict, 'INCONCLUSIVE');
});

test('a single retained absolute-budget breach fails without outlier stripping', () => {
  const data = pairs(); data[59].current.saveUiMs = 3000;
  const result = summarizePairs(data, statistics);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.metrics.saveUiMs.current.maximum, 3000);
  assert.equal(result.metrics.saveUiMs.current.samples, 60);
  assert.equal(result.metrics.coldReadyMs.verdict, 'PASS');
});

test('uncertain tails, insufficient pairs, unbalanced ordering and zero denominators are inconclusive', () => {
  assert.equal(summarizePairs(pairs(4), statistics).verdict, 'INCONCLUSIVE');
  const unbalanced = pairs(); for (const pair of unbalanced) pair.order = ['reference', 'current'];
  const unbalancedResult = summarizePairs(unbalanced, statistics);
  assert.equal(unbalancedResult.verdict, 'INCONCLUSIVE');
  assert.equal(unbalancedResult.balanced, false);
  const zero = summarizePairs(pairs(60, 0, 0), statistics);
  assert.equal(zero.verdict, 'INCONCLUSIVE');
  assert.equal(zero.metrics.coldReadyMs.medianRatio, null);
  assert.equal(zero.metrics.coldReadyMs.passConfidence, null);
  assert.equal(zero.metrics.coldReadyMs.confidenceIntervals95.p95Ratio, null);
  const tail = pairs(60, 100, 100);
  for (const index of [58, 59]) for (const metric of METRICS) tail[index].current[metric] = 1000;
  const uncertain = summarizePairs(tail, statistics);
  assert.equal(uncertain.verdict, 'INCONCLUSIVE');
  assert.equal(uncertain.metrics.saveUiMs.current.p95, 100);
  assert.equal(uncertain.metrics.saveUiMs.current.maximum, 1000);
  assert.equal(uncertain.metrics.saveUiMs.p95Stable, false);
});

test('pair summaries reject incomplete samples and invalid inference configuration', () => {
  assert.throws(() => summarizePairs([], statistics), /complete pair/);
  const missing = pairs(); delete missing[0].current.saveUiMs;
  assert.throws(() => summarizePairs(missing, statistics), /nonempty array/);
  const malformed = pairs(); malformed[0].order = ['reference', 'reference'];
  assert.throws(() => summarizePairs(malformed, statistics), /AB or BA/);
  for (const config of [{ bootstrap: 999 }, { bootstrap: 50001 }, { seed: 0 }, { seed: 2 ** 32 }, { minimumPairs: 1 },
    { medianLimit: NaN }, { p95Limit: 0.9 }, { absoluteBudgetMs: 0 }, { stabilityLimit: Infinity }]) {
    assert.throws(() => summarizePairs(pairs(), { ...statistics, ...config }), /Invalid statistical/);
  }
});

test('CLI defaults require 60 retained pairs and strict balanced option validation', () => {
  const options = parseOptions([]);
  assert.equal(options.reference, V15_REFERENCE);
  assert.equal(options.pairs, 60); assert.equal(options.warmupPairs, 4);
  assert.equal(options.bootstrap, 5000); assert.equal(options.seed, 160003);
  assert.equal(parseOptions(['--pairs', '120', '--warmup-pairs', '0']).pairs, 120);
  for (const args of [['--pairs', '3'], ['--pairs', '61'], ['--pairs', '60.5'], ['--pairs', '1002'], ['--pairs'],
    ['--pairs', '60', '--pairs', '60'], ['--pairs', '6e1'], ['--pairs', '0x3c'], ['--warmup-pairs', '3'], ['--bootstrap', '999'], ['--seed', '0'],
    ['--timeout-ms', '999'], ['--reference', 'main'], ['--unknown', '1'], ['--reference-site', 'site']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('origins must be isolated explicit loopback ports and external mode requires both artifact trees', () => {
  assert.equal(validateOrigin('http://127.0.0.1:49152/'), 'http://127.0.0.1:49152');
  assert.equal(validateOrigin('http://localhost:49153'), 'http://localhost:49153');
  assert.equal(validateOrigin('http://[::1]:49154'), 'http://[::1]:49154');
  for (const origin of ['https://127.0.0.1:49152', 'http://127.0.0.1', 'http://127.0.0.1:4173', 'http://provider.invalid:49152',
    'http://127.0.0.1:1023', 'http://user:secret@127.0.0.1:49152', 'http://127.0.0.1:49152/site', 'http://127.0.0.1:49152/?token=secret', 'http://127.0.0.1:49152/#hash']) {
    assert.throws(() => validateOrigin(origin));
  }
  assert.throws(() => parseOptions(['--reference-origin', 'http://127.0.0.1:49152']), /both origins/);
  assert.throws(() => parseOptions(['--reference-origin', 'http://127.0.0.1:49152', '--current-origin', 'http://127.0.0.1:49153']), /reference-site/);
  assert.throws(() => parseOptions(['--reference-origin', 'http://127.0.0.1:49152', '--current-origin', 'http://127.0.0.1:49152', '--reference-site', 'site']), /different origins/);
  assert.equal(parseOptions(['--reference-origin', 'http://127.0.0.1:49152', '--current-origin', 'http://127.0.0.1:49153', '--reference-site', 'site']).currentOrigin, 'http://127.0.0.1:49153');
});

test('hermetic routing fixtures only approved Worker reads and never sends third-party or Gist traffic', () => {
  const origin = 'http://127.0.0.1:49152';
  assert.equal(classifyHermeticRequest(`${origin}/js/app-shell.js`, origin), 'localStatic');
  assert.equal(classifyHermeticRequest(`${origin}/__fundval_dev/estimates?codes=005844`, origin), 'estimateFixture');
  assert.equal(classifyHermeticRequest(`${origin}/__fundval_dev/estimates?codes=005844`, origin, 'POST'), 'externalOrProxyBlocked');
  assert.equal(classifyHermeticRequest('https://sinan-estimate-push.ligugu69.workers.dev/holdings?code=005844', origin), 'holdingsFixture');
  assert.equal(classifyHermeticRequest('https://unknown.invalid/estimates', origin), 'externalOrProxyBlocked');
  assert.equal(classifyHermeticRequest(`${origin}/__fundval_dev/unapproved`, origin), 'externalOrProxyBlocked');
  assert.equal(classifyHermeticRequest(`${origin}/index.html`, origin, 'POST'), 'externalOrProxyBlocked');
  assert.equal(classifyHermeticRequest('https://fund.eastmoney.com/pingzhongdata/005844.js', origin), 'externalOrProxyBlocked');
  assert.equal(classifyHermeticRequest('https://qt.gtimg.cn/q=sh000001', origin), 'externalOrProxyBlocked');
  assert.equal(classifyHermeticRequest('https://api.github.com/gists/synthetic', origin), 'gistReadBlocked');
  assert.equal(classifyHermeticRequest('https://api.github.com/gists/synthetic', origin, 'PATCH'), 'gistWriteBlocked');
});

test('guarded SW policy rejects registration without calling the native implementation', async () => {
  let nativeCalls = 0;
  const container = { register: () => { nativeCalls += 1; } };
  const top = {}, environment = { navigator: { serviceWorker: container }, window: top, DOMException };
  top.top = top;
  runInNewContext(`(${installServiceWorkerBlock.toString()})();`, environment);
  await assert.rejects(() => container.register('/sw.js'), { name: 'SecurityError' });
  assert.equal(nativeCalls, 0);
  assert.equal(environment.__PAIR_SW_POLICY__.status, 'REGISTRATION_BLOCKED');
  assert.equal(environment.__PAIR_SW_POLICY__.registrationAttempts, 1);
  assert.equal(Object.getOwnPropertyDescriptor(container, 'register').writable, false);
});

test('SW getter guard handles only verified opaque-frame native denial and fails closed otherwise', () => {
  const known = new DOMException("Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.", 'SecurityError');
  const nativeDenied = { get serviceWorker() { throw known; } };
  const opaque = { navigator: nativeDenied, window: { top: {} }, DOMException };
  runInNewContext(`(${installServiceWorkerBlock.toString()})();`, opaque);
  assert.equal(opaque.__PAIR_SW_POLICY__.status, 'OPAQUE_FRAME_NATIVE_DENIAL');
  const top = {}; top.top = top;
  assert.throws(() => runInNewContext(`(${installServiceWorkerBlock.toString()})();`, { navigator: nativeDenied, window: top, DOMException }), { name: 'SecurityError' });
  assert.throws(() => runInNewContext(`(${installServiceWorkerBlock.toString()})();`, { navigator: { get serviceWorker() { throw new Error('unexpected'); } }, window: { top: {} }, DOMException }), /unexpected/);
});

test('request roles and cancellation causality distinguish owned optional teardown from critical failures', () => {
  const origin = 'http://127.0.0.1:49152';
  assert.equal(requestRole(`${origin}/sw.js`, origin, 'script'), 'serviceWorkerScript');
  assert.equal(requestRole(`${origin}/worker-other.js`, origin, 'script', { 'service-worker': 'script' }), 'serviceWorkerScript');
  assert.equal(requestRole(`${origin}/quote-bridge.html`, origin, 'document'), 'optionalQuoteBridge');
  assert.equal(requestRole(`${origin}/js/sandbox/quote-bridge-runtime.js`, origin, 'script'), 'optionalQuoteBridge');
  assert.equal(requestRole(`${origin}/`, origin, 'document'), 'criticalDocument');
  assert.equal(requestRole(`${origin}/js/chunks/app-synthetic.js`, origin, 'script'), 'criticalCode');
  assert.equal(requestRole(`${origin}/data/unknown.json`, origin, 'fetch'), 'otherLocalResource');
  const owned = { transport: 'loopbackHttp', role: 'optionalQuoteBridge', aborted: true, cause: 'ownedContextClose' };
  assert.equal(requestFailureCategory(owned), 'OWNED_OPTIONAL_CANCELLATION');
  assert.equal(requestFailureCategory({ ...owned, cause: 'ownedWarmReload' }), 'OWNED_OPTIONAL_CANCELLATION');
  assert.equal(requestFailureCategory({ ...owned, cause: 'running' }), 'UNEXPECTED_REQUEST_FAILURE');
  assert.equal(requestFailureCategory({ ...owned, aborted: false }), 'UNEXPECTED_REQUEST_FAILURE');
  assert.equal(requestFailureCategory({ ...owned, role: 'criticalCode' }), 'UNEXPECTED_REQUEST_FAILURE');
  assert.equal(requestFailureCategory({ ...owned, role: 'otherLocalResource' }), 'UNEXPECTED_REQUEST_FAILURE');
  assert.equal(requestFailureCategory({ ...owned, transport: 'blocked' }), 'HERMETIC_POLICY_BLOCK');
});

function rendererSnapshot({ loaderId = 'DOC_A', navigationStart = 100, timeOriginMs = 1_000_000, observedAtDocumentMs = 20,
  readyMs = null, timestamp = navigationStart + observedAtDocumentMs / 1000, duration = 0.01 } = {}) {
  return { values: { Timestamp: timestamp, NavigationStart: navigationStart, ...Object.fromEntries(RENDERER_COUNTERS.map(key => [key, duration])) },
    documentTiming: { timeOriginMs, observedAtDocumentMs, readyMs },
    documentEpoch: { frameId: 'MAIN_FRAME', loaderId, navigationStart, timeOriginMs }, invalidReason: null, timeDomain: 'timeTicks' };
}

test('same-document renderer subtraction retains clocks and labels navigation attribution as partial through collection', () => {
  const before = rendererSnapshot(), after = rendererSnapshot({ observedAtDocumentMs: 150, readyMs: 100, duration: 0.03 });
  const saved = structuredClone({ before, after }), result = rendererDelta(before, after);
  assert.equal(result.status, 'PARTIAL');
  for (const key of ['TaskMs', 'ScriptMs', 'LayoutMs', 'RecalcStyleMs']) assert.ok(Math.abs(result[key] - 20) < 1e-10);
  assert.equal(result.coverage.preReadyCoverageMs, 80);
  assert.equal(result.coverage.collectionDocumentMs, 150, 'collection is later than actual ready, not an exact-ready CPU bound');
  assert.match(result.coverage.scope, /post-commit.*partial startup/);
  assert.match(result.coverage.caveat, /not isolated OS CPU or exact ready-boundary CPU/);
  assert.match(result.coverage.caveat, /observation overhead/);
  assert.deepEqual(result.snapshots, saved);
  assert.deepEqual({ before, after }, saved, 'characterization does not mutate raw snapshots');
});

test('changed document epochs are rejected even if every new counter is greater than the old document counter', () => {
  const before = rendererSnapshot();
  for (const change of [{ loaderId: 'DOC_B' }, { navigationStart: 200 }, { timeOriginMs: 2_000_000 }]) {
    for (const duration of [0.005, 0.05]) {
      const after = rendererSnapshot({ ...change, observedAtDocumentMs: 150, readyMs: 100, duration });
      const result = rendererDelta(before, after);
      assert.equal(result.status, 'UNAVAILABLE');
      assert.deepEqual(Object.values(result.invalidReasons), Array(4).fill('DOCUMENT_EPOCH_CHANGED'));
      for (const key of ['TaskMs', 'ScriptMs', 'LayoutMs', 'RecalcStyleMs']) assert.equal(result[key], null);
    }
  }
});

test('missing/reset counters are null, while actual zero counters and same-document save differences remain usable', () => {
  const before = rendererSnapshot({ observedAtDocumentMs: 200, readyMs: 100, duration: 0 });
  const after = rendererSnapshot({ observedAtDocumentMs: 250, readyMs: 100, duration: 0 });
  const zero = rendererDelta(before, after, { phase: 'interaction' });
  assert.equal(zero.status, 'MEASURED'); assert.equal(zero.TaskMs, 0);
  const missing = structuredClone(after); missing.values.ScriptDuration = null;
  const partial = rendererDelta(before, missing, { phase: 'interaction' });
  assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.ScriptMs, null); assert.equal(partial.TaskMs, 0);
  assert.equal(partial.invalidReasons.ScriptMs, 'MISSING_COUNTER');
  const resetBefore = rendererSnapshot(), resetAfter = rendererSnapshot({ observedAtDocumentMs: 150, readyMs: 100, duration: 0.03 });
  resetAfter.values.TaskDuration = 0.001;
  const reset = rendererDelta(resetBefore, resetAfter);
  assert.equal(reset.TaskMs, null); assert.equal(reset.invalidReasons.TaskMs, 'COUNTER_DECREASED_WITHIN_EPOCH');
  assert.ok(reset.ScriptMs > 0);
});

test('renderer attribution refuses clock discontinuity, late baseline and unbounded failure text', () => {
  const before = rendererSnapshot(), after = rendererSnapshot({ observedAtDocumentMs: 150, readyMs: 100, duration: 0.03 });
  const backwards = structuredClone(after); backwards.values.Timestamp = before.values.Timestamp - 0.01;
  assert.equal(rendererDelta(before, backwards).invalidReasons.TaskMs, 'METRIC_CLOCK_DECREASED');
  const late = rendererSnapshot({ observedAtDocumentMs: 100, readyMs: 100 });
  const noCoverage = rendererDelta(late, after);
  assert.equal(noCoverage.status, 'UNAVAILABLE'); assert.equal(noCoverage.TaskMs, null);
  assert.equal(noCoverage.invalidReasons.TaskMs, 'BASELINE_AFTER_READY');
  const invalid = structuredClone(before); invalid.invalidReason = 'PRIVATE_RAW_ERROR_MUST_NOT_BE_PERSISTED';
  const sanitized = rendererDelta(invalid, after);
  assert.equal(sanitized.invalidReasons.TaskMs, 'SNAPSHOT_INVALID');
  assert.equal(JSON.stringify(sanitized).includes('PRIVATE_RAW_ERROR'), false);
  assert.equal(rendererDelta(null, after).invalidReasons.TaskMs, 'MISSING_DOCUMENT_EPOCH');
  assert.throws(() => rendererDelta(before, after, { phase: 'invalid' }), /attribution phase/);
});

test('fake-CDP snapshot characterization preserves only required metrics and frame identity without URL/log data', async () => {
  const calls = [], frame = { id: 'MAIN_FRAME', loaderId: 'DOC_A', url: 'http://private.invalid/?credential=PRIVATE' };
  const cdp = { async send(command) {
    calls.push(command);
    if (command === 'Page.getFrameTree') return { frameTree: { frame } };
    return { metrics: [...Object.entries(rendererSnapshot().values).map(([name, value]) => ({ name, value })), { name: 'PRIVATE_METRIC', value: 123 }] };
  } };
  const page = { async evaluate() { return { timeOriginMs: 1_000_000, observedAtDocumentMs: 20, readyMs: null }; } };
  const result = await captureRendererSnapshot(cdp, page);
  assert.deepEqual(calls, ['Page.getFrameTree', 'Performance.getMetrics', 'Page.getFrameTree']);
  assert.equal(result.invalidReason, null);
  assert.deepEqual(Object.keys(result.values), ['Timestamp', 'NavigationStart', ...RENDERER_COUNTERS]);
  assert.equal(result.documentEpoch.loaderId, 'DOC_A');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(calls.some(command => /Performance\.(?:disable|enable)/.test(command)), false, 'disable/enable is not assumed to reset counters');
});

test('fake-CDP snapshot fails closed on racing navigation, missing clocks or RPC failure; no real warm acceptance is claimed', async () => {
  const page = { async evaluate() { return { timeOriginMs: 1_000_000, observedAtDocumentMs: 20, readyMs: null }; } };
  const fake = ({ changeFrame = false, missingTimestamp = false } = {}) => {
    let frameReads = 0;
    return { async send(command) {
      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN_FRAME', loaderId: changeFrame && ++frameReads > 1 ? 'DOC_B' : 'DOC_A' } } };
      return { metrics: Object.entries(rendererSnapshot().values).filter(([name]) => !missingTimestamp || name !== 'Timestamp').map(([name, value]) => ({ name, value })) };
    } };
  };
  assert.equal((await captureRendererSnapshot(fake({ changeFrame: true }), page)).invalidReason, 'DOCUMENT_CHANGED_DURING_SNAPSHOT');
  assert.equal((await captureRendererSnapshot(fake({ missingTimestamp: true }), page)).invalidReason, 'MISSING_METRIC_CLOCK');
  const failed = await captureRendererSnapshot({ async send() { throw new Error('PRIVATE_RPC_ERROR'); } }, page);
  assert.equal(failed.invalidReason, 'SNAPSHOT_CAPTURE_FAILED');
  assert.equal(failed.values.TaskDuration, null);
  assert.equal(JSON.stringify(failed).includes('PRIVATE_RPC_ERROR'), false);
});

test('lock equality ignores only M0 root engine metadata and retains resolved package changes', () => {
  const original = { lockfileVersion: 3, packages: { '': { name: 'synthetic', dependencies: { tool: '1.0.0' } }, 'node_modules/tool': { version: '1.0.0', integrity: 'synthetic' } } };
  const pinned = structuredClone(original); pinned.packages[''].engines = { node: '24.14.0', npm: '11.9.0' };
  assert.equal(normalizedLock(JSON.stringify(original)), normalizedLock(JSON.stringify(pinned)));
  pinned.packages['node_modules/tool'].version = '1.0.1';
  assert.notEqual(normalizedLock(JSON.stringify(original)), normalizedLock(JSON.stringify(pinned)));
  const transitiveEngine = structuredClone(original); transitiveEngine.packages['node_modules/tool'].engines = { node: '>=25' };
  assert.notEqual(normalizedLock(JSON.stringify(original)), normalizedLock(JSON.stringify(transitiveEngine)));
  assert.throws(() => normalizedLock('not-json'));
});

test('artifact fingerprints are deterministic, include every raw file and reject linked data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fundval-performance-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = join(root, 'site'); await mkdir(join(site, 'js'), { recursive: true });
  await writeFile(join(site, 'index.html'), '<html>synthetic</html>');
  await writeFile(join(site, 'js', 'app-shell.js'), '// synthetic');
  const a = await artifactFingerprint(site), b = await artifactFingerprint(site);
  assert.deepEqual(a, b); assert.equal(a.fileCount, 2); assert.match(a.sha256, /^[a-f0-9]{64}$/);
  await writeFile(join(site, 'js', 'app-shell.js'), '// changed synthetic');
  assert.notEqual((await artifactFingerprint(site)).sha256, a.sha256);
  const linked = join(site, 'external');
  await symlink(join(root, 'site', 'js'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => artifactFingerprint(site), /without links/);
  await rm(linked);
});
