(function installQuoteBridgeRuntime(global) {
  'use strict';

  var REQUEST_TYPE = 'fundval:bridge:request';
  var RESPONSE_TYPE = 'fundval:bridge:response';
  var OPERATIONS = Object.freeze([
    'officialFundData',
    'indexQuotes',
    'securityQuotes',
    'overseasComponents',
  ]);
  var OPERATION_SET = new Set(OPERATIONS);
  var ERROR_CODE_SET = new Set([
    'invalid_request',
    'unsupported_operation',
    'load_failed',
    'timeout',
    'invalid_response',
  ]);
  var INDEX_CODE_SET = new Set(['sh000001', 'sh000300', 'usNDX', 'usINX']);
  var REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
  var FUND_CODE_RE = /^\d{6}$/;
  var CN_QUOTE_CODE_RE = /^(?:sh|sz)\d{6}$/;
  var HK_QUOTE_CODE_RE = /^hk\d{5}$/;
  var INTERNATIONAL_QUOTE_CODE_RE = /^(?:us|jp|kr)[A-Z0-9_]{1,16}$/;
  var HK_INDEX_QUOTE_CODE_RE = /^r_hk[A-Z0-9]{1,16}$/;
  var SOURCE_TIME_RE = /^(?:\d{14}|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})$/;
  var OFFICIAL_GLOBAL_KEYS = [
    'fS_code',
    'fS_name',
    'Data_netWorthTrend',
    'Data_fluctuationScale',
    'Data_currentFundManager',
    'fund_sourceRate',
    'fund_Rate',
  ];
  var LOAD_TIMEOUT_MS = 12_000;
  var requestQueue = Promise.resolve();
  var installed = false;

  function BridgeRuntimeError(code, message) {
    this.name = 'BridgeRuntimeError';
    this.code = ERROR_CODE_SET.has(code) ? code : 'invalid_response';
    this.message = message || this.code;
  }
  BridgeRuntimeError.prototype = Object.create(Error.prototype);
  BridgeRuntimeError.prototype.constructor = BridgeRuntimeError;

  function fail(code, message) {
    throw new BridgeRuntimeError(code, message);
  }

  function isPlainRecord(value) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
    var prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function onlyKeys(record, allowed) {
    var allowedSet = new Set(allowed);
    return Object.keys(record).every(function(key) { return allowedSet.has(key); });
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

  function operationLimit(operation) {
    if (operation === 'indexQuotes') return 4;
    if (operation === 'securityQuotes') return 50;
    return 64;
  }

  function validateParams(operation, params) {
    if (!isPlainRecord(params)) fail('invalid_request', 'params must be a plain object');
    if (operation === 'officialFundData') {
      if (!onlyKeys(params, ['fundCode']) || typeof params.fundCode !== 'string' || !FUND_CODE_RE.test(params.fundCode)) {
        fail('invalid_request', 'fundCode is invalid');
      }
      return Object.freeze({ fundCode: params.fundCode });
    }
    if (!onlyKeys(params, ['codes']) || !Array.isArray(params.codes)
      || params.codes.length < 1 || params.codes.length > operationLimit(operation)) {
      fail('invalid_request', 'codes has an invalid shape');
    }
    var seen = new Set();
    var codes = params.codes.map(function(value) {
      if (typeof value !== 'string') fail('invalid_request', 'code must be a string');
      var code = value.trim();
      if (!quoteCodeAllowed(operation, code) || seen.has(code)) {
        fail('invalid_request', 'code is invalid or duplicated');
      }
      seen.add(code);
      return code;
    });
    return Object.freeze({ codes: Object.freeze(codes) });
  }

  function validateRequest(value) {
    if (!isPlainRecord(value)
      || !onlyKeys(value, ['type', 'requestId', 'operation', 'params'])
      || value.type !== REQUEST_TYPE
      || typeof value.requestId !== 'string'
      || !REQUEST_ID_RE.test(value.requestId)) {
      fail('invalid_request', 'request envelope is invalid');
    }
    if (!OPERATION_SET.has(value.operation)) fail('unsupported_operation', 'operation is unsupported');
    return Object.freeze({
      type: REQUEST_TYPE,
      requestId: value.requestId,
      operation: value.operation,
      params: validateParams(value.operation, value.params),
    });
  }

  function buildScriptUrl(operation, params, nonce) {
    var normalized = validateParams(operation, params);
    var timestamp = Number.isFinite(Number(nonce)) ? Math.trunc(Number(nonce)) : Date.now();
    if (operation === 'officialFundData') {
      return 'https://fund.eastmoney.com/pingzhongdata/' + normalized.fundCode + '.js?v=' + timestamp;
    }
    return 'https://qt.gtimg.cn/q=' + normalized.codes.join(',') + '&_t=' + timestamp;
  }

  function finiteRemoteNumber(value, options) {
    var settings = options || {};
    if (value == null || typeof value === 'boolean') return null;
    if (typeof value === 'string' && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return null;
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (settings.minimum != null && number < settings.minimum) return null;
    if (settings.maximum != null && number > settings.maximum) return null;
    return number;
  }

  function boundedRemoteString(value, maximum, pattern) {
    if (value == null) return null;
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (!text || text.length > maximum || (pattern && !pattern.test(text))) return null;
    return text;
  }

  function chinaDate(timestampMs) {
    var date = new Date(Number(timestampMs) + 8 * 60 * 60 * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
  }

  function resetOfficialGlobals(scope) {
    OFFICIAL_GLOBAL_KEYS.forEach(function(key) {
      try { scope[key] = undefined; } catch (error) {}
    });
  }

  function tencentGlobalName(code) {
    return 'v_' + code.replace(/\./g, '_');
  }

  function resetTencentGlobals(scope, codes) {
    codes.forEach(function(code) {
      try { scope[tencentGlobalName(code)] = undefined; } catch (error) {}
    });
  }

  function parseOfficialFundData(expectedCode, scope) {
    var actualCode = boundedRemoteString(scope.fS_code, 6, FUND_CODE_RE);
    if (!actualCode || actualCode !== expectedCode) fail('invalid_response', 'fund identity mismatch');
    var trend = scope.Data_netWorthTrend;
    if (!Array.isArray(trend) || trend.length < 2) fail('invalid_response', 'NAV trend is unavailable');
    var remotePoints = trend.slice(-2);
    var points = remotePoints.map(function(raw) {
      if (!isPlainRecord(raw)) fail('invalid_response', 'NAV point is invalid');
      var timestampMs = finiteRemoteNumber(raw.x, {
        minimum: Date.UTC(1990, 0, 1),
        maximum: Date.UTC(2200, 0, 1),
      });
      var nav = finiteRemoteNumber(raw.y, { minimum: Number.MIN_VALUE, maximum: 1e9 });
      var date = timestampMs == null ? null : chinaDate(timestampMs);
      if (timestampMs == null || nav == null || !date) fail('invalid_response', 'NAV point is non-finite');
      return Object.freeze({ date: date, timestampMs: timestampMs, nav: nav });
    });
    if (points[0].timestampMs >= points[1].timestampMs) fail('invalid_response', 'NAV points are not chronological');

    var scale = null;
    var scaleData = scope.Data_fluctuationScale;
    if (isPlainRecord(scaleData) && Array.isArray(scaleData.series) && scaleData.series.length) {
      var latestScale = scaleData.series[scaleData.series.length - 1];
      scale = isPlainRecord(latestScale)
        ? finiteRemoteNumber(latestScale.y, { minimum: 0, maximum: 1e9 })
        : null;
    }
    var manager = Array.isArray(scope.Data_currentFundManager) && scope.Data_currentFundManager.length
      ? scope.Data_currentFundManager[0]
      : null;
    if (!isPlainRecord(manager)) manager = null;
    return Object.freeze({
      fundCode: actualCode,
      fundName: boundedRemoteString(scope.fS_name, 120),
      points: Object.freeze(points),
      meta: Object.freeze({
        scale: scale,
        managerName: manager ? boundedRemoteString(manager.name, 80) : null,
        managerWorkTime: manager ? boundedRemoteString(manager.workTime, 80) : null,
        managerId: manager ? boundedRemoteString(manager.id, 40, /^[A-Za-z0-9_-]+$/) : null,
        sourceRate: boundedRemoteString(scope.fund_sourceRate, 32),
        currentRate: boundedRemoteString(scope.fund_Rate, 32),
      }),
    });
  }

  function parseTencentQuote(raw, expectedCode) {
    if (typeof raw !== 'string' || raw.length < 4 || raw.length > 8192) return null;
    var fields = raw.split('~');
    if (fields.length < 4 || fields.length > 160) return null;
    var price = finiteRemoteNumber(fields[3], { minimum: Number.MIN_VALUE, maximum: 1e15 });
    if (price == null) return null;
    var changePct = finiteRemoteNumber(fields[32], { minimum: -1e6, maximum: 1e6 });
    if (changePct == null) {
      var previousClose = finiteRemoteNumber(fields[4], { minimum: Number.MIN_VALUE, maximum: 1e15 });
      if (previousClose != null) {
        changePct = (price - previousClose) / previousClose * 100;
        if (!Number.isFinite(changePct) || changePct < -1e6 || changePct > 1e6) changePct = null;
      }
    }
    var sourceTimeRaw = boundedRemoteString(fields[30], 32, SOURCE_TIME_RE);
    return Object.freeze({
      code: expectedCode,
      price: price,
      changePct: changePct,
      sourceTimeRaw: sourceTimeRaw,
    });
  }

  function parseTencentQuotes(operation, codes, scope) {
    var expected = new Set(codes);
    var quotes = [];
    codes.forEach(function(code) {
      if (!expected.has(code) || !quoteCodeAllowed(operation, code)) return;
      var parsed = parseTencentQuote(scope[tencentGlobalName(code)], code);
      if (parsed) quotes.push(parsed);
    });
    return Object.freeze({ quotes: Object.freeze(quotes) });
  }

  function loadScript(url, documentRef, timeoutMs) {
    return new Promise(function(resolve, reject) {
      var documentObject = documentRef || global.document;
      if (!documentObject || !documentObject.createElement || !documentObject.head) {
        reject(new BridgeRuntimeError('load_failed', 'bridge document is unavailable'));
        return;
      }
      var script = documentObject.createElement('script');
      var settled = false;
      var timer = global.setTimeout(function() {
        finish(new BridgeRuntimeError('timeout', 'quote source timed out'));
      }, timeoutMs || LOAD_TIMEOUT_MS);
      function finish(error) {
        if (settled) return;
        settled = true;
        global.clearTimeout(timer);
        try { script.remove(); } catch (removeError) {}
        if (error) reject(error); else resolve();
      }
      script.async = true;
      script.referrerPolicy = 'no-referrer';
      script.charset = url.indexOf('qt.gtimg.cn') >= 0 ? 'gbk' : 'utf-8';
      script.onload = function() { finish(); };
      script.onerror = function() { finish(new BridgeRuntimeError('load_failed', 'quote source failed')); };
      script.src = url;
      documentObject.head.appendChild(script);
    });
  }

  async function performOperation(request, options) {
    var normalized = validateRequest(request);
    var settings = options || {};
    var scope = settings.scope || global;
    var loader = settings.loadScript || loadScript;
    var documentRef = settings.document || global.document;
    if (normalized.operation === 'officialFundData') resetOfficialGlobals(scope);
    else resetTencentGlobals(scope, normalized.params.codes);
    try {
      await loader(buildScriptUrl(normalized.operation, normalized.params), documentRef, LOAD_TIMEOUT_MS);
      return normalized.operation === 'officialFundData'
        ? parseOfficialFundData(normalized.params.fundCode, scope)
        : parseTencentQuotes(normalized.operation, normalized.params.codes, scope);
    } finally {
      if (normalized.operation === 'officialFundData') resetOfficialGlobals(scope);
      else resetTencentGlobals(scope, normalized.params.codes);
    }
  }

  function successResponse(requestId, data) {
    return Object.freeze({ type: RESPONSE_TYPE, requestId: requestId, ok: true, data: data });
  }

  function errorResponse(requestId, error) {
    var code = error && ERROR_CODE_SET.has(error.code) ? error.code : 'invalid_response';
    return Object.freeze({ type: RESPONSE_TYPE, requestId: requestId, ok: false, data: null, errorCode: code });
  }

  function safeRequestId(value) {
    return isPlainRecord(value) && typeof value.requestId === 'string' && REQUEST_ID_RE.test(value.requestId)
      ? value.requestId
      : '';
  }

  function postResponse(target, response) {
    if (!target || typeof target.postMessage !== 'function') return;
    target.postMessage(response, '*');
  }

  function handleMessage(event) {
    if (!event || event.source !== global.parent) return;
    var id = safeRequestId(event.data);
    if (!id) return;
    var request;
    try {
      request = validateRequest(event.data);
    } catch (error) {
      postResponse(event.source, errorResponse(id, error));
      return;
    }
    var task = function() {
      return performOperation(request).then(function(data) {
        postResponse(event.source, successResponse(request.requestId, data));
      }, function(error) {
        postResponse(event.source, errorResponse(request.requestId, error));
      });
    };
    requestQueue = requestQueue.then(task, task);
  }

  function install() {
    if (installed || typeof global.addEventListener !== 'function') return;
    installed = true;
    global.addEventListener('message', handleMessage);
  }

  var api = Object.freeze({
    OPERATIONS: OPERATIONS,
    validateRequest: validateRequest,
    buildScriptUrl: buildScriptUrl,
    parseOfficialFundData: parseOfficialFundData,
    parseTencentQuote: parseTencentQuote,
    parseTencentQuotes: parseTencentQuotes,
    performOperation: performOperation,
    install: install,
  });

  Object.defineProperty(global, 'FundValQuoteBridgeRuntime', {
    value: api,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  if (global.document) install();
})(globalThis);
