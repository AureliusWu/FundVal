import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalModelAssetSignature,
  isSafeOcrAssetPath,
  loadOcrAssetManifest,
  OCR_ENGINE_VERSION,
  OCR_ORT_VERSION,
  validateOcrAssetManifest,
} from '../js/ocr/asset-manifest.js';
import {
  PADDLE_ORT_RUNTIME_FILES,
  resolveOcrManifestTimestamp,
  verifyOcrAssetManifest,
  writeOcrAssetManifest,
} from '../scripts/build-paddle-ocr.mjs';

const ENGINE_VERSION = OCR_ENGINE_VERSION;
const ORT_VERSION = OCR_ORT_VERSION;
const FIXED_TIME = '2026-08-26T00:00:00.000Z';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sampleManifest() {
  const assets = [
    { path: 'paddle/engine/assets/fundval-paddle-worker.js', role: 'worker', bytes: 6, sha256: digest('worker') },
    { path: 'paddle/engine/paddle-ocr-engine.mjs', role: 'engine', bytes: 6, sha256: digest('engine') },
    { path: 'paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar', role: 'model', bytes: 3, sha256: digest('det') },
    { path: 'paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar', role: 'model', bytes: 3, sha256: digest('rec') },
    { path: 'paddle/ort/ort-wasm-simd-threaded.mjs', role: 'runtime', bytes: 7, sha256: digest('runtime') },
  ];
  return {
    engine: 'paddleocr-js',
    engine_version: ENGINE_VERSION,
    model: 'PP-OCRv6-tiny',
    model_hash: digest(canonicalModelAssetSignature(assets)),
    ort_version: ORT_VERSION,
    generated_at: FIXED_TIME,
    assets,
  };
}

async function writeFixtureFile(root, relativePath, content) {
  const path = join(root, 'site', 'assets', 'ocr', ...relativePath.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
}

async function createProductionFixture(t, { integrityEngine, integrityRuntime } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fundval-ocr-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'site');

  await writeFixtureFile(root, 'paddle/engine/assets/fundval-paddle-worker.js', 'worker');
  await writeFixtureFile(root, 'paddle/engine/paddle-ocr-engine.mjs', 'engine');
  const det = Buffer.from('det-model');
  const rec = Buffer.from('rec-model');
  await writeFixtureFile(root, 'paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar', det);
  await writeFixtureFile(root, 'paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar', rec);
  for (const filename of PADDLE_ORT_RUNTIME_FILES) {
    await writeFixtureFile(root, `paddle/ort/${filename}`, `runtime:${filename}`);
  }
  await writeFixtureFile(root, 'support/readme.txt', 'same-origin-only');
  await writeFixtureFile(root, 'paddle/models/integrity.json', `${JSON.stringify({
    engine: integrityEngine || `@paddleocr/paddleocr-js@${ENGINE_VERSION}`,
    runtime: integrityRuntime || `onnxruntime-web@${ORT_VERSION}`,
    models: [
      {
        filename: 'PP-OCRv6_tiny_det_onnx_infer.tar',
        bytes: det.byteLength,
        sha256: digest(det),
      },
      {
        filename: 'PP-OCRv6_tiny_rec_onnx_infer.tar',
        bytes: rec.byteLength,
        sha256: digest(rec),
      },
    ],
  }, null, 2)}\n`);

  return { root, output };
}

test('OCR asset paths are same-origin relative paths and reject URL or traversal syntax', () => {
  assert.equal(isSafeOcrAssetPath('paddle/models/model.tar'), true);
  for (const path of [
    '',
    '/assets/model.tar',
    '//cdn.example/model.tar',
    'https://cdn.example/model.tar',
    'data:model/onnx;base64,AA==',
    'C:/models/model.tar',
    '../model.tar',
    'paddle/../model.tar',
    'paddle\\model.tar',
    'paddle/%2e%2e/model.tar',
    'paddle/model.tar?download=1',
    'paddle/model.tar#sha',
    'paddle/model file.tar',
  ]) {
    assert.equal(isSafeOcrAssetPath(path), false, path);
  }
});

test('v15 OCR manifest has exactly the documented fields and a real build timestamp', () => {
  const manifest = sampleManifest();
  assert.equal(validateOcrAssetManifest(manifest, {
    engineVersion: ENGINE_VERSION,
    ortVersion: ORT_VERSION,
  }), manifest);
  assert.throws(
    () => validateOcrAssetManifest({ ...manifest, generated_at: null }),
    /canonical ISO timestamp/
  );
  assert.throws(
    () => validateOcrAssetManifest({ ...manifest, schema_version: 1 }),
    /fields do not match the v15 contract/
  );
  assert.throws(
    () => validateOcrAssetManifest({ ...manifest, assets: manifest.assets.map((asset, index) => (
      index === 0 ? { ...asset, url: 'https://cdn.example/worker.js' } : asset
    )) }),
    /fields do not match the v15 contract/
  );
});

test('runtime manifest loading binds to the exact browser runtime versions', async () => {
  const manifest = sampleManifest();
  const fetchManifest = value => async () => ({
    ok: true,
    json: async () => value,
  });
  await assert.doesNotReject(() => loadOcrAssetManifest({
    fetchImpl: fetchManifest(manifest),
    url: 'https://example.invalid/assets/ocr/asset-manifest.json',
  }));
  await assert.rejects(
    loadOcrAssetManifest({
      fetchImpl: fetchManifest({ ...manifest, ort_version: '1.26.0' }),
      url: 'https://example.invalid/assets/ocr/asset-manifest.json',
    }),
    error => error && error.code === 'manifest_invalid',
  );
});

for (const stage of ['fetch', 'body']) {
  test(`manifest ${stage} timeout aborts even when the transport ignores cancellation`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let fetchSignal;
    const pending = loadOcrAssetManifest({ timeoutMs: 20, fetchImpl: async (_, options) => {
      fetchSignal = options.signal;
      if (stage === 'fetch') return new Promise(() => {});
      return { ok: true, json: () => new Promise(() => {}) };
    } });
    const checked = assert.rejects(pending, error => error.code === 'fetch_timeout');
    t.mock.timers.tick(20);
    await checked;
    assert.equal(fetchSignal.aborted, true);
  });
}

test('manifest load honors cancellation and never starts an already cancelled fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(loadOcrAssetManifest({ signal: controller.signal,
    fetchImpl: () => { calls += 1; return new Promise(() => {}); },
  }), error => error.code === 'aborted');
  assert.equal(calls, 0);
});

test('OCR manifest timestamp uses SOURCE_DATE_EPOCH when supplied and current time otherwise', () => {
  assert.equal(resolveOcrManifestTimestamp('0'), '1970-01-01T00:00:00.000Z');
  assert.equal(resolveOcrManifestTimestamp('', Date.parse(FIXED_TIME)), FIXED_TIME);
  assert.throws(() => resolveOcrManifestTimestamp('-1'), /non-negative integer/);
  assert.throws(() => resolveOcrManifestTimestamp('not-a-time'), /non-negative integer/);
});

test('manifest generation inventories and verifies every deployed OCR file without requiring Tesseract assets', async t => {
  const fixture = await createProductionFixture(t);
  const manifest = await writeOcrAssetManifest({
    ...fixture,
    engineVersion: ENGINE_VERSION,
    ortVersion: ORT_VERSION,
    sourceDateEpoch: '0',
  });

  assert.deepEqual(Object.keys(manifest).sort(), [
    'assets',
    'engine',
    'engine_version',
    'generated_at',
    'model',
    'model_hash',
    'ort_version',
  ]);
  assert.equal(manifest.generated_at, '1970-01-01T00:00:00.000Z');
  assert.equal(manifest.assets.some(asset => asset.role === 'fallback'), false);
  assert.equal(manifest.assets.every(asset => isSafeOcrAssetPath(asset.path)), true);
  await verifyOcrAssetManifest({
    ...fixture,
    engineVersion: ENGINE_VERSION,
    ortVersion: ORT_VERSION,
  });
});

test('manifest verification fails closed when a same-size deployed file changes', async t => {
  const fixture = await createProductionFixture(t);
  await writeOcrAssetManifest({
    ...fixture,
    engineVersion: ENGINE_VERSION,
    ortVersion: ORT_VERSION,
    sourceDateEpoch: '0',
  });
  await writeFile(join(fixture.output, 'assets/ocr/paddle/engine/paddle-ocr-engine.mjs'), 'ENGINE');
  await assert.rejects(
    verifyOcrAssetManifest({ ...fixture, engineVersion: ENGINE_VERSION, ortVersion: ORT_VERSION }),
    /SHA-256 mismatch/
  );
});

test('manifest verification rejects a changed model_hash and missing deployed files', async t => {
  const fixture = await createProductionFixture(t);
  await writeOcrAssetManifest({
    ...fixture,
    engineVersion: ENGINE_VERSION,
    ortVersion: ORT_VERSION,
    sourceDateEpoch: '0',
  });
  const manifestPath = join(fixture.output, 'assets/ocr/asset-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.model_hash = 'f'.repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    verifyOcrAssetManifest({ ...fixture, engineVersion: ENGINE_VERSION, ortVersion: ORT_VERSION }),
    /model files do not match model_hash/
  );

  await writeFile(manifestPath, `${JSON.stringify(await writeOcrAssetManifest({
    ...fixture,
    engineVersion: ENGINE_VERSION,
    ortVersion: ORT_VERSION,
    sourceDateEpoch: '0',
  }), null, 2)}\n`);
  await unlink(join(fixture.output, 'assets/ocr/support/readme.txt'));
  await assert.rejects(
    verifyOcrAssetManifest({ ...fixture, engineVersion: ENGINE_VERSION, ortVersion: ORT_VERSION }),
    /asset is missing: support\/readme\.txt/
  );
});

test('manifest generation rejects model metadata whose engine or runtime version drifted', async t => {
  const fixture = await createProductionFixture(t, { integrityRuntime: 'onnxruntime-web@1.26.0' });
  await assert.rejects(
    writeOcrAssetManifest({
      ...fixture,
      engineVersion: ENGINE_VERSION,
      ortVersion: ORT_VERSION,
      sourceDateEpoch: '0',
    }),
    /runtime version mismatch/
  );
});
