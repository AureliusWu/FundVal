import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

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
const PADDLE_OUTPUT_DIRECTORY = 'assets/ocr/paddle';
const paddleEntry = resolve(scriptDirectory, 'paddle-ocr-entry.mjs');

// The official package constructs its module Worker from a path beneath its
// ESM entry. Vite's default absolute base silently turns that into `/assets/`
// during production builds, which is wrong for our nested OCR engine output.
const ROOT_ABSOLUTE_WORKER_URL = /new URL\(\s*["']\/assets\/worker-entry-[^"']+\.js["']\s*,\s*import\.meta\.url\s*\)/;
const RELATIVE_WORKER_URL = /new URL\(\s*["']((?:\.\/)?assets\/worker-entry-[^"']+\.js)["']\s*,\s*import\.meta\.url\s*\)/;

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
 * Build the OCR-only ESM bundle and copy only same-origin OCR resources.
 * The function intentionally performs no network request and rejects unknown
 * or unverified model artifacts before Vite starts.
 */
export async function buildPaddleOcrAssets({ root = projectRoot, output = resolve(projectRoot, 'site') } = {}) {
  const normalizedRoot = resolve(root);
  const normalizedOutput = requirePathInsideRoot(normalizedRoot, output, 'PaddleOCR output');
  const paddleOutput = requirePathInsideRoot(normalizedRoot, resolve(normalizedOutput, PADDLE_OUTPUT_DIRECTORY), 'PaddleOCR output directory');
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
      engine: '@paddleocr/paddleocr-js@0.4.2',
      runtime: 'onnxruntime-web@1.27.0',
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

  const engineEntryPath = resolve(paddleOutput, 'engine/paddle-ocr-engine.mjs');
  const workerReference = assertRelativePaddleWorkerUrl(await readFile(engineEntryPath, 'utf8'));
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

  return {
    output: relative(normalizedRoot, paddleOutput),
    entry: relative(normalizedRoot, resolve(paddleOutput, 'engine/paddle-ocr-engine.mjs')),
    models: verifiedModels.map(({ filename }) => filename),
    ortRuntimeFiles: [...PADDLE_ORT_RUNTIME_FILES],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPaddleOcrAssets();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
