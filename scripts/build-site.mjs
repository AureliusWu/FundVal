import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build as viteBuild } from 'vite';
import { buildPaddleOcrAssets } from './build-paddle-ocr.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'site');
const APP_SHELL_FILENAME = 'js/app-shell.js';
// v14.0.2 shipped 43,545 gzip bytes across its 15 cold-start modules.
// Keep the production shell at or below the exact +20% regression boundary.
const APP_SHELL_GZIP_BUDGET = 52_254;
const APP_SHELL_CORE_START = '// BUILD_APP_SHELL_CORE_START';
const APP_SHELL_CORE_END = '// BUILD_APP_SHELL_CORE_END';

if (dirname(output) !== root || relative(root, output) !== 'site') {
  throw new Error('Refusing to clean an unexpected build directory.');
}

const copyIntoSite = async source => {
  const from = resolve(root, source);
  await access(from, constants.R_OK);
  await cp(from, resolve(output, source), { recursive: true });
};

function replaceExactlyOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Expected exactly one ${label}.`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

function replaceMarkedSection(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (
    start < 0
    || end < 0
    || source.indexOf(startMarker, start + startMarker.length) >= 0
    || source.indexOf(endMarker, end + endMarker.length) >= 0
  ) {
    throw new Error('Expected exactly one app-shell Service Worker marker pair.');
  }
  return `${source.slice(0, start + startMarker.length)}\n${replacement}\n${source.slice(end)}`;
}

async function buildAppShell() {
  const result = await viteBuild({
    configFile: false,
    root,
    logLevel: 'silent',
    build: {
      write: false,
      minify: 'esbuild',
      target: 'es2022',
      rolldownOptions: {
        input: resolve(root, 'js/bootstrap.js'),
        output: {
          format: 'es',
          codeSplitting: false,
          entryFileNames: APP_SHELL_FILENAME,
        },
      },
    },
  });
  const outputs = Array.isArray(result)
    ? result.flatMap(item => item.output || [])
    : result.output || [];
  const chunks = outputs.filter(item => item.type === 'chunk');
  if (chunks.length !== 1 || chunks[0].fileName !== APP_SHELL_FILENAME) {
    throw new Error(`Expected one ${APP_SHELL_FILENAME} chunk, received ${chunks.map(item => item.fileName).join(', ') || 'none'}.`);
  }

  const code = chunks[0].code;
  if (/^\s*import\s/m.test(code) || /\bimport\s*\(/.test(code)) {
    throw new Error('Homepage app shell contains a residual module import.');
  }
  if (/assets\/ocr|paddle-local-ocr|ocr-import-page|onnx|tesseract/i.test(code)) {
    throw new Error('Homepage app shell unexpectedly contains an OCR runtime or asset reference.');
  }
  const gzipBytes = gzipSync(code).length;
  if (gzipBytes > APP_SHELL_GZIP_BUDGET) {
    throw new Error(`Homepage app shell exceeds its gzip budget: ${gzipBytes} > ${APP_SHELL_GZIP_BUDGET} bytes.`);
  }

  const target = resolve(output, APP_SHELL_FILENAME);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, code, 'utf8');

  const indexPath = resolve(output, 'index.html');
  const index = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, replaceExactlyOnce(
    index,
    'src="js/bootstrap.js"',
    `src="${APP_SHELL_FILENAME}"`,
    'homepage bootstrap script reference',
  ), 'utf8');

  const workerPath = resolve(output, 'sw.js');
  const worker = replaceMarkedSection(
    await readFile(workerPath, 'utf8'),
    APP_SHELL_CORE_START,
    APP_SHELL_CORE_END,
    `  './${APP_SHELL_FILENAME}',`,
  );
  const core = worker.slice(worker.indexOf('const CORE'), worker.indexOf('self.addEventListener'));
  if (!core.includes(`'./${APP_SHELL_FILENAME}'`) || core.includes("'./js/bootstrap.js'")) {
    throw new Error('Built Service Worker did not replace the source module graph with the app shell.');
  }
  await writeFile(workerPath, worker, 'utf8');
  console.log(`Built ${APP_SHELL_FILENAME}: ${Buffer.byteLength(code)} bytes raw, ${gzipBytes} bytes gzip.`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const source of [
  'index.html', 'ocr-import.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'css', 'js', 'data', 'THIRD_PARTY_NOTICES.md',
]) {
  await copyIntoSite(source);
}

await buildAppShell();

const ocrAssets = [
  ['node_modules/tesseract.js/dist/tesseract.esm.min.js', 'assets/ocr/tesseract/tesseract.esm.min.js'],
  ['node_modules/tesseract.js/dist/worker.min.js', 'assets/ocr/tesseract/worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'assets/ocr/tesseract-core/tesseract-core-lstm.wasm.js'],
  ['node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz', 'assets/ocr/tessdata/chi_sim.traineddata.gz'],
  ['node_modules/tesseract.js/LICENSE.md', 'assets/ocr/licenses/tesseract.js-APACHE-2.0.txt'],
  ['node_modules/tesseract.js-core/LICENSE', 'assets/ocr/licenses/tesseract.js-core-APACHE-2.0.txt'],
  // The PaddleOCR npm package declares Apache-2.0 but does not ship a license
  // file. Apache-2.0 is a standard text, so reuse the verified copy bundled by
  // Tesseract and identify the Paddle component in THIRD_PARTY_NOTICES.md.
  ['node_modules/tesseract.js/LICENSE.md', 'assets/ocr/licenses/paddleocr-APACHE-2.0.txt'],
  ['node_modules/@techstark/opencv-js/LICENSE', 'assets/ocr/licenses/opencv-js-APACHE-2.0.txt'],
  ['node_modules/js-yaml/LICENSE', 'assets/ocr/licenses/js-yaml-MIT.txt'],
];

for (const [source, destination] of ocrAssets) {
  const from = resolve(root, source);
  const to = resolve(output, destination);
  await access(from, constants.R_OK);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
}

const thirdPartyNotice = await readFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const extractedLicenseNotices = [
  ['## MIT notices', '## Boost Software License', 'onnxruntime-web-MIT.txt'],
  ['## Boost Software License', '## MIT License notice for', 'clipper-lib-BSL-1.0.txt'],
  ['## MIT License notice for', null, 'chi_sim-MIT.txt'],
];
for (const [startHeading, endHeading, filename] of extractedLicenseNotices) {
  const start = thirdPartyNotice.indexOf(startHeading);
  const end = endHeading ? thirdPartyNotice.indexOf(endHeading, start + startHeading.length) : thirdPartyNotice.length;
  if (start < 0 || end <= start) throw new Error(`Missing reviewed license notice section for ${filename}.`);
  const target = resolve(output, 'assets/ocr/licenses', filename);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${thirdPartyNotice.slice(start, end).trim()}\n`, 'utf8');
}

await buildPaddleOcrAssets({ root, output });
