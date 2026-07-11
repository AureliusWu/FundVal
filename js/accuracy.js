const KEY = 'fuyu_overseas_accuracy_v1';

export function loadAccuracy(storage = localStorage) { try { return JSON.parse(storage.getItem(KEY) || '[]'); } catch (_) { return []; } }
export function saveAccuracy(rows, storage = localStorage) { storage.setItem(KEY, JSON.stringify(rows)); }

export function recordPrediction(rows, prediction) {
  const exists = rows.some(row => row.code === prediction.code && row.prediction_date === prediction.prediction_date && row.model_version === prediction.model_version);
  if (!exists) rows.push({ ...prediction, actual_change: null, error: null, direction_correct: null, settled_at: null });
  const grouped = new Map();
  rows.forEach(row => { const list = grouped.get(row.code) || []; list.push(row); grouped.set(row.code, list); });
  return [...grouped.values()].flatMap(list => list.sort((a,b) => String(b.prediction_date).localeCompare(String(a.prediction_date))).slice(0, 100));
}

export function settlePredictions(rows, code, navDate, actualChange, settledAt = new Date().toISOString()) {
  return rows.map(row => row.code === code && row.actual_change == null &&
    (row.target_nav_date === navDate || (row.target_nav_date === 'next' && row.prediction_date < navDate)) ? {
    ...row, actual_change: actualChange, error: row.predicted_change - actualChange,
    direction_correct: Math.sign(row.predicted_change) === Math.sign(actualChange), settled_at: settledAt
  } : row);
}

export function accuracyStats(rows) {
  const settled = rows.filter(row => Number.isFinite(row.error));
  const abs = settled.map(row => Math.abs(row.error)).sort((a,b) => a-b);
  const mae = abs.length ? abs.reduce((a,b) => a+b,0) / abs.length : null;
  const bias = settled.length ? settled.reduce((sum,row) => sum + row.error,0) / settled.length : null;
  const direction = settled.length ? settled.filter(row => row.direction_correct).length / settled.length * 100 : null;
  const confidence = settled.length < 5 ? 'collecting' : settled.length < 20 ? 'low' : mae <= .5 && direction >= 70 ? 'high' : mae <= .8 ? 'medium' : 'low';
  return { samples: settled.length, mae, bias, directionRate: direction, p80: abs.length ? abs[Math.min(abs.length - 1, Math.ceil(abs.length * .8) - 1)] : null, confidence };
}
