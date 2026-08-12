import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEastmoneyFundCatalogScript } from '../scripts/refresh-fund-catalog.mjs';

test('extracts only static identity rows from the upstream catalog assignment without evaluating it', () => {
  const source = 'var r = [["000001","HXCZ","华夏成长混合","混合型","huaxiachengzhang"],["000002","HXCZC","华夏成长混合C","混合型","huaxiachengzhangc"],["000001","DUP","重复","混合型","dup"],["bad","X","忽略","混合型","x"]]; window.untrusted = [];';
  const catalog = parseEastmoneyFundCatalogScript(source);
  assert.deepEqual(catalog, [
    { code: '000001', name: '华夏成长混合', pinyin: 'huaxiachengzhang' },
    { code: '000002', name: '华夏成长混合C', pinyin: 'huaxiachengzhangc' },
  ]);
});

test('rejects malformed upstream text instead of executing it', () => {
  assert.throws(() => parseEastmoneyFundCatalogScript('window.r = not-json;'));
});
