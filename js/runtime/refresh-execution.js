import { chinaDateKey } from './market-clock.js';
import { formatChinaQuoteTime } from '../holdings-estimate.js';
import { parseQuoteTimestamp } from './quote-contract.js';
import { normalizeCachedQuote } from './quote-normalizer.js';
import { isRefreshAbort } from './refresh-generation.js';
import { createRefreshPlan, createSecurityQuotePlan } from './refresh-plan.js';
import { createGenerationResourceScope } from './generation-resource-scope.js';
import { makeRefreshResourceEntry, readRefreshResources, serializeRefreshAggregate, validateRefreshResourceEntry } from './refresh-resource-cache.js';
import { executeSecurityQuotePlan } from './security-quote-batch.js';

const INDEX_KEY = 'indices:sh000001,sh000300,usINX,usNDX';

function limited(maximum) {
  let running = 0;
  const queue = [];
  function next() {
    if (running >= maximum || !queue.length) return;
    const { operation, resolve, reject } = queue.shift();
    running++;
    Promise.resolve().then(operation).then(resolve, reject).finally(() => { running--; next(); });
    next();
  }
  return operation => new Promise((resolve, reject) => { queue.push({ operation, resolve, reject }); next(); });
}

// Provider clients are read-only. The generation scope owns every refresh
// dispatch and the only final aggregate cache mutation; UI callbacks stay in app.
export async function executeRefreshPlan({ context, snapshot, options = {}, previous, legacyNavMoves,
  clients, ui, storage, now = Date.now } = {}) {
  const cached = readRefreshResources(previous, { now: now(), activeCodes: snapshot.map(h => h.code), legacyNavMoves });
  const plan = createRefreshPlan({ generation: context.generation, trigger: context.trigger, now: now(),
    activeHoldings: snapshot, cacheIndex: cached.cacheIndex, forceLive: options.force !== false,
    forceStable: options.forceStable });
  const scope = createGenerationResourceScope({ context, plan, now });
  const acquired = new Map();
  const navTasks = new Map();
  const metadataTasks = [];
  const enrichments = [];
  const current = () => {
    if (!context.isCurrent() || context.signal.aborted) throw Object.assign(new Error('刷新已取消'), { name: 'AbortError' });
  };
  const valid = (key, value) => Boolean(validateRefreshResourceEntry(key, value, { now: now() }));

  function acquireEntry(key, loader) {
    const old = cached.entries[key];
    return scope.acquire(key, async () => {
      const value = await loader();
      current();
      if (value && valid(key, value)) { acquired.set(key, value); return value; }
      return old || null;
    }, { cachedValue: old, validateCache: value => valid(key, value) }).then(value => {
      if (value && acquired.get(key) === value) scope.stageCache(key, value, candidate => valid(key, candidate));
      return value;
    });
  }

  function navMove(entry, key) {
    if (!entry) return null;
    const live = acquired.get(key) === entry;
    return { ...entry.payload, sourceTier: live ? 'secondary' : 'cache',
      originalSource: entry.originalSource, originalSourceTier: entry.originalSourceTier,
      fetchedAt: new Date(entry.fetchedAt).toISOString(), cachedAt: entry.cachedAt,
      expiresAt: entry.expiresAt, cacheState: now() < entry.expiresAt ? 'fresh' : 'stale' };
  }

  function getNav(holding) {
    if (navTasks.has(holding.code)) return navTasks.get(holding.code);
    const key = `nav:${holding.code}`;
    let navAttempted = false;
    const task = acquireEntry(key, async () => {
      navAttempted = true;
      const move = await scope.dispatch('eastmoney-official-nav', signal => clients.nav(holding.code, signal));
      return move && makeRefreshResourceEntry(key, { ...move, code: holding.code, source: 'eastmoney-official-nav', status: 'current' },
        { now: now(), sourceDate: move.date });
    }).then(entry => {
      const metaKey = `meta:${holding.code}`;
      const metaTask = acquireEntry(metaKey, async () => {
        let source = acquired.get(key) === entry ? entry : null;
        if (!source) {
          if (navAttempted) return null;
          // The shared official script is also the metadata endpoint. Fetch it
          // only when metadata actually needs acquisition; retain a warm NAV's
          // original envelope instead of implicitly forcing its separate TTL.
          const move = await scope.dispatch('eastmoney-official-nav', signal => clients.nav(holding.code, signal));
          source = move && makeRefreshResourceEntry(key, { ...move, code: holding.code, source: 'eastmoney-official-nav', status: 'current' },
            { now: now(), sourceDate: move.date });
        }
        if (!source) return null;
        return makeRefreshResourceEntry(metaKey, { code: holding.code, source: 'eastmoney-official-nav', meta: source.payload.meta || {} },
          { now: now(), fetchedAt: source.fetchedAt, sourceDate: source.sourceDate });
      }).then(meta => { if (meta) scope.commitUi(() => ui.metadata?.(holding.code, meta.payload.meta)); });
      const observedMetadata = metaTask.catch(error => { if (isRefreshAbort(error, context.signal)) throw error; });
      observedMetadata.catch(() => {});
      metadataTasks.push(observedMetadata);
      return navMove(entry, key);
    }).catch(error => {
      if (isRefreshAbort(error, context.signal)) throw error;
      return navMove(cached.entries[key], key);
    });
    navTasks.set(holding.code, task);
    return task;
  }

  const estimateBatches = plan.resources.filter(resource => resource.kind === 'estimates').map(estimateResource => acquireEntry(estimateResource.key, async () => {
    const rows = await clients.estimates(snapshot.filter(holding => estimateResource.codes.includes(holding.code)), options, context,
      operation => scope.dispatch('sinan-estimate-proxy', operation));
    const usable = [...rows.values()].filter(row => row?.status === 'ok' && row.source_quote
      && !['stale', 'unavailable'].includes(row.source_quote.status));
    if (!usable.length) return null;
    const sourceDate = usable.map(row => row.source_quote.targetDate || row.source_quote.officialNavDate).filter(Boolean).sort().at(-1);
    return makeRefreshResourceEntry(estimateResource.key, { codes: estimateResource.codes, rows: usable, source: 'sinan-estimate-proxy' },
      { now: now(), sourceDate });
  }).then(entry => new Map((entry?.payload.rows || []).map(row => [row.code,
    acquired.get(estimateResource.key) === entry ? row : { ...row, est_realtime: false,
      source_quote: normalizeCachedQuote(row.source_quote, { now: now(), fresh: now() < entry.expiresAt,
        fetchedAt: row.source_quote.fetchedAt, cachedAt: entry.cachedAt, expiresAt: entry.expiresAt }) },
  ]))));
  const estimates = Promise.all(estimateBatches).then(batches => new Map(batches.flatMap(batch => [...batch])));

  const indices = acquireEntry(INDEX_KEY, async () => {
    const quotes = await scope.dispatch('tencent-market-quote', signal => clients.indices(plan.resources.find(r => r.key === INDEX_KEY).codes, signal));
    const sourceDate = quotes.map(quote => chinaDateKey(parseQuoteTimestamp(quote.observedAt))).filter(Boolean).sort().at(-1);
    return makeRefreshResourceEntry(INDEX_KEY, { codes: ['sh000001', 'sh000300', 'usINX', 'usNDX'], quotes,
      status: quotes.length < 4 ? 'partial' : 'ok', source: 'tencent-market-quote' },
      { now: now(), sourceDate });
  }).catch(error => { if (isRefreshAbort(error, context.signal)) throw error; return cached.entries[INDEX_KEY] || null; });
  const gold = acquireEntry('gold:AU9999', async () => {
    const quote = await clients.gold(context.signal, (operation) => scope.dispatch('eastmoney-security-quote', operation));
    if (!quote || quote.cached || quote.status === 'unavailable') return null;
    return makeRefreshResourceEntry('gold:AU9999', { ...quote, code: 'AU9999', source: 'eastmoney-security-quote' },
      { now: now(), sourceDate: chinaDateKey(parseQuoteTimestamp(quote.observedAt)) });
  }).catch(error => { if (isRefreshAbort(error, context.signal)) throw error; return cached.entries['gold:AU9999'] || null; });
  const indexUi = indices.then(entry => { scope.commitUi(() => ui.market(entry, null, { indices: true })); return entry; });
  const goldUi = gold.then(entry => { scope.commitUi(() => ui.market(null, entry, { gold: true })); return entry; });
  const marketTask = Promise.all([indexUi, goldUi]);

  const runStable = limited(2);
  let holdingsClaim = null;
  let probeAt = null;
  let probeUsed = false;
  const holdingsOutcome = { requested: 0, usable: 0, failed: 0, responseMs: 0 };
  const holdingsTasks = snapshot.map(holding => runStable(async () => {
    current();
    const key = `holdings:${holding.code}`;
    const resource = plan.resources.find(r => r.key === key);
    if (resource?.action === 'skip') return null;
    try {
      const entry = await acquireEntry(key, async () => {
        // Claim at the real network boundary, not at planning time. A TTL may
        // expire while this resource waits in the stable-data queue.
        if (!holdingsClaim) {
          holdingsClaim = context.claimSourceAttempt('quarterly-holdings-model');
          if (holdingsClaim.halfOpen) probeAt = context.sourceHealth('quarterly-holdings-model')?.halfOpenProbeAt;
        }
        if (!holdingsClaim.allowed || (holdingsClaim.halfOpen && probeUsed)) return null;
        probeUsed = true;
        const startedAt = now();
        holdingsOutcome.requested++;
        try {
          const value = await scope.dispatch('sinan-holdings-proxy', signal => clients.holdings(holding.code, signal));
          const entry = value && makeRefreshResourceEntry(key, { ...value, code: holding.code, source: 'sinan-holdings-proxy' },
            { now: now(), fetchedAt: parseQuoteTimestamp(value.fetchedAt), sourceDate: value.reportDate });
          if (entry) holdingsOutcome.usable++;
          return entry;
        } catch (error) {
          if (!isRefreshAbort(error, context.signal)) holdingsOutcome.failed++;
          throw error;
        } finally { holdingsOutcome.responseMs = Math.max(holdingsOutcome.responseMs, now() - startedAt); }
      });
      if (!entry || now() >= entry.expiresAt) return null;
      const payload = { ...entry.payload, cachedAt: entry.cachedAt, expiresAt: entry.expiresAt };
      scope.commitUi(() => ui.holdings?.(holding.code, payload));
      const items = clients.qualifyHoldings(holding, entry.payload.items);
      return { holding, payload, validated: true, status: 'ok', items };
    } catch (error) {
      if (isRefreshAbort(error, context.signal)) throw error;
      return null;
    }
  }));

  const stableSnapshots = Promise.all(holdingsTasks).then(rows => {
    if (holdingsOutcome.requested && context.isCurrent()) {
      if (holdingsOutcome.usable === holdingsOutcome.requested) context.recordSourceSuccess('quarterly-holdings-model', { responseMs: holdingsOutcome.responseMs });
      else if (holdingsOutcome.usable) context.recordSourcePartial('quarterly-holdings-model', { responseMs: holdingsOutcome.responseMs, reason: 'partial_disclosure_coverage' });
      else context.recordSourceFailure('quarterly-holdings-model', { responseMs: holdingsOutcome.responseMs, reason: 'holdings_unavailable' });
    }
    return rows;
  }).finally(() => {
    // Do not release a newer generation's separately acquired half-open slot.
    if (holdingsClaim?.halfOpen && context.sourceHealth('quarterly-holdings-model')?.halfOpenProbeAt === probeAt) {
      context.releaseSourceAttempt('quarterly-holdings-model');
    }
  });

  const securityTask = Promise.all([stableSnapshots, clients.models(snapshot)]).then(async ([rows, models]) => {
    current();
    const securityPlan = createSecurityQuotePlan({ generation: context.generation,
      snapshots: rows.filter(Boolean), selectedModels: models });
    const seedQuotes = {};
    // Unrelated slow gold/index providers must not block domestic holdings.
    const indexEntry = securityPlan.modelCodes.some(code => ['usINX', 'usNDX'].includes(code)) ? await indices : null;
    const goldEntry = securityPlan.goldRequired ? await gold : null;
    current();
    indexEntry?.payload.quotes.forEach(quote => { seedQuotes[quote.code] = { ...quote, sourceTime: quote.observedAt }; });
    let modelClaim = null, modelProbeAt = null, modelProbeUsed = false, modelStartedAt = null;
    let result;
    try {
      result = await scope.acquire('securities:union', () => executeSecurityQuotePlan({ plan: securityPlan, scope,
        fetchEastmoney: clients.eastmoney, fetchBridge: clients.bridge, normalizeTime: clients.normalizeTime, seedQuotes, now,
        canAcquireModels() {
          current();
          if (!modelClaim) {
            modelClaim = context.claimSourceAttempt('market-model');
            modelStartedAt = now();
            if (modelClaim.halfOpen) modelProbeAt = context.sourceHealth('market-model')?.halfOpenProbeAt;
          }
          if (!modelClaim.allowed || modelClaim.halfOpen && modelProbeUsed) return false;
          modelProbeUsed = true;
          return true;
        },
        onModelAcquisition({ requestedCodes, acquiredCodes }) {
          current();
          const details = { responseMs: Math.max(0, now() - modelStartedAt) };
          if (acquiredCodes.length === requestedCodes.length) context.recordSourceSuccess('market-model', details);
          else if (acquiredCodes.length) context.recordSourcePartial('market-model', { ...details, reason: 'partial_model_coverage' });
          else context.recordSourceFailure('market-model', { ...details, reason: 'MODEL_QUOTES_UNAVAILABLE' });
        },
      }));
    } finally {
      if (modelClaim?.halfOpen && context.sourceHealth('market-model')?.halfOpenProbeAt === modelProbeAt) {
        context.releaseSourceAttempt('market-model');
      }
    }
    const modelQuotes = await scope.acquire('models:active', () => result?.modelQuotes || {});
    scope.commitUi(() => rows.filter(Boolean).forEach(row => ui.holdings?.(row.holding.code, {
      ...row.payload, items: row.items.map(item => ({ ...item, ...(result?.securityQuotes[item.quoteCode] || {}) })),
    })));
    if (securityPlan.goldRequired && goldEntry) {
      const quote = goldEntry.payload;
      if (quote.status === 'current' && now() < goldEntry.expiresAt) modelQuotes.AU9999 = {
        price: quote.price, changePct: quote.changePct, sourceTime: formatChinaQuoteTime(parseQuoteTimestamp(quote.observedAt) / 1000) };
    }
    return { rows, securities: result?.securityQuotes || {}, modelQuotes: modelQuotes || {} };
  });

  // All branch promises are observed immediately, including a portfolio where
  // every primary fails before enrichment is scheduled.
  for (const task of [estimates, marketTask, securityTask]) task.catch(() => {});
  const results = await Promise.all(snapshot.map(async holding => {
    try {
      const table = await estimates;
      current();
      const raw = table.get(holding.code);
      const official = raw?.status === 'ok' ? null : await getNav(holding);
      const primary = ui.primary(holding, raw, official);
      if (!primary) throw Object.assign(new Error('更新失败'), { code: 'FUND_UNAVAILABLE' });
      scope.commitUi(() => ui.publish(holding, primary));
      const enrichment = Promise.all([getNav(holding), securityTask]).then(async ([nav, security]) => {
        current();
        const row = security.rows.find(value => value?.holding.code === holding.code);
        const items = row?.items.map(item => ({ ...item, ...(security.securities[item.quoteCode] || {}) })) || [];
        const estimate = row ? await clients.calculateHoldings(items, row.payload.reportDate) : null;
        current();
        scope.commitUi(() => ui.enriched(holding, primary, nav, estimate, security.modelQuotes));
      }).catch(error => { if (!isRefreshAbort(error, context.signal)) context.recordDiagnostic('enrichment_failed', { key: holding.code, reason: error.code || error.name }); });
      enrichments.push(enrichment);
      return { code: holding.code, status: 'fulfilled' };
    } catch (error) {
      if (isRefreshAbort(error, context.signal)) return { code: holding.code, status: 'aborted' };
      scope.commitUi(() => ui.failure(holding, error));
      return { code: holding.code, status: 'failed' };
    }
  }));
  await Promise.allSettled([...enrichments, marketTask, securityTask, ...navTasks.values()]);
  // NAV completion may append metadata acquisitions; close that list before
  // the only cache flush, and keep all cancelled branches observed.
  await Promise.allSettled(metadataTasks);
  current();
  const refreshed = results.filter(result => result.status === 'fulfilled').length;
  if (snapshot.length && !refreshed) throw Object.assign(new Error('全部基金刷新失败'), { code: 'ALL_FUNDS_FAILED' });
  scope.flushCache({ storage, serialize: staged => serializeRefreshAggregate({ previous, staged,
    data: ui.cacheData(), holdingsHash: ui.holdingsHash(), now: now(), activeCodes: plan.activeCodes }) });
  scope.commitUi(() => ui.complete?.());
  const diagnostics = scope.snapshot();
  context.recordDiagnostic('refresh_resources', { reason: `requests=${diagnostics.requests};hits=${diagnostics.cacheHits};deduped=${diagnostics.deduped};writes=${diagnostics.cacheWrites}` });
  return { total: snapshot.length, refreshed, results, diagnostics };
}
