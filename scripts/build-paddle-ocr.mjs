import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import {
  OCR_ASSET_MANIFEST_PATH,
  OCR_ENGINE_NAME,
  OCR_ENGINE_VERSION,
  OCR_MODEL_NAME,
  OCR_ORT_VERSION,
  assertSafeOcrAssetPath,
  canonicalModelAssetSignature,
  validateOcrAssetManifest,
} from '../js/ocr/asset-manifest.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(scriptDirectory, '..');

export const PADDLE_OCR_VENDOR_MODELS = Object.freeze({
  'PP-OCRv6_tiny_det_onnx_infer.tar': Object.freeze({
    bytes: 1_792_000,
    sha256: 'ff6ab415b0a6e0c488550f2fb5d5046f1719848df220b2dc21b56402a65bc05d',
  }),
  'PP-OCRv6_tiny_rec_onnx_infer.tar': Object.freeze({
    bytes: 4_526_080,
    sha256: '1e13b22717b1edd89d4cde4fda272b6c17d5b505c97c2baea99da1a3a2d54b29',
  }),
});

// POC verification showed the threaded SIMD loader can dynamically resolve
// these compatibility modules. JSPI is deliberately omitted because this app
// pins a one-thread WASM configuration and the real-browser POC did not need it.
export const PADDLE_ORT_RUNTIME_FILES = Object.freeze([
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
]);

const VENDOR_MODEL_DIRECTORY = 'vendor/paddle-ocr/models';
const OCR_ASSET_DIRECTORY = 'assets/ocr';
const PADDLE_OUTPUT_DIRECTORY = 'assets/ocr/paddle';
const paddleEntry = resolve(scriptDirectory, 'paddle-ocr-entry.mjs');

// FundVal owns the outer module Worker. Vite's default absolute base would
// silently make it deployment-root relative, which breaks GitHub Pages project
// paths. The page-facing facade references only our pinned copy of the official
// protocol Worker.
const ROOT_ABSOLUTE_WORKER_URL = /new URL\(\s*["']\/assets\/fundval-paddle-worker\.js["']\s*,\s*import\.meta\.url\s*\)/;
const RELATIVE_WORKER_URL = /new URL\(\s*["']((?:\.\/)?assets\/fundval-paddle-worker\.js)["']\s*,\s*import\.meta\.url\s*\)/;
const MAX_PAGE_FACADE_BYTES = 32 * 1024;
const OFFICIAL_PADDLE_WORKER_SHA256 = '477db3f009c118823a5f9ebe15f1e96c1c464165715ba28a9884290f61addf52';
const OFFICIAL_INIT_ORT_RUNTIME_START = 'async function initOrtRuntime(ortOptions = {}) {';
const OFFICIAL_INIT_ORT_RUNTIME_END = '\nasync function createSession(';
const OFFICIAL_INIT_ORT_RUNTIME_SHA256 = '988d19a4f35b8e08eca76c4890bda668ef14e91022242a52cb5ba49139ef4acd';
const CONTROLLED_INIT_ORT_RUNTIME = `async function initOrtRuntime(ortOptions = {}) {
  const backend = typeof ortOptions === "string" ? ortOptions : ortOptions.backend === "webgpu" || ortOptions.backend === "wasm" ? ortOptions.backend : "auto";
  const webgpuState = backend === "wasm" ? { available: false, reason: "FundVal explicit WASM backend." } : await detectWebGpuAvailability();
  const ort = await loadOrtModule();
  if (typeof ortOptions !== "string") {
    applyOrtEnvironmentOptions(ort, ortOptions);
  }
  return {
    ort,
    webgpuState,
    backend
  };
}
`;

function requirePathInsideRoot(root, candidate, description) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}\\`) && !resolvedCandidate.startsWith(`${resolvedRoot}/`)) {
    throw new Error(`${description} escaped the project root.`);
  }
  return resolvedCandidate;
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactlyOneIndex(source, anchor, description) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`PaddleOCR Worker ${description} drifted; review the controlled WASM patch.`);
  }
  return first;
}

/**
 * PaddleOCR 0.4.2 probes navigator.gpu even when its caller explicitly chose
 * WASM. FundVal owns the one allowed WebGPU attempt in LocalOcrEngine, so the
 * fallback Worker must bypass that package-level probe. This is deliberately
 * fail-closed: a vendor update that changes the exact pinned anchor stops the
 * build instead of silently restoring a second GPU request.
 */
export function patchPaddleWorkerForExplicitWasm(workerSource) {
  if (typeof workerSource !== 'string' || sha256Text(workerSource) !== OFFICIAL_PADDLE_WORKER_SHA256) {
    throw new Error('PaddleOCR Worker source changed; review the controlled WASM patch.');
  }
  const start = exactlyOneIndex(workerSource, OFFICIAL_INIT_ORT_RUNTIME_START, 'initOrtRuntime start anchor');
  const end = exactlyOneIndex(workerSource, OFFICIAL_INIT_ORT_RUNTIME_END, 'initOrtRuntime end anchor') + 1;
  if (end <= start) {
    throw new Error('PaddleOCR Worker initOrtRuntime boundaries are invalid.');
  }
  const originalInit = workerSource.slice(start, end);
  if (sha256Text(originalInit) !== OFFICIAL_INIT_ORT_RUNTIME_SHA256) {
    throw new Error('PaddleOCR Worker initOrtRuntime changed; review the controlled WASM patch.');
  }
  return `${workerSource.slice(0, start)}${CONTROLLED_INIT_ORT_RUNTIME}${workerSource.slice(end)}`;
}

function classifyOcrAsset(path) {
  if (path === 'paddle/engine/paddle-ocr-engine.mjs') return 'engine';
  if (path === 'paddle/engine/assets/fundval-paddle-worker.js') return 'worker';
  if (/^paddle\/models\/PP-OCRv6_tiny_(?:det|rec)_onnx_infer\.tar$/.test(path)) return 'model';
  if (path === 'paddle/models/integrity.json') return 'model_metadata';
  if (path.startsWith('paddle/ort/')) return 'runtime';
  if (path.startsWith('tesseract/') || path.startsWith('tesseract-core/') || path.startsWith('tessdata/')) return 'fallback';
  if (path.startsWith('licenses/')) return 'license';
  return 'support';
}

function exactDependencyVersion(packageJson, dependencyName) {
  const version = packageJson?.dependencies?.[dependencyName];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${dependencyName} must use an exact dependency version for the OCR manifest.`);
  }
  return version;
}

async function readPackageJson(path, description) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${description}: ${error?.message || String(error)}`);
  }
  return parsed;
}

async function readPinnedOcrVersions(root) {
  const packageJson = await readPackageJson(resolve(root, 'package.json'), 'project package.json');
  const engineVersion = exactDependencyVersion(packageJson, '@paddleocr/paddleocr-js');
  const ortVersion = exactDependencyVersion(packageJson, 'onnxruntime-web');
  const [installedEngine, installedOrt] = await Promise.all([
    readPackageJson(resolve(root, 'node_modules/@paddleocr/paddleocr-js/package.json'), 'installed PaddleOCR package metadata'),
    readPackageJson(resolve(root, 'node_modules/onnxruntime-web/package.json'), 'installed ONNX Runtime package metadata'),
  ]);
  if (installedEngine.version !== engineVersion) {
    throw new Error(`Installed PaddleOCR version ${String(installedEngine.version)} does not match package.json ${engineVersion}.`);
  }
  if (installedOrt.version !== ortVersion) {
    throw new Error(`Installed ONNX Runtime version ${String(installedOrt.version)} does not match package.json ${ortVersion}.`);
  }
  if (engineVersion !== OCR_ENGINE_VERSION || ortVersion !== OCR_ORT_VERSION) {
    throw new Error('Runtime OCR manifest version pins do not match package.json.');
  }
  return { engineVersion, ortVersion };
}

async function resolvePinnedOcrVersions(root, engineVersion, ortVersion) {
  const supplied = engineVersion !== undefined || ortVersion !== undefined;
  if (!supplied) return readPinnedOcrVersions(root);
  if (
    typeof engineVersion !== 'string' ||
    typeof ortVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(engineVersion) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(ortVersion)
  ) {
    throw new Error('Both OCR engine and runtime versions must be supplied as exact versions.');
  }
  return { engineVersion, ortVersion };
}

export function resolveOcrManifestTimestamp(
  sourceDateEpoch = process.env.SOURCE_DATE_EPOCH,
  now = Date.now()
) {
  if (sourceDateEpoch === undefined || sourceDateEpoch === null || sourceDateEpoch === '') {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('OCR manifest build time must be a non-negative millisecond timestamp.');
    }
    try {
      return new Date(now).toISOString();
    } catch {
      throw new Error('OCR manifest build time is outside the supported date range.');
    }
  }
  if (!/^\d+$/.test(String(sourceDateEpoch))) {
    throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer number of seconds.');
  }
  const epoch = Number(sourceDateEpoch);
  if (!Number.isSafeInteger(epoch)) throw new Error('SOURCE_DATE_EPOCH is outside the safe integer range.');

  let generatedAt;
  try {
    generatedAt = new Date(epoch * 1000).toISOString();
  } catch {
    throw new Error('SOURCE_DATE_EPOCH is outside the supported date range.');
  }
  return generatedAt;
}

async function collectOcrAssets(directory, prefix = '') {
  const assets = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    assertSafeOcrAssetPath(relativePath);
    const absolutePath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`OCR production assets may not contain symbolic links: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      assets.push(...await collectOcrAssets(absolutePath, relativePath));
    } else if (entry.isFile() && relativePath !== 'asset-manifest.json') {
      const metadata = await stat(absolutePath);
      assets.push({
        path: relativePath,
        role: classifyOcrAsset(relativePath),
        bytes: metadata.size,
        sha256: await sha256File(absolutePath),
      });
    } else if (!entry.isFile()) {
      throw new Error(`Unsupported OCR production asset type: ${relativePath}`);
    }
  }
  return assets.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function assertPinnedProductionAssets(assets) {
  const paths = new Set(assets.map(asset => asset.path));
  for (const path of [
    'paddle/engine/paddle-ocr-engine.mjs',
    'paddle/engine/assets/fundval-paddle-worker.js',
    ...Object.keys(PADDLE_OCR_VENDOR_MODELS).map(filename => `paddle/models/${filename}`),
    'paddle/models/integrity.json',
    ...PADDLE_ORT_RUNTIME_FILES.map(filename => `paddle/ort/${filename}`),
  ]) {
    if (!paths.has(path)) throw new Error(`Missing required production OCR asset: ${path}`);
  }
}

function assertManifestMatchesAssets(expectedAssets, actualAssets) {
  const actualByPath = new Map(actualAssets.map(asset => [asset.path, asset]));
  for (const expected of expectedAssets) {
    const actual = actualByPath.get(expected.path);
    if (!actual) throw new Error(`OCR manifest asset is missing: ${expected.path}`);
    if (actual.role !== expected.role) {
      throw new Error(`OCR manifest asset role mismatch: ${expected.path}`);
    }
    if (actual.bytes !== expected.bytes) {
      throw new Error(`OCR manifest asset byte length mismatch: ${expected.path}`);
    }
    if (actual.sha256 !== expected.sha256) {
      throw new Error(`OCR manifest asset SHA-256 mismatch: ${expected.path}`);
    }
    actualByPath.delete(expected.path);
  }
  const unlisted = [...actualByPath.keys()].sort();
  if (unlisted.length > 0) {
    throw new Error(`OCR production asset is not listed in the manifest: ${unlisted[0]}`);
  }
}

async function verifyPaddleIntegrityMetadata(output, versions, assets) {
  const integrityPath = resolve(output, OCR_ASSET_DIRECTORY, 'paddle/models/integrity.json');
  const integrity = await readPackageJson(integrityPath, 'PaddleOCR model integrity metadata');
  if (integrity.engine !== `@paddleocr/paddleocr-js@${versions.engineVersion}`) {
    throw new Error('PaddleOCR model integrity metadata engine version mismatch.');
  }
  if (integrity.runtime !== `onnxruntime-web@${versions.ortVersion}`) {
    throw new Error('PaddleOCR model integrity metadata runtime version mismatch.');
  }
  if (!Array.isArray(integrity.models)) {
    throw new Error('PaddleOCR model integrity metadata has no model inventory.');
  }

  const byPath = new Map(assets.map(asset => [asset.path, asset]));
  const expectedModels = Object.keys(PADDLE_OCR_VENDOR_MODELS).map(filename => {
    const path = `paddle/models/${filename}`;
    const asset = byPath.get(path);
    if (!asset) throw new Error(`Missing required production OCR asset: ${path}`);
    return { filename, bytes: asset.bytes, sha256: asset.sha256 };
  });
  if (JSON.stringify(integrity.models) !== JSON.stringify(expectedModels)) {
    throw new Error('PaddleOCR model integrity metadata does not match deployed model files.');
  }
}

/**
 * Generate one deterministic inventory for every file deployed below
 * assets/ocr/. The manifest intentionally excludes itself.
 */
export async function writeOcrAssetManifest({
  root = projectRoot,
  output = resolve(projectRoot, 'site'),
  engineVersion,
  ortVersion,
  sourceDateEpoch = process.env.SOURCE_DATE_EPOCH,
} = {}) {
  const normalizedRoot = resolve(root);
  const normalizedOutput = requirePathInsideRoot(normalizedRoot, output, 'OCR manifest output');
  const ocrDirectory = requirePathInsideRoot(normalizedRoot, resolve(normalizedOutput, OCR_ASSET_DIRECTORY), 'OCR asset directory');
  const versions = await resolvePinnedOcrVersions(normalizedRoot, engineVersion, ortVersion);
  const assets = await collectOcrAssets(ocrDirectory);
  assertPinnedProductionAssets(assets);
  await verifyPaddleIntegrityMetadata(normalizedOutput, versions, assets);
  const modelHash = createHash('sha256').update(canonicalModelAssetSignature(assets)).digest('hex');
  const manifest = {
    engine: OCR_ENGINE_NAME,
    engine_version: versions.engineVersion,
    model: OCR_MODEL_NAME,
    model_hash: modelHash,
    ort_version: versions.ortVersion,
    generated_at: resolveOcrManifestTimestamp(sourceDateEpoch),
    assets,
  };
  validateOcrAssetManifest(manifest, {
    engineVersion: versions.engineVersion,
    ortVersion: versions.ortVersion,
  });

  const manifestPath = requirePathInsideRoot(normalizedRoot, resolve(normalizedOutput, OCR_ASSET_MANIFEST_PATH), 'OCR asset manifest');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await verifyOcrAssetManifest({
    root: normalizedRoot,
    output: normalizedOutput,
    engineVersion: versions.engineVersion,
    ortVersion: versions.ortVersion,
  });
  return manifest;
}

/**
 * Re-hash the production directory and require a byte-for-byte inventory
 * match. This catches missing, changed and unlisted assets after generation.
 */
export async function verifyOcrAssetManifest({
  root = projectRoot,
  output = resolve(projectRoot, 'site'),
  engineVersion,
  ortVersion,
} = {}) {
  const normalizedRoot = resolve(root);
  const normalizedOutput = requirePathInsideRoot(normalizedRoot, output, 'OCR manifest verification output');
  const versions = await resolvePinnedOcrVersions(normalizedRoot, engineVersion, ortVersion);
  const manifestPath = requirePathInsideRoot(normalizedRoot, resolve(normalizedOutput, OCR_ASSET_MANIFEST_PATH), 'OCR asset manifest');
  const manifest = await readPackageJson(manifestPath, 'OCR asset manifest');
  validateOcrAssetManifest(manifest, {
    engineVersion: versions.engineVersion,
    ortVersion: versions.ortVersion,
  });
  const actualAssets = await collectOcrAssets(resolve(normalizedOutput, OCR_ASSET_DIRECTORY));
  assertPinnedProductionAssets(actualAssets);
  assertManifestMatchesAssets(manifest.assets, actualAssets);
  await verifyPaddleIntegrityMetadata(normalizedOutput, versions, actualAssets);
  const actualModelHash = createHash('sha256').update(canonicalModelAssetSignature(actualAssets)).digest('hex');
  if (actualModelHash !== manifest.model_hash) {
    throw new Error('OCR production model files do not match model_hash.');
  }
  return manifest;
}

async function verifyVendorModels(root) {
  const modelDirectory = requirePathInsideRoot(root, resolve(root, VENDOR_MODEL_DIRECTORY), 'PaddleOCR vendor model directory');
  const verifiedModels = [];

  for (const [filename, expected] of Object.entries(PADDLE_OCR_VENDOR_MODELS)) {
    const modelPath = requirePathInsideRoot(root, resolve(modelDirectory, filename), `PaddleOCR model ${filename}`);
    try {
      await access(modelPath, constants.R_OK);
    } catch {
      throw new Error(
        `Missing audited PaddleOCR model: ${VENDOR_MODEL_DIRECTORY}/${filename}. ` +
        'Do not download it during build; place the reviewed, hash-verified file in this vendor path first.'
      );
    }
    const [metadata, digest] = await Promise.all([stat(modelPath), sha256File(modelPath)]);
    if (metadata.size !== expected.bytes || digest !== expected.sha256) {
      throw new Error(`PaddleOCR model verification failed for ${filename}; expected the pinned byte length and SHA-256.`);
    }
    verifiedModels.push({ filename, bytes: metadata.size, sha256: digest });
  }

  return { modelDirectory, verifiedModels };
}

async function copyFile(source, destination) {
  await access(source, constants.R_OK);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

/**
 * Reject a Vite output whose PaddleOCR module Worker was rewritten to the
 * deployment root. The return value is the emitted path, used to prove that
 * the referenced worker is packaged beside the engine entry.
 */
export function assertRelativePaddleWorkerUrl(emittedEntry) {
  if (ROOT_ABSOLUTE_WORKER_URL.test(emittedEntry)) {
    throw new Error(
      'PaddleOCR build emitted a root-absolute Worker URL. The OCR engine must use a relative Vite base.'
    );
  }

  const workerReference = emittedEntry.match(RELATIVE_WORKER_URL)?.[1];
  if (!workerReference) {
    throw new Error('PaddleOCR build did not emit the expected same-origin module Worker URL.');
  }
  return workerReference;
}

/**
 * Keep the page-side module small enough that Paddle/OpenCV cannot be bundled
 * there unnoticed. The heavy SDK belongs exclusively to the owned Worker.
 */
export function assertLightweightPaddleEntry(emittedEntry) {
  const bytes = Buffer.byteLength(emittedEntry, 'utf8');
  if (bytes > MAX_PAGE_FACADE_BYTES) {
    throw new Error(`PaddleOCR page facade is ${bytes} bytes; expected at most ${MAX_PAGE_FACADE_BYTES}.`);
  }
  if (!/new Worker\(/.test(emittedEntry)) {
    throw new Error('PaddleOCR page facade did not create its owned module Worker.');
  }
  return bytes;
}

/**
 * Build the OCR-only ESM bundle and copy only same-origin OCR resources.
 * The function intentionally performs no network request and rejects unknown
 * or unverified model artifacts before Vite starts.
 */
export async function buildPaddleOcrAssets({
  root = projectRoot,
  output = resolve(projectRoot, 'site'),
  sourceDateEpoch = process.env.SOURCE_DATE_EPOCH,
} = {}) {
  const normalizedRoot = resolve(root);
  const normalizedOutput = requirePathInsideRoot(normalizedRoot, output, 'PaddleOCR output');
  const paddleOutput = requirePathInsideRoot(normalizedRoot, resolve(normalizedOutput, PADDLE_OUTPUT_DIRECTORY), 'PaddleOCR output directory');
  const versions = await readPinnedOcrVersions(normalizedRoot);
  const { modelDirectory, verifiedModels } = await verifyVendorModels(normalizedRoot);

  await rm(paddleOutput, { recursive: true, force: true });
  await mkdir(paddleOutput, { recursive: true });

  const modelsOutput = resolve(paddleOutput, 'models');
  for (const { filename } of verifiedModels) {
    await copyFile(resolve(modelDirectory, filename), resolve(modelsOutput, filename));
  }

  const ortSource = resolve(normalizedRoot, 'node_modules/onnxruntime-web/dist');
  const ortOutput = resolve(paddleOutput, 'ort');
  for (const filename of PADDLE_ORT_RUNTIME_FILES) {
    await copyFile(resolve(ortSource, filename), resolve(ortOutput, filename));
  }

  await writeFile(
    resolve(modelsOutput, 'integrity.json'),
    `${JSON.stringify({
      engine: `@paddleocr/paddleocr-js@${versions.engineVersion}`,
      runtime: `onnxruntime-web@${versions.ortVersion}`,
      models: verifiedModels,
    }, null, 2)}\n`,
    'utf8'
  );

  await build({
    configFile: false,
    root: normalizedRoot,
    publicDir: false,
    // This bundle is deployed below `assets/ocr/paddle/engine/`, not at the
    // site root. Relative URLs keep Vite's emitted module Worker next to its
    // entry on both localhost and GitHub Pages project deployments.
    base: './',
    build: {
      outDir: resolve(paddleOutput, 'engine'),
      emptyOutDir: false,
      target: 'es2022',
      minify: 'esbuild',
      sourcemap: false,
      rollupOptions: {
        input: paddleEntry,
        // This is a browser entry point rather than a Vite library build.
        // Strict signatures retain the exported factory while allowing Vite to
        // emit PaddleOCR's module Worker as a separate same-origin resource.
        preserveEntrySignatures: 'strict',
        output: {
          entryFileNames: 'paddle-ocr-engine.mjs',
          chunkFileNames: 'chunks/[name]-[hash].mjs',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
    worker: {
      format: 'es',
    },
    logLevel: 'warn',
  });

  // The package's exact-pinned prebuilt Worker already implements the public
  // worker-transport protocol. Preserve it with one controlled, fail-closed
  // patch so an explicit WASM fallback cannot issue a second WebGPU adapter
  // request. Trying to bundle this deep side-effect-only artifact is
  // tree-shaken by Vite because the package marks itself sideEffects:false.
  const engineAssetsDirectory = resolve(paddleOutput, 'engine/assets');
  await mkdir(engineAssetsDirectory, { recursive: true });
  const officialWorkerPath = requirePathInsideRoot(
    normalizedRoot,
    resolve(normalizedRoot, 'node_modules/@paddleocr/paddleocr-js/dist/assets/worker-entry-C9UNuyOJ.js'),
    'PaddleOCR official Worker source'
  );
  const officialWorker = await readFile(officialWorkerPath, 'utf8');
  if (Buffer.byteLength(officialWorker) < 10_000_000 || !officialWorker.includes('worker-transport-request')) {
    throw new Error('PaddleOCR official Worker source failed its pinned protocol/build sanity check.');
  }
  const controlledWorker = patchPaddleWorkerForExplicitWasm(officialWorker);
  await writeFile(resolve(engineAssetsDirectory, 'fundval-paddle-worker.js'), controlledWorker, 'utf8');

  const engineEntryPath = resolve(paddleOutput, 'engine/paddle-ocr-engine.mjs');
  const emittedEntry = await readFile(engineEntryPath, 'utf8');
  const workerReference = assertRelativePaddleWorkerUrl(emittedEntry);
  const facadeBytes = assertLightweightPaddleEntry(emittedEntry);
  const emittedWorkerPath = requirePathInsideRoot(
    resolve(paddleOutput, 'engine'),
    resolve(dirname(engineEntryPath), workerReference),
    'PaddleOCR emitted Worker'
  );
  try {
    await access(emittedWorkerPath, constants.R_OK);
  } catch {
    throw new Error(`PaddleOCR build emitted a missing Worker resource: ${workerReference}`);
  }
  const emittedWorker = await readFile(emittedWorkerPath);
  const workerProtocolMarkers = [
    'worker-transport-request',
    'worker-transport-response',
    'sourcePayloadToMat',
  ];
  if (emittedWorker.byteLength < 10_000_000 || workerProtocolMarkers.some(marker => !emittedWorker.includes(Buffer.from(marker)))) {
    throw new Error('PaddleOCR emitted Worker is incomplete or missing the pinned worker protocol.');
  }

  const manifest = await writeOcrAssetManifest({
    root: normalizedRoot,
    output: normalizedOutput,
    engineVersion: versions.engineVersion,
    ortVersion: versions.ortVersion,
    sourceDateEpoch,
  });

  return {
    output: relative(normalizedRoot, paddleOutput),
    entry: relative(normalizedRoot, resolve(paddleOutput, 'engine/paddle-ocr-engine.mjs')),
    worker: relative(normalizedRoot, emittedWorkerPath),
    workerBytes: emittedWorker.byteLength,
    facadeBytes,
    models: verifiedModels.map(({ filename }) => filename),
    ortRuntimeFiles: [...PADDLE_ORT_RUNTIME_FILES],
    manifest: relative(normalizedRoot, resolve(normalizedOutput, OCR_ASSET_MANIFEST_PATH)),
    manifestAssets: manifest.assets.length,
    modelHash: manifest.model_hash,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPaddleOcrAssets();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
