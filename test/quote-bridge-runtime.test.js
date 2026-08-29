import test from 'node:test';
import assert from 'node:assert/strict';

await import('../js/sandbox/quote-bridge-runtime.js');

const runtime = globalThis.FundValQuoteBridgeRuntime;
const REQUEST_ID = 'request-runtime1';

function request(operation, params) {
  return { type: 'fundval:bridge:request', requestId: REQUEST_ID, operation, params };
}

test('bridge runtime exposes only the closed operation set and builds fixed provider URLs', () => {
  assert.deepEqual(runtime.OPERATIONS, [
    'officialFundData', 'indexQuotes', 'securityQuotes', 'overseasComponents',
  ]);
  assert.equal(
    runtime.buildScriptUrl('officialFundData', { fundCode: '005844' }, 123),
    'https://fund.eastmoney.com/pingzhongdata/005844.js?v=123',
  );
  assert.equal(
    runtime.buildScriptUrl('indexQuotes', { codes: ['sh000001', 'usNDX'] }, 123),
    'https://qt.gtimg.cn/q=sh000001,usNDX&_t=123',
  );
  assert.throws(() => runtime.validateRequest(request('loadAnyScript', {
    url: 'https://evil.example/x.js',
  })), { code: 'unsupported_operation' });
});

test('officialFundData adapter validates fS_code and returns only bounded latest NAV fields', async () => {
  const scope = {};
  const data = await runtime.performOperation(request('officialFundData', { fundCode: '005844' }), {
    scope,
    loadScript: async (url) => {
      assert.match(url, /^https:\/\/fund\.eastmoney\.com\/pingzhongdata\/005844\.js\?v=/);
      scope.fS_code = '005844';
      scope.fS_name = '东方人工智能主题混合A';
      scope.Data_netWorthTrend = [
        { x: Date.parse('2026-08-26T00:00:00Z'), y: 3.3 },
        { x: Date.parse('2026-08-27T00:00:00Z'), y: 3.4 },
        { x: Date.parse('2026-08-28T00:00:00Z'), y: 3.5 },
      ];
      scope.Data_fluctuationScale = { series: [{ y: 37.96 }] };
      scope.Data_currentFundManager = [{ id: '123', name: '测试经理', workTime: '6年' }];
      scope.fund_sourceRate = '1.50';
      scope.fund_Rate = '0.15';
    },
  });
  assert.equal(data.fundCode, '005844');
  assert.deepEqual(data.points.map((point) => point.nav), [3.4, 3.5]);
  assert.equal(data.meta.scale, 37.96);
  assert.equal('Data_netWorthTrend' in data, false);
  assert.equal(scope.Data_netWorthTrend, undefined);
});

test('officialFundData adapter converts Eastmoney NAV timestamps to China dates', () => {
  const data = runtime.parseOfficialFundData('005844', {
    fS_code: '005844',
    Data_netWorthTrend: [
      { x: Date.parse('2026-08-27T16:00:00Z'), y: 3.4 },
      { x: Date.parse('2026-08-28T16:00:00Z'), y: 3.5 },
    ],
  });

  assert.deepEqual(data.points.map((point) => point.date), ['2026-08-28', '2026-08-29']);
});

test('officialFundData adapter rejects a mismatched remote fund identity', async () => {
  const scope = {};
  await assert.rejects(runtime.performOperation(request('officialFundData', { fundCode: '005844' }), {
    scope,
    loadScript: async () => {
      scope.fS_code = '000001';
      scope.Data_netWorthTrend = [
        { x: Date.parse('2026-08-27T00:00:00Z'), y: 1 },
        { x: Date.parse('2026-08-28T00:00:00Z'), y: 1.1 },
      ];
    },
  }), { code: 'invalid_response' });
});

test('Tencent adapter returns only requested codes with finite values and null for missing change', () => {
  const scope = {
    v_usNVDA: '200~NVIDIA~NVDA~100~100~~~~~~~~~~~~~~~~~~~~~~~~~~2026-08-28 16:00:00~~',
    v_usAMD: '200~AMD~AMD~80~79~~~~~~~~~~~~~~~~~~~~~~~~~~~~1.2~',
    v_usEVIL: '200~evil~evil~999~1~~~~~~~~~~~~~~~~~~~~~~~~~~~~999~',
  };
  const parsed = runtime.parseTencentQuotes('overseasComponents', ['usNVDA', 'usAMD'], scope);
  assert.deepEqual(parsed.quotes.map((quote) => quote.code), ['usNVDA', 'usAMD']);
  assert.equal(parsed.quotes.some((quote) => quote.code === 'usEVIL'), false);
  parsed.quotes.forEach((quote) => assert.equal(Number.isFinite(quote.price), true));
});

test('Tencent adapter rejects non-finite or non-numeric prices instead of coercing them to zero', () => {
  assert.equal(runtime.parseTencentQuote('1~x~x~--~1', 'usNVDA'), null);
  assert.equal(runtime.parseTencentQuote('1~x~x~Infinity~1', 'usNVDA'), null);
  assert.equal(runtime.parseTencentQuote('1~x~x~~1', 'usNVDA'), null);
});
