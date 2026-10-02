import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configureSnapshotTransport, createSourceSnapshot, safeRemoveSnapshot } from './collect-baseline.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const V15_REFERENCE = '40e68edab9cb3fba0b17338dc3672a82d13ad17e';
export const METRICS = Object.freeze(['coldReadyMs', 'warmReadyMs', 'saveUiMs']);
const WORKER_HOST = 'sinan-estimate-push.ligugu69.workers.dev';
const FIXED_TIME = '2026-08-28T06:45:10.000Z';
const FUND = Object.freeze({ code: '005844', name: 'E2E 测试基金', shares: '100', cost: '1.2' });
const sha256 = value => createHash('sha256').update(value).digest('hex');

function finiteValues(values) {
  if (!Array.isArray(values) || !values.length || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('Timings must be a nonempty array of finite nonnegative numbers; no sample may be silently removed.');
  }
  return [...values].sort((a, b) => a - b);
}

export function nearestRank(values, quantile) {
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) throw new RangeError('Quantile must be in (0, 1].');
  const sorted = finiteValues(values);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

export function median(values) {
  const sorted = finiteValues(values), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function balancedOrder(pairs) {
  if (!Number.isInteger(pairs) || pairs < 2 || pairs % 2) throw new RangeError('Pair count must be a positive even integer of at least 2.');
  return Array.from({ length: pairs }, (_, index) => index % 2 ? ['current', 'reference'] : ['reference', 'current']);
}

export function normalizedLock(bytes) {
  const lock = JSON.parse(String(bytes));
  // M0 pinned root Node/npm engines without changing the resolved dependency graph.
  if (lock.packages?.['']) delete lock.packages[''].engines;
  return JSON.stringify(lock);
}

export function validateOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port
    || Number(url.port) < 1024 || Number(url.port) > 65535 || Number(url.port) === 4173) {
    throw new Error('Origin must be an explicit loopback HTTP port (not existing user port 4173), without credentials or paths.');
  }
  return url.origin;
}

export function classifyHermeticRequest(value, origin, method = 'GET') {
  const url = new URL(value), workerPath = url.pathname.replace(/^\/__fundval_dev/, '');
  if (url.hostname === 'api.github.com') return ['GET', 'HEAD'].includes(method) ? 'gistReadBlocked' : 'gistWriteBlocked';
  if (['GET', 'HEAD'].includes(method) && (url.hostname === WORKER_HOST || url.origin === origin) && workerPath === '/estimates') return 'estimateFixture';
  if (['GET', 'HEAD'].includes(method) && (url.hostname === WORKER_HOST || url.origin === origin) && workerPath === '/holdings') return 'holdingsFixture';
  if (url.origin === origin && !url.pathname.startsWith('/__fundval_dev/') && ['GET', 'HEAD'].includes(method)) return 'localStatic';
  return 'externalOrProxyBlocked';
}

export function requestRole(value, origin, resourceType, headers = {}) {
  const url = new URL(value);
  if (headers['service-worker'] === 'script' || /(?:^|\/)sw\.js$/.test(url.pathname)) return 'serviceWorkerScript';
  if (url.origin !== origin) return 'external';
  if (url.pathname === '/quote-bridge.html' || url.pathname === '/js/sandbox/quote-bridge-runtime.js') return 'optionalQuoteBridge';
  if (resourceType === 'document') return 'criticalDocument';
  if (['script', 'stylesheet'].includes(resourceType)) return 'criticalCode';
  return 'otherLocalResource';
}

export function requestFailureCategory({ transport, role, cause, aborted }) {
  if (transport === 'blocked') return 'HERMETIC_POLICY_BLOCK';
  if (role === 'optionalQuoteBridge' && aborted && ['ownedWarmReload', 'ownedContextClose'].includes(cause)) return 'OWNED_OPTIONAL_CANCELLATION';
  return 'UNEXPECTED_REQUEST_FAILURE';
}

export function installServiceWorkerBlock() {
  // Playwright 1.62.1's built-in block probes navigator.serviceWorker in opaque
  // sandbox frames without a guard. Keep equivalent registration denial while
  // avoiding that harness-created SecurityError; app exceptions remain visible.
  const policy = globalThis.__PAIR_SW_POLICY__ = { status: 'UNAVAILABLE', registrationAttempts: 0 };
  let container;
  try { container = navigator.serviceWorker; }
  catch (error) {
    if (window !== window.top && error?.name === 'SecurityError' && /serviceWorker/.test(String(error.message))
      && /sandbox/.test(String(error.message)) && /allow-same-origin/.test(String(error.message))) {
      policy.status = 'OPAQUE_FRAME_NATIVE_DENIAL'; return;
    }
    throw error;
  }
  if (!container) return;
  Object.defineProperty(container, 'register', { configurable: false, writable: false, value: async () => {
    policy.registrationAttempts += 1;
    throw new DOMException('Service Worker registration blocked by performance sampler', 'SecurityError');
  } });
  policy.status = 'REGISTRATION_BLOCKED';
}

export function parseOptions(args) {
  const options = { pairs: 60, warmupPairs: 4, bootstrap: 5000, seed: 160003, timeoutMs: 30_000,
    reference: V15_REFERENCE, currentSite: resolve(repository, 'site'), referenceOrigin: null, currentOrigin: null,
    referenceSite: null, output: null, help: false };
  const names = { '--pairs': 'pairs', '--warmup-pairs': 'warmupPairs', '--bootstrap': 'bootstrap', '--seed': 'seed',
    '--timeout-ms': 'timeoutMs', '--reference': 'reference', '--current-site': 'currentSite',
    '--reference-site': 'referenceSite', '--reference-origin': 'referenceOrigin', '--current-origin': 'currentOrigin', '--output': 'output' };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === '--help') { options.help = true; continue; }
    if (!names[name] || seen.has(name) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid, duplicate or missing option: ${name}`);
    seen.add(name);
    const key = names[name], raw = args[++index];
    if (['pairs', 'warmupPairs', 'bootstrap', 'seed', 'timeoutMs'].includes(key) && !/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error(`${name} requires a decimal integer.`);
    options[key] = ['pairs', 'warmupPairs', 'bootstrap', 'seed', 'timeoutMs'].includes(key) ? Number(raw) : raw;
  }
  if (!Number.isInteger(options.pairs) || options.pairs < 60 || options.pairs > 1000 || options.pairs % 2) throw new Error('--pairs must be even, between 60 and 1000.');
  if (!Number.isInteger(options.warmupPairs) || options.warmupPairs < 0 || options.warmupPairs > 20 || options.warmupPairs % 2) throw new Error('--warmup-pairs must be even, between 0 and 20.');
  if (!Number.isInteger(options.bootstrap) || options.bootstrap < 1000 || options.bootstrap > 50_000) throw new Error('--bootstrap must be between 1000 and 50000.');
  if (!Number.isInteger(options.seed) || options.seed < 1 || options.seed > 0xffffffff) throw new Error('--seed must be a nonzero unsigned 32-bit integer.');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 120_000) throw new Error('--timeout-ms must be between 1000 and 120000.');
  if (!/^[a-f\d]{40}$/.test(options.reference)) throw new Error('--reference must be an immutable full 40-character commit SHA.');
  if (Boolean(options.referenceOrigin) !== Boolean(options.currentOrigin)) throw new Error('Supply both origins or neither.');
  if (options.referenceOrigin) {
    options.referenceOrigin = validateOrigin(options.referenceOrigin); options.currentOrigin = validateOrigin(options.currentOrigin);
    if (options.referenceOrigin === options.currentOrigin || !options.referenceSite) throw new Error('External mode requires different origins and --reference-site for artifact verification.');
  } else if (options.referenceSite) throw new Error('--reference-site requires both externally managed origins.');
  for (const key of ['currentSite', 'referenceSite', 'output']) if (options[key]) options[key] = resolve(repository, options[key]);
  return options;
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
}

function range(values) { return [nearestRank(values, 0.025), nearestRank(values, 0.975)]; }
function timingDescription(values) { return { samples: values.length, median: median(values), p95: nearestRank(values, 0.95), maximum: Math.max(...values) }; }

export function summarizePairs(pairs, { bootstrap = 5000, seed = 160003, minimumPairs = 60,
  medianLimit = 1.15, p95Limit = 1.20, absoluteBudgetMs = 3000, stabilityLimit = 0.20 } = {}) {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('At least one complete pair is required.');
  if (!Number.isInteger(bootstrap) || bootstrap < 1000 || bootstrap > 50_000 || !Number.isInteger(seed) || seed < 1 || seed > 0xffffffff
    || !Number.isInteger(minimumPairs) || minimumPairs < 2 || !Number.isFinite(medianLimit) || medianLimit < 1
    || !Number.isFinite(p95Limit) || p95Limit < 1 || !Number.isFinite(absoluteBudgetMs) || absoluteBudgetMs <= 0
    || !Number.isFinite(stabilityLimit) || stabilityLimit <= 0) throw new Error('Invalid statistical configuration.');
  const strata = [[], []];
  for (const [index, pair] of pairs.entries()) {
    if (!pair || !Array.isArray(pair.order) || pair.order.length !== 2 || !['reference,current', 'current,reference'].includes(pair.order.join(','))) throw new Error('Every complete pair must identify AB or BA order.');
    strata[pair.order[0] === 'reference' ? 0 : 1].push(index);
    for (const side of ['reference', 'current']) for (const metric of METRICS) finiteValues([pair[side]?.[metric]]);
  }
  const balanced = strata[0].length === strata[1].length && strata.every(stratum => stratum.length > 0);
  const metrics = {}, random = randomGenerator(seed);
  const draws = Array.from({ length: bootstrap }, () => strata.flatMap(stratum => stratum.map(() => stratum[Math.floor(random() * stratum.length)])));
  for (const metric of METRICS) {
    const before = pairs.map(pair => pair.reference[metric]), after = pairs.map(pair => pair.current[metric]);
    const reference = timingDescription(before), current = timingDescription(after);
    const point = { medianRatio: reference.median > 0 ? current.median / reference.median : null, p95Ratio: reference.p95 > 0 ? current.p95 / reference.p95 : null };
    const resampled = draws.map(indices => {
      const a = indices.map(index => before[index]), b = indices.map(index => after[index]);
      const aMedian = median(a), aP95 = nearestRank(a, 0.95), bMedian = median(b), bP95 = nearestRank(b, 0.95);
      return { medianRatio: aMedian > 0 ? bMedian / aMedian : null, p95Ratio: aP95 > 0 ? bP95 / aP95 : null, referenceP95Ms: aP95, currentP95Ms: bP95 };
    });
    const zeroDenominator = resampled.some(row => row.medianRatio === null || row.p95Ratio === null);
    const intervals = Object.fromEntries(['medianRatio', 'p95Ratio', 'referenceP95Ms', 'currentP95Ms'].map(key => [key,
      zeroDenominator && key.endsWith('Ratio') ? null : range(resampled.map(row => row[key]))]));
    const p95Width = side => {
      const bounds = intervals[`${side}P95Ms`], value = side === 'reference' ? reference.p95 : current.p95;
      return value > 0 ? (bounds[1] - bounds[0]) / value : null;
    };
    const widths = { reference: p95Width('reference'), current: p95Width('current') };
    const stable = Object.values(widths).every(width => width !== null && width <= stabilityLimit);
    const passConfidence = zeroDenominator ? null : resampled.filter(row => row.medianRatio <= medianLimit && row.p95Ratio <= p95Limit && row.currentP95Ms < absoluteBudgetMs).length / bootstrap;
    const reasons = [];
    let verdict = 'INCONCLUSIVE';
    if (current.maximum >= absoluteBudgetMs) { verdict = 'FAIL'; reasons.push('At least one retained current critical-path sample met or exceeded the absolute budget.'); }
    else if (pairs.length < minimumPairs || !balanced || zeroDenominator) {
      if (pairs.length < minimumPairs) reasons.push('Too few retained complete pairs.');
      if (!balanced) reasons.push('AB/BA pair counts are not balanced.');
      if (zeroDenominator) reasons.push('A zero reference timing prevents finite relative confidence bounds.');
    } else if (intervals.medianRatio[0] > medianLimit || intervals.p95Ratio[0] > p95Limit) {
      verdict = 'FAIL'; reasons.push('The lower 95% bootstrap bound exceeds a relative regression limit.');
    } else if (stable && intervals.medianRatio[1] <= medianLimit && intervals.p95Ratio[1] <= p95Limit
      && intervals.currentP95Ms[1] < absoluteBudgetMs && passConfidence >= 0.95) {
      verdict = 'PASS'; reasons.push('Both upper 95% relative bounds meet the limits, with stable p95 intervals and at least 95% bootstrap pass confidence.');
    } else {
      if (!stable) reasons.push('A p95 confidence interval is wider than the declared stability limit.');
      reasons.push('Confidence bounds do not establish a stable pass or a confident relative regression.');
    }
    metrics[metric] = { reference, current, ...point, medianDeltaPercent: point.medianRatio === null ? null : (point.medianRatio - 1) * 100,
      p95DeltaPercent: point.p95Ratio === null ? null : (point.p95Ratio - 1) * 100, confidenceIntervals95: intervals,
      p95RelativeIntervalWidth: widths, p95Stable: stable, passConfidence, verdict, reasons,
      orderEffect: Object.fromEntries(strata.map((stratum, index) => [index === 0 ? 'AB' : 'BA', stratum.length ? {
        pairs: stratum.length, referenceMedian: median(stratum.map(row => before[row])), currentMedian: median(stratum.map(row => after[row])),
      } : null])) };
  }
  const verdicts = Object.values(metrics).map(metric => metric.verdict);
  return { verdict: verdicts.includes('FAIL') ? 'FAIL' : verdicts.every(value => value === 'PASS') ? 'PASS' : 'INCONCLUSIVE',
    retainedPairs: pairs.length, balanced, orderCounts: { AB: strata[0].length, BA: strata[1].length }, metrics,
    method: { p95: 'nearest rank: sorted[ceil(0.95 * n) - 1]', median: 'arithmetic mean of the middle two values for even n',
      uncertainty: '95% percentile bootstrap, resampling whole pairs within AB/BA strata; deterministic PRNG seed; all retained samples included',
      bootstrap, seed, minimumPairs, medianLimit, p95Limit, absoluteBudgetMs, stabilityLimit,
      confidenceCaveat: 'Bootstrap pass confidence is the fraction of resamples meeting the gate, not a probability that the population passes. Small tail counts and desktop scheduling limit inference.' } };
}

async function run(file, args, { cwd = repository, env = {}, timeoutMs = 180_000 } = {}) {
  return new Promise((done, failed) => {
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0, overflow = false;
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 20_000_000) chunks.push(chunk); else { overflow = true; child.kill(); } });
    // Deliberately drain, but do not persist, subprocess error/log output.
    child.stderr.on('data', () => {});
    const deadline = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', error => { clearTimeout(deadline); failed(error); });
    child.once('close', code => { clearTimeout(deadline); code === 0 && !overflow ? done(Buffer.concat(chunks)) : failed(new Error('A scoped subprocess failed; command output was not persisted to protect credentials.')); });
  });
}
async function git(args) { return (await run('git', args)).toString('utf8').trim(); }
async function sourceIdentity() {
  const head = await git(['rev-parse', 'HEAD']);
  const diff = await run('git', ['diff', '--binary', 'HEAD', '--']);
  const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard', '-z'])).toString('utf8').split('\0')
    .filter(path => /^(?:js\/|css\/|data\/|scripts\/|assets\/|[^/]+\.(?:html|json))/.test(path)).sort();
  const untrackedHashes = [];
  for (const path of untracked) untrackedHashes.push(`${path}\0${sha256(await readFile(resolve(repository, path)))}`);
  return { head, trackedDiffSha256: sha256(diff), buildRelevantUntrackedSha256: sha256(untrackedHashes.join('\n')),
    dirty: diff.length > 0 || untracked.length > 0, label: 'Current working-tree candidate; HEAD is not an immutable identity for uncommitted changes.' };
}

export async function artifactFingerprint(directory) {
  const root = await realpath(directory), files = [];
  async function walk(prefix = '') {
    for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of createReadStream(resolve(root, path))) { hash.update(chunk); bytes += chunk.length; }
        files.push({ path, bytes, sha256: hash.digest('hex') });
      } else throw new Error('Artifact fingerprints require regular files, without links to external data.');
    }
  }
  await walk(); files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!files.some(file => file.path === 'index.html') || !files.some(file => file.path === 'js/app-shell.js')) throw new Error('Expected an already-built FundVal site with index.html and js/app-shell.js.');
  return { sha256: sha256(files.map(file => `${file.path}\0${file.sha256}\n`).join('')), files, fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

async function dependencyIdentity(reference) {
  const referenceLock = await run('git', ['show', `${reference}:package-lock.json`]), currentLock = await readFile(resolve(repository, 'package-lock.json'));
  if (normalizedLock(referenceLock) !== normalizedLock(currentLock)) throw new Error('Resolved dependency locks differ; identical dependencies are required.');
  const before = JSON.parse(await run('git', ['show', `${reference}:package.json`])), current = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8'));
  const declared = value => ({ ...value.dependencies, ...value.devDependencies });
  if (JSON.stringify(declared(before)) !== JSON.stringify(declared(current))) throw new Error('Declared dependencies differ between reference and current.');
  const installed = {};
  for (const [name, version] of Object.entries(declared(current))) {
    const actual = JSON.parse(await readFile(resolve(repository, 'node_modules', name, 'package.json'), 'utf8')).version;
    if (actual !== version) throw new Error(`Installed package differs from pinned dependency: ${name}`);
    installed[name] = actual;
  }
  if (current.engines?.node && process.versions.node !== current.engines.node) throw new Error('Use the repository-pinned Node version for performance comparison.');
  return { referenceRawLockSha256: sha256(referenceLock), currentRawLockSha256: sha256(currentLock), resolvedLockSha256: sha256(normalizedLock(currentLock)),
    normalization: 'Only packages[\'\'].engines is omitted; resolved packages and all other lock fields must be equal.', installed, node: process.version };
}

async function allocatePort(excluded = []) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((done, failed) => {
      const server = createServer(); server.once('error', failed);
      server.listen(0, '127.0.0.1', () => { const selected = server.address().port; server.close(() => done(selected)); });
    });
    if (port !== 4173 && !excluded.includes(port)) return port;
  }
  throw new Error('Cannot allocate an isolated loopback port.');
}

async function verifyTransport(origin, fingerprint, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  const expected = fingerprint.files.find(file => file.path === 'index.html').sha256;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error('Owned server exited before verification.');
    try {
      const response = await fetch(`${origin}/`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
      if (response.status !== 200 || !/\bno-store\b/i.test(response.headers.get('cache-control') || '') || sha256(Buffer.from(await response.arrayBuffer())) !== expected) {
        throw Object.assign(new Error('Served index does not match the supplied no-store artifact.'), { code: 'ARTIFACT_MISMATCH' });
      }
      // An identical HTML entry alone does not prove that a server is serving
      // the paired build's shell/chunks. Verify the entire startup graph too.
      for (const file of fingerprint.files.filter(file => /^(?:js\/(?:app-shell\.js|app-chunks\.json|chunks\/)|css\/)/.test(file.path))) {
        const resource = await fetch(`${origin}/${file.path}`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
        if (resource.status !== 200 || !/\bno-store\b/i.test(resource.headers.get('cache-control') || '') || sha256(Buffer.from(await resource.arrayBuffer())) !== file.sha256) {
          throw Object.assign(new Error('Served startup resource does not match supplied artifact.'), { code: 'ARTIFACT_MISMATCH' });
        }
      }
      return;
    } catch (error) { if (error.code === 'ARTIFACT_MISMATCH') throw error; }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Isolated server readiness deadline exceeded.');
}

function installBrowserObserver({ time }) {
  if (window !== window.top) return;
  const NativeDate = Date, fixed = NativeDate.parse(time);
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [Math.floor(fixed + performance.now())])); }
    static now() { return Math.floor(fixed + performance.now()); }
  };
  const state = window.__PAIR_PERFORMANCE__ = { readyMs: null, longTasks: [], lcpMs: null, save: null,
    longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
  if (state.longTaskSupported) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
  }).observe({ type: 'longtask', buffered: true });
  if (PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint')) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.lcpMs = entry.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  const observer = new MutationObserver(() => {
    if (document.documentElement?.dataset.appReady === 'true' && state.readyMs === null) {
      state.readyMs = performance.now(); observer.disconnect();
    }
  });
  observer.observe(document, { attributes: true, subtree: true, attributeFilter: ['data-app-ready'] });
}

export const RENDERER_COUNTERS = Object.freeze(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']);
const SNAPSHOT_REASONS = new Set(['MISSING_DOCUMENT_EPOCH', 'DOCUMENT_CHANGED_DURING_SNAPSHOT', 'MISSING_DOCUMENT_CLOCK',
  'MISSING_METRIC_CLOCK', 'METRIC_CLOCK_PRECEDES_NAVIGATION', 'SNAPSHOT_CAPTURE_FAILED', 'SNAPSHOT_INVALID']);
const safeSnapshotReason = value => value == null ? null : SNAPSHOT_REASONS.has(value) ? value : 'SNAPSHOT_INVALID';

function frameIdentity(response) {
  const frame = response?.frameTree?.frame;
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  return frame && valid(frame.id) && valid(frame.loaderId) ? { frameId: frame.id, loaderId: frame.loaderId } : null;
}

export async function captureRendererSnapshot(cdp, page) {
  // Timestamp is a monotonic clock, not a document/counter epoch. Bracket the
  // allowlisted metrics with main-frame loader identity; never persist frame URLs.
  try {
    const first = frameIdentity(await cdp.send('Page.getFrameTree'));
    const raw = await cdp.send('Performance.getMetrics');
    const names = ['Timestamp', 'NavigationStart', ...RENDERER_COUNTERS];
    const values = Object.fromEntries(names.map(name => {
      const value = raw.metrics?.find(metric => metric.name === name)?.value;
      return [name, Number.isFinite(value) && value >= 0 ? value : null];
    }));
    const documentTiming = await page.evaluate(() => ({ timeOriginMs: performance.timeOrigin,
      observedAtDocumentMs: performance.now(), readyMs: Number.isFinite(window.__PAIR_PERFORMANCE__?.readyMs) ? window.__PAIR_PERFORMANCE__.readyMs : null }));
    const last = frameIdentity(await cdp.send('Page.getFrameTree'));
    const invalidReason = !first || !last ? 'MISSING_DOCUMENT_EPOCH'
      : first.frameId !== last.frameId || first.loaderId !== last.loaderId ? 'DOCUMENT_CHANGED_DURING_SNAPSHOT'
      : !Number.isFinite(documentTiming.timeOriginMs) || documentTiming.timeOriginMs <= 0 || !Number.isFinite(documentTiming.observedAtDocumentMs) || documentTiming.observedAtDocumentMs < 0 ? 'MISSING_DOCUMENT_CLOCK'
      : values.Timestamp === null || values.NavigationStart === null ? 'MISSING_METRIC_CLOCK'
      : values.Timestamp < values.NavigationStart ? 'METRIC_CLOCK_PRECEDES_NAVIGATION' : null;
    return { values, documentTiming, documentEpoch: first ? { ...first, navigationStart: values.NavigationStart, timeOriginMs: documentTiming.timeOriginMs } : null,
      invalidReason, timeDomain: 'timeTicks' };
  } catch (_) {
    return { values: Object.fromEntries(['Timestamp', 'NavigationStart', ...RENDERER_COUNTERS].map(name => [name, null])), documentTiming: null,
      documentEpoch: null, invalidReason: 'SNAPSHOT_CAPTURE_FAILED', timeDomain: 'timeTicks' };
  }
}

export function rendererDelta(before, after, { phase = 'navigation' } = {}) {
  if (!['navigation', 'interaction'].includes(phase)) throw new Error('Invalid renderer attribution phase.');
  const a = before?.values || {}, b = after?.values || {}, first = before?.documentEpoch, last = after?.documentEpoch;
  const valid = value => Number.isFinite(value) && value >= 0;
  const epochKeys = ['frameId', 'loaderId', 'navigationStart', 'timeOriginMs'];
  const validEpoch = epoch => epoch && typeof epoch.frameId === 'string' && typeof epoch.loaderId === 'string'
    && epoch.frameId.length > 0 && epoch.loaderId.length > 0 && valid(epoch.navigationStart) && Number.isFinite(epoch.timeOriginMs) && epoch.timeOriginMs > 0;
  const baselineMs = before?.documentTiming?.observedAtDocumentMs, collectedMs = after?.documentTiming?.observedAtDocumentMs, readyMs = after?.documentTiming?.readyMs;
  let reason = safeSnapshotReason(before?.invalidReason) || safeSnapshotReason(after?.invalidReason);
  if (!reason && (!validEpoch(first) || !validEpoch(last))) reason = 'MISSING_DOCUMENT_EPOCH';
  if (!reason && epochKeys.some(key => first[key] !== last[key])) reason = 'DOCUMENT_EPOCH_CHANGED';
  if (!reason && (!valid(a.Timestamp) || !valid(b.Timestamp))) reason = 'MISSING_METRIC_CLOCK';
  if (!reason && b.Timestamp < a.Timestamp) reason = 'METRIC_CLOCK_DECREASED';
  if (!reason && (!valid(baselineMs) || !valid(collectedMs) || collectedMs < baselineMs)) reason = 'DOCUMENT_CLOCK_INVALID';
  if (!reason && phase === 'navigation' && !valid(readyMs)) reason = 'MISSING_READY_BOUNDARY';
  if (!reason && phase === 'navigation' && baselineMs >= readyMs) reason = 'BASELINE_AFTER_READY';
  const invalidReasons = {}, counters = {};
  for (const key of RENDERER_COUNTERS) {
    const label = key.replace('Duration', 'Ms');
    const invalid = reason || (!valid(a[key]) || !valid(b[key]) ? 'MISSING_COUNTER'
      : b[key] < a[key] ? 'COUNTER_DECREASED_WITHIN_EPOCH' : null);
    counters[label] = invalid ? null : (b[key] - a[key]) * 1000;
    if (invalid) invalidReasons[label] = invalid;
  }
  return { ...counters, status: Object.keys(invalidReasons).length === RENDERER_COUNTERS.length ? 'UNAVAILABLE'
    : phase === 'navigation' || Object.keys(invalidReasons).length ? 'PARTIAL' : 'MEASURED', invalidReasons,
    coverage: { scope: phase === 'navigation' ? 'same-document post-commit baseline through readiness collection; partial startup attribution'
      : 'same-document pre-click baseline through result collection', baselineDocumentMs: valid(baselineMs) ? baselineMs : null,
      readyDocumentMs: valid(readyMs) ? readyMs : null, collectionDocumentMs: valid(collectedMs) ? collectedMs : null,
      preReadyCoverageMs: !reason && phase === 'navigation' ? readyMs - baselineMs : null,
      metricClockIntervalMs: !reason ? (b.Timestamp - a.Timestamp) * 1000 : null,
      caveat: 'Default timeTicks activity durations, not isolated OS CPU or exact ready-boundary CPU; includes inspected-renderer and collection/harness work. Post-commit snapshot RPCs add observation overhead. Missing or cross-epoch counters remain null.' },
    snapshots: { before: before ? { ...before, invalidReason: safeSnapshotReason(before.invalidReason) } : null,
      after: after ? { ...after, invalidReason: safeSnapshotReason(after.invalidReason) } : null } };
}

export async function measureSide(browser, origin, timeoutMs) {
  // 'allow' avoids the unguarded Playwright probe. Registration itself is denied
  // by our guarded init script; SW script requests and actual workers fail closed.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  let phase = 'cold', pageErrors = 0, consoleErrors = 0;
  let lifecycle = 'running', lastActivityMs = performance.now(), serviceWorkerEvents = 0;
  let observation = null;
  const requests = [], pendingRecords = new Set(), inflight = new Set(), drains = [];
  const recorders = new WeakMap(), requestRows = new WeakMap();
  const networkInstrumentation = { failures: 0 };
  const pageErrorCategories = {};
  try {
    await context.addInitScript(installServiceWorkerBlock);
    await context.addInitScript(installBrowserObserver, { time: FIXED_TIME });
    context.on('serviceworker', () => { serviceWorkerEvents += 1; });
    context.on('request', request => {
      const category = classifyHermeticRequest(request.url(), origin, request.method());
      const role = requestRole(request.url(), origin, request.resourceType(), request.headers());
      const row = { index: requests.length, phase, category, role, method: request.method(),
        transport: role === 'serviceWorkerScript' ? 'blocked' : category === 'localStatic' ? 'loopbackHttp' : category.endsWith('Fixture') ? 'syntheticIntercept' : 'blocked',
        status: null, failure: null, timing: null, sizes: null, lifecycleCause: null, lifecycleAtStart: lifecycle };
      requests.push(row);
      requestRows.set(request, row);
      inflight.add(request); lastActivityMs = performance.now();
      const done = async failed => {
        inflight.delete(request); lastActivityMs = performance.now();
        if (failed) {
          row.failure = 'request_failed'; row.lifecycleCause = lifecycle;
          const aborted = /(?:net::)?ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(request.failure()?.errorText || '');
          row.instrumentation = requestFailureCategory({ transport: row.transport, role, cause: lifecycle, aborted });
          if (row.instrumentation === 'UNEXPECTED_REQUEST_FAILURE') networkInstrumentation.failures += 1;
          // A failed/aborted request has no response body: do not ask Playwright
          // for its sizes after reload/teardown and mistake cancellation for CPU.
          return;
        }
        try {
          const response = await request.response();
          row.status = response?.status() ?? null; row.failure = request.failure() ? 'request_failed' : null;
          const timing = request.timing();
          row.timing = Object.fromEntries(Object.entries(timing).filter(([key, value]) => key !== 'startTime' && Number.isFinite(value)).map(([key, value]) => [key, value < 0 ? null : value]));
          // Aborted providers have no response bytes by design, not zero bytes.
          row.sizes = row.transport === 'blocked' ? null : await request.sizes();
          row.instrumentation = row.transport === 'blocked' ? 'BLOCKED_NO_RESPONSE_BYTES' : 'MEASURED';
        } catch (_) {
          row.instrumentation = 'INCOMPLETE'; networkInstrumentation.failures += 1;
        }
      };
      recorders.set(request, done);
    });
    const finish = (request, failed) => {
      const task = recorders.get(request)?.(failed);
      if (task) { pendingRecords.add(task); task.then(() => pendingRecords.delete(task), () => pendingRecords.delete(task)); }
    };
    context.on('requestfinished', request => finish(request, false)); context.on('requestfailed', request => finish(request, true));
    async function drain(reason) {
      const started = performance.now(), deadline = started + Math.min(timeoutMs, 5000);
      // Begin a fresh quiescence window at the measured boundary. Otherwise a
      // previously idle editor could return immediately while save continuations
      // are about to enqueue their quote Bridge/document/module reads.
      lastActivityMs = Math.max(lastActivityMs, started);
      while (performance.now() < deadline) {
        if (!inflight.size && !pendingRecords.size && performance.now() - lastActivityMs >= 200) {
          drains.push({ reason, status: 'SETTLED', durationMs: performance.now() - started }); return;
        }
        await new Promise(done => setTimeout(done, 20));
      }
      drains.push({ reason, status: 'DEADLINE_INCOMPLETE', durationMs: performance.now() - started, inflight: inflight.size, pendingRecorders: pendingRecords.size });
      networkInstrumentation.failures += 1;
    }
    await context.route('**/*', async route => {
      const request = route.request(), category = classifyHermeticRequest(request.url(), origin, request.method()), url = new URL(request.url());
      if (requestRole(request.url(), origin, request.resourceType(), request.headers()) === 'serviceWorkerScript') return route.abort('blockedbyclient');
      if (category === 'localStatic') return route.continue();
      if (category === 'estimateFixture' && ['GET', 'HEAD'].includes(request.method())) {
        const codes = (url.searchParams.get('codes') || '').split(',').filter(code => /^\d{6}$/.test(code));
        return route.fulfill({ status: 200, headers: { 'cache-control': 'no-store' }, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ fetched_at: '2026-08-28T06:45:10.000Z',
          items: codes.map(code => ({ code, name: code === FUND.code ? FUND.name : `基金 ${code}`, type: '混合型', last_nav: 1.2, est_nav: 1.21, est_change: 0.83,
            nav_date: '2026-08-27', est_time: '2026-08-28 14:45:00', source_time: '2026-08-28 14:45:00', est_label: '延迟估值', est_kind: 'estimate', est_realtime: false, status: 'ok', source: 'sinan-estimate-proxy' })) }) });
      }
      if (category === 'holdingsFixture' && ['GET', 'HEAD'].includes(request.method())) return route.fulfill({ status: 200, headers: { 'cache-control': 'no-store' }, contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ report_date: '2026-06-30', fetched_at: '2026-08-28T06:45:10.000Z', source: 'e2e-worker-fixture', items: [] }) });
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage(); page.setDefaultTimeout(timeoutMs); page.setDefaultNavigationTimeout(timeoutMs);
    page.on('pageerror', error => {
      pageErrors += 1;
      const category = error?.name === 'SecurityError' ? 'UNEXPECTED_SECURITY_ERROR'
        : error?.name === 'ReferenceError' ? 'UNEXPECTED_REFERENCE_ERROR' : error?.name === 'TypeError' ? 'UNEXPECTED_TYPE_ERROR' : 'UNEXPECTED_APPLICATION_ERROR';
      pageErrorCategories[category] = (pageErrorCategories[category] || 0) + 1;
    });
    page.on('console', message => { if (message.type() === 'error') consoleErrors += 1; });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable'); await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    const breakdown = {};
    async function verifyNoServiceWorkers() {
      const policy = await page.evaluate(async () => ({ status: globalThis.__PAIR_SW_POLICY__?.status,
        registrationAttempts: globalThis.__PAIR_SW_POLICY__?.registrationAttempts,
        controlled: Boolean(navigator.serviceWorker?.controller), registrations: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0 }));
      if (policy.status !== 'REGISTRATION_BLOCKED' || policy.controlled || policy.registrations || serviceWorkerEvents) throw new Error('Service Worker isolation could not be established.');
      return policy;
    }
    async function load(name, action) {
      phase = name;
      const response = await action();
      if (response?.status() !== 200 || !/\bno-store\b/i.test(response.headers()['cache-control'] || '')) throw new Error('Navigation did not use the no-store artifact.');
      // The previous document's cumulative counters are never this load's
      // baseline. Capture only after commit, within the new document epoch.
      const before = await captureRendererSnapshot(cdp, page);
      await page.waitForFunction(() => document.documentElement?.dataset.appReady === 'true' && Number.isFinite(window.__PAIR_PERFORMANCE__?.readyMs)
        && window.__FUNDVAL_BOOTSTRAP_STATUS__?.migration === 'ok' && document.querySelectorAll('#fund-list .skeleton').length === 0);
      const timing = await page.evaluate(() => {
        const state = window.__PAIR_PERFORMANCE__, nav = performance.getEntriesByType('navigation')[0], resources = performance.getEntriesByType('resource');
        const ready = state.readyMs, longTasks = state.longTasks.filter(task => task.startMs < ready);
        const bootstrap = resources.filter(entry => /\/(?:bootstrap|app-shell)\.js(?:\?|$)/.test(entry.name));
        return { readyMs: ready, bootstrapMigration: window.__FUNDVAL_BOOTSTRAP_STATUS__?.migration,
          http: nav ? { responseStartMs: nav.responseStart, responseEndMs: nav.responseEnd, navigationTtfbMs: nav.responseStart - nav.requestStart,
            responseDownloadMs: nav.responseEnd - nav.responseStart, transferBytes: nav.transferSize } : null,
          postHttpBootstrapAndDomMs: nav ? Math.max(0, ready - nav.responseEnd) : null,
          bootstrapResources: bootstrap.map(entry => ({ startMs: entry.startTime, responseEndMs: entry.responseEnd, durationMs: entry.duration })),
          longTaskSupported: state.longTaskSupported, longTasks, longTaskTotalMs: state.longTaskSupported ? longTasks.reduce((sum, task) => sum + Math.min(task.durationMs, ready - task.startMs), 0) : null,
          lcpAtCollectionMs: state.lcpMs, resourceCountAtCollection: resources.length };
      });
      timing.renderer = rendererDelta(before, await captureRendererSnapshot(cdp, page));
      breakdown[name] = timing;
      return timing.readyMs;
    }
    const coldReadyMs = await load('cold', () => page.goto(origin, { waitUntil: 'commit' }));
    // These drain/verification steps are outside the readiness/interaction timers.
    await drain('beforeOwnedWarmReload');
    breakdown.cold.serviceWorkers = await verifyNoServiceWorkers();
    lifecycle = 'ownedWarmReload';
    const warmReadyMs = await load('warm', () => page.reload({ waitUntil: 'commit' }));
    lifecycle = 'running';
    await drain('afterWarmReadiness');
    breakdown.warm.serviceWorkers = await verifyNoServiceWorkers();
    phase = 'savePreparation';
    await page.locator('#nav-edit').click(); await page.locator('#page-edit.active').waitFor({ state: 'visible' });
    for (const [selector, value] of [['#i-code', FUND.code], ['#i-name', FUND.name], ['#i-shares', FUND.shares], ['#i-cost', FUND.cost]]) await page.locator(selector).fill(value);
    await page.evaluate(() => {
      const state = window.__PAIR_PERFORMANCE__;
      const button = document.querySelector('#add-btn');
      button.addEventListener('click', () => {
        state.save = { clickMs: performance.now(), visibleMs: null };
        const observer = new MutationObserver(() => {
          const details = [...document.querySelectorAll('#holdings-list .h-detail')];
          if (details.some(element => element.textContent.includes('100份') && element.getClientRects().length)) {
            state.save.visibleMs = performance.now(); observer.disconnect();
          }
        });
        observer.observe(document.querySelector('#holdings-list'), { childList: true, characterData: true, subtree: true });
      }, { once: true, capture: true });
    });
    phase = 'save';
    const beforeSave = await captureRendererSnapshot(cdp, page), start = performance.now();
    await page.locator('#add-btn').click();
    await page.waitForFunction(() => Number.isFinite(window.__PAIR_PERFORMANCE__?.save?.visibleMs));
    const saveUiMs = performance.now() - start;
    breakdown.save = await page.evaluate(() => ({ clickToVisibleDomMs: window.__PAIR_PERFORMANCE__.save.visibleMs - window.__PAIR_PERFORMANCE__.save.clickMs }));
    breakdown.save.renderer = rendererDelta(beforeSave, await captureRendererSnapshot(cdp, page), { phase: 'interaction' });
    await drain('beforeOwnedContextClose');
    breakdown.save.serviceWorkers = await verifyNoServiceWorkers();
    // No storage values, console text, request URLs, screenshots or credentials are persisted.
    if (requests.some(request => request.category === 'gistWriteBlocked')) throw new Error('Synthetic context attempted a blocked Gist write.');
    observation = { coldReadyMs, warmReadyMs, saveUiMs, pageErrors, pageErrorCategories, consoleErrors, breakdown, requests, networkInstrumentation, drains };
    return observation;
  } finally {
    // Finish recorder APIs while their context still exists. All failures caused
    // by our subsequent close retain explicit ownership and resource-role labels.
    await Promise.allSettled([...pendingRecords]); lifecycle = 'ownedContextClose';
    await context.close(); await Promise.allSettled([...pendingRecords]);
    for (const request of inflight) {
      const row = requestRows.get(request);
      row.lifecycleCause = 'ownedContextClose'; row.failure = 'context_closed_without_terminal_request_event';
      row.instrumentation = 'INCOMPLETE_OWNED_CLOSE'; networkInstrumentation.failures += 1;
    }
    inflight.clear();
    if (observation) {
      observation.pageErrors = pageErrors; observation.consoleErrors = consoleErrors;
      observation.serviceWorkerEvents = serviceWorkerEvents;
      if (serviceWorkerEvents) networkInstrumentation.failures += 1;
    }
  }
}

async function terminateOwnedServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([new Promise(done => child.once('close', done)), new Promise(done => setTimeout(done, 5000))]);
  if (child.exitCode === null && child.signalCode === null) throw new Error('Owned server cleanup could not be confirmed; no unrelated process was terminated.');
}
function within(parent, target) { const path = relative(parent, target); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); }

function reportError(code) { return Object.assign(new Error(code), { code }); }
async function realPathAllowMissing(path) {
  const tail = []; let ancestor = resolve(path);
  for (;;) {
    try { return resolve(await realpath(ancestor), ...tail); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      tail.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
}

export async function reserveReportFile(reportPath, forbiddenDirectories = []) {
  const path = resolve(reportPath), forbidden = await Promise.all(forbiddenDirectories.map(realPathAllowMissing));
  const permitted = candidate => {
    if (forbidden.some(directory => within(directory, candidate))) throw reportError('REPORT_IN_DEPLOYABLE_SITE');
  };
  // Check the nearest existing real parent before mkdir, then the complete parent.
  // This covers fixed aliases/junctions, not hostile concurrent ancestor renames.
  permitted(resolve(await realPathAllowMissing(dirname(path)), basename(path)));
  await mkdir(dirname(path), { recursive: true });
  const canonicalPath = resolve(await realpath(dirname(path)), basename(path));
  permitted(canonicalPath);
  // Windows lacks O_NOFOLLOW; O_EXCL still rejects existing files and symlinks.
  // 0600 is a POSIX mode request, not a guarantee of private Windows ACLs.
  const handle = await open(canonicalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  return { handle, path };
}

export async function writeReservedReport({ handle, path }, report) {
  let failure = 'REPORT_SERIALIZATION_FAILED';
  try {
    const payload = `${JSON.stringify(report, null, 2)}\n`;
    failure = 'REPORT_WRITE_FAILED';
    // The reservation stays empty until this single descriptor-only write.
    await handle.writeFile(payload, 'utf8');
    failure = 'REPORT_PATH_IDENTITY_CHANGED';
    const [named, reserved] = await Promise.all([lstat(path, { bigint: true }), handle.stat({ bigint: true })]);
    if (!named.isFile() || named.dev !== reserved.dev || named.ino !== reserved.ino) throw reportError(failure);
    // Identity is confirmed at this instant only; never delete a replacement.
  } catch (_) { throw reportError(failure); }
  finally {
    try { await handle.close(); }
    catch (_) { throw reportError('REPORT_CLOSE_FAILED'); }
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log('node scripts/measure-performance-pair.mjs [--pairs 60] [--warmup-pairs 4] [--bootstrap 5000] [--seed 160003] [--output <new-json-path>] [--reference <full-sha>]\nExternal lifecycle: add --reference-origin http://127.0.0.1:<port> --current-origin http://127.0.0.1:<other-port> --reference-site <built-reference-site> [--current-site site]. Both servers must use no-store, and port 4173 is never touched.');
    return;
  }
  const reportPath = options.output || resolve(repository, 'docs/v16.0.0/performance-evidence', new Date().toISOString().replace(/[:.]/g, '-'), 'PAIR.json');
  if (within(options.currentSite, reportPath) || (options.referenceSite && within(options.referenceSite, reportPath))) throw new Error('Performance evidence cannot be placed in deployable site artifacts.');
  const reservation = await reserveReportFile(reportPath, [options.currentSite, options.referenceSite].filter(Boolean));
  let closeHandedOff = false;
  try {
  const servers = [], rawPairs = [], cleanup = []; let snapshot = null, browser = null, interrupted = false, stage = 'referenceIdentity';
  const report = { schema: 1, collectedAt: new Date().toISOString(), status: 'INCONCLUSIVE', requested: { retainedPairs: options.pairs, warmupPairs: options.warmupPairs, bootstrap: options.bootstrap, seed: options.seed },
    scope: 'Paired desktop Chrome, 390x844, fresh context per side with cold navigation, same-context no-store warm reload and real synthetic UI save; not production network or physical-device evidence.',
    measurement: { protocol: 'paired-readiness-v2-same-document-counters',
      protocolCaveat: 'The ready MutationObserver and UI-save wall timer definitions are unchanged. Additional post-commit snapshot RPCs add observation overhead; future comparisons must use this identical protocol for both sides and must not pool samples from the earlier 60/200-pair protocol. Old renderer deltas cannot be retrospectively promoted to full startup CPU.',
      fixtures: 'v15.spec.js default Worker estimate and empty holdings fixtures; all other providers and every Gist request blocked', fixedFixtureTime: FIXED_TIME,
      saveFixture: 'Synthetic E2E fund only, 100 shares, cost 1.2; readiness is data-app-ready observed by MutationObserver and migration/skeleton checks; save requires visible .h-detail containing 100份.',
      cold: 'Fresh empty storage and HTTP cache; a new browser context for every side of every pair.', warm: 'Same context reload after readiness and untimed request drain; service workers blocked and HTTP cache disabled/no-store in both phases.',
      saveUiMs: 'Runner wall time from before ordinary Playwright click to observer-confirmed visible save result; includes automation scheduling overhead, matching the v15 interaction budget.',
      separation: 'Local navigation TTFB/download are HTTP wall time, not isolated server CPU. Post-response bootstrap/DOM is a residual. CDP timeTicks counters use same-document post-commit baselines and partial startup coverage through collection, not isolated OS CPU or full bootstrap CPU. Before/after clocks, epochs and missing reasons are retained; long tasks are independently observed. Synthetic intercepted upstream timing is not production network latency.',
      exclusions: 'Only prespecified warm-up pairs excluded from inference; their raw samples remain in this report. No outlier stripping, retries, or post-hoc sample rejection.' },
    environment: { node: process.version, platform: platform(), osRelease: release(), architecture: process.arch, cpuModel: cpus()[0]?.model || null,
      logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryStartBytes: freemem(), viewport: { width: 390, height: 844 }, browser: 'Installed desktop Chrome, one browser process for both sides',
      serviceWorkers: 'Guarded registration denial + SW script route blocking + zero worker/controller/registration assertions; Playwright allow avoids its opaque-frame probe bug.', httpCache: 'CDP disabled and context routing/no-store; CDP service-worker bypass also enabled' },
    rawPairs, cleanup };
  const stop = () => { interrupted = true; browser?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    report.referenceSha = await git(['rev-parse', '--verify', `${options.reference}^{commit}`]);
    stage = 'sourceAndDependencyIdentity';
    report.currentSourceBefore = await sourceIdentity(); report.dependencies = await dependencyIdentity(report.referenceSha);
    if (!options.referenceOrigin) {
      stage = 'referenceSnapshot';
      snapshot = await createSourceSnapshot(report.referenceSha);
      const transport = await configureSnapshotTransport(snapshot);
      options.referenceOrigin = validateOrigin(transport.localOrigin);
      options.referenceSite = resolve(snapshot, 'site');
      const epoch = await git(['show', '-s', '--format=%ct', report.referenceSha]);
      console.log('PAIR: building only the isolated v15 reference with shared pinned dependencies; current site is not rebuilt.');
      stage = 'referenceBuild';
      await run(process.execPath, ['scripts/build-site.mjs'], { cwd: snapshot, env: { SOURCE_DATE_EPOCH: epoch, FORCE_COLOR: '0', NO_COLOR: '1' }, timeoutMs: 600_000 });
      const currentPort = await allocatePort([Number(new URL(options.referenceOrigin).port)]);
      options.currentOrigin = `http://127.0.0.1:${currentPort}`;
      if (await realpath(options.currentSite) !== await realpath(resolve(repository, 'site'))) throw new Error('Managed lifecycle requires the current repository site; use external origins for a custom current site.');
      stage = 'ownedServers';
      for (const [cwd, origin] of [[snapshot, options.referenceOrigin], [repository, options.currentOrigin]]) {
        const child = spawn(process.execPath, ['scripts/serve-site.mjs'], { cwd, windowsHide: true, stdio: 'ignore', env: { ...process.env, FUNDVAL_E2E_PORT: new URL(origin).port } });
        child.on('error', () => {}); servers.push({ child, origin });
      }
      report.lifecycle = { mode: 'owned isolated snapshot and servers', referenceTransportEdits: transport.changedSnapshotPaths, cleanup: 'Only owned browser, child servers and validated temporary reference snapshot.' };
    } else report.lifecycle = { mode: 'external loopback servers', cleanup: 'Only the sampler browser; external servers and artifact directories are left untouched.',
      provenanceCaveat: 'External reference build provenance is caller-managed; served startup graph bytes are verified against supplied artifact fingerprints, not inferred from a port.' };
    report.origins = { reference: options.referenceOrigin, current: options.currentOrigin };
    stage = 'artifactFingerprint';
    report.artifactsBefore = { reference: await artifactFingerprint(options.referenceSite), current: await artifactFingerprint(options.currentSite) };
    stage = 'noStoreTransportVerification';
    for (const side of ['reference', 'current']) await verifyTransport(options[`${side}Origin`], report.artifactsBefore[side], options.timeoutMs, servers.find(server => server.origin === options[`${side}Origin`])?.child);
    stage = 'installedChromeLaunch';
    const { chromium } = await import('@playwright/test'); browser = await chromium.launch({ channel: 'chrome', headless: true });
    report.environment.chromeVersion = browser.version();
    const plan = [...(options.warmupPairs ? balancedOrder(options.warmupPairs) : []), ...balancedOrder(options.pairs)];
    stage = 'pairedBrowserMeasurement';
    for (const [index, order] of plan.entries()) {
      if (interrupted) throw new Error('Sampling interrupted.');
      const pair = { index, retained: index >= options.warmupPairs, order, startedAt: new Date().toISOString(), reference: null, current: null };
      rawPairs.push(pair);
      for (const side of order) {
        try { pair[side] = await measureSide(browser, options[`${side}Origin`], options.timeoutMs); }
        catch (_) { pair.failure = { side, category: interrupted ? 'INTERRUPTED' : 'MEASUREMENT_FAILED', note: 'Raw preceding samples retained; no retry/replacement or raw error text persisted.' }; throw new Error('Pair measurement failed; see retained safe failure metadata.'); }
      }
      pair.finishedAt = new Date().toISOString();
      if ((index + 1) % 10 === 0 || index === plan.length - 1) console.log(`PAIR: ${rawPairs.filter(pair => pair.retained).length}/${options.pairs} retained complete pairs; warm-up samples also retained.`);
    }
    stage = 'pairedStatisticalInference';
    report.summary = summarizePairs(rawPairs.filter(pair => pair.retained), { bootstrap: options.bootstrap, seed: options.seed });
    report.status = report.summary.verdict;
    stage = 'evidenceStabilityVerification';
    report.artifactsAfter = { reference: await artifactFingerprint(options.referenceSite), current: await artifactFingerprint(options.currentSite) };
    report.currentSourceAfter = await sourceIdentity();
    const unchanged = ['reference', 'current'].every(side => report.artifactsBefore[side].sha256 === report.artifactsAfter[side].sha256)
      && JSON.stringify(report.currentSourceBefore) === JSON.stringify(report.currentSourceAfter);
    report.integrity = { status: unchanged ? 'PASS' : 'FAIL', note: 'Source identity and both artifact trees fingerprinted before/after; changes make the paired inference inconclusive.' };
    if (!unchanged) report.status = 'INCONCLUSIVE';
    if (rawPairs.some(pair => ['reference', 'current'].some(side => pair[side]?.pageErrors > 0))) {
      report.health = { status: 'FAIL', reason: 'At least one synthetic page emitted a pageerror; text not persisted.' }; report.status = 'INCONCLUSIVE';
    } else report.health = { status: 'PASS', pageErrors: 0 };
    if (rawPairs.some(pair => ['reference', 'current'].some(side => pair[side]?.networkInstrumentation.failures > 0))) {
      report.instrumentation = { status: 'INCOMPLETE', reason: 'Safe request timing/size collection failed; raw error text and URLs are not retained.' }; report.status = 'INCONCLUSIVE';
    } else report.instrumentation = { status: 'PASS' };
  } catch (_) {
    report.failure = { category: interrupted ? 'INTERRUPTED' : 'SETUP_OR_MEASUREMENT_FAILED', stage,
      reason: 'Evidence is incomplete at the named stage; raw partial samples preserved, no error/log/credential content persisted.' };
    report.status = 'INCONCLUSIVE';
  } finally {
    if (browser) try { await browser.close(); cleanup.push({ resource: 'ownedBrowser', status: 'PASS' }); } catch (_) { cleanup.push({ resource: 'ownedBrowser', status: 'UNCONFIRMED' }); }
    for (const server of servers) try { await terminateOwnedServer(server.child); cleanup.push({ resource: 'ownedServer', origin: server.origin, status: 'PASS' }); } catch (_) { cleanup.push({ resource: 'ownedServer', origin: server.origin, status: 'UNCONFIRMED' }); }
    if (snapshot) try { await safeRemoveSnapshot(snapshot); cleanup.push({ resource: 'validatedTemporarySnapshot', status: 'PASS' }); } catch (_) { cleanup.push({ resource: 'validatedTemporarySnapshot', status: 'UNCONFIRMED' }); }
    if (cleanup.some(item => item.status !== 'PASS')) report.status = 'INCONCLUSIVE';
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    report.observed = { retainedCompletePairs: rawPairs.filter(pair => pair.retained && pair.reference && pair.current && !pair.failure).length,
      warmupCompletePairs: rawPairs.filter(pair => !pair.retained && pair.reference && pair.current && !pair.failure).length,
      failedPairs: rawPairs.filter(pair => pair.failure).length };
    report.environment.freeMemoryEndBytes = freemem(); report.finishedAt = new Date().toISOString();
    closeHandedOff = true;
    await writeReservedReport(reservation, report);
  }
  console.log(`PAIR ${report.status}: ${reportPath}`);
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2;
  return report;
  } finally {
    // Covers exceptions before finalization takes ownership, including setup.
    if (!closeHandedOff) await reservation.handle.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    const category = ['EEXIST', 'ELOOP', 'REPORT_IN_DEPLOYABLE_SITE', 'REPORT_SERIALIZATION_FAILED', 'REPORT_WRITE_FAILED', 'REPORT_PATH_IDENTITY_CHANGED', 'REPORT_CLOSE_FAILED'].includes(error?.code)
      ? error.code : 'SETUP_OR_REPORT_WRITE_FAILED';
    console.error(`PAIR setup/report write failed (${category}); no raw error output retained.`); process.exitCode = 2;
  });
}
