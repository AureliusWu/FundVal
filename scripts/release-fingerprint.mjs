import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateOcrAssetManifest } from '../js/ocr/asset-manifest.js';

export const RELEASE_CRITICAL_PATHS = Object.freeze([
  'index.html',
  'manifest.json',
  'sw.js',
  'js/app-shell.js',
  'js/version.js',
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

async function readRegularFileInsideRoot(root, rootRealPath, relativePath) {
  const safePath = assertSafeReleasePath(relativePath);
  const candidate = resolve(root, safePath);
  const rootRelative = relative(root, candidate);
  if (!rootRelative || rootRelative === '..' || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) {
    throw new Error('Release fingerprint path escaped its root.');
  }
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Release fingerprint path is not a regular file: ${safePath}`);
  }
  const realCandidate = await realpath(candidate);
  const realRelative = relative(rootRealPath, realCandidate);
  if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error('Release fingerprint path escaped its root.');
  }
  const content = await readFile(realCandidate);
  if (content.length !== metadata.size) {
    throw new Error(`Release fingerprint file changed while reading: ${safePath}`);
  }
  return content;
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
