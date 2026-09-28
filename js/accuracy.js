import { safeGetItem, safeSetItem } from './storage.js';

const KEY = 'fuyu_overseas_accuracy_v1';

function defaultStorage() {
  try { return globalThis.localStorage; }
  catch (_) { return null; }
}

export function normalizeAccuracyRows(value) {
  return Array.isArray(value)
    ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row))
    : [];
}

export function loadAccuracy(storage = defaultStorage()) {
  try { return normalizeAccuracyRows(JSON.parse(safeGetItem(KEY, storage) || '[]')); }
  catch (_) { return []; }
}

export function saveAccuracy(rows, storage = defaultStorage()) {
  return safeSetItem(KEY, JSON.stringify(normalizeAccuracyRows(rows)), storage);
}

export function recordPrediction(rows, prediction) {
  const normalized = normalizeAccuracyRows(rows);
  if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)) return normalized;
  const exists = normalized.some(row => row.code === prediction.code && row.prediction_date === prediction.prediction_date && row.model_version === prediction.model_version);
  if (!exists) normalized.push({ ...prediction, actual_change: null, error: null, direction_correct: null, settled_at: null });
  const grouped = new Map();
  normalized.forEach(row => { const list = grouped.get(row.code) || []; list.push(row); grouped.set(row.code, list); });
  return [...grouped.values()].flatMap(list => list.sort((a,b) => String(b.prediction_date).localeCompare(String(a.prediction_date))).slice(0, 100));
}

export function settlePredictions(rows, code, navDate, actualChange, settledAt = new Date().toISOString(), previousNavDate = '') {
  return normalizeAccuracyRows(rows).map(row => row.code === code && row.actual_change == null &&
    (row.target_nav_date === navDate || (row.target_nav_date === 'next'
      && row.base_nav_date
      && row.base_nav_date === previousNavDate)) ? {
    ...row, actual_change: actualChange, error: row.predicted_change - actualChange,
    direction_correct: Math.sign(row.predicted_change) === Math.sign(actualChange), settled_at: settledAt
  } : row);
}

export function accuracyStats(rows) {
  const settled = normalizeAccuracyRows(rows).filter(row => Number.isFinite(row.error));
  const abs = settled.map(row => Math.abs(row.error)).sort((a,b) => a-b);
  const mae = abs.length ? abs.reduce((a,b) => a+b,0) / abs.length : null;
  const bias = settled.length ? settled.reduce((sum,row) => sum + row.error,0) / settled.length : null;
  const direction = settled.length ? settled.filter(row => row.direction_correct).length / settled.length * 100 : null;
  const confidence = settled.length < 5 ? 'collecting' : settled.length < 20 ? 'low' : mae <= .5 && direction >= 70 ? 'high' : mae <= .8 ? 'medium' : 'low';
  return { samples: settled.length, mae, bias, directionRate: direction, p80: abs.length ? abs[Math.min(abs.length - 1, Math.ceil(abs.length * .8) - 1)] : null, confidence };
}

// Loaded only for an overseas fund or explicit export, never needed to paint
// the homepage. The refresh coordinator guards the call after dynamic import.
export function updateFundAccuracy(fund, { now = Date.now(), storage = defaultStorage() } = {}) {
  let rows = loadAccuracy(storage);
  const move = fund.latest_nav_move;
  const recordedAt = new Date(now).toISOString();
  if (move?.date && Number.isFinite(move.change)) {
    rows = settlePredictions(rows, fund.code, move.date, move.change, recordedAt, move.prevDate || '');
  }
  const china = new Date(now + 8 * 3600_000);
  const minute = china.getUTCHours() * 60 + china.getUTCMinutes();
  const quote = fund.quote;
  if (quote?.valueKind === 'model_estimate' && quote.status === 'model' && fund.est_model && !fund.est_model_stale
      && quote.baseNavDate && quote.targetDate && Number.isFinite(quote.changePct) && minute >= 870) {
    rows = recordPrediction(rows, {
      code: fund.code, prediction_date: china.toISOString().slice(0, 10),
      target_nav_date: quote.targetDate, base_nav_date: quote.baseNavDate,
      model_version: fund.est_model_version || 'unknown', model_label: fund.est_model_label || '',
      predicted_change: quote.changePct, confidence: fund.est_confidence || 'unknown', recorded_at: recordedAt,
    });
  }
  saveAccuracy(rows, storage);
  fund.accuracy = accuracyStats(rows.filter(row => row.code === fund.code));
}
