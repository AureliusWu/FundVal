import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('fund details load holdings through the proxy instead of cross-site script injection', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(source, /fetchFundHoldings\(code\)/);
  assert.doesNotMatch(source, /FundArchivesDatas\.aspx/);
  assert.doesNotMatch(source, /window\.apidata/);
  assert.doesNotMatch(source, /type=(?:jjxx|jjfl)/);
  assert.match(source, /重仓数据获取失败，重新展开可重试/);
});
