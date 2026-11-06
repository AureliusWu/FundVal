import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { inventorySite } from '../scripts/release-candidate.mjs';
import {
  assertAppBundleBudget, fingerprintReleaseDirectory, verifyAppChunkReleaseDirectory,
  verifyAppModuleGraphReleaseDirectory, verifyOcrReleaseDirectory,
} from '../scripts/release-fingerprint.mjs';

const project = resolve(import.meta.dirname, '..');
const native = resolve(import.meta.dirname, 'app/src/main');
const [siteArg, stageArg] = process.argv.slice(2);
assert.ok(siteArg && stageArg && process.argv.length === 4, 'Usage: node android/prepare-assets.mjs <built-site> <empty-stage>');
const site = await realpath(siteArg);
const stage = await realpath(stageArg);
assert.equal((await readdir(stage)).length, 0, 'Stage must be empty');
const inventory = await inventorySite(site);
const releaseFingerprint = await fingerprintReleaseDirectory(site);
const budget = assertAppBundleBudget(await verifyAppChunkReleaseDirectory(site));
const moduleGraph = await verifyAppModuleGraphReleaseDirectory(site);
const ocr = await verifyOcrReleaseDirectory(resolve(site, 'assets/ocr'));
const manifest = JSON.parse(await readFile(resolve(site, 'manifest.json'), 'utf8'));
const version = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8')).version;
const versionSource = await readFile(resolve(site, 'js/version.js'), 'utf8');
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.equal(versionSource.match(/APP_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/)?.[1], version);
assert.ok(manifest.description.includes(`v${version} `));
const [major, minor, patch] = version.split('.').map(Number);
const apkRevision = 6;
assert.ok(major < 2100 && minor < 100 && patch < 100);
const versionCode = major * 1_000_000 + minor * 10_000 + patch * 100 + apkRevision;
const www = resolve(stage, 'assets/www');
for (const { path, sha256 } of inventory.files) {
  // Native releases are atomically replaced by package installation, not SW.
  if (path === 'sw.js') continue;
  const input = resolve(site, path);
  const target = resolve(www, path);
  const bytes = await readFile(input);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `Changed during staging: ${path}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
}

function replaceOne(value, needle, replacement) {
  assert.equal(value.split(needle).length, 2, `Unexpected homepage markup: ${needle}`);
  return value.replace(needle, replacement);
}
const index = resolve(www, 'index.html');
let markup = await readFile(index, 'utf8');
markup = replaceOne(markup, '<html lang="zh-CN">', '<html lang="zh-CN" data-fundval-platform="android">');
markup = replaceOne(markup, '<link rel="manifest" href="manifest.json">', '<script defer src="android-runtime.js"></script>');
markup = replaceOne(markup, '<script type="module" src="js/app-shell.js"></script>', '<script defer src="android-start.js"></script>');
const notifications = /<div class="sec-title">可信行情通知<\/div>\s*<div class="cloud-section notification-section">[\s\S]*?<\/button>\s*<\/div>/g;
assert.equal([...markup.matchAll(notifications)].length, 1, 'Review Android notification disclosure');
markup = markup.replace(notifications, '<div class="f-hint">Android 版不提供网页 14:30 通知。更新请安装新版 APK。</div>');
await writeFile(index, markup, 'utf8');
const ocrPage = resolve(www, 'ocr-import.html');
let ocrMarkup = await readFile(ocrPage, 'utf8');
ocrMarkup = replaceOne(ocrMarkup, '<html lang="zh-CN">', '<html lang="zh-CN" data-fundval-platform="android">');
ocrMarkup = replaceOne(ocrMarkup, '<script type="module" src="js/ocr-import-page.js"></script>',
  '<script defer src="android-runtime.js"></script>\n<script defer src="android-start.js"></script>');
await writeFile(ocrPage, ocrMarkup, 'utf8');
await copyFile(resolve(import.meta.dirname, 'android-runtime.js'), resolve(www, 'android-runtime.js'));
await copyFile(resolve(import.meta.dirname, 'android-start.js'), resolve(www, 'android-start.js'));
for (const file of await readdir(project)) {
  if (/^LICENSE(?:\.md|\.txt)?$/i.test(file) && (await lstat(resolve(project, file))).isFile()) {
    await copyFile(resolve(project, file), resolve(www, basename(file)));
  }
}
await cp(resolve(native, 'res'), resolve(stage, 'res'), { recursive: true });
await cp(resolve(native, 'java'), resolve(stage, 'java'), { recursive: true });
const manifestXml = replaceOne(await readFile(resolve(native, 'AndroidManifest.xml'), 'utf8'),
  'package="io.github.aureliuswu.fundval">',
  `package="io.github.aureliuswu.fundval" android:versionName="${version}" android:versionCode="${versionCode}">`);
await writeFile(resolve(stage, 'AndroidManifest.xml'), manifestXml, { flag: 'wx' });
for (const [src, dest] of [
  ['icon-maskable-192.png', 'res/mipmap-nodpi/ic_launcher.png'],
  ['icon-maskable-512.png', 'res/drawable-nodpi/ic_launcher_foreground.png'],
]) {
  const target = resolve(stage, dest);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(www, src), target);
}
const packaged = await inventorySite(www);
const nativeInputs = {
  manifestSha256: createHash('sha256').update(manifestXml).digest('hex'),
  javaInventory: (await inventorySite(resolve(stage, 'java'))).fingerprint,
  resourceInventory: (await inventorySite(resolve(stage, 'res'))).fingerprint,
};
const sourceBase = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
await writeFile(resolve(stage, 'asset-evidence.json'), `${JSON.stringify({
  schema: 1, version, versionCode, apkRevision, sourceBase, releaseFingerprint,
  builtSiteInventory: inventory.fingerprint, packagedSiteInventory: packaged.fingerprint,
  packagedFiles: packaged.files.length, packagedBytes: packaged.totalBytes,
  budget, moduleGraph, ocr, nativeInputs, webUpdateWorkerBundled: false,
  scope: 'Local Android packaging of built web assets plus Android-only adapter; sourceBase is the base Git commit, not a claim of a clean tree or CI deployment.',
}, null, 2)}\n`, { flag: 'wx' });
console.log(`Prepared FundVal ${version} (${versionCode}): ${packaged.files.length} bundled web assets.`);
