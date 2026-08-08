import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('migration storage operations use the safe storage helpers', async () => {
  const source = await readFile(new URL('../js/migrations.js', import.meta.url), 'utf8');

  assert.match(source, /from '\.\/storage\.js'/);
  assert.match(source, /safeGetItem/);
  assert.match(source, /safeSetItem/);
  assert.match(source, /safeRemoveItem/);
  assert.doesNotMatch(source, /localStorage\s*\./);
});

test('migration module still loads when browser storage throws', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { addEventListener() {} },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem() { throw new Error('storage blocked'); },
      setItem() { throw new Error('storage blocked'); },
      removeItem() { throw new Error('storage blocked'); },
    },
  });

  try {
    await import(new URL(`../js/migrations.js?blocked-storage=${Date.now()}`, import.meta.url));
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  }
});
