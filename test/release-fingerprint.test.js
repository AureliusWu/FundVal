import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalModelAssetSignature } from '../js/ocr/asset-manifest.js';
import {
  RELEASE_CRITICAL_PATHS,
  fingerprintReleaseDirectory,
  listOcrAssetPaths,
  verifyOcrReleaseDirectory,
} from '../scripts/release-fingerprint.mjs';

assert.ok(RELEASE_CRITICAL_PATHS.includes('manifest.json'));
assert.ok(RELEASE_CRITICAL_PATHS.includes('js/ocr/performance-ledger.js'));

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createFixture(root, suffix = '') {
  for (const relativePath of RELEASE_CRITICAL_PATHS) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${relativePath}:${suffix}`, 'utf8');
  }
}

async function createOcrFixture(root) {
  const definitions = [
    ['paddle/engine/assets/fundval-paddle-worker.js', 'worker', 'worker'],
    ['paddle/engine/paddle-ocr-engine.mjs', 'engine', 'engine'],
    ['paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar', 'model', 'det'],
    ['paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar', 'model', 'recognition'],
    ['paddle/ort/runtime.mjs', 'runtime', 'runtime'],
  ];
  const assets = definitions.map(([path, role, content]) => ({
    path,
    role,
    bytes: Buffer.byteLength(content),
    sha256: digest(content),
  }));
  for (const [path, , content] of definitions) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  const manifest = {
    engine: 'paddleocr-js',
    engine_version: '0.4.2',
    model: 'PP-OCRv6-tiny',
    model_hash: digest(canonicalModelAssetSignature(assets)),
    ort_version: '1.27.0',
    generated_at: '2026-08-29T00:00:00.000Z',
    assets,
  };
  const manifestPath = join(root, 'asset-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  return { definitions, manifestPath };
}

test('release fingerprint binds every critical path, length and deployed byte deterministically', async () => {
  const first = await mkdtemp(join(tmpdir(), 'fundval-release-first-'));
  const second = await mkdtemp(join(tmpdir(), 'fundval-release-second-'));
  try {
    await Promise.all([createFixture(first), createFixture(second)]);
    const baseline = await fingerprintReleaseDirectory(first);
    assert.match(baseline, /^[0-9a-f]{64}$/);
    assert.equal(await fingerprintReleaseDirectory(second), baseline);

    for (const changedPath of RELEASE_CRITICAL_PATHS) {
      await writeFile(join(second, changedPath), 'changed-release-bytes', 'utf8');
      assert.notEqual(await fingerprintReleaseDirectory(second), baseline, changedPath);
      await writeFile(join(second, changedPath), `${changedPath}:`, 'utf8');
    }
  } finally {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ]);
  }
});

test('release fingerprint fails closed on missing, empty, duplicate and escaping paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fundval-release-guards-'));
  try {
    await createFixture(root);
    await rm(join(root, RELEASE_CRITICAL_PATHS[0]));
    await assert.rejects(() => fingerprintReleaseDirectory(root), /ENOENT/);
    await assert.rejects(() => fingerprintReleaseDirectory(root, []), /non-empty array/);
    await assert.rejects(() => fingerprintReleaseDirectory(root, ['../outside']), /escaped its root/);
    await assert.rejects(
      () => fingerprintReleaseDirectory(root, [resolve(root, 'absolute')]),
      /normalized relative|escaped its root/
    );
    await assert.rejects(
      () => fingerprintReleaseDirectory(root, ['manifest.json', 'manifest.json']),
      /Duplicate release fingerprint path/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deployed OCR verification checks every validated manifest asset byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fundval-ocr-release-'));
  try {
    const { definitions, manifestPath } = await createOcrFixture(root);
    assert.deepEqual(await listOcrAssetPaths(manifestPath), definitions.map(([path]) => path));
    const verified = await verifyOcrReleaseDirectory(root);
    assert.equal(verified.assetCount, definitions.length);
    assert.equal(verified.totalBytes, definitions.reduce((total, [, , content]) => total + Buffer.byteLength(content), 0));

    await writeFile(join(root, definitions[0][0]), 'stale-worker-bytes', 'utf8');
    await assert.rejects(() => verifyOcrReleaseDirectory(root), /failed manifest verification/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
