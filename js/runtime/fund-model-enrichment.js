import { getOverseasConfig, loadOverseasModels, selectOverseasModel, calculateOverseasEstimate, validateOverseasEstimatePeriod } from "../overseas-model.js";
import { latestOfficialNavBase, formatChinaQuoteTime } from "../holdings-estimate.js";
import { parseQuoteTimestamp } from "./quote-contract.js";
export { getOverseasConfig, loadOverseasModels, selectOverseasModel };
const isUsableNav = value => Number.isFinite(value) && value > 0;
const fmt = value => Number(value).toFixed(2);

export async function fetchOverseasModelQuotes(signal, { fetchTencentQuotes, fetchGoldPrice }) {
  var tencentCodes = ['usEEM', 'usQQQ', 'usSPY', 'usNDX', 'usIXIC', 'usINX', 'usSMH', 'usSOXX', 'usEWY', 'r_hkHSTECH', 'r_hkHSI'];
  var modelConfig = getOverseasConfig();
  collectOverseasModelCodes(modelConfig.models, tencentCodes);
  collectOverseasModelCodes(modelConfig.rules, tencentCodes);
  var results = await Promise.all([fetchTencentQuotes(tencentCodes, signal), fetchGoldPrice(signal)]);
  var q = results[0] || {};
  var gold = results[1];
  if (gold && Number.isFinite(gold.changePct)) {
    if (gold.status === 'current') q.AU9999 = { price: gold.price, changePct: gold.changePct,
      sourceTime: formatChinaQuoteTime(parseQuoteTimestamp(gold.observedAt) / 1000) };
  }
  return q;
}

function collectOverseasModelCodes(models, out) {
  var seen = {};
  out.forEach(function(code) { seen[code] = true; });
  var list = Array.isArray(models) ? models : Object.keys(models || {}).map(function(k) { return models[k]; });
  list.forEach(function(model) {
    var legs = [];
    if (model && Array.isArray(model.legs)) legs = legs.concat(model.legs);
    if (model && model.fallback && Array.isArray(model.fallback.legs)) legs = legs.concat(model.fallback.legs);
    legs.forEach(function(leg) {
      if (leg && leg.code && !seen[leg.code]) {
        seen[leg.code] = true;
        out.push(leg.code);
      }
    });
  });
}

function chooseOverseasModel(fund) {
  return selectOverseasModel(String(fund && fund.code || ''), String(fund && fund.name || ''));
}

export function applyOverseasModelEstimate(fund, quotes) {
  if (!fund || fund.est_realtime !== false) return;
  var model = chooseOverseasModel(fund);
  if (!model) return;
  var normalizedQuotes = {};
  Object.keys(quotes || {}).forEach(function(code) {
    var quote = quotes[code];
    if (quote) normalizedQuotes[code] = { change: quote.changePct, time: quote.sourceTime || quote.time };
  });
  var result = calculateOverseasEstimate(model, normalizedQuotes);
  var changePct = result && result.change;
  if (!Number.isFinite(changePct)) return;

  var official = latestOfficialNavBase(fund);
  if (!official) return;
  var modelBaseNav = official.nav;
  var modelBaseDate = official.date;
  var period = validateOverseasEstimatePeriod(model, normalizedQuotes, modelBaseDate);
  if (!period.valid || !isUsableNav(modelBaseNav) || result.stale) return;
  fund.est_change = changePct;
  if (isUsableNav(modelBaseNav)) {
    fund.est_nav = modelBaseNav * (1 + changePct / 100);
  }
  fund.est_model_base_nav = modelBaseNav;
  fund.est_model_base_date = modelBaseDate;
  fund.est_model_target_date = period.targetDate;
  fund.est_time = result.sourceTime || fund.est_time;
  fund.est_model_time = result.sourceTime || '';
  fund.est_model_stale = Boolean(result.stale || !result.sourceTime);
  fund.est_kind = 'overseas_model';
  fund.est_label = '海外模型估算';
  fund.est_realtime = !fund.est_model_stale;
  fund.est_model = true;
  fund.est_model_code = model.legs.map(function(leg) { return leg.code + ':' + leg.weight; }).join(',');
  fund.est_model_label = result.modelLabel || model.label;
  fund.est_model_weight = result.usableWeight;
  fund.est_model_version = result.modelVersion || model.version || '';
  fund.est_model_quarter = model.quarter || '';
  fund.est_confidence = result.confidence;
  fund.est_note = fund.est_model_label + ' · ' + fund.est_model_version + ' · 可用权重' + fmt(result.usableWeight) + '% · 行情时间' + (result.sourceTime || '未知') + ' · 下一净值自建模型估算，不是基金公司官方净值';
}
