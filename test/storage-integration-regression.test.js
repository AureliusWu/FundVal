import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, bootstrap, ocr, migrations, serviceWorker, gistRemote, holdingEdit, ocrTransaction] = await Promise.all([
  readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/bootstrap.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/ocr-import-page.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/migrations.js', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/storage/gist-remote.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/runtime/holding-edit.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/ocr/import-transaction.js', import.meta.url), 'utf8'),
]);

test('all local holding mutations use the authoritative Schema 3 repository', () => {
  assert.match(app, /await import\('\.\/runtime\/holding-edit\.js'\)/);
  assert.match(app, /await commitHoldingEdit\(/);
  assert.match(holdingEdit, /return withHoldingsLock\(/);
  assert.match(holdingEdit, /saveLegacyHoldingsTransaction\(storage, candidate/);
  assert.match(holdingEdit, /expectedDocument: loaded\.document/);
  assert.match(app, /persistHoldingsDocument/);
  assert.doesNotMatch(app, /function pruneOldTombstones/);
  assert.doesNotMatch(app, /safeSetItem\(STORAGE_KEY/);
  assert.match(ocr, /from '\.\/ocr\/import-transaction\.js'/);
  assert.match(ocrTransaction, /return withHoldingsLock\(/);
  assert.match(ocrTransaction, /saveLegacyHoldingsTransaction\(storage, result\.holdings/);
  assert.match(ocrTransaction, /expectedDocument: loaded\.document/);
  assert.doesNotMatch(ocr, /safeSetItem\([^\n]*fuyu_holdings_v1/);
});

test('Gist PATCH has one guarded adapter entry and verified cloud orchestration', () => {
  assert.equal((gistRemote.match(/method:\s*'PATCH'/g) || []).length, 1);
  assert.equal((app.match(/method:\s*'PATCH'/g) || []).length, 0);
  assert.match(app, /synchronizeHoldingsCloud/);
  assert.match(app, /pullHoldingsCloud/);
  assert.match(app, /remote_readback_mismatch/);
  assert.match(app, /backupCloudSyncSnapshot/);
  assert.match(app, /remote_schema_upgrade_required/);
  assert.match(app, /pushToCloud\(false, \{ upgradeSchema: true \}\)/);
  assert.match(app, /createCloudArchive\(token, \{ targetSchema: 3 \}\)/);
  assert.match(app, /import\('\.\/storage\/gist-remote\.js'\)/);
  assert.match(gistRemote, /V3_GIST_DEVICE_PREFIX\s*=\s*'fuyu-holdings-v3-'/);
  assert.match(gistRemote, /write\?\.schema !== 3/);
  assert.doesNotMatch(gistRemote, /headers\['If-Match'\]/);
  assert.match(gistRemote, /reconcileCloudBridgePayloadSet/);
});

test('startup migrations remain local-only and offline cache includes Schema 3 runtime', () => {
  assert.match(bootstrap, /recoverPendingRepositoryTransaction/);
  assert.match(bootstrap, /await withHoldingsLock\(/);
  assert.ok(bootstrap.indexOf('recoverPendingRepositoryTransaction') < bootstrap.indexOf('runLocalMigrations()'));
  assert.ok(bootstrap.indexOf('runLocalMigrations()') < bootstrap.indexOf('runStartupIntegrityChecks()'));
  assert.match(bootstrap, /if \(!migration\.ok\) throw/);
  assert.ok(bootstrap.indexOf('runStartupIntegrityChecks()') < bootstrap.indexOf("await import('./app.js')"));
  assert.doesNotMatch(migrations, /fetch\s*\(/);
  for (const path of [
    './js/storage/holdings-schema.js',
    './js/storage/holdings-migration.js',
    './js/storage/holdings-repository.js',
    './js/storage/cloud-sync.js',
  ]) {
    assert.match(serviceWorker, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
