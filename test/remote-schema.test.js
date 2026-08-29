import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_OPERATIONS,
  RemoteSchemaError,
  createBridgeRequest,
  validateBridgeResponse,
} from '../js/runtime/remote-schema.js';

const REQUEST_ID = 'request-12345678';

function officialData(overrides = {}) {
  return {
    fundCode: '005844',
    fundName: '东方人工智能主题混合A',
    points: [
      { date: '2026-08-27', timestampMs: Date.parse('2026-08-27T00:00:00Z'), nav: 3.4 },
      { date: '2026-08-28', timestampMs: Date.parse('2026-08-28T00:00:00Z'), nav: 3.5 },
    ],
    meta: {
      scale: 37.96,
      managerName: '测试经理',
      managerWorkTime: '6年',
      managerId: '12345',
      sourceRate: '1.50',
      currentRate: '0.15',
    },
    ...overrides,
  };
}

test('bridge operations are a closed enum and requests cannot carry URLs or extra fields', () => {
  assert.deepEqual(BRIDGE_OPERATIONS, [
    'officialFundData',
    'indexQuotes',
    'securityQuotes',
    'overseasComponents',
  ]);
  assert.throws(() => createBridgeRequest('loadAnyScript', { url: 'https://evil.example/x.js' }, REQUEST_ID), {
    code: 'unsupported_operation',
  });
  assert.throws(() => createBridgeRequest('officialFundData', {
    fundCode: '005844',
    url: 'https://evil.example/x.js',
  }, REQUEST_ID), { code: 'invalid_request' });
});

test('operation request schemas enforce code format, uniqueness, and bounded counts', () => {
  const request = createBridgeRequest('securityQuotes', {
    codes: ['sh688361', 'hk00700', 'usNVDA'],
  }, REQUEST_ID);
  assert.deepEqual(request.params.codes, ['sh688361', 'hk00700', 'usNVDA']);
  assert.throws(() => createBridgeRequest('indexQuotes', { codes: ['sh688361'] }, REQUEST_ID), {
    code: 'invalid_request',
  });
  assert.throws(() => createBridgeRequest('securityQuotes', { codes: ['sh688361', 'sh688361'] }, REQUEST_ID), {
    code: 'invalid_request',
  });
  assert.throws(() => createBridgeRequest('overseasComponents', {
    codes: Array.from({ length: 65 }, (_, index) => `usX${index}`),
  }, REQUEST_ID), { code: 'invalid_request' });
});

test('official fund response requires exact requested identity and two finite chronological NAV points', () => {
  const response = validateBridgeResponse({
    type: 'fundval:bridge:response',
    requestId: REQUEST_ID,
    ok: true,
    data: officialData(),
  }, {
    requestId: REQUEST_ID,
    operation: 'officialFundData',
    params: { fundCode: '005844' },
  });
  assert.equal(response.data.fundCode, '005844');
  assert.equal(response.data.points[1].nav, 3.5);
  assert.equal(Object.isFrozen(response.data), true);

  assert.throws(() => validateBridgeResponse({
    type: 'fundval:bridge:response', requestId: REQUEST_ID, ok: true,
    data: officialData({ fundCode: '000001' }),
  }, {
    requestId: REQUEST_ID, operation: 'officialFundData', params: { fundCode: '005844' },
  }), { code: 'invalid_response' });

  assert.throws(() => validateBridgeResponse({
    type: 'fundval:bridge:response', requestId: REQUEST_ID, ok: true,
    data: officialData({
      points: [
        { date: '2026-08-27', timestampMs: Date.parse('2026-08-27T00:00:00Z'), nav: 3.4 },
        { date: '2026-08-28', timestampMs: Date.parse('2026-08-28T00:00:00Z'), nav: Infinity },
      ],
    }),
  }, {
    requestId: REQUEST_ID, operation: 'officialFundData', params: { fundCode: '005844' },
  }), { code: 'invalid_response' });
});

test('quote responses preserve a real zero but reject missing price and out-of-request codes', () => {
  const expected = {
    requestId: REQUEST_ID,
    operation: 'overseasComponents',
    params: { codes: ['usNVDA', 'jp285A'] },
  };
  const response = validateBridgeResponse({
    type: 'fundval:bridge:response',
    requestId: REQUEST_ID,
    ok: true,
    data: { quotes: [
      { code: 'usNVDA', price: 100, changePct: 0, sourceTimeRaw: '2026-08-28 16:00:00' },
    ] },
  }, expected);
  assert.equal(response.data.quotes[0].changePct, 0);

  assert.throws(() => validateBridgeResponse({
    type: 'fundval:bridge:response', requestId: REQUEST_ID, ok: true,
    data: { quotes: [{ code: 'usAMD', price: 100, changePct: 1, sourceTimeRaw: null }] },
  }, expected), { code: 'invalid_response' });

  assert.throws(() => validateBridgeResponse({
    type: 'fundval:bridge:response', requestId: REQUEST_ID, ok: true,
    data: { quotes: [{ code: 'usNVDA', price: null, changePct: 1, sourceTimeRaw: null }] },
  }, expected), { code: 'invalid_response' });
});

test('response envelopes reject wrong request IDs, arbitrary trees, and unknown error codes', () => {
  assert.throws(() => validateBridgeResponse({
    type: 'fundval:bridge:response', requestId: 'request-wrong000', ok: false,
    data: null, errorCode: 'timeout',
  }, {
    requestId: REQUEST_ID, operation: 'indexQuotes', params: { codes: ['sh000001'] },
  }), { code: 'invalid_response' });

  assert.throws(() => validateBridgeResponse({
    type: 'fundval:bridge:response', requestId: REQUEST_ID, ok: false,
    data: null, errorCode: 'remote_html', html: '<img onerror=alert(1)>',
  }, {
    requestId: REQUEST_ID, operation: 'indexQuotes', params: { codes: ['sh000001'] },
  }), RemoteSchemaError);
});
