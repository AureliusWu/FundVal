import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const V15_REFERENCE = '40e68edab9cb3fba0b17338dc3672a82d13ad17e';
let LOCAL_ORIGIN = 'http://127.0.0.1:4173';
const FIXED_TIME = '2026-09-30T06:00:00.000Z';
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function discoverNpmCli({
  platform = process.platform,
  nodeExecutable = process.execPath,
  environment = process.env,
  realpathFn = realpath,
} = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const candidates = [];
  if (environment.npm_execpath) candidates.push(environment.npm_execpath);
  const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const rawDirectory of pathValue.split(platform === 'win32' ? ';' : ':')) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    // POSIX npm is usually a symlink to npm-cli.js. On Windows npm.cmd/ps1
    // cannot safely be spawned without a shell; discover their adjacent JS CLI.
    candidates.push(paths.resolve(directory, 'npm'));
    candidates.push(paths.resolve(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(paths.resolve(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  const nodeDirectory = paths.dirname(nodeExecutable);
  candidates.push(paths.resolve(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(paths.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const cli = await realpathFn(candidate);
      if (paths.basename(cli).toLowerCase() === 'npm-cli.js') return cli;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  throw new Error('Cannot locate npm-cli.js from npm_execpath, PATH or the installed Node runtime. Install npm alongside Node or run the collector through npm.');
}

export function parseNodeSummary(output) {
  const result = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
    const match = output.match(new RegExp(`(?:^|\\n)[^\\n]*?\\b${key}\\s+(\\d+(?:\\.\\d+)?)\\s*(?:\\n|$)`));
    result[key] = match ? Number(match[1]) : null;
  }
  return result;
}

export function parseCoverage(output) {
  const totals = output.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
  const modules = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^.*?([A-Za-z0-9_.-]+\.js)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/);
    if (match) modules.push({ basename: match[1], line: Number(match[2]), branch: Number(match[3]), functions: Number(match[4]) });
  }
  return {
    status: totals ? 'MEASURED' : 'UNAVAILABLE',
    scope: 'Node test runner; imported js/**/*.js modules only; app.js/browser DOM and unimported modules are not included in the denominator.',
    line: totals ? Number(totals[1]) : null,
    branch: totals ? Number(totals[2]) : null,
    functions: totals ? Number(totals[3]) : null,
    modules,
  };
}

export function timingSummary(samples, key) {
  const values = samples.map(sample => sample[key]).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  return { samples: values.length, median: values[Math.floor(values.length / 2)], maximum: values.at(-1), p95: null, p95Reason: 'Three observations do not support a stable p95 estimate.' };
}

export function classifyRequest(value, method = 'GET') {
  const url = new URL(value);
  const workerPath = url.pathname.replace(/^\/__fundval_dev/, '');
  if (url.hostname === 'api.github.com') return method === 'GET' ? 'gistRead' : 'gistWrite';
  if (workerPath === '/estimates') return 'estimateBatch';
  if (workerPath === '/holdings') return 'holdingsSnapshot';
  if (url.hostname === 'fund.eastmoney.com' && url.pathname.startsWith('/pingzhongdata/')) return 'officialNav';
  if (url.hostname === 'qt.gtimg.cn') {
    return /(?:sh000001|sh000300|usNDX|usINX)/.test(url.href) ? 'indexQuotes' : 'securityQuotes';
  }
  if (url.origin === LOCAL_ORIGIN) return 'sameOriginStatic';
  return 'otherExternalBlocked';
}

function run(file, args, { cwd = repository, env = {}, timeout = 180_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const started = performance.now();
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    const deadline = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', data => stdout.push(data));
    child.stderr.on('data', data => stderr.push(data));
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(deadline);
      resolveRun({ exitCode, signal, durationMs: performance.now() - started, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

async function git(args) {
  const result = await run('git', args);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

export async function createSourceSnapshot(reference) {
  const directory = await mkdtemp(resolve(tmpdir(), 'fundval-baseline-'));
  await new Promise((resolveArchive, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', reference], { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const unpack = spawn('tar', ['-xf', '-', '-C', directory], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    archive.stdout.pipe(unpack.stdin);
    const errors = [];
    archive.stderr.on('data', chunk => errors.push(chunk));
    unpack.stderr.on('data', chunk => errors.push(chunk));
    const finished = Promise.all([
      new Promise((done, failed) => { archive.once('error', failed); archive.once('close', done); }),
      new Promise((done, failed) => { unpack.once('error', failed); unpack.once('close', done); }),
    ]);
    finished.then(codes => codes.every(code => code === 0)
      ? resolveArchive()
      : reject(new Error(`Source archive failed: ${Buffer.concat(errors).toString('utf8')}`)), reject);
  });
  // A Windows junction avoids admin permissions and reuses only installed
  // dependencies. The archive's lockfile is checked before any test executes.
  await symlink(resolve(repository, 'node_modules'), resolve(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Git for Windows can apply core.autocrlf while archiving. Existing source
  // extraction tests require LF; normalize the isolated text copy, not the repo.
  for (const path of await filesInside(directory)) {
    if (!/\.(?:html|css|js|mjs|json|md|yml|yaml|txt)$/.test(path)) continue;
    const text = await readFile(resolve(directory, path), 'utf8');
    if (text.includes('\r\n')) await writeFile(resolve(directory, path), text.replace(/\r\n/g, '\n'), 'utf8');
  }
  return directory;
}

async function filesInside(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(resolve(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesInside(directory, path));
    else if (entry.isSymbolicLink() && path === 'node_modules') continue;
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Artifact contains a non-regular path: ${path}`);
  }
  return files.sort();
}

async function artifactInventory(directory) {
  const files = [];
  for (const path of await filesInside(directory)) {
    const bytes = await readFile(resolve(directory, path));
    const text = /\.(?:html|css|js|mjs|json|md|txt)$/.test(path);
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes), normalizedSha256: text ? sha256(bytes.toString('utf8').replace(/\r\n/g, '\n')) : sha256(bytes) });
  }
  const aggregate = key => sha256(files.map(file => `${file.path}\0${file[key]}\n`).join(''));
  return { fileCount: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), sha256: aggregate('sha256'), normalizedSha256: aggregate('normalizedSha256'), files };
}

async function portInUse() {
  return new Promise(resolvePort => {
    const socket = createConnection({ port: Number(new URL(LOCAL_ORIGIN).port), host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('error', () => resolvePort(false));
    socket.setTimeout(500, () => { socket.destroy(); resolvePort(false); });
  });
}

export async function configureSnapshotTransport(snapshot) {
  const port = await new Promise((done, failed) => {
    const server = createServer();
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => { const number = server.address().port; server.close(() => done(number)); });
  });
  LOCAL_ORIGIN = `http://127.0.0.1:${port}`;
  for (const path of ['scripts/serve-site.mjs', 'playwright.config.mjs', 'e2e/v15.spec.js']) {
    const text = await readFile(resolve(snapshot, path), 'utf8');
    if (!text.includes('4173')) throw new Error(`Expected isolated localhost transport in ${path}.`);
    await writeFile(resolve(snapshot, path), text.replaceAll('4173', String(port)), 'utf8');
  }
  return { localOrigin: LOCAL_ORIGIN, changedSnapshotPaths: ['scripts/serve-site.mjs', 'playwright.config.mjs', 'e2e/v15.spec.js'], scope: 'Only fixed localhost port literals replaced; test assertions, fixtures and app/business modules unchanged.' };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error('Baseline wait deadline exceeded.');
}

function jsonpQuotes(url) {
  const codes = url.href.match(/\/q=([^&]+)/)?.[1]?.split(',') || [];
  return codes.map(code => {
    const fields = Array(34).fill('');
    fields[1] = 'Synthetic security'; fields[3] = '10.1'; fields[4] = '10';
    fields[30] = '20260930140000'; fields[32] = '1';
    const variable = /^(?:kr|jp)/.test(code) ? `v_${code.slice(0, 2)}_${code.slice(2)}` : `v_${code}`;
    return `var ${variable}=${JSON.stringify(fields.join('~'))};`;
  }).join('\n');
}

async function measureRefreshNetwork(snapshot) {
  if (await portInUse()) return { status: 'NOT_RUN', reason: 'Port 4173 is occupied; existing user server was left untouched.' };
  const { chromium } = await import('@playwright/test');
  const server = spawn(process.execPath, ['scripts/serve-site.mjs'], { cwd: snapshot, windowsHide: true, stdio: 'ignore' });
  let browser;
  try {
    await waitFor(portInUse);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const samples = [];
    for (let sampleIndex = 0; sampleIndex < 3; sampleIndex += 1) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', hasTouch: true });
      const holdings = [
        { code: '005844', name: '基线境内混合基金A', shares: 100, cost: 1.2, deleted: false, ts: 1790750000000 },
        { code: '012920', name: '基线全球精选混合(QDII)人民币A', shares: 100, cost: 1.2, deleted: false, ts: 1790750000000 },
        { code: '539002', name: '基线新兴市场混合(QDII)A', shares: 100, cost: 1.2, deleted: false, ts: 1790750000000 },
      ];
      await context.addInitScript(({ time, rows }) => {
        const NativeDate = Date;
        const fixed = NativeDate.parse(time);
        globalThis.Date = class extends NativeDate {
          constructor(...args) { super(...(args.length ? args : [fixed + performance.now()])); }
          static now() { return fixed + performance.now(); }
        };
        if (!localStorage.getItem('fuyu_holdings_v1')) localStorage.setItem('fuyu_holdings_v1', JSON.stringify(rows));
      }, { time: FIXED_TIME, rows: holdings });
      const requests = [];
      let phase = 'coldStartup', lastRequestAt = performance.now(), inflight = 0;
      context.on('request', request => {
        inflight += 1; lastRequestAt = performance.now();
        requests.push({ phase, category: classifyRequest(request.url(), request.method()), method: request.method(), url: request.url() });
      });
      const finished = () => { inflight = Math.max(0, inflight - 1); };
      context.on('requestfinished', finished); context.on('requestfailed', finished);
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), category = classifyRequest(url.href, request.method());
        if (category === 'sameOriginStatic') return route.continue();
        if (category === 'estimateBatch') {
          const codes = (url.searchParams.get('codes') || '').split(',');
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ fetched_at: FIXED_TIME, items: codes.map(code => ({ code, name: holdings.find(row => row.code === code)?.name, type: '混合型', last_nav: 1.2, est_nav: 1.21, est_change: 0.83, nav_date: '2026-09-29', est_time: '2026-09-30 14:00:00', source_time: '2026-09-30 14:00:00', est_kind: 'estimate', est_realtime: true, status: 'ok', source: 'sinan-estimate-proxy' })) }) });
        }
        if (category === 'holdingsSnapshot') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ report_date: '2026-06-30', fetched_at: FIXED_TIME, source: 'synthetic-baseline', items: Array.from({ length: 10 }, (_, index) => ({ code: String(index + 1).padStart(6, '0'), name: `合成股票${index + 1}`, ratio: 8, market: 'cn' })) }) });
        if (category === 'officialNav') {
          const code = url.pathname.match(/(\d{6})\.js$/)?.[1];
          return route.fulfill({ contentType: 'application/javascript', body: `var fS_code=${JSON.stringify(code)};var fS_name='基线合成基金';var Data_netWorthTrend=[{x:1790553600000,y:1.19},{x:1790640000000,y:1.2}];` });
        }
        if (category === 'indexQuotes' || category === 'securityQuotes') return route.fulfill({ contentType: 'application/javascript', body: jsonpQuotes(url) });
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      const settle = async () => {
        await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
        await waitFor(() => inflight === 0 && performance.now() - lastRequestAt >= 400, 30_000);
      };
      await page.goto(LOCAL_ORIGIN); await settle();
      phase = 'warmManualRefresh';
      await page.evaluate(() => {
        const start = new Event('touchstart'); Object.defineProperty(start, 'touches', { value: [{ clientY: 0 }] }); window.dispatchEvent(start);
        const end = new Event('touchend'); Object.defineProperty(end, 'changedTouches', { value: [{ clientY: 100 }] }); window.dispatchEvent(end);
      });
      await waitFor(() => requests.some(request => request.phase === phase && request.category === 'estimateBatch'));
      await settle();
      const summarize = name => {
        const rows = requests.filter(request => request.phase === name);
        const categories = Object.fromEntries([...new Set(rows.map(row => row.category))].sort().map(category => [category, rows.filter(row => row.category === category).length]));
        return { totalRequests: rows.length, dataRequests: rows.filter(row => !['sameOriginStatic', 'otherExternalBlocked'].includes(row.category)).length, categories };
      };
      samples.push({ coldStartup: summarize('coldStartup'), warmManualRefresh: summarize('warmManualRefresh') });
      if (requests.some(request => request.category === 'gistWrite')) throw new Error('Network baseline attempted a Gist write.');
      await context.close();
    }
    return { status: 'MEASURED', scope: 'Three synthetic holdings; 390x844 desktop Chrome; real third-party requests intercepted; successful official NAV and 10-row holdings fixtures; no production Gist or physical-device evidence.', fixedChinaTime: '2026-09-30 14:00:00', phaseDefinition: { coldStartup: 'Fresh context seeded with legacy holdings, no quote cache; includes index and app-shell reads.', warmManualRefresh: 'Same tab after startup/enrichment settled; ordinary pull-to-refresh within TTL; excludes unrelated startup index reads.' }, samples };
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(done => { if (server.exitCode !== null) done(); else server.once('close', done); });
  }
}

export async function safeRemoveSnapshot(directory) {
  const resolved = await realpath(directory);
  const parent = await realpath(tmpdir());
  const child = relative(parent, resolved);
  if (isAbsolute(child) || child.startsWith(`..${sep}`) || child === '..' || !/^fundval-baseline-[^/\\]+$/.test(child)) throw new Error('Refusing to remove an unexpected snapshot directory.');
  // Remove the junction itself first so cleanup cannot traverse dependencies.
  const dependencies = resolve(resolved, 'node_modules');
  if (existsSync(dependencies)) {
    if (!(await lstat(dependencies)).isSymbolicLink()) throw new Error('Snapshot dependencies are not the expected junction.');
    await unlink(dependencies);
  }
  await rm(resolved, { recursive: true, force: true });
}

async function main(args) {
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const reference = await git(['rev-parse', '--verify', `${option('--reference', V15_REFERENCE)}^{commit}`]);
  const reportPath = resolve(repository, option('--output', 'docs/v16.0.0/BASELINE.json'));
  if (args.includes('--help')) {
    console.log('node scripts/collect-baseline.mjs [--reference <commit>] [--output <json>] [--keep-snapshot] [--network-only]');
    return;
  }
  const currentHead = await git(['rev-parse', 'HEAD']);
  const statusBefore = await git(['status', '--short']);
  const snapshot = await createSourceSnapshot(reference);
  const transport = await configureSnapshotTransport(snapshot);
  const collectedAt = new Date().toISOString();
  // Keep evidence outside site: a current candidate build deliberately recreates
  // site, and deployable artifacts must not contain hidden baseline logs.
  const evidence = resolve(dirname(reportPath), 'baseline-evidence', collectedAt.replace(/[:.]/g, '-'));
  const epoch = await git(['show', '-s', '--format=%ct', reference]);
  const npmCli = await discoverNpmCli();
  const npm = (command, extra = []) => run(process.execPath, [npmCli, ...command, ...extra], { cwd: snapshot, env: { SOURCE_DATE_EPOCH: epoch, FORCE_COLOR: '0', NO_COLOR: '1' } });
  await mkdir(evidence, { recursive: true });
  const results = {};
  async function gate(name, operation) {
    console.log(`BASELINE ${name}: started (${reference.slice(0, 7)} snapshot)`);
    const result = await operation();
    await writeFile(resolve(evidence, `${name}.log`), `${result.stdout}\n${result.stderr}`, 'utf8');
    results[name] = { status: result.exitCode === 0 ? 'PASS' : 'FAIL', exitCode: result.exitCode, durationMs: result.durationMs, evidence: relative(repository, resolve(evidence, `${name}.log`)).split(sep).join('/'), logSha256: sha256(`${result.stdout}\n${result.stderr}`) };
    console.log(`BASELINE ${name}: ${results[name].status}`);
    return result;
  }
  try {
    const packageJson = JSON.parse(await readFile(resolve(snapshot, 'package.json'), 'utf8'));
    const archiveLock = await readFile(resolve(snapshot, 'package-lock.json'));
    const installedLock = await readFile(resolve(repository, 'package-lock.json'));
    const lockIdentity = bytes => {
      const value = JSON.parse(bytes.toString('utf8'));
      // M0 engine pinning changes only this root metadata, not resolved packages.
      if (value.packages?.['']) delete value.packages[''].engines;
      return JSON.stringify(value);
    };
    if (lockIdentity(archiveLock) !== lockIdentity(installedLock)) throw new Error('Working resolved dependency lock differs from reference commit; install reference dependencies in a separate checkout first.');
    const declaredDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const installedDependencies = {};
    for (const [name, version] of Object.entries(declaredDependencies)) {
      const installed = JSON.parse(await readFile(resolve(repository, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== version) throw new Error(`Installed dependency ${name} differs from reference ${version}.`);
      installedDependencies[name] = installed.version;
    }
    if (args.includes('--network-only')) {
      const previous = JSON.parse(await readFile(reportPath, 'utf8'));
      if (previous.referenceCommit !== reference) throw new Error('Existing report reference differs from the requested network-only measurement.');
      const build = await gate('network-replay-build', () => npm(['run', 'build']));
      if (build.exitCode !== 0) throw new Error('Network-only reference build failed.');
      const network = await measureRefreshNetwork(snapshot).catch(error => ({ status: 'FAILED_MEASUREMENT', reason: error.message }));
      previous.performance.networkAttempts = [...(previous.performance.networkAttempts || []), { status: previous.performance.network.status, reason: previous.performance.network.reason || null }];
      previous.performance.network = { ...network, measuredAt: new Date().toISOString(), transport };
      await writeFile(reportPath, `${JSON.stringify(previous, null, 2)}\n`, 'utf8');
      console.log(`BASELINE network-only: ${network.status}`);
      if (network.status !== 'MEASURED') process.exitCode = 1;
      return;
    }
    const unit = await gate('unit', () => npm(['test']));
    const check = await gate('check', () => npm(['run', 'check']));
    const coverage = await gate('coverage', () => run(process.execPath, ['--experimental-test-coverage', '--test-coverage-include=js/**/*.js', '--test', '--test-reporter=spec'], { cwd: snapshot, env: { FORCE_COLOR: '0', NO_COLOR: '1' } }));
    const auditDefault = await gate('audit-default', () => npm(['audit', '--audit-level=high', '--json']));
    const auditOfficial = await gate('audit-official', () => npm(['audit', '--audit-level=high', '--registry=https://registry.npmjs.org', '--json']));
    await gate('build-first', () => npm(['run', 'build']));
    const firstArtifact = await artifactInventory(resolve(snapshot, 'site'));
    await gate('build-second', () => npm(['run', 'build']));
    const secondArtifact = await artifactInventory(resolve(snapshot, 'site'));
    const chunks = JSON.parse(await readFile(resolve(snapshot, 'site/js/app-chunks.json'), 'utf8'));
    const ocr = JSON.parse(await readFile(resolve(snapshot, 'site/assets/ocr/asset-manifest.json'), 'utf8'));
    const fingerprintModule = await import(pathToFileURL(resolve(snapshot, 'scripts/release-fingerprint.mjs')).href);
    const criticalFingerprint = await fingerprintModule.fingerprintReleaseDirectory(resolve(snapshot, 'site'));
    const appVerification = await fingerprintModule.verifyAppChunkReleaseDirectory(resolve(snapshot, 'site'));
    const ocrVerification = await fingerprintModule.verifyOcrReleaseDirectory(resolve(snapshot, 'site/assets/ocr'));
    const e2e = await portInUse()
      ? { stdout: '', stderr: 'Port 4173 occupied; refuse to test an existing user server.', exitCode: null, durationMs: 0 }
      : await gate('e2e', () => npm(['run', 'test:e2e']));
    if (e2e.exitCode === null) results.e2e = { status: 'NOT_RUN', reason: e2e.stderr };
    const timingSamples = JSON.parse(e2e.stdout.match(/LOCAL_PERFORMANCE (\[[^\n]+\])/u)?.[1] || '[]');
    const network = await measureRefreshNetwork(snapshot).catch(error => ({ status: 'FAILED_MEASUREMENT', reason: error.message }));
    await cp(resolve(snapshot, 'site/js/app-chunks.json'), resolve(evidence, 'app-chunks.json'));
    await cp(resolve(snapshot, 'site/assets/ocr/asset-manifest.json'), resolve(evidence, 'ocr-asset-manifest.json'));
    const report = {
      schemaVersion: 1, project: 'FundVal', version: packageJson.version, collectedAt, referenceCommit: reference, sourceSnapshot: 'LF-normalized git archive of the reference commit; original tests and build configuration, not current governance edits; isolated localhost port substitution only',
      workingContext: { head: currentHead, statusBefore, statusAfter: await git(['status', '--short']), sourceDateEpoch: Number(epoch) },
      environment: { platform: process.platform, architecture: process.arch, node: process.version, npm: (await run(process.execPath, [npmCli, '--version'])).stdout.trim(), transport, viewport: { width: 390, height: 844 }, browser: 'Installed desktop Chrome via Playwright; physical Android/iOS NOT_RUN', installedDependencies, lockfileSha256Normalized: sha256(archiveLock.toString('utf8').replace(/\r\n/g, '\n')) },
      gates: { ...results, unit: { ...results.unit, summary: parseNodeSummary(unit.stdout) }, coverage: { ...results.coverage, report: parseCoverage(coverage.stdout) }, auditOfficial: { ...results['audit-official'], command: 'npm audit --audit-level=high --registry=https://registry.npmjs.org --json', metadata: JSON.parse(auditOfficial.stdout || '{}').metadata || null }, deterministicBuild: { status: firstArtifact.sha256 === secondArtifact.sha256 ? 'PASS' : 'FAIL', firstSha256: firstArtifact.sha256, secondSha256: secondArtifact.sha256, normalizedSha256: secondArtifact.normalizedSha256, scope: 'All regular generated site files, before browser-test result artifacts.' }, e2e: { ...results.e2e, passed: Number(e2e.stdout.match(/(\d+) passed/)?.[1]) || null, failed: Number(e2e.stdout.match(/(\d+) failed/)?.[1]) || 0 } },
      artifact: { criticalFingerprint, ...secondArtifact },
      bundle: { coldStartGzipBytes: chunks.chunks.filter(chunk => chunk.role === 'cold').reduce((sum, chunk) => sum + chunk.gzipBytes, 0), hardBudgetGzipBytes: 52241, allNonOcrGzipBytes: chunks.chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0), verified: appVerification, manifest: chunks },
      ocr: { verified: ocrVerification, roleBytes: Object.fromEntries([...new Set(ocr.assets.map(asset => asset.role || 'unspecified'))].map(role => [role, ocr.assets.filter(asset => (asset.role || 'unspecified') === role).reduce((sum, asset) => sum + asset.bytes, 0)])), actualRecognitionDuration: { status: 'NOT_RUN', reason: 'This collection does not execute a real OCR engine or process private screenshots.' }, manifest: ocr },
      performance: { scope: 'Hermetic local no-store browser readiness and UI save; timings include desktop environment scheduling, not production network/service latency.', samplesMs: timingSamples, summary: { coldReadyMs: timingSummary(timingSamples, 'coldReadyMs'), warmReadyMs: timingSummary(timingSamples, 'warmReadyMs'), saveUiMs: timingSummary(timingSamples, 'saveUiMs') }, network, latencyBreakdown: { status: 'NOT_RUN', reason: 'Current instrumentation does not independently measure server, real upstream network, renderer CPU and main-thread time.' } },
      notRun: ['Physical Android 4GB', 'Physical Android >=8GB and installed PWA', 'Physical iOS Safari and Home Screen PWA', 'Real two-device synthetic Gist read/write', 'Installed v15.0.2 -> v16 PWA update', 'Actual long-screenshot OCR timing', 'Production performance/request counts'],
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`BASELINE report: ${reportPath}`);
    const mandatory = ['unit', 'check', 'coverage', 'audit-official', 'build-first', 'build-second', 'e2e'];
    if (mandatory.some(name => results[name]?.status !== 'PASS') || report.gates.deterministicBuild.status !== 'PASS' || network.status !== 'MEASURED') process.exitCode = 1;
    if (args.includes('--keep-snapshot')) console.log(`BASELINE snapshot retained: ${snapshot}`);
  } finally {
    if (!args.includes('--keep-snapshot')) await safeRemoveSnapshot(snapshot);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
