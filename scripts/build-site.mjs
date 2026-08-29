import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const APP_CHUNK_FILENAME = 'js/chunks/[name]-[hash].js';
const APP_CHUNK_MANIFEST = 'js/app-chunks.json';
// v14.0.4 shipped a 52,241-byte gzip cold-start shell. Splitting truly
// on-demand features must create headroom without increasing that baseline.
const APP_SHELL_GZIP_BUDGET = 52_241;
const APP_SHELL_CORE_START = '// BUILD_APP_SHELL_CORE_START';
const APP_SHELL_CORE_END = '// BUILD_APP_SHELL_CORE_END';
const OCR_BUNDLE_REFERENCE = /assets\/ocr|paddle-local-ocr|ocr-import-page|onnx|tesseract/i;

function resolveSiteSourceDateEpoch() {
  if (process.env.SOURCE_DATE_EPOCH) return process.env.SOURCE_DATE_EPOCH;
  try {
    const commitEpoch = execFileSync('git', ['log', '-1', '--format=%ct'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^\d+$/.test(commitEpoch)) return commitEpoch;
  } catch (_) {
    // A source archive may not include .git. In that environment the OCR
    // builder retains its documented current-time fallback.
  }
  return undefined;
}

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

function collectStaticChunkGraph(chunkByFile, roots) {
  const files = new Set();
  const queue = [...roots];
  while (queue.length) {
    const fileName = queue.shift();
    if (files.has(fileName)) continue;
    const chunk = chunkByFile.get(fileName);
    if (!chunk) throw new Error(`Homepage chunk graph references missing output ${fileName}.`);
    files.add(fileName);
    queue.push(...chunk.imports);
  }
  return files;
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
          codeSplitting: true,
          entryFileNames: APP_SHELL_FILENAME,
          chunkFileNames: APP_CHUNK_FILENAME,
        },
      },
    },
  });
  const outputs = Array.isArray(result)
    ? result.flatMap(item => item.output || [])
    : result.output || [];
  const chunks = outputs.filter(item => item.type === 'chunk');
  const entryChunks = chunks.filter(chunk => chunk.isEntry);
  if (entryChunks.length !== 1 || entryChunks[0].fileName !== APP_SHELL_FILENAME) {
    throw new Error(`Expected one ${APP_SHELL_FILENAME} entry, received ${entryChunks.map(item => item.fileName).join(', ') || 'none'}.`);
  }
  const chunkByFile = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const generatedFiles = new Set(chunkByFile.keys());
  for (const chunk of chunks) {
    if (!/^js\/(?:app-shell|chunks\/[A-Za-z0-9._-]+)\.js$/.test(chunk.fileName)) {
      throw new Error(`Homepage build emitted an unsafe chunk path ${chunk.fileName}.`);
    }
    for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
      if (!generatedFiles.has(dependency)) {
        throw new Error(`Homepage chunk ${chunk.fileName} references non-generated output ${dependency}.`);
      }
    }
    if (OCR_BUNDLE_REFERENCE.test(chunk.code)) {
      throw new Error(`Homepage chunk ${chunk.fileName} unexpectedly contains an OCR runtime or asset reference.`);
    }
  }

  // bootstrap.js immediately awaits each of its direct dynamic imports. Those
  // roots, plus all of their static dependencies, are the real cold-start
  // transfer graph. Nested dynamic imports belong to on-demand features.
  const entry = entryChunks[0];
  const coldStartFiles = collectStaticChunkGraph(
    chunkByFile,
    [entry.fileName, ...entry.dynamicImports],
  );
  const lazyChunks = chunks.filter(chunk => !coldStartFiles.has(chunk.fileName));
  const featureLazyChunks = lazyChunks.filter(
    chunk => chunk.isDynamicEntry && Object.keys(chunk.modules).length > 0,
  );
  if (!featureLazyChunks.length) {
    throw new Error('Homepage build must retain at least one non-OCR on-demand feature chunk.');
  }

  const measurements = chunks.map(chunk => ({
    chunk,
    rawBytes: Buffer.byteLength(chunk.code),
    gzipBytes: gzipSync(chunk.code).length,
  }));
  const coldStartGzipBytes = measurements
    .filter(item => coldStartFiles.has(item.chunk.fileName))
    .reduce((total, item) => total + item.gzipBytes, 0);
  const totalGzipBytes = measurements.reduce((total, item) => total + item.gzipBytes, 0);
  if (coldStartGzipBytes > APP_SHELL_GZIP_BUDGET) {
    throw new Error(`Homepage cold-start chunks exceed the gzip budget: ${coldStartGzipBytes} > ${APP_SHELL_GZIP_BUDGET} bytes.`);
  }

  for (const { chunk } of measurements) {
    const target = resolve(output, chunk.fileName);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, chunk.code, 'utf8');
  }

  const chunkManifest = {
    schema: 1,
    entry: APP_SHELL_FILENAME,
    coldStart: [...coldStartFiles].sort(),
    lazy: lazyChunks.map(chunk => chunk.fileName).sort(),
    chunks: measurements
      .map(({ chunk, rawBytes, gzipBytes }) => ({
        path: chunk.fileName,
        role: coldStartFiles.has(chunk.fileName) ? 'cold' : 'lazy',
        bytes: rawBytes,
        gzipBytes,
        sha256: createHash('sha256').update(chunk.code).digest('hex'),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  const manifestTarget = resolve(output, APP_CHUNK_MANIFEST);
  await mkdir(dirname(manifestTarget), { recursive: true });
  await writeFile(manifestTarget, `${JSON.stringify(chunkManifest, null, 2)}\n`, 'utf8');

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
    [APP_CHUNK_MANIFEST, ...generatedFiles].sort().map(fileName => `  './${fileName}',`).join('\n'),
  );
  const core = worker.slice(worker.indexOf('const CORE'), worker.indexOf('self.addEventListener'));
  if (
    [APP_CHUNK_MANIFEST, ...generatedFiles].some(fileName => !core.includes(`'./${fileName}'`))
    || core.includes("'./js/bootstrap.js'")
    || OCR_BUNDLE_REFERENCE.test(core)
  ) {
    throw new Error('Built Service Worker did not replace the source module graph with every non-OCR homepage chunk.');
  }
  await writeFile(workerPath, worker, 'utf8');
  for (const { chunk, rawBytes, gzipBytes } of measurements.sort((left, right) => left.chunk.fileName.localeCompare(right.chunk.fileName))) {
    const role = coldStartFiles.has(chunk.fileName) ? 'cold' : 'lazy';
    console.log(`Built ${chunk.fileName}: ${rawBytes} bytes raw, ${gzipBytes} bytes gzip (${role}).`);
  }
  console.log(`Homepage cold-start gzip: ${coldStartGzipBytes}/${APP_SHELL_GZIP_BUDGET} bytes; all chunks: ${totalGzipBytes} bytes gzip.`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const source of [
  'index.html', 'ocr-import.html', 'quote-bridge.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'css', 'js', 'data', 'THIRD_PARTY_NOTICES.md',
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

await buildPaddleOcrAssets({
  root,
  output,
  sourceDateEpoch: resolveSiteSourceDateEpoch(),
});
