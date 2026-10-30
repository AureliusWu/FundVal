import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { artifactFingerprint, balancedOrder, measureSide, reserveReportFile, summarizePairs, writeReservedReport, V15_REFERENCE } from './measure-performance-pair.mjs';
import { inventorySite, validateCandidateManifest } from './release-candidate.mjs';

const CURRENT_SHA = '35808ee3b4698db1f9919cbc8f0d4033f9baa986';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', mjs: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', png: 'image/png', svg: 'image/svg+xml', wasm: 'application/wasm' };

export function parseReleaseOptions(args) {
  const options = { pairs: 60, warmupPairs: 4, bootstrap: 5000, seed: 160003, timeoutMs: 30000 };
  const names = { '--reference-provenance': 'referenceProvenance', '--candidate-json': 'candidateJson', '--current-site': 'currentSite', '--output': 'output', '--pairs': 'pairs' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!names[key] || seen.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid, duplicate or missing release-pair option');
    seen.add(key); options[names[key]] = args[++i];
  }
  if (!/^[0-9]+$/.test(String(options.pairs))) throw new Error('Invalid pair count');
  options.pairs = Number(options.pairs);
  if (!Number.isInteger(options.pairs) || options.pairs < 60 || options.pairs > 1000 || options.pairs % 2) throw new Error('Pairs must be even, between 60 and 1000');
  for (const key of ['referenceProvenance', 'candidateJson', 'currentSite', 'output']) {
    if (typeof options[key] !== 'string' || !options[key]) throw new Error('Explicit reference provenance, original candidate, site and new output are required');
    options[key] = resolve(options[key]);
  }
  return options;
}

export function releaseStaticPath(requestUrl) {
  let path;
  try { path = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname); } catch { return null; }
  if (path === '/') return 'index.html';
  if (!path.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(path)) return null;
  const parts = path.slice(1).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function releaseHealth(rawPairs, expectedPairs) {
  const retained = rawPairs.filter(pair => pair.retained);
  const complete = retained.length === expectedPairs && retained.every(pair => pair.reference && pair.current && !pair.failure);
  const sides = rawPairs.flatMap(pair => [pair.reference, pair.current].filter(Boolean));
  const validCounters = sides.every(side => Number.isInteger(side.pageErrors) && side.pageErrors >= 0
    && Number.isInteger(side.networkInstrumentation?.failures) && side.networkInstrumentation.failures >= 0);
  const pageErrors = validCounters ? sides.reduce((sum, side) => sum + side.pageErrors, 0) : null;
  const instrumentationFailures = validCounters ? sides.reduce((sum, side) => sum + side.networkInstrumentation.failures, 0) : null;
  return { complete, retainedCompletePairs: retained.filter(pair => pair.reference && pair.current && !pair.failure).length,
    pageErrors, instrumentationFailures, validCounters, verdict: complete && validCounters && !pageErrors && !instrumentationFailures ? 'PASS' : 'INCONCLUSIVE' };
}

async function serveArtifacts(artifacts) {
  let side = 'reference';
  const maps = Object.fromEntries(Object.entries(artifacts).map(([key, entry]) => [key, new Map(entry.inventory.files.map(file => [file.path, file]))]));
  const server = createServer(async (request, response) => {
    const selected = side, path = releaseStaticPath(request.url);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    if (!path || !maps[selected].has(path)) { response.writeHead(404); response.end(); return; }
    try {
      const bytes = await readFile(resolve(artifacts[selected].root, path));
      response.setHeader('Content-Type', types[path.split('.').at(-1)] || 'application/octet-stream');
      response.setHeader('Content-Length', bytes.length); response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  if (port === 4173) { await new Promise(done => server.close(done)); throw new Error('Reserved user port refused'); }
  return { origin: `http://127.0.0.1:${port}`, select: selected => { assert.ok(artifacts[selected]); side = selected; },
    close: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done())) };
}

async function verifyServed(origin, inventory) {
  const results = [];
  for (const expected of inventory.files.filter(file => /^(?:index\.html|js\/(?:app-shell\.js|app-chunks\.json|chunks\/)|css\/)/.test(file.path))) {
    const response = await fetch(new URL(expected.path, origin + '/'), { redirect: 'error', signal: AbortSignal.timeout(30000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') || '', /\bno-store\b/);
    assert.equal(bytes.length, expected.bytes); assert.equal(hash(bytes), expected.sha256);
    results.push({ path: expected.path, bytes: bytes.length, sha256: expected.sha256 });
  }
  return { verdict: 'PASS', files: results.length, resources: results };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseReleaseOptions(args);
  const reference = JSON.parse(await readFile(options.referenceProvenance, 'utf8'));
  assert.equal(reference.referenceSha, V15_REFERENCE); assert.equal(reference.version, '15.0.2'); assert.equal(reference.sourceUnchanged, true);
  assert.equal(process.version, 'v24.14.0');
  const candidate = validateCandidateManifest(JSON.parse(await readFile(options.candidateJson, 'utf8')),
    { repository: 'AureliusWu/FundVal', sha: CURRENT_SHA, runId: '40877032757', attempt: '1' });
  assert.deepEqual(await inventorySite(options.currentSite), candidate.site);
  const referenceSite = reference.siteRoot;
  const reservation = await reserveReportFile(options.output, [referenceSite, options.currentSite]);
  const report = { schema: 1, version: '16.0.0', collectedAt: new Date().toISOString(), status: 'INCONCLUSIVE',
    scope: 'Exact-release v15.0.2 versus released v16.0.0 whole-version desktop comparison; not same-dependency M3 qualification, production network or physical-device evidence.',
    identity: { referenceSha: V15_REFERENCE, currentSha: CURRENT_SHA, currentCiRun: '40877032757', currentCiAttempt: '1',
      currentReleaseCriticalFingerprint: candidate.releaseFingerprint, currentSiteInventoryFingerprint: candidate.site.fingerprint,
      referenceSourceInventorySha256: reference.sourceInventorySha256, referenceRawLockSha256: reference.rawLockSha256,
      referenceInstalledDependencies: reference.installedDependencies, currentDependencyLockScope: 'Original exact CI artifact built from its committed lock; current working-tree node_modules is not used to rebuild either side.' },
    requested: { retainedPairs: options.pairs, warmupPairs: options.warmupPairs, bootstrap: options.bootstrap, seed: options.seed },
    method: { protocol: 'measure-performance-pair.mjs paired-readiness-v2-same-document-counters, unchanged measureSide and summarizePairs',
      origin: 'One owned loopback HTTP origin and identical root URL; static root changes only after prior context has closed; before measuring each artifact, startup graph bytes verified.',
      urlScope: 'Controlled root-URL CPU/whole-version comparison only, not actual /FundVal/ deployment-path acceptance. Separate upgrade preflight found the historical v15 root-absolute preload/lazy-save path fails under /FundVal/. Neither baseline nor artifacts are patched here; root-URL save timings must not be generalized to old production-subpath availability.',
      ordering: 'Alternating AB/BA whole pairs, four prespecified warm-up pairs retained but excluded from inference; no outlier removal or failed sample replacement.',
      cold: 'Fresh empty storage/context per side; HTTP cache disabled, no-store local transport, no service workers.',
      warm: 'Same-context reload retaining local storage after untimed drain; HTTP cache still disabled/no-store. This is not HTTP-cache-hot or OS warm PWA launch.',
      interaction: 'Real synthetic UI save of E2E fund 005844, 100 shares, cost1.2; click through visible holding result (not a separate durability readback assertion); runner wall timer retains automation overhead.',
      fixtures: 'Unchanged historical v15 default synthetic estimate/empty holdings at fixed Date2026-08-28T06:45:10Z; nonfixture providers, Gist and SW requests blocked.',
      attribution: 'Loopback navigation TTFB/download vs post-response bootstrap/DOM residual, long tasks, LCP if available, request counts/bytes and partial same-document renderer counters; neither isolated server CPU nor OS CPU nor production API timings.',
      dependencies: 'Both actual releases retain original locks/build tools. Historical v15 Vite8.2.2 and final v16 Vite8.2.4 differ, so effects cannot be attributed solely to application code. Existing M3 same-lock guard is unchanged.',
      thresholds: { medianRatio: 1.15, p95Ratio: 1.20, absoluteCriticalMs: 3000, stabilityWidth: 0.20, bootstrapPassConfidence: 0.95 },
      caveat: 'Small tail counts and desktop scheduling limit inference; INCONCLUSIVE is retained, not promoted to PASS.' },
    environment: { node: process.version, platform: platform(), osRelease: release(), cpuModel: cpus()[0]?.model || null, logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(), viewport: { width: 390, height: 844 }, serviceWorkers: 'Existing guarded registration denial + blocked SW script requests + zero registration/controller/worker assertions' },
    rawPairs: [], cleanup: [] };
  let transport, browser, interrupted = false;
  const stop = () => { interrupted = true; browser?.close().catch(() => {}); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let stage = 'artifactBefore';
  try {
    report.artifactsBefore = { reference: await artifactFingerprint(referenceSite), current: await artifactFingerprint(options.currentSite) };
    assert.equal(report.artifactsBefore.reference.sha256, reference.artifact.sha256);
    const artifacts = { reference: { root: referenceSite, inventory: report.artifactsBefore.reference }, current: { root: options.currentSite, inventory: report.artifactsBefore.current } };
    stage = 'ownedIdenticalOriginServer'; transport = await serveArtifacts(artifacts); report.environment.origin = transport.origin;
    report.transportVerification = {};
    for (const side of ['reference', 'current']) { transport.select(side); report.transportVerification[side] = await verifyServed(transport.origin, artifacts[side].inventory); }
    stage = 'installedChrome'; const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ channel: 'chrome', headless: true }); report.environment.chromeVersion = browser.version();
    stage = 'pairedBrowserMeasurement';
    const order = [...balancedOrder(options.warmupPairs), ...balancedOrder(options.pairs)];
    for (let index = 0; index < order.length; index++) {
      if (interrupted) throw new Error('Interrupted');
      const pair = { index, retained: index >= options.warmupPairs, order: order[index], startedAt: new Date().toISOString(), reference: null, current: null };
      report.rawPairs.push(pair);
      for (const side of pair.order) {
        transport.select(side);
        try { pair[side] = await measureSide(browser, transport.origin, options.timeoutMs); }
        catch { pair.failure = { side, category: interrupted ? 'INTERRUPTED' : 'MEASUREMENT_FAILED', note: 'Raw partial pair retained; no retry, replacement, raw error, financial data or screenshots.' }; throw new Error('Measurement failed'); }
      }
      pair.finishedAt = new Date().toISOString();
      if ((index + 1) % 10 === 0 || index + 1 === order.length) console.log(`RELEASE PAIR: ${report.rawPairs.filter(row => row.retained).length}/${options.pairs} retained complete pairs.`);
    }
    stage = 'pairedInference'; report.health = releaseHealth(report.rawPairs, options.pairs);
    report.summary = summarizePairs(report.rawPairs.filter(pair => pair.retained), { bootstrap: options.bootstrap, seed: options.seed });
    report.status = report.health.verdict === 'PASS' ? report.summary.verdict : 'INCONCLUSIVE';
    stage = 'artifactAfter'; report.artifactsAfter = { reference: await artifactFingerprint(referenceSite), current: await artifactFingerprint(options.currentSite) };
    report.integrity = { status: ['reference', 'current'].every(side => report.artifactsBefore[side].sha256 === report.artifactsAfter[side].sha256) ? 'PASS' : 'FAIL' };
    if (report.integrity.status !== 'PASS') report.status = 'INCONCLUSIVE';
  } catch {
    report.failure = { stage, category: interrupted ? 'INTERRUPTED' : 'SETUP_OR_MEASUREMENT_FAILED', note: 'No raw error/message/URL content retained; all existing samples preserved.' };
    report.status = 'INCONCLUSIVE'; report.health = releaseHealth(report.rawPairs, options.pairs);
  } finally {
    if (browser) { try { await browser.close(); report.cleanup.push({ resource: 'ownedBrowser', status: browser.isConnected() ? 'UNCONFIRMED' : 'PASS' }); } catch { report.cleanup.push({ resource: 'ownedBrowser', status: 'UNCONFIRMED' }); } }
    if (transport) { try { await transport.close(); report.cleanup.push({ resource: 'ownedSameOriginServer', status: 'PASS' }); } catch { report.cleanup.push({ resource: 'ownedSameOriginServer', status: 'UNCONFIRMED' }); } }
    if (report.cleanup.some(row => row.status !== 'PASS')) report.status = 'INCONCLUSIVE';
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    report.finishedAt = new Date().toISOString(); await writeReservedReport(reservation, report);
  }
  console.log(`RELEASE PAIR ${report.status}: ${options.output}`);
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2;
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(() => { console.error('Release-pair preflight failed before measurement; no raw error details recorded.'); process.exitCode = 2; });
