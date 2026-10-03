import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEstimateQuote } from '../js/runtime/quote-normalizer.js';

const NOW = Date.parse('2026-08-25T02:05:00Z');
const REASON_KEYS = ['fallback_reason', 'primary_reason', 'model_reason', 'official_reason'];
const DIAGNOSTIC_CODES = [
  'upstream_empty', 'no_data', 'no_quote', 'unavailable', 'source_unavailable',
  'timeout', 'network_error', 'http_4xx', 'http_5xx', 'invalid_response', 'invalid_payload', 'stale',
];
const STATUS_CODES = ['latest_official', 'official', 'degraded', 'stale', 'unavailable', 'error', 'failed'];
const BOUNDED_PREFIX = /^(?:FALLBACK_REASON_|PRIMARY_REASON_|MODEL_REASON_|OFFICIAL_REASON_|UPSTREAM_STATUS_|UPSTREAM_FALLBACK$)/;

function row(overrides = {}) {
  return {
    code: '005844', name: '合成基金', kind: 'intraday_estimate', value_nav: 1,
    estimate_change: 0, source_time: '2026-08-25 10:04', base_nav: 1,
    base_nav_date: '2026-08-24', value_date: '2026-08-25', ...overrides,
  };
}

function normalize(input) {
  return normalizeEstimateQuote(input, { now: NOW, fundCode: '005844', market: 'cn' });
}

function codes(input) {
  return normalize(input).reasonCodes.filter(code => BOUNDED_PREFIX.test(code));
}

test('bounded Worker diagnostics retain every allowed code, case normalization and inline/nested precedence', () => {
  for (const key of REASON_KEYS) {
    for (const code of DIAGNOSTIC_CODES) {
      const expected = [`${key}_${code}`.toUpperCase()];
      assert.deepEqual(codes(row({ [key]: ` ${code.toUpperCase()} ` })), expected);
      assert.deepEqual(codes(row({ diagnostics: { [key]: ` ${code.toUpperCase()} ` } })), expected);
      assert.deepEqual(codes(row({ [key]: code, diagnostics: { [key]: 'unknown' } })), expected);
      for (const missing of [null, undefined]) {
        assert.deepEqual(codes(row({ [key]: missing, diagnostics: { [key]: code } })), expected);
      }
    }
  }
});

test('Worker statuses keep a separate allowlist rather than borrowing diagnostic meanings', () => {
  for (const code of STATUS_CODES) {
    assert.deepEqual(codes(row({ status: ` ${code.toUpperCase()} ` })), [`UPSTREAM_STATUS_${code.toUpperCase()}`]);
  }
  for (const code of ['timeout', 'http_5xx', 'constructor', '__proto__']) {
    assert.deepEqual(codes(row({ status: code })), ['UPSTREAM_STATUS_UNCLASSIFIED']);
  }
  for (const code of ['', ' ', 'OK', ' success ', null, undefined, 0, false, {}]) {
    assert.deepEqual(codes(row({ status: code })), []);
  }
  assert.deepEqual(codes(row({ primary_reason: 'latest_official' })), ['PRIMARY_REASON_UNCLASSIFIED']);
});

test('unknown and prototype-like diagnostic text is bounded, with no secret-like content retained', () => {
  const unknown = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'https://synthetic.invalid/?token=not-real'];
  for (const key of REASON_KEYS) {
    for (const value of unknown) {
      const quote = normalize(row({ [key]: value }));
      assert.deepEqual(quote.reasonCodes.filter(code => BOUNDED_PREFIX.test(code)), [`${key}_UNCLASSIFIED`.toUpperCase()]);
      assert.doesNotMatch(JSON.stringify(quote), /synthetic\.invalid|token=not-real/i);
    }
  }
});

test('diagnostic non-strings and empty strings remain absent without coercion or nested rescue', () => {
  const hostile = { toString() { throw new Error('must not coerce diagnostics'); } };
  for (const key of REASON_KEYS) {
    for (const value of [0, -0, 1, false, true, NaN, Infinity, {}, [], hostile, '', ' ']) {
      assert.deepEqual(codes(row({ [key]: value, diagnostics: { [key]: 'timeout' } })), []);
    }
  }
  const quote = normalize(row({ estimate_change: 0, value_nav: null, primary_reason: 0 }));
  assert.equal(quote.value, null);
  assert.equal(quote.changePct, 0);
  assert.equal(quote.baseNavDate, '2026-08-24');
  assert.equal(quote.targetDate, '2026-08-25');
});

test('bounded diagnostics keep ordered fields followed by upstream status and fallback', () => {
  assert.deepEqual(codes(row({
    diagnostics: { fallback_reason: 'timeout', primary_reason: 'http_5xx', model_reason: 'stale', official_reason: 'invalid_payload' },
    status: 'degraded', is_fallback: true,
  })), [
    'FALLBACK_REASON_TIMEOUT', 'PRIMARY_REASON_HTTP_5XX', 'MODEL_REASON_STALE',
    'OFFICIAL_REASON_INVALID_PAYLOAD', 'UPSTREAM_STATUS_DEGRADED', 'UPSTREAM_FALLBACK',
  ]);
});

test('diagnostic getters retain the established read order and exception propagation', () => {
  const expected = [
    'row.is_fallback', 'row.diagnostics', 'row.diagnostics', 'row.fallback_reason',
    'diagnostics.fallback_reason', 'row.primary_reason', 'row.model_reason', 'diagnostics.model_reason',
    'row.official_reason', 'diagnostics.official_reason', 'row.status', 'row.status', 'row.is_fallback', 'row.status',
  ];
  const observed = new Set(['diagnostics', ...REASON_KEYS, 'status', 'is_fallback']);
  const sentinel = new Error('synthetic getter exception');
  function input(trace, failAt = Infinity) {
    let reads = 0;
    function view(value, label, include) {
      return new Proxy(value, {
        get(target, key, receiver) {
          if (include(key)) {
            trace.push(`${label}.${String(key)}`);
            if (++reads === failAt) throw sentinel;
          }
          return Reflect.get(target, key, receiver);
        },
      });
    }
    const diagnostics = view({ fallback_reason: 'timeout', primary_reason: 'http_5xx', model_reason: 0, official_reason: '__proto__' }, 'diagnostics', () => true);
    return view(row({ diagnostics, fallback_reason: null, primary_reason: '', status: 'failed', is_fallback: true }), 'row', key => observed.has(key));
  }
  const trace = [];
  assert.deepEqual(codes(input(trace)), ['FALLBACK_REASON_TIMEOUT', 'OFFICIAL_REASON_UNCLASSIFIED', 'UPSTREAM_STATUS_FAILED', 'UPSTREAM_FALLBACK']);
  assert.deepEqual(trace, expected);
  for (let index = 1; index <= expected.length; index += 1) {
    const failedTrace = [];
    assert.throws(() => normalize(input(failedTrace, index)), error => error === sentinel);
    assert.deepEqual(failedTrace, expected.slice(0, index));
  }
});
