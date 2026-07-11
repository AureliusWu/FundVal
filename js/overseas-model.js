import { MODEL_URL } from './config.js';

let config = { schema: 1, models: {}, rules: [] };

export async function loadOverseasModels(fetcher = fetch) {
  try {
    const response = await fetcher(MODEL_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = await response.json();
  } catch (_) { /* retain empty config; official NAV remains available */ }
  return config;
}
export function getOverseasConfig() { return config; }

export function selectOverseasModel(code, name) {
  if (config.models?.[code]) return config.models[code];
  const rule = (config.rules || []).find(item => new RegExp(item.pattern, 'i').test(name || ''));
  return rule ? { ...rule, version: 'rule-v1', quarter: '', min_weight: rule.min_weight || 100 } : null;
}

export function calculateOverseasEstimate(model, quotes, now = new Date()) {
  if (!model) return { change: null, usableWeight: 0, confidence: null, stale: true, reason: '无可靠模型' };
  const legs = model.legs || [];
  let weighted = 0, usableWeight = 0, stale = false;
  for (const leg of legs) {
    const quote = quotes instanceof Map ? quotes.get(leg.code) : quotes[leg.code];
    if (!quote || !Number.isFinite(quote.change)) continue;
    usableWeight += leg.weight; weighted += quote.change * leg.weight;
    if (quote.time && now.getTime() - new Date(quote.time).getTime() > 15 * 60000) stale = true;
  }
  const minimum = model.min_weight ?? model.minWeight ?? 100;
  if (usableWeight < minimum) return { change: null, usableWeight, modelVersion: model.version || '', modelLabel: model.label || '', confidence: 'low', stale: true, reason: `可用权重 ${usableWeight.toFixed(1)}% 低于 ${minimum}%` };
  let change = weighted / usableWeight;
  change = change * (model.scale ?? model.adjustment?.scale ?? 1) + (model.bias ?? model.adjustment?.bias ?? 0);
  const quarterYear = Number(String(model.quarter || '').slice(0, 4));
  const oldQuarter = quarterYear && now.getFullYear() > quarterYear;
  return { change, usableWeight, modelVersion: model.version || '', modelLabel: model.label || '', confidence: stale || oldQuarter ? 'low' : (model.confidence || 'medium'), stale, reason: stale ? '成分行情过期' : '模型可用' };
}
