import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPaddleOcrAssets } from './build-paddle-ocr.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'site');

if (dirname(output) !== root || relative(root, output) !== 'site') {
  throw new Error('Refusing to clean an unexpected build directory.');
}

const copyIntoSite = async source => {
  const from = resolve(root, source);
  await access(from, constants.R_OK);
  await cp(from, resolve(output, source), { recursive: true });
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const source of [
  'index.html', 'ocr-import.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'css', 'js', 'data', 'THIRD_PARTY_NOTICES.md',
]) {
  await copyIntoSite(source);
}

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
