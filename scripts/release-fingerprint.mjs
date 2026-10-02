import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { validateOcrAssetManifest } from '../js/ocr/asset-manifest.js';

// Fixed v15.0.2 M0 anchor, not a value supplied by editable artifact metadata.
const APP_BUNDLE_BASELINE_COMMIT = '40e68edab9cb3fba0b17338dc3672a82d13ad17e';
const APP_BUNDLE_BASELINE_ALL_GZIP_BYTES = 70_207;
const APP_BUNDLE_COLD_GZIP_BUDGET = 52_241;
const APP_BUNDLE_ALL_BUDGET_NUMERATOR = APP_BUNDLE_BASELINE_ALL_GZIP_BYTES * 11;
const APP_BUNDLE_ALL_BUDGET_DENOMINATOR = 10;

export const RELEASE_CRITICAL_PATHS = Object.freeze([
  'index.html',
  'manifest.json',
  'sw.js',
  'js/app-shell.js',
  'js/app-chunks.json',
  'js/version.js',
  'js/update-compat.js',
  'quote-bridge.html',
  'js/sandbox/quote-bridge-runtime.js',
  'ocr-import.html',
  'js/ocr-import-page.js',
  'js/ocr/performance-ledger.js',
  'js/paddle-local-ocr.js',
  'assets/ocr/asset-manifest.json',
  'assets/ocr/paddle/engine/paddle-ocr-engine.mjs',
  'assets/ocr/paddle/engine/assets/fundval-paddle-worker.js',
]);

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertSafeReleasePath(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.includes('\\')) {
    throw new Error('Release fingerprint paths must be non-empty normalized relative paths.');
  }
  if (isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Release fingerprint path escaped its root.');
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Release fingerprint path escaped its root.');
  }
  return value;
}

function assertInsideRoot(root, candidate) {
  const rootRelative = relative(root, candidate);
  if (!rootRelative || rootRelative === '..' || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) {
    throw new Error('Release fingerprint path escaped its root.');
  }
}

async function assertRegularDirectoryInsideRoot(root, rootRealPath, relativePath) {
  const segments = assertSafeReleasePath(relativePath).split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const path = segments.slice(0, index).join('/');
    const candidate = resolve(root, path);
    assertInsideRoot(root, candidate);
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Release fingerprint path is not a regular directory (symlinks are forbidden): ${path}`);
    }
    assertInsideRoot(rootRealPath, await realpath(candidate));
  }
}

async function readRegularFileInsideRoot(root, rootRealPath, relativePath) {
  const safePath = assertSafeReleasePath(relativePath);
  const candidate = resolve(root, safePath);
  assertInsideRoot(root, candidate);
  const segments = safePath.split('/');
  if (segments.length > 1) await assertRegularDirectoryInsideRoot(root, rootRealPath, segments.slice(0, -1).join('/'));
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Release fingerprint path is not a regular file: ${safePath}`);
  }
  const realCandidate = await realpath(candidate);
  assertInsideRoot(rootRealPath, realCandidate);
  const handle = await open(realCandidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    const current = await lstat(candidate);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
      || opened.ino !== metadata.ino || opened.dev !== metadata.dev
      || opened.ino !== current.ino || opened.dev !== current.dev) {
      throw new Error(`Release fingerprint file changed while reading: ${safePath}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (content.length !== opened.size || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new Error(`Release fingerprint file changed while reading: ${safePath}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

export async function fingerprintReleaseDirectory(directory, paths = RELEASE_CRITICAL_PATHS) {
  const root = resolve(String(directory || ''));
  const rootRealPath = await realpath(root);
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('Release fingerprint paths must be a non-empty array.');
  }
  const seen = new Set();
  const aggregate = createHash('sha256');
  for (const relativePath of paths) {
    const safePath = assertSafeReleasePath(relativePath);
    if (seen.has(safePath)) throw new Error(`Duplicate release fingerprint path: ${safePath}`);
    seen.add(safePath);
    const content = await readRegularFileInsideRoot(root, rootRealPath, safePath);
    aggregate.update(safePath);
    aggregate.update('\0');
    aggregate.update(String(content.length));
    aggregate.update('\0');
    aggregate.update(hashBytes(content));
    aggregate.update('\n');
  }
  return aggregate.digest('hex');
}

async function readValidatedOcrManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(resolve(String(manifestPath || '')), 'utf8'));
  return validateOcrAssetManifest(manifest);
}

function validateAppChunkManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || manifest.entry !== 'js/app-shell.js'
    || !Array.isArray(manifest.coldStart) || !Array.isArray(manifest.lazy)
    || !Array.isArray(manifest.chunks) || manifest.chunks.length < 2 || manifest.chunks.length > 64) {
    throw new Error('App chunk manifest is invalid.');
  }
  const paths = new Set();
  const chunks = manifest.chunks.map(chunk => {
    const path = assertSafeReleasePath(chunk?.path);
    if (!/^js\/(?:app-shell|chunks\/[A-Za-z0-9._-]+)\.js$/.test(path)
      || !['cold', 'lazy'].includes(chunk?.role)
      || !Number.isSafeInteger(chunk?.bytes) || chunk.bytes <= 0
      || !Number.isSafeInteger(chunk?.gzipBytes) || chunk.gzipBytes <= 0
      || !/^[0-9a-f]{64}$/.test(String(chunk?.sha256 || ''))
      || paths.has(path)) {
      throw new Error('App chunk manifest contains an invalid chunk.');
    }
    paths.add(path);
    return Object.freeze({
      path,
      role: chunk.role,
      bytes: chunk.bytes,
      gzipBytes: chunk.gzipBytes,
      sha256: chunk.sha256,
    });
  });
  const cold = new Set(manifest.coldStart);
  const lazy = new Set(manifest.lazy);
  if (!paths.has(manifest.entry)
    || !cold.has(manifest.entry)
    || cold.size !== manifest.coldStart.length || lazy.size !== manifest.lazy.length
    || manifest.coldStart.some(path => !paths.has(path))
    || manifest.lazy.some(path => !paths.has(path))
    || [...cold].some(path => lazy.has(path))
    || chunks.some(chunk => (chunk.role === 'cold' ? !cold.has(chunk.path) : !lazy.has(chunk.path)))
    || new Set([...manifest.coldStart, ...manifest.lazy]).size !== paths.size) {
    throw new Error('App chunk manifest graph is inconsistent.');
  }
  return Object.freeze({
    ...manifest,
    coldStart: Object.freeze([...manifest.coldStart]),
    lazy: Object.freeze([...manifest.lazy]),
    chunks: Object.freeze(chunks),
  });
}

export async function readValidatedAppChunkManifest(manifestPath) {
  const path = resolve(String(manifestPath || ''));
  const root = resolve(path, '..');
  const rootRealPath = await realpath(root);
  const manifestBytes = await readRegularFileInsideRoot(root, rootRealPath, relative(root, path).split(sep).join('/'));
  return validateAppChunkManifest(JSON.parse(manifestBytes.toString('utf8')));
}

export async function listAppChunkPaths(manifestPath) {
  return (await readValidatedAppChunkManifest(manifestPath)).chunks.map(chunk => chunk.path);
}

export async function verifyAppChunkReleaseDirectory(directory) {
  const root = resolve(String(directory || ''));
  const rootRealPath = await realpath(root);
  const manifestBytes = await readRegularFileInsideRoot(root, rootRealPath, 'js/app-chunks.json');
  const manifest = validateAppChunkManifest(JSON.parse(manifestBytes.toString('utf8')));
  const listed = new Set(manifest.chunks.map(chunk => chunk.path));
  const actual = new Set(['js/app-shell.js']);
  async function walkChunks(directoryPath) {
    await assertRegularDirectoryInsideRoot(root, rootRealPath, directoryPath);
    for (const name of await readdir(resolve(root, directoryPath))) {
      const path = assertSafeReleasePath(`${directoryPath}/${name}`);
      const metadata = await lstat(resolve(root, path));
      if (metadata.isSymbolicLink()) throw new Error(`App chunk directory contains a forbidden symlink: ${path}`);
      if (metadata.isDirectory()) await walkChunks(path);
      else if (metadata.isFile()) {
        if (!listed.has(path)) throw new Error(`Unlisted app chunk file: ${path}`);
        actual.add(path);
      } else throw new Error(`App chunk path is not a regular file: ${path}`);
    }
  }
  await walkChunks('js/chunks');
  if (actual.size !== listed.size || [...listed].some(path => !actual.has(path))) {
    throw new Error('App chunk directory is missing listed files.');
  }
  let totalBytes = 0;
  let actualColdStartGzipBytes = 0;
  let actualAllNonOcrGzipBytes = 0;
  for (const chunk of manifest.chunks) {
    const content = await readRegularFileInsideRoot(root, rootRealPath, chunk.path);
    if (content.length !== chunk.bytes || hashBytes(content) !== chunk.sha256) {
      throw new Error(`Deployed app chunk failed manifest verification: ${chunk.path}`);
    }
    const gzipBytes = gzipSync(content).length;
    if (gzipBytes !== chunk.gzipBytes) {
      throw new Error(`Deployed app chunk gzip failed manifest verification: ${chunk.path}`);
    }
    totalBytes += content.length;
    actualAllNonOcrGzipBytes += gzipBytes;
    if (chunk.role === 'cold') actualColdStartGzipBytes += gzipBytes;
  }
  // This verifies byte accounting and the complete declared partition. The real
  // import/static closure and startup isolation still require build-site's graph verifier.
  return { chunkCount: manifest.chunks.length, totalBytes, actualColdStartGzipBytes, actualAllNonOcrGzipBytes };
}

export function analyzeAppChunkBudgets(result) {
  const cold = result?.actualColdStartGzipBytes;
  const all = result?.actualAllNonOcrGzipBytes;
  if (!Number.isSafeInteger(cold) || cold <= 0 || !Number.isSafeInteger(all) || all < cold
    || !Number.isSafeInteger(all * APP_BUNDLE_ALL_BUDGET_DENOMINATOR)) {
    throw new Error('App bundle budget requires valid actual gzip measurements.');
  }
  const coldPass = cold <= APP_BUNDLE_COLD_GZIP_BUDGET;
  const allPass = all * APP_BUNDLE_ALL_BUDGET_DENOMINATOR <= APP_BUNDLE_ALL_BUDGET_NUMERATOR;
  return Object.freeze({
    baselineCommit: APP_BUNDLE_BASELINE_COMMIT,
    baselineAllNonOcrGzipBytes: APP_BUNDLE_BASELINE_ALL_GZIP_BYTES,
    actualColdStartGzipBytes: cold,
    actualAllNonOcrGzipBytes: all,
    coldBudgetBytes: APP_BUNDLE_COLD_GZIP_BUDGET,
    allBudgetNumerator: APP_BUNDLE_ALL_BUDGET_NUMERATOR,
    allBudgetDenominator: APP_BUNDLE_ALL_BUDGET_DENOMINATOR,
    allBudgetBytes: APP_BUNDLE_ALL_BUDGET_NUMERATOR / APP_BUNDLE_ALL_BUDGET_DENOMINATOR,
    coldPass,
    allPass,
    pass: coldPass && allPass,
    verdict: coldPass && allPass ? 'PASS' : 'FAIL',
    importClosureVerified: false,
  });
}

export function assertAppBundleBudget(result) {
  const report = analyzeAppChunkBudgets(result);
  const failures = [];
  if (!report.coldPass) failures.push(`cold gzip budget: ${report.actualColdStartGzipBytes} > ${report.coldBudgetBytes}`);
  if (!report.allPass) failures.push(`all non-OCR gzip budget: ${report.actualAllNonOcrGzipBytes} > ${report.allBudgetBytes}`);
  if (failures.length) throw new Error(`App bundle exceeds ${failures.join('; ')} bytes.`);
  return report;
}

export async function listOcrAssetPaths(manifestPath) {
  const manifest = await readValidatedOcrManifest(manifestPath);
  return manifest.assets.map(asset => asset.path);
}

export async function verifyOcrReleaseDirectory(directory) {
  const root = resolve(String(directory || ''));
  const rootRealPath = await realpath(root);
  const manifestBytes = await readRegularFileInsideRoot(root, rootRealPath, 'asset-manifest.json');
  const manifest = validateOcrAssetManifest(JSON.parse(manifestBytes.toString('utf8')));
  let totalBytes = 0;
  for (const asset of manifest.assets) {
    const content = await readRegularFileInsideRoot(root, rootRealPath, asset.path);
    if (content.length !== asset.bytes || hashBytes(content) !== asset.sha256) {
      throw new Error(`Deployed OCR asset failed manifest verification: ${asset.path}`);
    }
    totalBytes += content.length;
  }
  return { assetCount: manifest.assets.length, totalBytes };
}

async function main(args) {
  if (args.includes('--list')) {
    process.stdout.write(`${RELEASE_CRITICAL_PATHS.join('\n')}\n`);
    return;
  }
  const assertAppBudgetIndex = args.indexOf('--assert-app-bundle-budget');
  if (assertAppBudgetIndex >= 0) {
    const directory = args[assertAppBudgetIndex + 1];
    if (!directory) throw new Error('Usage: release-fingerprint.mjs --assert-app-bundle-budget <path>');
    const result = await verifyAppChunkReleaseDirectory(directory);
    process.stdout.write(`${JSON.stringify(analyzeAppChunkBudgets(result))}\n`);
    assertAppBundleBudget(result);
    return;
  }
  const listAppChunksIndex = args.indexOf('--list-app-chunks');
  if (listAppChunksIndex >= 0) {
    const manifestPath = args[listAppChunksIndex + 1];
    if (!manifestPath) throw new Error('Usage: release-fingerprint.mjs --list-app-chunks <manifest>');
    process.stdout.write(`${(await listAppChunkPaths(manifestPath)).join('\n')}\n`);
    return;
  }
  const verifyAppChunksIndex = args.indexOf('--verify-app-chunks-directory');
  if (verifyAppChunksIndex >= 0) {
    const directory = args[verifyAppChunksIndex + 1];
    if (!directory) throw new Error('Usage: release-fingerprint.mjs --verify-app-chunks-directory <path>');
    const result = await verifyAppChunkReleaseDirectory(directory);
    process.stdout.write(`Verified ${result.chunkCount} app chunks (${result.totalBytes} bytes).\n`);
    return;
  }
  const listOcrIndex = args.indexOf('--list-ocr-assets');
  if (listOcrIndex >= 0) {
    const manifestPath = args[listOcrIndex + 1];
    if (!manifestPath) throw new Error('Usage: release-fingerprint.mjs --list-ocr-assets <manifest>');
    process.stdout.write(`${(await listOcrAssetPaths(manifestPath)).join('\n')}\n`);
    return;
  }
  const verifyOcrIndex = args.indexOf('--verify-ocr-directory');
  if (verifyOcrIndex >= 0) {
    const directory = args[verifyOcrIndex + 1];
    if (!directory) throw new Error('Usage: release-fingerprint.mjs --verify-ocr-directory <path>');
    const result = await verifyOcrReleaseDirectory(directory);
    process.stdout.write(`Verified ${result.assetCount} OCR assets (${result.totalBytes} bytes).\n`);
    return;
  }
  const directoryIndex = args.indexOf('--directory');
  const directory = directoryIndex >= 0 ? args[directoryIndex + 1] : '';
  if (!directory) throw new Error('Usage: release-fingerprint.mjs --directory <path> | --list');
  process.stdout.write(`${await fingerprintReleaseDirectory(directory)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
