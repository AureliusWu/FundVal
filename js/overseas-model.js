import { MODEL_URL, TIMING } from './config.js';

const MAX_QUOTE_AGE_MS = 36 * 60 * 60 * 1000;
const CODE_PATTERN = /^\d{6}$/;

function emptyConfig() {
  return { schema: 1, models: {}, rules: [] };
}

let config = emptyConfig();

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeLegs(value) {
  if (!Array.isArray(value)) return [];
  return value.reduce((legs, leg) => {
    const code = String(leg && leg.code || '').trim();
    const weight = finiteNumber(leg && leg.weight);
    if (!code || !Number.isFinite(weight) || weight <= 0) return legs;
    legs.push({ ...leg, code, weight });
    return legs;
  }, []);
}

function normalizeModel(value, defaults = {}) {
  if (!value || typeof value !== 'object') return null;
  const legs = normalizeLegs(value.legs);
  if (!legs.length) return null;

  const minWeight = finiteNumber(value.min_weight ?? value.minWeight ?? defaults.minWeight ?? 100);
  if (!Number.isFinite(minWeight) || minWeight <= 0) return null;

  const scale = finiteNumber(value.scale ?? value.adjustment?.scale, 1);
  const bias = finiteNumber(value.bias ?? value.adjustment?.bias, 0);
  const confidence = ['low', 'medium', 'high'].includes(value.confidence)
    ? value.confidence
    : (defaults.confidence || 'medium');
  return {
    ...value,
    legs,
    min_weight: minWeight,
    minWeight,
    scale,
    bias,
    version: String(value.version || defaults.version || ''),
    label: String(value.label || defaults.label || ''),
    quarter: String(value.quarter || ''),
    valid_until: String(value.valid_until || value.validUntil || ''),
    confidence,
  };
}

function normalizeRule(value) {
  if (!value || typeof value !== 'object') return null;
  const pattern = String(value.pattern || '').trim();
  if (!pattern) return null;
  try { new RegExp(pattern, 'i'); }
  catch (_) { return null; }
  const model = normalizeModel(value, { minWeight: 100, version: 'rule-v1', confidence: 'low' });
  return model ? { ...model, pattern, version: model.version || 'rule-v1', quarter: '' } : null;
}

export function normalizeOverseasConfig(value) {
  const next = emptyConfig();
  if (!value || typeof value !== 'object') return next;
  next.schema = finiteNumber(value.schema, 1);
  next.updated_at = typeof value.updated_at === 'string' ? value.updated_at : '';

  if (value.models && typeof value.models === 'object' && !Array.isArray(value.models)) {
    Object.entries(value.models).forEach(([code, model]) => {
      const normalizedCode = String(code || '').trim();
      const normalizedModel = normalizeModel(model);
      if (CODE_PATTERN.test(normalizedCode) && normalizedModel) next.models[normalizedCode] = normalizedModel;
    });
  }
  next.rules = Array.isArray(value.rules) ? value.rules.map(normalizeRule).filter(Boolean) : [];
  return next;
}

function fetchModelConfig(fetcher, timeout) {
  const controller = new AbortController();
  let timer = null;
  const request = Promise.resolve().then(() => fetcher(MODEL_URL, { cache: 'no-cache', signal: controller.signal }));
  const timeoutError = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('overseas model request timed out'));
    }, timeout);
  });
  return Promise.race([request, timeoutError]).finally(() => clearTimeout(timer));
}

export async function loadOverseasModels(fetcher = fetch, { timeout = TIMING.MODEL_LOAD_TIMEOUT } = {}) {
  try {
    const response = await fetchModelConfig(fetcher, timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = normalizeOverseasConfig(await response.json());
  } catch (_) { config = emptyConfig(); /* official NAV remains available */ }
  return config;
}
export function getOverseasConfig() { return config; }

export function selectOverseasModel(code, name) {
  const direct = config.models?.[String(code || '')];
  if (direct) return direct;
  const text = String(name || '');
  for (const rule of config.rules || []) {
    try {
      if (new RegExp(rule.pattern, 'i').test(text)) return rule;
    } catch (_) { /* malformed rules must not interrupt valuation refresh */ }
  }
  return null;
}

function parseQuoteTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0'] = match;
  const normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${minute}:${second.padStart(2, '0')}`;
  const timestamp = Date.parse(`${normalized.replace(' ', 'T')}+08:00`);
  return Number.isFinite(timestamp) ? { text: normalized, timestamp } : null;
}

function chinaQuarterIndex(nowMs) {
  const date = new Date(nowMs + 8 * 60 * 60 * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return date.getUTCFullYear() * 4 + Math.floor(date.getUTCMonth() / 3);
}

function validUntilMs(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const timestamp = Date.parse(`${text}T23:59:59+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function modelIsPastQuarter(model, nowMs) {
  const explicitExpiry = validUntilMs(model.valid_until);
  if (explicitExpiry != null) return nowMs > explicitExpiry;
  const match = String(model.quarter || '').match(/^(\d{4})Q([1-4])$/i);
  if (!match) return false;
  const modelQuarter = Number(match[1]) * 4 + Number(match[2]) - 1;
  const currentQuarter = chinaQuarterIndex(nowMs);
  return currentQuarter != null && currentQuarter > modelQuarter;
}

export function calculateOverseasEstimate(model, quotes, now = new Date()) {
  const normalizedModel = normalizeModel(model);
  if (!normalizedModel) return { change: null, usableWeight: 0, confidence: null, stale: true, reason: '无可靠模型' };
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const referenceNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const legs = normalizedModel.legs;
  let weighted = 0, usableWeight = 0, excludedWeight = 0;
  const sourceTimes = [];
  const rejected = { missingTime: 0, future: 0, stale: 0 };
  for (const leg of legs) {
    const quote = quotes instanceof Map ? quotes.get(leg.code) : quotes[leg.code];
    if (!quote || !Number.isFinite(quote.change)) continue;
    const quoteTime = parseQuoteTime(quote.time);
    if (!quoteTime) { excludedWeight += leg.weight; rejected.missingTime += 1; continue; }
    const ageMs = referenceNow - quoteTime.timestamp;
    if (ageMs < 0) { excludedWeight += leg.weight; rejected.future += 1; continue; }
    if (ageMs > MAX_QUOTE_AGE_MS) { excludedWeight += leg.weight; rejected.stale += 1; continue; }
    usableWeight += leg.weight; weighted += quote.change * leg.weight;
    sourceTimes.push(quoteTime);
  }
  const minimum = normalizedModel.min_weight;
  if (usableWeight < minimum) return {
    change: null,
    usableWeight,
    excludedWeight,
    rejected,
    modelVersion: normalizedModel.version,
    modelLabel: normalizedModel.label,
    confidence: 'low',
    stale: true,
    reason: `可用权重 ${usableWeight.toFixed(1)}% 低于 ${minimum}%`,
  };
  let change = weighted / usableWeight;
  change = change * normalizedModel.scale + normalizedModel.bias;
  const oldQuarter = modelIsPastQuarter(normalizedModel, referenceNow);
  const latestSource = sourceTimes.sort((a, b) => b.timestamp - a.timestamp)[0];
  return {
    change,
    usableWeight,
    excludedWeight,
    rejected,
    modelVersion: normalizedModel.version,
    modelLabel: normalizedModel.label,
    confidence: oldQuarter || rejected.missingTime || rejected.future || rejected.stale ? 'low' : normalizedModel.confidence,
    stale: oldQuarter,
    sourceTime: latestSource?.text || '',
    reason: oldQuarter ? '模型披露季度已过期' : '模型可用',
  };
}
