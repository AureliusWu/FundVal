import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

test('existing icons have their declared pixel sizes and do not falsely claim a maskable safe area', async () => {
  assert.deepEqual(manifest.icons.map(icon => icon.sizes).sort(), ['192x192', '512x512']);
  for (const icon of manifest.icons) {
    assert.equal(icon.purpose, 'any', 'Dedicated maskable artwork is not yet accepted');
    assert.match(icon.src, /^icon-(192|512)\.png$/);
    const bytes = await readFile(new URL('../' + icon.src, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height);
  }
});

test('Apple touch icon uses an existing same-origin application icon', () => {
  const href = /<link\s+rel="apple-touch-icon"\s+href="([^"]+)"/.exec(index)?.[1];
  assert.ok(href);
  assert.ok(manifest.icons.some(icon => icon.src === href));
  assert.equal(new URL(href, productionManifestUrl).origin, productionManifestUrl.origin);
});
