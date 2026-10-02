import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as release from '../scripts/release-fingerprint.mjs';

const cliPath = fileURLToPath(new URL('../scripts/release-fingerprint.mjs', import.meta.url));
const BASELINE_COMMIT = '40e68edab9cb3fba0b17338dc3672a82d13ad17e';

function measurement(cold = 52_241, all = 77_227) {
  return { chunkCount: 2, totalBytes: 100_000, actualColdStartGzipBytes: cold, actualAllNonOcrGzipBytes: all };
}

function noisyBytes(length) {
  const blocks = [];
  for (let index = 0; blocks.length * 32 < length; index += 1) {
    blocks.push(createHash('sha256').update(`synthetic-budget-${index}`).digest());
  }
  return Buffer.concat(blocks).subarray(0, length);
}

async function fixture(root, lazyContent = Buffer.from('export const feature = true;\n')) {
  const definitions = [
    ['js/app-shell.js', 'cold', Buffer.from('export const entry = true;\n')],
    ['js/chunks/feature-fixture.js', 'lazy', lazyContent],
  ];
  for (const [path, , content] of definitions) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const manifest = {
    schema: 1, entry: 'js/app-shell.js', coldStart: ['js/app-shell.js'], lazy: ['js/chunks/feature-fixture.js'],
    chunks: definitions.map(([path, role, bytes]) => ({ path, role, bytes: bytes.length,
      gzipBytes: gzipSync(bytes).length, sha256: createHash('sha256').update(bytes).digest('hex') })),
  };
  const path = join(root, 'js/app-chunks.json');
  await writeFile(path, JSON.stringify(manifest));
  return { path, manifest, definitions };
}

test('v16 budget analysis pins v15 baseline and compares exact integer ratios at boundaries', () => {
  assert.equal(typeof release.analyzeAppChunkBudgets, 'function');
  assert.equal(typeof release.assertAppBundleBudget, 'function');
  const equalCold = release.analyzeAppChunkBudgets(measurement());
  assert.equal(equalCold.baselineCommit, BASELINE_COMMIT);
  assert.equal(equalCold.baselineAllNonOcrGzipBytes, 70_207);
  assert.equal(equalCold.coldBudgetBytes, 52_241);
  assert.equal(equalCold.allBudgetNumerator, 772_277);
  assert.equal(equalCold.allBudgetDenominator, 10);
  assert.equal(equalCold.allBudgetBytes, 77_227.7);
  assert.equal(equalCold.pass, true);
  assert.ok(Object.isFrozen(equalCold));
  assert.equal(release.assertAppBundleBudget(measurement(52_240, 77_226)).pass, true);
  assert.equal(release.assertAppBundleBudget(measurement()).pass, true);
  assert.throws(() => release.assertAppBundleBudget(measurement(52_242, 77_227)), /cold.*budget/i);
  assert.throws(() => release.assertAppBundleBudget(measurement(52_241, 77_228)), /all.*budget/i);
  assert.equal(release.analyzeAppChunkBudgets({ ...measurement(52_241, 77_228), allBudgetBytes: 999_999, baselineAllNonOcrGzipBytes: 999_999 }).allPass, false);
  for (const invalid of [undefined, {}, measurement(-1, 1), measurement(10, 9), measurement(1.5, 10), measurement(1, Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => release.analyzeAppChunkBudgets(invalid), /measurement/i);
  }
});

test('actual app gzip rejects forged declarations without changing chunk bytes or SHA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fundval-budget-gzip-'));
  try {
    const { path, manifest } = await fixture(root);
    manifest.chunks[1].gzipBytes = 1;
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(() => release.verifyAppChunkReleaseDirectory(root), /gzip.*manifest verification/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('app chunk partition rejects duplicates, non-cold entry and incomplete lazy accounting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fundval-budget-partition-'));
  try {
    const { path, manifest } = await fixture(root);
    for (const field of ['bytes', 'gzipBytes']) {
      const candidate = structuredClone(manifest);
      candidate.chunks[0][field] = Number.MAX_SAFE_INTEGER + 1;
      await writeFile(path, JSON.stringify(candidate));
      await assert.rejects(() => release.readValidatedAppChunkManifest(path), /invalid chunk/);
    }
    const mutations = [
      candidate => candidate.coldStart.push(candidate.entry),
      candidate => candidate.lazy.push(candidate.lazy[0]),
      candidate => { candidate.coldStart = []; candidate.lazy.push(candidate.entry); candidate.chunks[0].role = 'lazy'; },
      candidate => { candidate.lazy = []; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      await writeFile(path, JSON.stringify(candidate));
      await assert.rejects(() => release.verifyAppChunkReleaseDirectory(root), /graph is inconsistent/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('app chunk directory must account for every actual lazy file, including non-JS files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fundval-budget-inventory-'));
  try {
    const { path, manifest } = await fixture(root);
    const omitted = structuredClone(manifest);
    omitted.lazy = [];
    omitted.chunks = omitted.chunks.filter(chunk => chunk.role === 'cold');
    await writeFile(path, JSON.stringify(omitted));
    await assert.rejects(() => release.verifyAppChunkReleaseDirectory(root), /invalid|unlisted/i);
    await writeFile(path, JSON.stringify(manifest));
    for (const extra of ['js/chunks/unlisted.js', 'js/chunks/unlisted.map', 'js/chunks/nested/unlisted.txt']) {
      await mkdir(dirname(join(root, extra)), { recursive: true });
      await writeFile(join(root, extra), 'unlisted synthetic bytes');
      await assert.rejects(() => release.verifyAppChunkReleaseDirectory(root), /unlisted app chunk file/i);
      await rm(join(root, extra));
    }
    const [entry] = manifest.chunks;
    const lazy = manifest.chunks[1];
    const omittedWithSecondChunk = {
      ...manifest, coldStart: [entry.path, 'js/chunks/cold-fixture.js'], lazy: [],
      chunks: [entry, { ...lazy, path: 'js/chunks/cold-fixture.js', role: 'cold' }],
    };
    await writeFile(join(root, 'js/chunks/cold-fixture.js'), await readFile(join(root, lazy.path)));
    await writeFile(path, JSON.stringify(omittedWithSecondChunk));
    await assert.rejects(() => release.verifyAppChunkReleaseDirectory(root), /unlisted app chunk file/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('app verification rejects directory symlinks even when they resolve within the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fundval-budget-links-'));
  try {
    await fixture(root);
    await mkdir(join(root, 'linked-target'));
    await symlink(resolve(root, 'linked-target'), join(root, 'js/chunks/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => release.verifyAppChunkReleaseDirectory(root), /symlink|regular directory/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('budget CLI emits measured JSON before failing and preserves structural verification without admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fundval-budget-cli-'));
  try {
    await fixture(root);
    const passed = spawnSync(process.execPath, [cliPath, '--assert-app-bundle-budget', root], { encoding: 'utf8' });
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).pass, true);
    await fixture(root, noisyBytes(80_000));
    const result = await release.verifyAppChunkReleaseDirectory(root);
    assert.ok(result.actualColdStartGzipBytes <= 52_241);
    assert.ok(result.actualAllNonOcrGzipBytes > 77_227.7);
    const failed = spawnSync(process.execPath, [cliPath, '--assert-app-bundle-budget', root], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.actualAllNonOcrGzipBytes, result.actualAllNonOcrGzipBytes);
    assert.equal(report.coldPass, true);
    assert.equal(report.allPass, false);
    assert.equal(report.pass, false);
    assert.match(failed.stderr, /all.*budget/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
