import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyPwaIconAssets } from '../scripts/pwa-icon-assets.mjs';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const productionManifestUrl = new URL('https://aureliuswu.github.io/FundVal/manifest.json');
// v15.0.2 production manifest observed on 2026-10-26 has start_url="."
// and no explicit id. Per the W3C algorithm its default id is its start URL.
const legacyIdentity = new URL('.', productionManifestUrl);

test('explicit PWA id retains the v15 production identity without a version or query', () => {
  assert.equal(manifest.id, '/FundVal/');
  const start = new URL(manifest.start_url, productionManifestUrl);
  const id = new URL(manifest.id, start.origin);
  assert.equal(id.href, legacyIdentity.href);
  assert.equal(start.href, legacyIdentity.href);
  assert.equal(id.search, ''); assert.equal(id.hash, '');
  // A relative id is resolved from origin, NOT from the manifest directory.
  assert.notEqual(new URL('./', start.origin).href, legacyIdentity.href);
});

test('explicit PWA scope retains the old project-directory scope and includes OCR', () => {
  assert.equal(typeof manifest.scope, 'string');
  const scope = new URL(manifest.scope, productionManifestUrl);
  assert.equal(scope.href, legacyIdentity.href);
  for (const page of ['', 'index.html', 'ocr-import.html']) {
    assert.ok(new URL(page, productionManifestUrl).href.startsWith(scope.href));
  }
  assert.equal(new URL('/other-project/', productionManifestUrl).href.startsWith(scope.href), false);
});

test('original any-purpose icons retain their declarations and pixel sizes', async () => {
  const icons = manifest.icons.filter(icon => icon.purpose === 'any');
  assert.deepEqual(icons.map(icon => icon.sizes).sort(), ['192x192', '512x512']);
  for (const icon of icons) {
    assert.match(icon.src, /^icon-(192|512)\.png$/);
    const bytes = await readFile(new URL('../' + icon.src, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height);
  }
});

test('dedicated maskable artwork is opaque and keeps the blue brand inside the safe circle', async () => {
  const result = await verifyPwaIconAssets(fileURLToPath(new URL('..', import.meta.url)));
  assert.equal(result.result, 'PASS');
  assert.equal(manifest.icons.length, 4);
  assert.equal(result.records.length, 2);
});

test('maskable assets are shipped without adding installation artwork to startup preload or CORE', async () => {
  const [build, worker] = await Promise.all([
    readFile(new URL('../scripts/build-site.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  ]);
  for (const filename of ['icon-maskable-192.png', 'icon-maskable-512.png']) {
    assert.ok(build.includes(filename));
    assert.equal(worker.slice(worker.indexOf('const CORE'), worker.indexOf('self.addEventListener')).includes(filename), false);
    assert.equal(index.includes(filename), false);
  }
});

test('Apple touch icon uses an existing same-origin application icon', () => {
  const href = /<link\s+rel="apple-touch-icon"\s+href="([^"]+)"/.exec(index)?.[1];
  assert.ok(href);
  assert.ok(manifest.icons.some(icon => icon.src === href));
  assert.equal(new URL(href, productionManifestUrl).origin, productionManifestUrl.origin);
});
