import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as catalogModule from '../scripts/refresh-fund-catalog.mjs';

const LIMITS = { sourceBytes: 16 * 1024 * 1024, rows: 100000, nameLength: 128,
  pinyinLength: 512, outputBytes: 16 * 1024 * 1024, timeoutMs: 20000 };
const SOURCE = new URL('../scripts/refresh-fund-catalog.mjs', import.meta.url);
const REAL_TARGET = new URL('../data/fund-catalog.json', import.meta.url);
const VALID = 'var r = [["000001","A","合成基金/增强+","混合型","PIN*YIN"]];';
const SENTINEL = Buffer.from('[{"code":"654321","name":"synthetic-old-catalog","pinyin":"old"}]');
const hash = value => createHash('sha256').update(value).digest('hex');
const script = rows => `var r = ${JSON.stringify(rows)};`;
const row = (code = '000001', name = '合成基金', pinyin = 'A') => [code, pinyin, name];
async function flush() { for (let index = 0; index < 16; index++) await Promise.resolve(); }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t, directoryTarget = false) {
  const root = await mkdtemp(join(tmpdir(), 'fundval-catalog-test-'));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('fundval-catalog-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('fundval-catalog-test-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'data'));
  const modulePath = join(root, 'scripts', 'refresh-fund-catalog.mjs');
  const target = join(root, 'data', 'fund-catalog.json');
  // Execute an unchanged copy of the real module in an isolated project mirror.
  // Its fixed target therefore belongs to this owned Temp fixture, never data/.
  await copyFile(SOURCE, modulePath);
  assert.equal(hash(await readFile(modulePath)), hash(await readFile(SOURCE)));
  if (directoryTarget) { await mkdir(target); await writeFile(join(target, 'sentinel'), SENTINEL); }
  else await writeFile(target, SENTINEL);
  const module = await import(pathToFileURL(modulePath).href);
  return { root, target, module,
    async unchanged() {
      assert.equal(hash(await readFile(directoryTarget ? join(target, 'sentinel') : target)), hash(SENTINEL),
        'Rejected input must not replace the pre-existing catalog.');
      assert.deepEqual((await readdir(join(root, 'data'))).sort(), ['fund-catalog.json'],
        'Failed publication must clean only its own temporary sibling.');
    } };
}

function textResponse(value, extra = {}) {
  return { ok: true, headers: new Headers(), text: async () => value, ...extra };
}

async function rejectedWithoutReplacement(t, response) {
  const f = await fixture(t);
  let rejected = false;
  try { await f.module.refreshFundCatalog({ fetchFn: async () => response }); }
  catch { rejected = true; }
  await f.unchanged();
  assert.equal(rejected, true, 'The bounded refresh must reject this response.');
}

test('maintenance limits are explicit and do not replace the existing public parser/refresh API', () => {
  assert.deepEqual(catalogModule.FUND_CATALOG_LIMITS, LIMITS);
  assert.equal(typeof catalogModule.parseEastmoneyFundCatalogScript, 'function');
  assert.equal(typeof catalogModule.refreshFundCatalog, 'function');
});

test('parser preserves BOM, escaping, first-valid deduplication, order and non-executed suffix', () => {
  const rows = [row('000002', ''), row('000001', '名字含[括号]、"引号"和\\路径'),
    row('000002', '量化/增强+'), row('000001', 'duplicate'), ['bad', 'X', 'ignored'], null];
  const source = '\ufeff  ' + script(rows) + ' globalThis.__fundvalCatalogMustNotRun = true;';
  assert.deepEqual(catalogModule.parseEastmoneyFundCatalogScript(source), [
    { code: '000001', name: rows[1][2], pinyin: 'A' },
    { code: '000002', name: '量化/增强+', pinyin: 'A' },
  ]);
  assert.equal(globalThis.__fundvalCatalogMustNotRun, undefined);
});

test('parser keeps original numeric-code coercion and selected-pinyin truthiness before trim', () => {
  assert.deepEqual(catalogModule.parseEastmoneyFundCatalogScript(script([
    [123456, 'SHORT', '名称', '', '   '], ['000002', 'P*YIN', '基金/增强+', '', ''],
    ['000003', 'x'.repeat(513), '名称', '', 'OK'],
  ])), [
    { code: '123456', name: '名称', pinyin: '' },
    { code: '000002', name: '基金/增强+', pinyin: 'P*YIN' },
    { code: '000003', name: '名称', pinyin: 'OK' },
  ]);
});

test('source budget counts UTF8 bytes before trimming oversized whitespace', () => {
  const padded = VALID + ' '.repeat(LIMITS.sourceBytes - Buffer.byteLength(VALID) + 1);
  assert.ok(padded.length < LIMITS.sourceBytes, 'Chinese source makes UTF8 length different from JS length.');
  assert.throws(() => catalogModule.parseEastmoneyFundCatalogScript(padded));
});

test('source byte boundary is inclusive and name limits count trimmed UTF16 code units', () => {
  const valid = script([row('000001', '汉'.repeat(LIMITS.nameLength))]);
  const padded = valid + ' '.repeat(LIMITS.sourceBytes - Buffer.byteLength(valid));
  assert.equal(catalogModule.parseEastmoneyFundCatalogScript(padded)[0].name.length, LIMITS.nameLength);
});

test('raw row budget rejects invalid-row floods before filtering', () => {
  assert.throws(() => catalogModule.parseEastmoneyFundCatalogScript(script([row(), ...Array(LIMITS.rows).fill(null)])));
});

test('raw row boundary remains inclusive even when most rows are skipped', () => {
  assert.equal(catalogModule.parseEastmoneyFundCatalogScript(script([row(), ...Array(LIMITS.rows - 1).fill(null)])).length, 1);
});

test('a valid-code overlong name rejects the batch instead of truncating or silently dropping a fund', () => {
  assert.throws(() => catalogModule.parseEastmoneyFundCatalogScript(script([row(), row('000002', 'N'.repeat(LIMITS.nameLength + 1))])));
});

test('an overlong selected pinyin rejects the batch while its exact boundary is accepted', () => {
  assert.equal(catalogModule.parseEastmoneyFundCatalogScript(script([row('000001', '名称', 'P'.repeat(LIMITS.pinyinLength))]))[0].pinyin.length, LIMITS.pinyinLength);
  assert.throws(() => catalogModule.parseEastmoneyFundCatalogScript(script([row('000001', '名称', 'P'.repeat(LIMITS.pinyinLength + 1))])));
});

test('refresh uses the fixed public source and fixed local target with no user payload', async t => {
  const f = await fixture(t);
  let captured;
  const result = await f.module.refreshFundCatalog({ fetchFn: async (url, options) => {
    captured = { url, options }; return textResponse(VALID);
  } });
  assert.equal(captured.url, catalogModule.EASTMONEY_FUND_CATALOG_SOURCE);
  assert.equal(captured.options.headers.Accept, 'application/javascript');
  assert.ok(captured.options.signal instanceof AbortSignal);
  assert.equal(result.target, f.target);
  assert.equal(result.count, 1);
  assert.deepEqual(JSON.parse(await readFile(f.target, 'utf8')), [{ code: '000001', name: '合成基金/增强+', pinyin: 'PIN*YIN' }]);
  assert.deepEqual((await readdir(join(f.root, 'data'))).sort(), ['fund-catalog.json']);
});

test('an arbitrary output path is rejected before fetch, including the real repository target from a fixture', async t => {
  const f = await fixture(t);
  let requests = 0;
  for (const targetPath of [join(f.root, 'outside.json'), fileURLToPath(REAL_TARGET)]) {
    await assert.rejects(f.module.refreshFundCatalog({ targetPath, fetchFn: async () => { requests++; return textResponse(VALID); } }));
  }
  assert.equal(requests, 0);
  await f.unchanged();
});

test('HTTP failures do not consume or publish a body', async t => {
  let reads = 0;
  await rejectedWithoutReplacement(t, textResponse(VALID, { ok: false, text: async () => { reads++; return VALID; } }));
  assert.equal(reads, 0);
});

test('text-only injected fallback is supported but checked against UTF8 source bytes after it resolves', async t => {
  const large = VALID + ' '.repeat(LIMITS.sourceBytes - Buffer.byteLength(VALID) + 1);
  await rejectedWithoutReplacement(t, textResponse(large));
});

test('an excessive Content-Length rejects before reading even a small text fallback', async t => {
  let reads = 0;
  await rejectedWithoutReplacement(t, textResponse(VALID, { headers: new Headers({ 'Content-Length': String(LIMITS.sourceBytes + 1) }),
    text: async () => { reads++; return VALID; } }));
  assert.equal(reads, 0);
});

test('malformed or unsafe Content-Length fails closed before consuming the response', async t => {
  let reads = 0;
  for (const declared of ['', '-1', '1.5', 'not-a-number', '9007199254740992']) {
    await rejectedWithoutReplacement(t, textResponse(VALID, {
      headers: new Headers({ 'Content-Length': declared }),
      text: async () => { reads++; return VALID; },
    }));
  }
  assert.equal(reads, 0);
});

test('a low Content-Length cannot bypass actual stream byte accounting or cancellation', async t => {
  let cancelled = 0, textReads = 0;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(VALID));
    controller.enqueue(new Uint8Array(LIMITS.sourceBytes).fill(32));
  }, cancel() { cancelled++; } });
  await rejectedWithoutReplacement(t, textResponse(VALID, { body, headers: new Headers({ 'Content-Length': '1' }),
    text: async () => { textReads++; return VALID; } }));
  assert.equal(textReads, 0);
  assert.equal(cancelled, 1);
});

test('stream decoding preserves multibyte names split at every byte and does not use text fallback', async t => {
  const f = await fixture(t);
  let textReads = 0;
  const bytes = new TextEncoder().encode(script([row('000001', '量化😀/增强+', 'P*YIN')]));
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  await f.module.refreshFundCatalog({ fetchFn: async () => textResponse(script([row('000001', 'wrong-fallback')]),
    { body, text: async () => { textReads++; return script([row('000001', 'wrong-fallback')]); } }) });
  assert.equal(textReads, 0);
  assert.equal(JSON.parse(await readFile(f.target, 'utf8'))[0].name, '量化😀/增强+');
});

test('a stream read error never retries through response.text or replaces the old catalog', async t => {
  let textReads = 0;
  const body = new ReadableStream({ start(controller) { controller.error(new Error('synthetic stream read failure')); } });
  await rejectedWithoutReplacement(t, textResponse(VALID, { body, text: async () => { textReads++; return VALID; } }));
  assert.equal(textReads, 0);
});

test('getReader failure never falls back to a second response consumer', async t => {
  let textReads = 0;
  await rejectedWithoutReplacement(t, textResponse(VALID, { body: { getReader() { throw new Error('synthetic reader acquisition failure'); } },
    text: async () => { textReads++; return VALID; } }));
  assert.equal(textReads, 0);
});

test('malformed UTF8 in a stream fails closed without publishing', async t => {
  const bytes = Buffer.concat([Buffer.from('var r = [["000001","A","'), Buffer.from([0xc3, 0x28]), Buffer.from('"]];')]);
  // A replacement decoder would create valid JSON and publish a corrupted name.
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  await rejectedWithoutReplacement(t, textResponse(VALID, { body }));
});

test('a fetch ignoring abort rejects at its deadline and cannot publish a late valid response', async t => {
  const f = await fixture(t), delayed = deferred();
  let signal, state = 'pending', cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = f.module.refreshFundCatalog({ fetchFn: (_url, options) => { signal = options.signal; return delayed.promise; } });
  request.then(() => { state = 'fulfilled'; }, () => { state = 'rejected'; });
  await flush();
  t.mock.timers.tick(LIMITS.timeoutMs);
  await flush();
  const atDeadline = state;
  delayed.resolve(textResponse(VALID, { body }));
  await Promise.allSettled([request]);
  await flush();
  const preserved = hash(await readFile(f.target)) === hash(SENTINEL);
  assert.deepEqual({ atDeadline, preserved, aborted: signal.aborted, cancelled },
    { atDeadline: 'rejected', preserved: true, aborted: true, cancelled: 1 });
  await f.unchanged();
});

test('a body consumer ignoring abort cannot publish text after the deadline', async t => {
  const f = await fixture(t), delayed = deferred();
  let state = 'pending';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = f.module.refreshFundCatalog({ fetchFn: async () => textResponse('', { text: () => delayed.promise }) });
  request.then(() => { state = 'fulfilled'; }, () => { state = 'rejected'; });
  await flush();
  t.mock.timers.tick(LIMITS.timeoutMs);
  await flush();
  const atDeadline = state;
  delayed.resolve(VALID);
  await Promise.allSettled([request]);
  await flush();
  assert.deepEqual({ atDeadline, preserved: hash(await readFile(f.target)) === hash(SENTINEL) },
    { atDeadline: 'rejected', preserved: true });
  await f.unchanged();
});

test('a genuinely pending native stream is cancelled at the deadline without reading text or publishing', async t => {
  const f = await fixture(t);
  let signal, textReads = 0, cancelled = 0, state = 'pending';
  const body = new ReadableStream({ pull() {}, cancel() { cancelled++; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = f.module.refreshFundCatalog({ fetchFn: async (_url, options) => {
    signal = options.signal;
    return textResponse(VALID, { body, text: async () => { textReads++; return VALID; } });
  } });
  request.then(() => { state = 'fulfilled'; }, () => { state = 'rejected'; });
  await flush();
  assert.equal(state, 'pending');
  t.mock.timers.tick(LIMITS.timeoutMs);
  await flush();
  await Promise.allSettled([request]);
  assert.deepEqual({ state, aborted: signal.aborted, cancelled, textReads },
    { state: 'rejected', aborted: true, cancelled: 1, textReads: 0 });
  await f.unchanged();
});

test('output bytes are independently bounded even when source, row and field budgets pass', async t => {
  const rows = Array.from({ length: LIMITS.rows }, (_, index) => row(String(index).padStart(6, '0'), 'N'.repeat(LIMITS.nameLength), 'X'));
  const input = script(rows);
  assert.ok(Buffer.byteLength(input) < LIMITS.sourceBytes);
  const outputBytes = Buffer.byteLength(JSON.stringify(rows.map(item => ({ code: item[0], name: item[2], pinyin: item[1] }))));
  assert.ok(outputBytes > LIMITS.outputBytes);
  await rejectedWithoutReplacement(t, textResponse(input));
});

test('rename failure cleans the owned temporary sibling and does not damage an existing destination directory', async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.module.refreshFundCatalog({ fetchFn: async () => textResponse(VALID) }));
  await f.unchanged();
});

test('elapsed monotonic deadline rejects before publication even when a blocked timer has not fired', async t => {
  const f = await fixture(t);
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  await assert.rejects(f.module.refreshFundCatalog({ fetchFn: async () => {
    // Simulate synchronous work starving the timers queue, without blocking the
    // real test process for 20 seconds or changing Date/system time.
    elapsed = LIMITS.timeoutMs + 1;
    return textResponse(VALID);
  } }));
  await f.unchanged();
});

test('ready empty stream chunks cannot starve the monotonic deadline until EOF', async t => {
  const f = await fixture(t);
  let elapsed = 0, pulls = 0, cancelled = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      elapsed += 10001;
      if (pulls < 5) controller.enqueue(new Uint8Array());
      else { controller.enqueue(new TextEncoder().encode(VALID)); controller.close(); }
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  await assert.rejects(f.module.refreshFundCatalog({ fetchFn: async () => textResponse(VALID, { body }) }));
  assert.deepEqual({ pulls, cancelled }, { pulls: 2, cancelled: 1 });
  await f.unchanged();
});

test('fragment retention is independent of empty or one-byte chunk count and decode excludes unused capacity', async t => {
  const f = await fixture(t);
  const bytes = new TextEncoder().encode(VALID);
  const concatenatedLengths = [], decodedLengths = [];
  const originalConcat = Buffer.concat;
  const originalDecode = TextDecoder.prototype.decode;
  t.mock.method(Buffer, 'concat', function (chunks, ...args) {
    concatenatedLengths.push(chunks.length);
    return Reflect.apply(originalConcat, this, [chunks, ...args]);
  });
  t.mock.method(TextDecoder.prototype, 'decode', function (input, ...args) {
    decodedLengths.push(input?.byteLength ?? 0);
    return Reflect.apply(originalDecode, this, [input, ...args]);
  });
  let emitted = 0;
  const body = new ReadableStream({ pull(controller) {
    if (emitted < 4096) controller.enqueue(new Uint8Array());
    else if (emitted < 4096 + bytes.length) controller.enqueue(bytes.subarray(emitted - 4096, emitted - 4095));
    else controller.close();
    emitted++;
  } }, { highWaterMark: 0 });
  await f.module.refreshFundCatalog({ fetchFn: async () => textResponse(VALID, { body }) });
  assert.deepEqual(JSON.parse(await readFile(f.target, 'utf8')), [{ code: '000001', name: '合成基金/增强+', pinyin: 'PIN*YIN' }]);
  // Deterministic implementation guard, not a heap/GC benchmark: the old
  // per-fragment list reaches thousands of entries even with a tiny payload.
  assert.ok(concatenatedLengths.every(length => length <= 1), 'No retained per-fragment aggregation list.');
  assert.equal(decodedLengths.reduce((sum, size) => sum + size, 0), bytes.length, 'Decode only initialized source bytes.');
});

test('native stream accepts the exact source byte limit with legal trailing padding', async t => {
  const f = await fixture(t);
  const bytes = new TextEncoder().encode(VALID);
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(bytes);
    controller.enqueue(new Uint8Array(LIMITS.sourceBytes - bytes.length).fill(32));
    controller.close();
  } });
  await f.module.refreshFundCatalog({ fetchFn: async () => textResponse(VALID, { body }) });
  assert.equal(JSON.parse(await readFile(f.target, 'utf8'))[0].name, '合成基金/增强+');
});
