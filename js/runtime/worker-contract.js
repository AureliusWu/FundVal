import { normalizeQuoteDate } from './quote-contract.js';
import {
  validateHoldingSet, contractOwn as own, contractRecord as record,
  contractClock as clock, contractChinaDay as chinaDay, contractText as text, contractNumber as numeric,
} from './holding-set-contract.js';
export { validateHoldingSet } from './holding-set-contract.js';

export const WORKER_REQUEST_LIMIT = 50;
const MAX_ROWS = WORKER_REQUEST_LIMIT;
const KINDS = new Set(['intraday_estimate', 'qdii_next_nav_estimate', 'holdings_model', 'official_nav', 'unavailable']);
const ROW_STATUSES = new Set(['ok', 'success', 'fresh', 'delayed', 'modeled', 'degraded', 'stale', 'latest_official', 'official', 'realtime', 'unavailable', 'error', 'failed']);
const TOP_STATUSES = new Set(['ok', 'partial', 'degraded', 'unavailable']);

export class WorkerContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WorkerContractError';
    this.code = code;
  }
}

function reject(code) { throw new WorkerContractError(code); }
function timestamp(value, { zoned = false } = {}) {
  const raw = text(value, 40);
  const date = normalizeQuoteDate(raw.slice(0, 10));
  const match = raw.match(zoned
    ? /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
    : /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!date || !match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) return null;
  const zone = match[4];
  if (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4, 6)) > 59
    || (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4, 6)) !== 0))) return null;
  const parsed = Date.parse(raw.replace(' ', 'T') + (zone ? '' : '+08:00'));
  return Number.isFinite(parsed) ? parsed : null;
}
function kind(value) {
  if (value === 'estimate') return 'intraday_estimate';
  if (value === 'overseas_model') return 'qdii_next_nav_estimate';
  return KINDS.has(value) ? value : '';
}
function chooseNumber(row, canonical, aliases, { percent = false, ignoreNullAliases = false } = {}) {
  const hasCanonical = own(row, canonical);
  let value = hasCanonical ? numeric(row[canonical], percent) : null;
  if (hasCanonical && row[canonical] != null && value == null) reject('WORKER_ROW_INVALID');
  for (const alias of aliases) {
    if (!own(row, alias)) continue;
    const candidate = numeric(row[alias], percent);
    if (row[alias] != null && candidate == null && !['', '--'].includes(row[alias])) reject('WORKER_ROW_INVALID');
    if (hasCanonical) {
      if (ignoreNullAliases && candidate == null) continue;
      if (candidate !== value) reject('WORKER_ALIAS_CONFLICT');
    } else if (value == null) value = candidate;
    else if (candidate != null && candidate !== value) reject('WORKER_ALIAS_CONFLICT');
  }
  return value;
}
function reasonPresent(row) {
  return [row.reason, row.fallback_reason, row.unavailable_reason,
    ...(record(row.diagnostics) ? [row.diagnostics.primary_reason, row.diagnostics.model_reason, row.diagnostics.official_reason] : [])]
    .some(value => /^[a-z][a-z0-9_:-]{0,79}$/.test(text(value, 80)));
}

/** Normalize only the wire contract; Quote freshness/presentation is a separate layer. */
export function normalizeWorkerEstimateRow(row, { wireVersion = 1, now = Date.now() } = {}) {
  if (!record(row)) reject('WORKER_ROW_INVALID');
  if (![1, 2].includes(wireVersion)) reject('WORKER_SCHEMA_UNSUPPORTED');
  if (wireVersion === 2 && ['kind', 'base_nav', 'base_nav_date', 'value_nav', 'value_date', 'source_time']
    .some(key => !own(row, key))) reject('WORKER_ROW_INVALID');
  const code = text(row.code ?? row.bzdm, 6);
  if (!/^\d{6}$/.test(code)) reject('WORKER_ROW_INVALID');
  const canonicalKind = own(row, 'kind') ? kind(row.kind) : '';
  const legacyKind = own(row, 'est_kind') ? kind(row.est_kind) : '';
  if ((own(row, 'kind') && !canonicalKind) || (own(row, 'est_kind') && !legacyKind)) reject('WORKER_ROW_INVALID');
  const valueKind = canonicalKind || legacyKind || (wireVersion === 1 ? 'intraday_estimate' : '');
  if (!valueKind) reject('WORKER_ROW_INVALID');
  if (canonicalKind && legacyKind && canonicalKind !== legacyKind && canonicalKind !== 'unavailable') reject('WORKER_ALIAS_CONFLICT');
  const status = text(row.status, 32) || (wireVersion === 1 && !canonicalKind ? 'ok' : '');
  if (!ROW_STATUSES.has(status)) reject('WORKER_STATUS_INVALID');
  const unusable = valueKind === 'unavailable' || ['unavailable', 'error', 'failed'].includes(status);
  const source = text(row.source, 120);
  if (!unusable && !source) reject('WORKER_ROW_INVALID');
  const name = text(row.name ?? row.jjjc, 160) || code;
  const baseNav = chooseNumber(row, 'base_nav', ['last_nav', 'dwjz']);
  const valueNav = chooseNumber(row, 'value_nav', valueKind === 'official_nav' ? ['est_nav', 'gsz'] : ['estimate_nav', 'est_nav', 'gsz'],
    { ignoreNullAliases: valueKind === 'official_nav' });
  const change = valueKind === 'official_nav'
    ? chooseNumber(row, 'value_change', ['est_change', 'gszzl'], { percent: true, ignoreNullAliases: true })
    : chooseNumber(row, own(row, 'estimate_change') ? 'estimate_change' : 'value_change', ['est_change', 'gszzl'], { percent: true });
  const baseDateRaw = own(row, 'base_nav_date') ? row.base_nav_date : (canonicalKind ? null : row.nav_date ?? row.gzrq);
  const baseDate = normalizeQuoteDate(baseDateRaw);
  if (baseDateRaw != null && baseDateRaw !== '' && !baseDate) reject('WORKER_ROW_INVALID');
  const sourceTime = text(own(row, 'source_time') ? row.source_time : row.estimate_time ?? row.est_time ?? row.gxrq, 40);
  const sourceDate = normalizeQuoteDate(sourceTime.slice(0, 10));
  const sourceMs = sourceTime === sourceDate ? Date.parse(`${sourceDate}T00:00:00+08:00`) : timestamp(sourceTime, { zoned: wireVersion === 2 });
  if (own(row, 'source_time_precision') && !['date', 'datetime', ...(wireVersion === 1 ? ['minute'] : [])].includes(row.source_time_precision)) reject('WORKER_ROW_INVALID');
  if (!unusable && row.source_time_precision === 'date' && sourceTime !== sourceDate
    || !unusable && ['datetime', 'minute'].includes(row.source_time_precision) && sourceTime === sourceDate) reject('WORKER_ROW_INVALID');
  const targetRaw = own(row, 'value_date') ? row.value_date
    : (valueKind === 'official_nav' && canonicalKind ? row.nav_date : sourceDate);
  const targetDate = normalizeQuoteDate(targetRaw);
  for (const alias of ['estimate_time', 'est_time', 'gxrq']) {
    if (!row[alias] || !sourceTime) continue;
    const aliasTime = text(row[alias], 40);
    // Worker v1 deliberately reduces the legacy holdings-model time to its date.
    if (valueKind === 'holdings_model' && alias === 'est_time' && aliasTime === sourceDate) continue;
    const aliasMs = aliasTime === normalizeQuoteDate(aliasTime)
      ? Date.parse(`${aliasTime}T00:00:00+08:00`) : timestamp(aliasTime);
    if (aliasTime !== sourceTime && (aliasMs == null || aliasMs !== sourceMs)) reject('WORKER_ALIAS_CONFLICT');
  }
  const nowMs = clock(now);
  if (!unusable && (valueNav == null || valueNav <= 0 || !sourceDate || sourceMs == null || sourceMs > nowMs
    || !targetDate || !baseDate && valueKind !== 'official_nav'
    || baseDate && (baseDate >= targetDate || baseDate > chinaDay(nowMs))
    || baseNav != null && baseNav <= 0
    || (baseNav == null) !== (baseDate == null)
    || valueKind !== 'official_nav' && (baseNav == null || change == null)
    || valueKind !== 'qdii_next_nav_estimate' && targetDate > chinaDay(nowMs)
    || valueKind !== 'qdii_next_nav_estimate' && targetDate !== sourceDate)) reject('WORKER_ROW_INVALID');
  if (unusable && canonicalKind === 'unavailable' && [baseNav, valueNav, change].some(value => value != null)) reject('WORKER_ROW_INVALID');
  const coverage = chooseNumber(row, 'coverage', ['model_coverage'], { percent: true, ignoreNullAliases: true });
  const quoteCount = chooseNumber(row, 'quote_count', ['model_quote_count'], { ignoreNullAliases: true });
  const reportRaw = own(row, 'report_date') ? row.report_date : row.model_report_date;
  if (own(row, 'report_date') && own(row, 'model_report_date') && row.model_report_date !== reportRaw
    && (text(row.model_report_date, 10) || text(reportRaw, 10))) reject('WORKER_ALIAS_CONFLICT');
  const reportDate = text(reportRaw, 10);
  if (valueKind === 'holdings_model' && !unusable) {
    const report = validateHoldingSet([], { reportDate, wireVersion, now: nowMs });
    if (!report.valid || coverage == null || coverage < 50 || coverage > 100 || !Number.isInteger(quoteCount) || quoteCount < 5 || quoteCount > 10) {
      reject('WORKER_MODEL_EVIDENCE_INVALID');
    }
  }
  if (valueKind === 'qdii_next_nav_estimate' && !unusable) {
    const target = normalizeQuoteDate(row.target_nav_date);
    const uncertainty = row.uncertainty;
    const mae = numeric(uncertainty?.mae), error80 = numeric(uncertainty?.error_p80), direction = numeric(uncertainty?.direction_accuracy);
    if (!target || target !== targetDate || target < sourceDate || !text(row.estimate_model_version, 80)
      || !Number.isInteger(row.sample_count) || row.sample_count <= 0 || row.sample_count > 100000
      || coverage == null || coverage <= 0 || coverage > 100 || !record(uncertainty)
      || mae == null || mae < 0 || error80 == null || error80 < 0 || direction == null || direction < 0 || direction > 100) {
      reject('WORKER_MODEL_EVIDENCE_INVALID');
    }
  }
  return {
    ...row, code, name, source: source || 'unavailable', kind: unusable ? 'unavailable' : valueKind,
    status: unusable ? 'unavailable' : 'ok', source_status: status,
    base_nav: unusable ? null : baseNav, base_nav_date: unusable ? null : baseDate,
    value_nav: unusable ? null : valueNav,
    value_change: valueKind === 'official_nav' && !unusable ? change : null,
    value_date: unusable ? null : targetDate,
    estimate_nav: valueKind !== 'official_nav' && !unusable ? valueNav : null,
    estimate_change: valueKind !== 'official_nav' && !unusable ? change : null,
    source_time: unusable ? null : sourceTime,
    last_nav: unusable ? null : baseNav, nav_date: valueKind === 'official_nav' ? targetDate : baseDate,
    est_nav: unusable ? null : valueNav, est_change: unusable ? null : change,
    est_time: unusable ? null : sourceTime,
    est_kind: valueKind === 'official_nav' ? 'official_nav' : valueKind === 'qdii_next_nav_estimate' ? 'overseas_model' : valueKind === 'holdings_model' ? 'holdings_model' : 'estimate',
    coverage, quote_count: quoteCount, report_date: reportDate || null,
  };
}

/** HTTP schema is independent of the estimate-wire-v8 row fixture schema. */
export function parseWorkerEnvelope(payload, { endpoint, requestedCodes = [], now = Date.now() } = {}) {
  if (!record(payload) || !['estimates', 'holdings'].includes(endpoint) || !Array.isArray(payload.items) || payload.items.length > MAX_ROWS) reject('WORKER_PAYLOAD_INVALID');
  const wireVersion = own(payload, 'schema_version') ? payload.schema_version : 1;
  if (own(payload, 'schema_version') && wireVersion !== 2) reject('WORKER_SCHEMA_UNSUPPORTED');
  const nowMs = clock(now);
  const status = payload.status ?? (endpoint === 'holdings' && !payload.items.length ? 'empty' : 'ok');
  if (wireVersion === 2 && (!own(payload, 'status') || !TOP_STATUSES.has(payload.status))) reject('WORKER_STATUS_INVALID');
  if (!TOP_STATUSES.has(status) && !(wireVersion === 1 && endpoint === 'holdings' && status === 'empty')) reject('WORKER_STATUS_INVALID');
  if (wireVersion === 2) {
    const generated = timestamp(payload.generated_at, { zoned: true });
    if (!text(payload.service_version, 80) || generated == null || generated > nowMs
      || !Array.isArray(payload.capabilities) || payload.capabilities.length > 16
      || !payload.capabilities.every(value => /^[a-z][a-z0-9_]{0,39}$/.test(value))
      || new Set(payload.capabilities).size !== payload.capabilities.length
      || !payload.capabilities.includes(`${endpoint}_v2`)) reject('WORKER_METADATA_INVALID');
  }
  if (own(payload, 'fetched_at') && (timestamp(payload.fetched_at, { zoned: true }) == null
    || timestamp(payload.fetched_at, { zoned: true }) > nowMs)) reject('WORKER_METADATA_INVALID');
  const requested = new Set(requestedCodes);
  if (!requested.size || requested.size !== requestedCodes.length || [...requested].some(code => !/^\d{6}$/.test(code))) reject('WORKER_ACCOUNTING_INVALID');
  let items;
  if (endpoint === 'holdings') {
    if (payload.code != null && (requested.size !== 1 || !requested.has(payload.code))) reject('WORKER_ACCOUNTING_INVALID');
    if (['partial', 'degraded'].includes(status) && payload.items.some(row => !ROW_STATUSES.has(row?.status) || !reasonPresent(row))) reject('WORKER_PARTIAL_SEMANTICS_INVALID');
    if (['unavailable', 'empty'].includes(status) && payload.items.length) reject('WORKER_STATUS_INVALID');
    const result = payload.items.length ? validateHoldingSet(payload.items, { reportDate: payload.report_date, now: nowMs, wireVersion })
      : { valid: true, items: [], reportDate: normalizeQuoteDate(payload.report_date) || '' };
    if (!result.valid) reject(result.reasonCodes[0]);
    if (own(payload, 'returned') && payload.returned !== result.items.length) reject('WORKER_ACCOUNTING_INVALID');
    if (payload.items.length && !text(payload.source, 120)) reject('WORKER_ROW_INVALID');
    items = result.items;
  } else {
    const rawItems = [...payload.items];
    const unavailable = payload.unavailable_items ?? [];
    if (!Array.isArray(unavailable) || unavailable.length > MAX_ROWS) reject('WORKER_ACCOUNTING_INVALID');
    const identities = new Set();
    for (const [index, row] of [...rawItems, ...unavailable].entries()) {
      const code = row?.code ?? row?.bzdm;
      if (identities.has(code)) reject(index < rawItems.length ? 'WORKER_DUPLICATE_CODE' : 'WORKER_ACCOUNTING_INVALID');
      if (!requested.has(code)) reject('WORKER_ACCOUNTING_INVALID');
      identities.add(code);
    }
    const absent = [...requested].filter(code => !rawItems.some(row => (row.code ?? row.bzdm) === code));
    const hasAccounting = ['requested', 'returned', 'unavailable', 'unavailable_codes', 'unavailable_items', 'accounting'].some(key => own(payload, key));
    if (wireVersion === 2 || hasAccounting) {
      if (payload.requested !== requested.size || payload.returned !== rawItems.length
        || payload.unavailable !== absent.length || !Array.isArray(payload.unavailable_codes)
        || payload.unavailable_codes.length !== absent.length || new Set(payload.unavailable_codes).size !== absent.length
        || payload.unavailable_codes.some(code => !absent.includes(code)) || unavailable.length !== absent.length
        || unavailable.some(row => !absent.includes(row?.code) || row.kind !== 'unavailable' || row.status !== 'unavailable')
        || identities.size !== requested.size) reject('WORKER_ACCOUNTING_INVALID');
    }
    if (wireVersion === 2 && status === 'ok' && absent.length) reject('WORKER_ACCOUNTING_INVALID');
    const legacySuccess = new Set();
    if (['partial', 'degraded'].includes(status)) for (const row of [...rawItems, ...unavailable]) {
      if (!text(row?.status, 32)) reject('WORKER_PARTIAL_SEMANTICS_INVALID');
      if (reasonPresent(row)) continue;
      // HTTP v1 mixed batches use null failure reasons for complete successful
      // canonical rows. This is explicit adapter evidence, not an upstream reason.
      if (wireVersion === 1 && ['fresh', 'realtime', 'success', 'ok'].includes(row.status)
        && row.kind === 'intraday_estimate' && ['base_nav', 'base_nav_date', 'value_nav', 'value_date', 'source_time', 'source']
          .every(key => own(row, key) && row[key] != null)
        && normalizeWorkerEstimateRow(row, { wireVersion, now: nowMs }).status === 'ok') legacySuccess.add(row.code);
      else reject('WORKER_PARTIAL_SEMANTICS_INVALID');
    }
    items = [...rawItems, ...unavailable].map(row => {
      const normalized = normalizeWorkerEstimateRow(row, { wireVersion, now: nowMs });
      return { ...normalized, transport_status: normalized.status, status: normalized.source_status,
        adapterReasonCodes: legacySuccess.has(normalized.code) ? ['LEGACY_SUCCESS_ROW'] : [] };
    });
    if (status === 'unavailable' && items.some(row => row.kind !== 'unavailable')) reject('WORKER_STATUS_INVALID');
    if (payload.accounting != null) {
      const expected = { primary: items.filter(row => row.kind === 'intraday_estimate').length,
        model: items.filter(row => ['holdings_model', 'qdii_next_nav_estimate'].includes(row.kind)).length,
        official: items.filter(row => row.kind === 'official_nav').length,
        unavailable: items.filter(row => row.kind === 'unavailable').length };
      if (!record(payload.accounting) || Object.entries(expected).some(([key, count]) => payload.accounting[key] !== count)) reject('WORKER_ACCOUNTING_INVALID');
    }
  }
  return { wireVersion, status, source: text(payload.source, 120), fetchedAt: payload.fetched_at || '',
    generatedAt: payload.generated_at || '', serviceVersion: payload.service_version || '',
    capabilities: wireVersion === 2 ? [...payload.capabilities] : [], reportDate: text(payload.report_date, 10), items };
}
