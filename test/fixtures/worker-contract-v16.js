// Synthetic, fixed-date fixtures. These contain no user holdings or credentials.
export const WORKER_FIXTURE_NOW = Date.parse('2026-09-30T06:00:00Z');

export function officialRow(overrides = {}) {
  return {
    code: '000001', name: '合成正式净值A', kind: 'official_nav', status: 'latest_official',
    source: 'fixture_official_nav', is_fallback: true, fallback_reason: 'intraday_unavailable',
    base_nav: 1, base_nav_date: '2026-09-28', value_nav: 1.02, value_change: 2,
    value_date: '2026-09-29', nav_date: '2026-09-29', source_time: '2026-09-29',
    source_time_precision: 'date', estimate_nav: null, estimate_change: null, estimate_time: null,
    last_nav: 1, est_nav: null, est_change: null, est_time: '2026-09-29', est_kind: 'official_nav',
    diagnostics: { primary_reason: 'intraday_unavailable', model_reason: null, official_reason: null },
    ...overrides,
  };
}

export function intradayRow(overrides = {}) {
  return {
    code: '000002', name: '合成盘中估值A', kind: 'intraday_estimate', status: 'fresh',
    source: 'fixture_intraday', is_fallback: false,
    base_nav: 1, base_nav_date: '2026-09-29', value_nav: 1.01, value_change: null,
    value_date: '2026-09-30', nav_date: null, source_time: '2026-09-30T13:59:00+08:00',
    source_time_precision: 'datetime', estimate_nav: 1.01, estimate_change: 1,
    estimate_time: '2026-09-30T13:59:00+08:00', last_nav: 1,
    est_nav: 1.01, est_change: 1, est_time: '2026-09-30T13:59:00+08:00', est_kind: 'estimate',
    est_realtime: true, diagnostics: { primary_reason: null, model_reason: null, official_reason: null },
    ...overrides,
  };
}

export function holdingsModelRow(overrides = {}) {
  return intradayRow({
    code: '000003', name: '合成重仓模型A', kind: 'holdings_model', status: 'modeled',
    source: 'fixture_holdings_model', is_fallback: true, fallback_reason: 'intraday_unavailable',
    est_kind: 'holdings_model', est_realtime: false, est_time: '2026-09-30',
    coverage: 60, quote_count: 6, report_date: '2026-06-30',
    model_coverage: 60, model_quote_count: 6, model_report_date: '2026-06-30',
    diagnostics: { primary_reason: 'intraday_unavailable', model_reason: null, official_reason: null },
    ...overrides,
  });
}

export function unavailableRow(overrides = {}) {
  return {
    code: '000004', name: '合成不可用A', kind: 'unavailable', status: 'unavailable',
    source: 'unavailable', base_nav: null, base_nav_date: null, value_nav: null,
    value_change: null, value_date: null, source_time: null, estimate_nav: null,
    estimate_change: null, est_nav: null, est_change: null,
    fallback_reason: 'all_sources_unavailable',
    diagnostics: { primary_reason: 'all_sources_unavailable' }, ...overrides,
  };
}

export function qdiiRow(overrides = {}) {
  return intradayRow({
    code: '000005', name: '合成海外模型(QDII)A', kind: 'qdii_next_nav_estimate', status: 'modeled',
    source: 'fixture_qdii_model', est_kind: 'overseas_model', est_realtime: false,
    target_nav_date: '2026-09-30', estimate_model_version: 'fixture-qdii-v1', sample_count: 28,
    coverage: 78.5, uncertainty: { mae: 0.74, error_p80: 1.3, direction_accuracy: 64.3 }, ...overrides,
  });
}

export function estimatesV1(items = [officialRow()], overrides = {}) {
  return {
    status: 'degraded', source: 'fixture_worker', fetched_at: '2026-09-30T05:59:30Z',
    requested: items.length, returned: items.length, unavailable: 0,
    unavailable_codes: [], unavailable_items: [], items, ...overrides,
  };
}

export function estimatesV2(items = [intradayRow()], overrides = {}) {
  return estimatesV1(items, {
    schema_version: 2, service_version: 'fixture-worker-2.0.0', generated_at: '2026-09-30T05:59:30Z',
    capabilities: ['estimates_v2', 'holdings_v2'], status: 'ok', ...overrides,
  });
}

export function holdingRows(count = 6) {
  return Array.from({ length: count }, (_, index) => ({
    code: String(600001 + index), name: `合成股票${index + 1}`, ratio: 10, market: 'cn',
  }));
}

export function holdingsV1(items = holdingRows(), overrides = {}) {
  return {
    code: '000001', source: 'fixture_archives', fetched_at: '2026-09-30T05:59:30Z',
    status: 'ok', report_date: '2026-06-30', returned: items.length, items, ...overrides,
  };
}

export function holdingsV2(items = holdingRows(), overrides = {}) {
  return holdingsV1(items, {
    schema_version: 2, service_version: 'fixture-worker-2.0.0', generated_at: '2026-09-30T05:59:30Z',
    capabilities: ['estimates_v2', 'holdings_v2'], ...overrides,
  });
}
