const PROVIDERS = new Set(['sinan-estimate-proxy', 'sinan-holdings-proxy', 'eastmoney-official-nav',
  'eastmoney-security-quote', 'tencent-market-quote', 'gold', 'model-config']);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function privateCopy(value) {
  return freeze(JSON.parse(JSON.stringify(value)));
}

function cancelled() {
  return Object.assign(new Error('刷新代际已取消'), { name: 'AbortError' });
}

function syncResult(callback, value) {
  if (typeof callback !== 'function' || callback.constructor?.name === 'AsyncFunction') return undefined;
  const result = callback(value);
  if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); return undefined; }
  return result;
}

// A scope belongs to exactly one coordinator generation. Clients return data;
// they do not own UI or persistence. Only validated, current results are staged.
export function createGenerationResourceScope({ context, plan, now = Date.now } = {}) {
  if (!context || typeof context.isCurrent !== 'function' || typeof context.commit !== 'function'
    || !context.signal || plan?.generation !== context.generation || !Array.isArray(plan.resources)
    || typeof now !== 'function') throw new TypeError('Invalid generation resource scope');
  const resources = new Map(plan.resources.map(item => {
    if (!item || typeof item.key !== 'string' || !/^[a-z]+:[A-Za-z0-9,._:-]{1,1500}$/.test(item.key)
      || !['cache', 'fetch', 'skip'].includes(item.action)) throw new TypeError('Invalid planned resource');
    return [item.key, Object.freeze({ key: item.key, action: item.action, cacheExpiresAt: item.cacheExpiresAt })];
  }));
  if (resources.size !== plan.resources.length) throw new TypeError('Duplicate planned resource');
  const promises = new Map(), states = new Map(), staged = new Map(), providers = {};
  const counters = { cacheHits: 0, deduped: 0, requests: 0, abortedRequests: 0, failedRequests: 0,
    cancelledResources: 0, writeAttempts: 0, cacheWrites: 0 };
  let flushed = false;
  const current = () => context.isCurrent() && !context.signal.aborted;
  const requireCurrent = () => { if (!current()) throw cancelled(); };
  const registered = key => {
    const resource = resources.get(key);
    if (!resource) throw new TypeError('Unknown refresh resource');
    return resource;
  };

  function acquire(key, operation, { cachedValue, validateCache } = {}) {
    const resource = registered(key);
    if (typeof operation !== 'function') throw new TypeError('Resource loader must be a function');
    if (!current()) { counters.cancelledResources++; return Promise.reject(cancelled()); }
    if (promises.has(key)) { counters.deduped++; return promises.get(key); }
    const task = Promise.resolve().then(() => {
      requireCurrent();
      if (resource.action === 'skip') { states.set(key, 'skip'); return null; }
      const at = now();
      if (resource.action === 'cache' && Number.isFinite(at) && Number.isSafeInteger(resource.cacheExpiresAt)
        && at < resource.cacheExpiresAt && cachedValue != null && typeof validateCache === 'function') {
        try {
          const copy = privateCopy(cachedValue);
          if (syncResult(validateCache, copy) === true) { counters.cacheHits++; states.set(key, 'cache'); return copy; }
        } catch (_) { /* corrupt cached data is a miss, not a terminal failure */ }
      }
      return Promise.resolve(operation()).then(value => { requireCurrent(); states.set(key, 'fetched'); return value; });
    }).then(value => { requireCurrent(); return value; }).catch(error => {
      if (!current() || error?.name === 'AbortError') {
        counters.cancelledResources++;
        throw cancelled();
      }
      throw error;
    });
    // Keep even rejected promises for the rest of this generation. A second
    // consumer must not turn one outage into an implicit retry storm.
    promises.set(key, task);
    return task;
  }

  async function dispatch(provider, operation) {
    if (!PROVIDERS.has(provider) || typeof operation !== 'function') throw new TypeError('Invalid refresh provider');
    requireCurrent();
    counters.requests++;
    providers[provider] = (providers[provider] || 0) + 1;
    try {
      const value = await operation(context.signal);
      requireCurrent();
      return value;
    } catch (error) {
      if (!current() || error?.name === 'AbortError') { counters.abortedRequests++; throw cancelled(); }
      counters.failedRequests++;
      throw error;
    }
  }

  function stageCache(key, value, validate) {
    if (!resources.has(key) || states.get(key) !== 'fetched' || !current() || flushed || typeof validate !== 'function') return false;
    try {
      const copy = privateCopy(value);
      if (!copy || typeof copy !== 'object' || syncResult(validate, copy) !== true) return false;
      staged.set(key, copy);
      return true;
    } catch (_) { return false; }
  }

  function flushCache({ storage, key = 'fuyu_funds_cache_v1', serialize } = {}) {
    if (!current() || flushed || !staged.size || key !== 'fuyu_funds_cache_v1'
      || typeof storage?.setItem !== 'function' || typeof serialize !== 'function') return false;
    // A failed storage attempt remains failed; no second write or TTL renewal.
    flushed = true;
    const entries = Object.freeze(Object.fromEntries(staged));
    try {
      // A serializer only returns bytes. This scope, not an arbitrary async
      // writer callback, owns the sole synchronous Storage mutation.
      const payload = syncResult(serialize, entries);
      if (typeof payload !== 'string' || !current()) return false;
      const result = context.commit(() => { counters.writeAttempts++; return storage.setItem(key, payload); });
      if (result.committed && result.value !== false) { counters.cacheWrites++; return true; }
    } catch (_) { /* storage failure is observable without logging payloads */ }
    return false;
  }

  return Object.freeze({ acquire, dispatch, stageCache, flushCache, assertCurrent: requireCurrent,
    commitUi(operation) { return current() ? context.commit(operation) : Object.freeze({ committed: false }); },
    snapshot() { return Object.freeze({ generation: context.generation, planned: resources.size,
      staged: staged.size, ...counters, providers: Object.freeze({ ...providers }) }); },
  });
}
