import test from 'node:test';
import assert from 'node:assert/strict';

function createStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    getItem(key) {
      calls.push(['get', key]);
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      calls.push(['set', key, String(value)]);
      entries.set(key, String(value));
    },
    removeItem(key) {
      calls.push(['remove', key]);
      entries.delete(key);
    },
    value(key) {
      return entries.has(key) ? entries.get(key) : null;
    }
  };
}

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

test('importing migrations has no storage, network, or window-listener side effects', async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const storage = createStorage({ fuyu_holdings_v1: '[{"code":"000001"}]' });
  let listenerCalls = 0;
  let networkCalls = 0;

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { addEventListener() { listenerCalls += 1; } }
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value() { networkCalls += 1; throw new Error('network must not be used'); }
  });

  try {
    await import(new URL(`../js/migrations.js?side-effect-free=${Date.now()}`, import.meta.url));
    assert.deepEqual(storage.calls, []);
    assert.equal(listenerCalls, 0);
    assert.equal(networkCalls, 0);
  } finally {
    restoreGlobal('localStorage', originalStorage);
    restoreGlobal('window', originalWindow);
    restoreGlobal('fetch', originalFetch);
  }
});

test('explicit local migration never changes canonical holdings', async () => {
  const { runLocalMigrations } = await import('../js/migrations.js');
  const holdings = '[{"code":"000001","shares":100,"updated_at":"2026-01-01T00:00:00.000Z"}]';
  const storage = createStorage({ fuyu_holdings_v1: holdings });

  const result = runLocalMigrations({ storage, now: Date.UTC(2026, 7, 25) });

  assert.equal(result.ok, true);
  assert.equal(result.canonicalHoldingsChanged, false);
  assert.equal(storage.value('fuyu_holdings_v1'), holdings);
  assert.equal(storage.calls.some(([operation, key]) => key === 'fuyu_holdings_v1' && operation !== 'get'), false);
});

test('legacy cloud-pending marker becomes a local manual-review marker without network work', async () => {
  const {
    LEGACY_CLOUD_PENDING_KEY,
    MIGRATION_REVIEW_KEY,
    runLocalMigrations
  } = await import('../js/migrations.js');
  const holdings = '[{"code":"000001","shares":100}]';
  const storage = createStorage({
    fuyu_holdings_v1: holdings,
    [LEGACY_CLOUD_PENDING_KEY]: '1'
  });
  const result = runLocalMigrations({ storage, now: Date.UTC(2026, 7, 25, 12) });

  assert.equal(result.ok, true);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.reviewMarkerWritten, true);
  assert.equal(result.legacyPendingCleared, true);
  assert.equal(storage.value(LEGACY_CLOUD_PENDING_KEY), null);
  assert.equal(storage.value('fuyu_holdings_v1'), holdings);
  assert.deepEqual(JSON.parse(storage.value(MIGRATION_REVIEW_KEY)), {
    version: 15,
    type: 'legacy_cloud_sync_pending',
    detected_at: '2026-08-25T12:00:00.000Z',
    action: 'manual_review_required',
    canonical_holdings_untouched: true
  });
});

test('a failed review-marker write preserves the legacy pending marker and still leaves holdings alone', async () => {
  const { LEGACY_CLOUD_PENDING_KEY, runLocalMigrations } = await import('../js/migrations.js');
  const holdings = '[{"code":"000001","shares":100}]';
  const storage = createStorage({
    fuyu_holdings_v1: holdings,
    [LEGACY_CLOUD_PENDING_KEY]: '1'
  });
  const originalSet = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === 'fuyu_migration_review_required_v15') throw new Error('storage blocked');
    originalSet.call(storage, key, value);
  };

  const result = runLocalMigrations({ storage, now: Date.UTC(2026, 7, 25) });

  assert.equal(result.ok, false);
  assert.equal(result.reviewMarkerWritten, false);
  assert.equal(storage.value(LEGACY_CLOUD_PENDING_KEY), '1');
  assert.equal(storage.value('fuyu_holdings_v1'), holdings);
});
