import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FUND_CATALOG_ERROR_MESSAGE,
  findFundCatalogMatches,
  loadFundCatalog,
  normalizeFundCatalog,
} from '../js/fund-catalog.js';

const localLocation = { origin: 'https://example.test' };
const localUrl = 'https://example.test/data/fund-catalog.json';
const rows = [
  { code: '000001', name: '华夏成长混合', pinyin: 'huaxiachengzhang' },
  { code: '000002', name: '华夏成长混合C', pinyin: 'huaxiachengzhangc' },
  { code: '000001', name: '重复', pinyin: 'duplicate' },
  { code: 'bad', name: '忽略', pinyin: 'ignored' },
];

test('loads only same-origin JSON and retains only minimal catalog identity fields', async () => {
  let request;
  const catalog = await loadFundCatalog({
    url: localUrl,
    locationRef: localLocation,
    fetchFn: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => rows };
    },
  });
  assert.equal(request.url, localUrl);
  assert.equal(request.options.credentials, 'same-origin');
  assert.deepEqual(catalog, [
    { code: '000001', name: '华夏成长混合', pinyin: 'huaxiachengzhang' },
    { code: '000002', name: '华夏成长混合C', pinyin: 'huaxiachengzhangc' },
  ]);
  assert.equal('holdingAmount' in catalog[0], false);
});

test('rejects a cross-origin catalog URL before any request is sent', async () => {
  let called = false;
  await assert.rejects(
    loadFundCatalog({
      url: 'https://fund.eastmoney.com/js/fundcode_search.js',
      locationRef: localLocation,
      fetchFn: async () => { called = true; return { ok: true, json: async () => [] }; },
    }),
    error => error.message === FUND_CATALOG_ERROR_MESSAGE,
  );
  assert.equal(called, false);
});

test('returns a controlled error for unavailable or malformed same-origin catalog data', async () => {
  await assert.rejects(
    loadFundCatalog({ url: 'https://example.test/unavailable.json', locationRef: localLocation, fetchFn: async () => ({ ok: false }) }),
    error => error.message === FUND_CATALOG_ERROR_MESSAGE,
  );
  await assert.rejects(
    loadFundCatalog({ url: 'https://example.test/malformed.json', locationRef: localLocation, fetchFn: async () => ({ ok: true, json: async () => ({}) }) }),
    error => error.message === FUND_CATALOG_ERROR_MESSAGE,
  );
});

test('normalizes catalog rows and provides minimal local picker matches', () => {
  const catalog = normalizeFundCatalog(rows);
  assert.deepEqual(findFundCatalogMatches(catalog, '000002'), [catalog[1]]);
  assert.deepEqual(findFundCatalogMatches(catalog, '成长'), [catalog[0], catalog[1]]);
});

test('reads Eastmoney raw array rows with the Chinese name in the third field and pinyin in the fifth field', () => {
  assert.deepEqual(normalizeFundCatalog([['000003', 'ZH', '中海混合A', '混合型', 'zhonghai']]), [
    { code: '000003', name: '中海混合A', pinyin: 'zhonghai' },
  ]);
});

test('ships a sizable minimal same-origin identity catalog for the OCR confirmation page', async () => {
  const catalog = JSON.parse(await readFile(new URL('../data/fund-catalog.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(catalog));
  assert.ok(catalog.length > 20000);
  const known = catalog.find(item => item.code === '005827');
  assert.deepEqual(known, {
    code: '005827',
    name: '易方达蓝筹精选混合',
    pinyin: 'YIFANGDALANCHOUJINGXUANHUNHE',
  });
  assert.deepEqual(Object.keys(catalog[0]).sort(), ['code', 'name', 'pinyin']);
});
