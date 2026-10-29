import { expect, test } from '@playwright/test';

// Hermetic real-UI integration only. These are synthetic tokens/documents and
// in-memory route responses, NOT a live test account, real Gist or device proof.
const ORIGIN = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
const TOKEN = 'synthetic_m4_session_only';
const NEXT_TOKEN = 'synthetic_m4_reconfigured';
const PRIVATE = 'synthetic_private_metadata_never_for_ui';
const A = '0000000000000000000000000000000a';
const B = '0000000000000000000000000000000b';
const C = '0000000000000000000000000000000c';
const NOW = '2026-10-25T08:00:00.000Z';
const V3_KEY = 'fuyu_holdings_v3';
const TOKEN_KEY = 'fuyu_gist_token';
const CONSENT_KEY = 'fuyu_gist_token_persist';
const ID_KEY = 'fuyu_gist_id';
const META_KEY = 'fuyu_sync_meta_v1';
const TIME_KEY = 'fuyu_gist_sync_time';

function documentFor(code = null) {
  return { schema: 3, deviceId: 'synthetic:remote', updatedAt: NOW,
    holdings: code ? [{ id: `fund:${code}`, fundCode: code, fundName: `合成基金${code}`,
      shares: 10, costNav: 1, createdAt: NOW, updatedAt: NOW, deletedAt: null,
      revision: 1, deviceId: 'synthetic:remote', note: null }] : [] };
}
function archive(code = null) {
  return { revision: 1, files: {
    'fuyu-holdings-v3.json': { content: JSON.stringify(documentFor(code)) },
    'fuyu-holdings.json': { content: JSON.stringify({ schema: 2, device_id: 'synthetic:legacy', updated_at: NOW, holdings: [] }) },
  } };
}

function remoteFixture(initial = [[A, archive()]]) {
  const archives = new Map(initial);
  const state = { requests: [], writes: [], blockedExternal: 0, providerStubs: 0,
    ignorePatch: false, rateLimit: false, createUnavailable: false, holdId: null, heldReply: null, protocolErrors: [] };
  const counts = () => ({ scope: 'HERMETIC_REAL_UI_NOT_LIVE_GIST_NOT_PHYSICAL_DEVICES',
    get: state.requests.filter(row => row.method === 'GET' && row.kind === 'archive').length,
    list: state.requests.filter(row => row.kind === 'list').length,
    patch: state.writes.filter(row => row.method === 'PATCH').length,
    post: state.writes.filter(row => row.method === 'POST').length,
    blockedExternal: state.blockedExternal, providerStubs: state.providerStubs,
    protocolErrors: state.protocolErrors.slice() });
  async function install(context, { device = 'synthetic:browser-a', legacyToken = false } = {}) {
    await context.addInitScript(({ origin, deviceId, legacy, key }) => {
      if (window !== window.top || location.origin !== origin) return;
      if (!localStorage.getItem('fuyu_device_id_v1')) localStorage.setItem('fuyu_device_id_v1', deviceId);
      if (legacy && !localStorage.getItem('__m4_legacy_seeded')) {
        localStorage.setItem(key, 'synthetic_legacy_unconsented');
        localStorage.setItem('__m4_legacy_seeded', 'true');
      }
    }, { origin: ORIGIN, deviceId: device, legacy: legacyToken, key: TOKEN_KEY });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const headers = { 'access-control-allow-origin': ORIGIN,
        'access-control-allow-headers': 'authorization,content-type,accept,cache-control',
        'access-control-allow-methods': 'GET,PATCH,POST,OPTIONS', 'cache-control': 'no-store' };
      const reply = (status, body, extra = {}) => route.fulfill({ status,
        contentType: 'application/json', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
      if (url.origin === 'https://api.github.com' && /^\/gists(?:\/[a-f\d]{1,64})?$/.test(url.pathname)) {
        if (method === 'OPTIONS') { await reply(204, null); return; }
        const authorization = request.headers().authorization;
        if (![TOKEN, NEXT_TOKEN].some(token => authorization === `token ${token}`)) {
          state.protocolErrors.push('unexpected_synthetic_credential'); await reply(401, {}); return;
        }
        const kind = url.pathname === '/gists' ? 'list' : 'archive';
        const id = kind === 'archive' ? url.pathname.slice(7) : null;
        state.requests.push({ method, kind, id }); // No token/body/raw private URL logging.
        if (method === 'GET' && kind === 'list') {
          if (url.searchParams.get('per_page') !== '100' || url.searchParams.get('page') !== '1') {
            state.protocolErrors.push('unexpected_discovery_page'); await reply(400, {}); return;
          }
          await reply(200, [...archives].filter(([gistId]) => !state.createUnavailable || gistId !== C).map(([gistId, value]) => ({ id: gistId, updated_at: NOW,
            description: PRIVATE, html_url: `https://invalid.example/${PRIVATE}`, owner: { login: PRIVATE },
            files: Object.fromEntries(Object.keys(value.files).map(filename => [filename,
              { filename, truncated: false, raw_url: `https://invalid.example/${PRIVATE}` }])) })));
          return;
        }
        if (method === 'POST' && kind === 'list') {
          const body = request.postDataJSON();
          if (body.public !== false || !body.files || Object.keys(body.files).length !== 1) {
            state.protocolErrors.push('invalid_create_shape'); await reply(400, {}); return;
          }
          archives.set(C, { revision: 1, files: structuredClone(body.files) });
          state.writes.push({ method, id: C });
          await reply(state.createUnavailable ? 503 : 201, state.createUnavailable ? {} : { id: C }); return;
        }
        const remote = archives.get(id);
        if (!remote) { await reply(404, {}); return; }
        if (method === 'GET' && kind === 'archive') {
          if (state.rateLimit) { await reply(429, { message: PRIVATE }, { 'retry-after': '120' }); return; }
          const payload = { id, updated_at: NOW, truncated: false, files: structuredClone(remote.files) };
          const etag = `"synthetic-${remote.revision}"`;
          if (state.holdId === id) {
            state.holdId = null;
            await new Promise(resolve => { state.heldReply = resolve; });
            state.heldReply = null;
          }
          // A cancelled old fetch may reject this server-side late fulfillment;
          // the application still must not revive its cancelled operation.
          await reply(200, payload, { etag }).catch(() => {});
          return;
        }
        if (method === 'PATCH' && kind === 'archive') {
          const body = request.postDataJSON();
          const entries = Object.entries(body.files || {});
          if (entries.length !== 1 || !/^fuyu-holdings-v3-[a-f\d]{16}\.json$/.test(entries[0][0])
            || typeof entries[0][1]?.content !== 'string' || JSON.parse(entries[0][1].content).schema !== 3) {
            state.protocolErrors.push('invalid_device_shard_write'); await reply(400, {}); return;
          }
          state.writes.push({ method, id, filename: entries[0][0] });
          if (!state.ignorePatch) { remote.files[entries[0][0]] = structuredClone(entries[0][1]); remote.revision++; }
          await reply(200, {}); return;
        }
        state.protocolErrors.push('unexpected_gist_method'); await reply(400, {}); return;
      }
      // Never continue the local dev proxy: doing so would cause the local
      // server itself to contact real providers, outside browser route control.
      if (url.origin === ORIGIN && url.pathname.startsWith('/__fundval_dev/')) {
        state.providerStubs++; await reply(503, { status: 'unavailable' }); return;
      }
      if (url.origin === ORIGIN) { await route.continue(); return; }
      state.blockedExternal++; await route.abort('blockedbyclient');
    });
  }
  return { state, archives, install, counts };
}

async function openApp(page) {
  await page.clock.setFixedTime(new Date(NOW));
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.locator('#nav-edit').click();
  await expect(page.locator('#gist-token')).toBeVisible();
}
async function addHolding(page, code) {
  await page.locator('#i-code').fill(code);
  await page.locator('#i-name').fill(`合成基金${code}`);
  await page.locator('#i-shares').fill('10');
  await page.locator('#i-cost').fill('1');
  await page.locator('#add-btn').click();
  await expect(page.locator(`#holdings-list [data-action="edit-fund"][data-code="${code}"]`)).toBeVisible();
}
async function configure(page, token = TOKEN, { persist = false } = {}) {
  await page.locator('#gist-token').fill(token);
  await page.locator('#gist-remember-token').setChecked(persist);
  await page.locator('[data-action="cloud-discover"]').click();
  await expect(page.locator('#gist-archive option')).not.toHaveCount(1);
}
async function choose(page, id) {
  await page.locator('#gist-archive').selectOption(id);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), ID_KEY)).toBe(id);
}
async function cloudAction(page, selector) {
  // Observe the real form's disabled lifecycle, including an asynchronously
  // loaded feature. Merely seeing an enabled button immediately after click
  // could otherwise pass before the action has even started.
  await page.locator(selector).evaluate(button => {
    const observed = { started: false, finished: false };
    globalThis.__m4ObservedButtonLifecycle = observed;
    const observer = new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'disabled' && record.oldValue === null)) observed.started = true;
      if (observed.started && !button.disabled) { observed.finished = true; observer.disconnect(); }
    });
    observer.observe(button, { attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
  });
  await page.locator(selector).click();
  await page.waitForFunction(() => globalThis.__m4ObservedButtonLifecycle?.finished === true);
  await expect(page.locator(selector)).toBeEnabled();
}
const upload = page => cloudAction(page, '#cloud-upload-btn');
const download = page => cloudAction(page, '#cloud-download-btn');
const storedDocument = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), V3_KEY);
async function evidence(testInfo, fixture) {
  expect(fixture.state.protocolErrors).toEqual([]);
  await testInfo.attach('hermetic-sync-boundary', { contentType: 'application/json', body: JSON.stringify(fixture.counts()) });
}

test('multiple compatible archives require an explicit real-UI choice; private metadata stays out of the selector', async ({ context, page }, testInfo) => {
  const fixture = remoteFixture([[A, archive()], [B, archive()]]);
  await fixture.install(context); await openApp(page); await addHolding(page, '000001');
  await configure(page);
  expect(await page.evaluate(key => localStorage.getItem(key), ID_KEY)).toBeNull();
  expect(fixture.state.requests.filter(row => row.kind === 'archive')).toEqual([]);
  await expect(page.locator('#gist-archive')).not.toContainText(PRIVATE);
  await choose(page, B); await upload(page);
  await expect(page.locator('#cloud-status')).toContainText('远端读回验证一致');
  expect(fixture.state.writes.some(row => row.method === 'PATCH' && row.id === B)).toBe(true);
  expect(fixture.state.requests.filter(row => row.id === A)).toEqual([]);
  await evidence(testInfo, fixture);
});

test('first archive creation verifies the same new ID before claiming synchronized', async ({ context, page }, testInfo) => {
  const fixture = remoteFixture([]);
  await fixture.install(context); await openApp(page); await addHolding(page, '000001');
  await page.locator('#gist-token').fill(TOKEN);
  await upload(page);
  await expect(page.locator('#cloud-status')).toContainText('远端读回验证一致');
  expect(await page.evaluate(key => localStorage.getItem(key), ID_KEY)).toBe(C);
  expect(fixture.state.writes.filter(row => row.method === 'POST')).toHaveLength(1);
  expect(fixture.state.requests.some(row => row.method === 'GET' && row.id === C)).toBe(true);
  expect(await page.evaluate(key => localStorage.getItem(key), TIME_KEY)).not.toBeNull();
  await evidence(testInfo, fixture);
});

test('a POST applied remotely but returning 5xx cannot be blindly repeated after cooldown', async ({ context, page }, testInfo) => {
  const fixture = remoteFixture([]);
  fixture.state.createUnavailable = true;
  await fixture.install(context); await openApp(page); await addHolding(page, '000001');
  await page.locator('#gist-token').fill(TOKEN);
  await upload(page);
  expect(fixture.archives.has(C)).toBe(true);
  expect(fixture.state.writes.filter(row => row.method === 'POST')).toHaveLength(1);
  await expect(page.locator('#cloud-status')).toContainText('远端暂不可用');
  expect(await page.evaluate(key => localStorage.getItem(key), TIME_KEY)).toBeNull();
  // Advance the real app's Date deadline without sleeping or bypassing its gate.
  // Discovery still deliberately cannot confirm the unknown created archive.
  await page.clock.setFixedTime(new Date(Date.parse(NOW) + 5000));
  await upload(page);
  await expect(page.locator('#toast')).toContainText('已阻止重复创建');
  expect(fixture.state.writes.filter(row => row.method === 'POST')).toHaveLength(1);
  await expect(page.locator('#cloud-status')).not.toContainText('远端读回验证一致');
  await evidence(testInfo, fixture);
});

test('session default and explicit persistent opt-in are observable through the real form and reload', async ({ context, page }, testInfo) => {
  const fixture = remoteFixture();
  await fixture.install(context); await openApp(page); await configure(page);
  expect(await page.evaluate(({ token, consent }) => ({ session: sessionStorage.getItem(token), local: localStorage.getItem(token), consent: localStorage.getItem(consent) }), { token: TOKEN_KEY, consent: CONSENT_KEY }))
    .toEqual({ session: TOKEN, local: null, consent: null });
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.locator('#nav-edit').click(); await expect(page.locator('#gist-token')).toHaveValue(TOKEN);
  const isolatedTab = await context.newPage();
  try {
    await openApp(isolatedTab);
    await expect(isolatedTab.locator('#gist-token')).toHaveValue('');
    expect(await isolatedTab.evaluate(key => sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();
  } finally { await isolatedTab.close(); }
  await configure(page, TOKEN, { persist: true });
  expect(await page.evaluate(({ token, consent }) => ({ session: sessionStorage.getItem(token), local: localStorage.getItem(token), consent: localStorage.getItem(consent) }), { token: TOKEN_KEY, consent: CONSENT_KEY }))
    .toEqual({ session: null, local: TOKEN, consent: 'true' });
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.locator('#nav-edit').click();
  await expect(page.locator('#gist-token')).toHaveValue(TOKEN);
  await expect(page.locator('#gist-remember-token')).toBeChecked();
  await page.locator('[data-action="clear-cloud"]').click();
  await expect(page.locator('#gist-token')).toHaveValue('');
  expect(await page.evaluate(({ token, consent }) => [localStorage.getItem(token), sessionStorage.getItem(token), localStorage.getItem(consent)], { token: TOKEN_KEY, consent: CONSENT_KEY })).toEqual([null, null, null]);
  await evidence(testInfo, fixture);
});

test('an unconsented legacy persistent token is not activated or sent by startup', async ({ context, page }, testInfo) => {
  const fixture = remoteFixture();
  await fixture.install(context, { legacyToken: true }); await openApp(page);
  await expect(page.locator('#gist-credential-status')).toContainText('未自动启用');
  await expect(page.locator('#gist-token')).toHaveValue('');
  expect(fixture.state.requests).toEqual([]);
  await evidence(testInfo, fixture);
});

test('an acknowledged PATCH with mismatched readback remains unverified and pending', async ({ context, page }, testInfo) => {
  const fixture = remoteFixture(); fixture.state.ignorePatch = true;
  await fixture.install(context); await openApp(page); await addHolding(page, '000001');
  await configure(page); await choose(page, A); await upload(page);
  await expect(page.locator('#cloud-status')).toContainText('同步冲突');
  await expect(page.locator('#cloud-status')).not.toContainText('远端读回验证一致');
  expect(fixture.state.writes.filter(row => row.method === 'PATCH')).toHaveLength(1);
  expect(await page.evaluate(key => localStorage.getItem(key), TIME_KEY)).toBeNull();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).pending, META_KEY)).toBe(true);
  await evidence(testInfo, fixture);
});

test('429 cooldown survives manual and online/visibility entry points without clearing the selected archive', async ({ context, page }, testInfo) => {
  const fixture = remoteFixture();
  await fixture.install(context); await openApp(page); await addHolding(page, '000001');
  await configure(page); await choose(page, A); fixture.state.rateLimit = true;
  await download(page);
  await expect(page.locator('#cloud-status')).toContainText('请求受限');
  const before = fixture.state.requests.length;
  await download(page); await upload(page);
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('#cloud-status')).toContainText('请求受限');
  expect(fixture.state.requests).toHaveLength(before);
  expect(fixture.state.writes).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), ID_KEY)).toBe(A);
  await evidence(testInfo, fixture);
});

test('clearing an in-flight cloud read prevents its late response from contaminating a new archive configuration', async ({ context, page }, testInfo) => {
  const fixture = remoteFixture([[A, archive('000001')], [B, archive('000002')]]);
  await fixture.install(context); await openApp(page); await addHolding(page, '000003');
  await configure(page); await choose(page, A); fixture.state.holdId = A;
  try {
    await page.locator('#cloud-download-btn').click();
    await expect.poll(() => typeof fixture.state.heldReply).toBe('function');
    await page.locator('[data-action="clear-cloud"]').click();
    await expect(page.locator('#gist-token')).toHaveValue('');
    await configure(page, NEXT_TOKEN); await choose(page, B); await download(page);
    await expect.poll(async () => (await storedDocument(page)).holdings.some(row => row.fundCode === '000002')).toBe(true);
    fixture.state.heldReply?.();
    await expect.poll(() => fixture.state.heldReply).toBeNull();
    const current = await storedDocument(page);
    expect(current.holdings.some(row => row.fundCode === '000001')).toBe(false);
    expect(current.holdings.some(row => row.fundCode === '000003' && !row.deletedAt)).toBe(true);
    expect(await page.evaluate(key => localStorage.getItem(key), ID_KEY)).toBe(B);
    await evidence(testInfo, fixture);
  } finally { fixture.state.heldReply?.(); }
});

test('changing only the archive cannot bypass a credential-wide 429 deadline', async ({ context, page }, testInfo) => {
  const fixture = remoteFixture([[A, archive()], [B, archive()]]);
  await fixture.install(context); await openApp(page); await addHolding(page, '000001');
  await configure(page); await choose(page, A);
  fixture.state.rateLimit = true;
  await download(page);
  await expect(page.locator('#cloud-status')).toContainText('请求受限');
  const reads = fixture.state.requests.filter(row => row.kind === 'archive').length;
  await choose(page, B);
  await download(page);
  await expect(page.locator('#cloud-status')).toContainText('请求受限');
  expect(fixture.state.requests.filter(row => row.kind === 'archive')).toHaveLength(reads);
  expect(fixture.state.requests.some(row => row.id === B)).toBe(false);
  await evidence(testInfo, fixture);
});

test('two isolated browser contexts converge Schema3 device shards and preserve tombstones plus legacy bytes', async ({ browser }, testInfo) => {
  const fixture = remoteFixture();
  const legacyBefore = fixture.archives.get(A).files['fuyu-holdings.json'].content;
  const left = await browser.newContext({ baseURL: ORIGIN, serviceWorkers: 'block' });
  const right = await browser.newContext({ baseURL: ORIGIN, serviceWorkers: 'block' });
  try {
    await fixture.install(left, { device: 'synthetic:browser-left' });
    await fixture.install(right, { device: 'synthetic:browser-right' });
    const p = await left.newPage(), q = await right.newPage();
    await openApp(p); await openApp(q);
    await addHolding(p, '000001'); await addHolding(q, '000002');
    await configure(p); await choose(p, A); await upload(p);
    await expect(p.locator('#cloud-status')).toContainText('远端读回验证一致');
    await configure(q); await choose(q, A); await upload(q);
    await expect(q.locator('#cloud-status')).toContainText('远端读回验证一致');
    await download(p); await upload(p);
    await expect(p.locator('#cloud-status')).toContainText('远端读回验证一致');
    for (const view of [p, q]) {
      expect((await storedDocument(view)).holdings.filter(row => !row.deletedAt).map(row => row.fundCode).sort()).toEqual(['000001', '000002']);
    }
    expect((await storedDocument(p)).deviceId).not.toBe((await storedDocument(q)).deviceId);
    await p.locator('[data-action="delete-fund"][data-code="000001"]').click();
    await expect.poll(async () => (await storedDocument(p)).holdings.find(row => row.fundCode === '000001')?.deletedAt || null).not.toBeNull();
    await upload(p); await expect(p.locator('#cloud-status')).toContainText('远端读回验证一致');
    await download(q); await upload(q); await download(p);
    for (const view of [p, q]) {
      const rows = (await storedDocument(view)).holdings;
      expect(rows.find(row => row.fundCode === '000001')?.deletedAt).toBe(NOW);
      expect(rows.filter(row => !row.deletedAt).map(row => row.fundCode)).toEqual(['000002']);
      await expect(view.locator('[data-action="edit-fund"][data-code="000001"]')).toHaveCount(0);
    }
    expect(new Set(fixture.state.writes.filter(row => row.method === 'PATCH').map(row => row.filename)).size).toBe(2);
    expect(fixture.archives.get(A).files['fuyu-holdings.json'].content).toBe(legacyBefore);
    await evidence(testInfo, fixture);
  } finally { await left.close(); await right.close(); }
});
