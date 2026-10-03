export const BRIDGE_REQUEST_TYPE = 'fundval:bridge:request';
export const BRIDGE_RESPONSE_TYPE = 'fundval:bridge:response';

export const BRIDGE_OPERATIONS = Object.freeze([
  'officialFundData',
  'indexQuotes',
  'securityQuotes',
  'overseasComponents',
]);

export const BRIDGE_ERROR_CODES = Object.freeze([
  'invalid_request',
  'unsupported_operation',
  'load_failed',
  'timeout',
  'invalid_response',
  'bridge_unavailable',
  'aborted',
]);

export const BRIDGE_LIMITS = Object.freeze({
  requestIdLength: 128,
  indexCodes: 4,
  securityCodes: 50,
  overseasCodes: 64,
  remoteTextLength: 160,
});

const OPERATION_SET = new Set(BRIDGE_OPERATIONS);
const ERROR_CODE_SET = new Set(BRIDGE_ERROR_CODES);
const INDEX_CODE_SET = new Set(['sh000001', 'sh000300', 'usNDX', 'usINX']);
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const FUND_CODE_RE = /^\d{6}$/;
const CN_QUOTE_CODE_RE = /^(?:sh|sz)\d{6}$/;
const HK_QUOTE_CODE_RE = /^hk\d{5}$/;
const INTERNATIONAL_QUOTE_CODE_RE = /^(?:us|jp|kr)[A-Z0-9_]{1,16}$/;
const HK_INDEX_QUOTE_CODE_RE = /^r_hk[A-Z0-9]{1,16}$/;
const SOURCE_TIME_RE = /^(?:\d{14}|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class RemoteSchemaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'RemoteSchemaError';
    this.code = ERROR_CODE_SET.has(code) ? code : 'invalid_response';
  }
}

function fail(code, message) {
  throw new RemoteSchemaError(code, message);
}

function isPlainRecord(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, label, errorCode = 'invalid_response') {
  if (!isPlainRecord(value)) fail(errorCode, `${label} must be a plain object`);
  return value;
}

function assertOnlyKeys(record, allowedKeys, label, errorCode = 'invalid_response') {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(errorCode, `${label} contains unsupported field ${key}`);
  }
}

function boundedString(value, label, maximum, { nullable = false, pattern } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string') fail('invalid_response', `${label} must be a string`);
  const text = value.trim();
  if (!text || text.length > maximum || (pattern && !pattern.test(text))) {
    fail('invalid_response', `${label} is invalid`);
  }
  return text;
}

function nullableBoundedString(value, label, maximum, pattern) {
  if (value == null || value === '') return null;
  return boundedString(value, label, maximum, { pattern });
}

function finiteNumber(value, label, minimum = -Infinity, maximum = Infinity, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('invalid_response', `${label} must be a finite number`);
  }
  return value;
}

function requestId(value, errorCode = 'invalid_request') {
  if (typeof value !== 'string' || !REQUEST_ID_RE.test(value)) {
    fail(errorCode, 'requestId is invalid');
  }
  return value;
}

function quoteCodeAllowed(operation, code) {
  if (operation === 'indexQuotes') return INDEX_CODE_SET.has(code);
  if (operation === 'securityQuotes') {
    return CN_QUOTE_CODE_RE.test(code)
      || HK_QUOTE_CODE_RE.test(code)
      || INTERNATIONAL_QUOTE_CODE_RE.test(code);
  }
  return CN_QUOTE_CODE_RE.test(code)
    || INTERNATIONAL_QUOTE_CODE_RE.test(code)
    || HK_INDEX_QUOTE_CODE_RE.test(code);
}

function codeLimit(operation) {
  if (operation === 'indexQuotes') return BRIDGE_LIMITS.indexCodes;
  if (operation === 'securityQuotes') return BRIDGE_LIMITS.securityCodes;
  return BRIDGE_LIMITS.overseasCodes;
}

function normalizeCodeList(operation, value, errorCode = 'invalid_request') {
  if (!Array.isArray(value) || value.length < 1 || value.length > codeLimit(operation)) {
    fail(errorCode, `${operation}.codes has an invalid length`);
  }
  const unique = new Set();
  const codes = value.map((entry) => {
    if (typeof entry !== 'string') fail(errorCode, `${operation}.codes must contain strings`);
    const code = entry.trim();
    if (!quoteCodeAllowed(operation, code) || unique.has(code)) {
      fail(errorCode, `${operation}.codes contains an invalid or duplicate code`);
    }
    unique.add(code);
    return code;
  });
  return Object.freeze(codes);
}

export function validateBridgeParams(operation, input, errorCode = 'invalid_request') {
  if (!OPERATION_SET.has(operation)) fail('unsupported_operation', 'operation is unsupported');
  const params = assertRecord(input, 'params', errorCode);
  if (operation === 'officialFundData') {
    assertOnlyKeys(params, ['fundCode'], 'params', errorCode);
    if (typeof params.fundCode !== 'string' || !FUND_CODE_RE.test(params.fundCode)) {
      fail(errorCode, 'officialFundData.fundCode is invalid');
    }
    return Object.freeze({ fundCode: params.fundCode });
  }
  assertOnlyKeys(params, ['codes'], 'params', errorCode);
  return Object.freeze({ codes: normalizeCodeList(operation, params.codes, errorCode) });
}

export function validateBridgeRequest(input) {
  const request = assertRecord(input, 'bridge request', 'invalid_request');
  assertOnlyKeys(request, ['type', 'requestId', 'operation', 'params'], 'bridge request', 'invalid_request');
  if (request.type !== BRIDGE_REQUEST_TYPE) fail('invalid_request', 'bridge request type is invalid');
  const id = requestId(request.requestId);
  if (!OPERATION_SET.has(request.operation)) fail('unsupported_operation', 'operation is unsupported');
  return Object.freeze({
    type: BRIDGE_REQUEST_TYPE,
    requestId: id,
    operation: request.operation,
    params: validateBridgeParams(request.operation, request.params),
  });
}

export function createBridgeRequest(operation, params, id) {
  return validateBridgeRequest({
    type: BRIDGE_REQUEST_TYPE,
    requestId: id,
    operation,
    params,
  });
}

function normalizeOfficialFundData(data, expectedParams) {
  const input = assertRecord(data, 'officialFundData data');
  assertOnlyKeys(input, ['fundCode', 'fundName', 'points', 'meta'], 'officialFundData data');
  const fundCode = boundedString(input.fundCode, 'fundCode', 6, { pattern: FUND_CODE_RE });
  if (fundCode !== expectedParams.fundCode) fail('invalid_response', 'fundCode does not match the request');
  const fundName = nullableBoundedString(input.fundName, 'fundName', 120);
  if (!Array.isArray(input.points) || input.points.length !== 2) {
    fail('invalid_response', 'officialFundData points must contain the latest two NAV points');
  }
  const points = input.points.map((entry, index) => {
    const point = assertRecord(entry, `points[${index}]`);
    assertOnlyKeys(point, ['date', 'timestampMs', 'nav'], `points[${index}]`);
    return Object.freeze({
      date: boundedString(point.date, `points[${index}].date`, 10, { pattern: DATE_RE }),
      timestampMs: finiteNumber(point.timestampMs, `points[${index}].timestampMs`, Date.UTC(1990, 0, 1), Date.UTC(2200, 0, 1)),
      nav: finiteNumber(point.nav, `points[${index}].nav`, Number.MIN_VALUE, 1e9),
    });
  });
  if (points[0].timestampMs >= points[1].timestampMs) {
    fail('invalid_response', 'officialFundData points must be chronological');
  }
  const rawMeta = assertRecord(input.meta, 'officialFundData meta');
  assertOnlyKeys(rawMeta, [
    'scale',
    'managerName',
    'managerWorkTime',
    'managerId',
    'sourceRate',
    'currentRate',
  ], 'officialFundData meta');
  const meta = Object.freeze({
    scale: finiteNumber(rawMeta.scale, 'meta.scale', 0, 1e9, true),
    managerName: nullableBoundedString(rawMeta.managerName, 'meta.managerName', 80),
    managerWorkTime: nullableBoundedString(rawMeta.managerWorkTime, 'meta.managerWorkTime', 80),
    managerId: nullableBoundedString(rawMeta.managerId, 'meta.managerId', 40, /^[A-Za-z0-9_-]+$/),
    sourceRate: nullableBoundedString(rawMeta.sourceRate, 'meta.sourceRate', 32),
    currentRate: nullableBoundedString(rawMeta.currentRate, 'meta.currentRate', 32),
  });
  return Object.freeze({ fundCode, fundName, points: Object.freeze(points), meta });
}

function normalizeQuoteData(operation, data, expectedParams) {
  const input = assertRecord(data, `${operation} data`);
  assertOnlyKeys(input, ['quotes'], `${operation} data`);
  if (!Array.isArray(input.quotes) || input.quotes.length > expectedParams.codes.length) {
    fail('invalid_response', `${operation}.quotes has an invalid length`);
  }
  const expected = new Set(expectedParams.codes);
  const seen = new Set();
  const quotes = input.quotes.map((entry, index) => {
    const quote = assertRecord(entry, `quotes[${index}]`);
    assertOnlyKeys(quote, ['code', 'price', 'changePct', 'sourceTimeRaw'], `quotes[${index}]`);
    const code = boundedString(quote.code, `quotes[${index}].code`, 32);
    if (!quoteCodeAllowed(operation, code) || !expected.has(code) || seen.has(code)) {
      fail('invalid_response', `quotes[${index}].code is outside the expected request set`);
    }
    seen.add(code);
    return Object.freeze({
      code,
      price: finiteNumber(quote.price, `quotes[${index}].price`, Number.MIN_VALUE, 1e15),
      changePct: finiteNumber(quote.changePct, `quotes[${index}].changePct`, -1e6, 1e6, true),
      sourceTimeRaw: nullableBoundedString(
        quote.sourceTimeRaw,
        `quotes[${index}].sourceTimeRaw`,
        32,
        SOURCE_TIME_RE,
      ),
    });
  });
  return Object.freeze({ quotes: Object.freeze(quotes) });
}

export function validateBridgeOperationData(operation, data, params) {
  const expectedParams = validateBridgeParams(operation, params, 'invalid_response');
  return operation === 'officialFundData'
    ? normalizeOfficialFundData(data, expectedParams)
    : normalizeQuoteData(operation, data, expectedParams);
}

export function validateBridgeResponse(input, expected = {}) {
  const response = assertRecord(input, 'bridge response');
  assertOnlyKeys(response, ['type', 'requestId', 'ok', 'data', 'errorCode'], 'bridge response');
  if (response.type !== BRIDGE_RESPONSE_TYPE) fail('invalid_response', 'bridge response type is invalid');
  const id = requestId(response.requestId, 'invalid_response');
  if (expected.requestId && id !== expected.requestId) fail('invalid_response', 'requestId does not match');
  if (typeof response.ok !== 'boolean') fail('invalid_response', 'bridge response ok must be boolean');
  if (!response.ok) {
    if (response.data != null) fail('invalid_response', 'failed bridge response cannot contain data');
    if (typeof response.errorCode !== 'string' || !ERROR_CODE_SET.has(response.errorCode)) {
      fail('invalid_response', 'bridge response errorCode is invalid');
    }
    return Object.freeze({
      type: BRIDGE_RESPONSE_TYPE,
      requestId: id,
      ok: false,
      data: null,
      errorCode: response.errorCode,
    });
  }
  if (response.errorCode != null && response.errorCode !== '') {
    fail('invalid_response', 'successful bridge response cannot contain errorCode');
  }
  if (!OPERATION_SET.has(expected.operation)) fail('invalid_response', 'expected operation is required');
  return Object.freeze({
    type: BRIDGE_RESPONSE_TYPE,
    requestId: id,
    ok: true,
    data: validateBridgeOperationData(expected.operation, response.data, expected.params),
    errorCode: null,
  });
}
