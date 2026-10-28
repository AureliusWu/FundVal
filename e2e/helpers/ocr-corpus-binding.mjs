import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { validateOcrAssetManifest, OCR_ENGINE_VERSION, OCR_ORT_VERSION } from '../../js/ocr/asset-manifest.js';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['ocr-import.html', 'css/style.css', 'css/ocr.css', 'js/ocr-import-page.js', 'js/paddle-local-ocr.js',
  'js/alipay-ocr-parser.js', 'js/ocr-table-layout.js', 'js/fund-catalog.js', 'js/holding-import-plan.js',
  'js/ocr/asset-manifest.js', 'js/ocr/capability.js', 'js/ocr/engine.js', 'js/ocr/image-header.js',
  'js/ocr/import-transaction.js', 'js/ocr/page-guard.js', 'js/ocr/performance-ledger.js',
  'js/ocr/preprocess-client.js', 'js/ocr/preprocess-worker.js', 'js/resilience.js', 'js/integrity.js', 'js/storage.js',
  'js/storage/holdings-schema.js', 'js/storage/holdings-migration.js', 'js/storage/holdings-repository.js', 'data/fund-catalog.json'];

/** Checks current source copies and real assets. This does not pretend to
 * reconstruct a missing build-input receipt or prove an immutable full tree. */
export async function bindOcrSource(root) {
  const files = [];
  for (const file of paths) {
    const raw = await readFile(resolve(root, file)), site = await readFile(resolve(root, 'site', file)), digest = sha256(raw);
    if (digest !== sha256(site)) throw new Error('OCR source/site mismatch: ' + file);
    files.push({ file, bytes: raw.length, sha256: digest });
  }
  for (const file of ['scripts/paddle-ocr-entry.mjs', 'scripts/build-paddle-ocr.mjs', 'scripts/build-site.mjs', 'package.json', 'package-lock.json']) {
    const raw = await readFile(resolve(root, file)); files.push({ file, bytes: raw.length, sha256: sha256(raw) });
  }
  const packages = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (packages.dependencies?.['@paddleocr/paddleocr-js'] !== OCR_ENGINE_VERSION || packages.dependencies?.['onnxruntime-web'] !== OCR_ORT_VERSION) {
    throw new Error('OCR exact package pins differ from browser manifest contract');
  }
  const manifestBytes = await readFile(resolve(root, 'site/assets/ocr/asset-manifest.json'));
  const manifest = validateOcrAssetManifest(JSON.parse(manifestBytes), { engineVersion: OCR_ENGINE_VERSION, ortVersion: OCR_ORT_VERSION });
  if (manifest.assets.length !== 23) throw new Error('OCR asset set changed; separately qualify a new corpus runtime');
  const assets = [];
  for (const asset of manifest.assets) {
    const file = 'site/assets/ocr/' + asset.path, raw = await readFile(resolve(root, file)), digest = sha256(raw);
    if (raw.length !== asset.bytes || digest !== asset.sha256) throw new Error('OCR manifest/asset mismatch');
    assets.push({ file, bytes: raw.length, sha256: digest });
  }
  return { scope: 'CURRENT_OCR_SOURCE_SITE_AND_ASSETS_NOT_FULL_TREE_FREEZE',
    buildInputProvenance: 'CURRENT_BUILDER_HASHES_RECORDED_NOT_AN_INDEPENDENT_BUILD_INPUT_RECEIPT',
    files, manifestSha256: sha256(manifestBytes), assets,
    fingerprint: sha256(JSON.stringify({ files, assets, manifest: sha256(manifestBytes) })) };
}
