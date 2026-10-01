import { expect, test } from '@playwright/test';

const ORIGIN = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
const NOW = new Date('2026-09-30T14:00:00+08:00');

test('published NAV is a dated official interval, never today profit after refresh or cache reload', async ({ context, page }) => {
  await page.clock.setFixedTime(NOW);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const endpoint = url.pathname.replace(/^\/__fundval_dev/, '');
    if ((url.origin === ORIGIN || url.hostname === 'sinan-estimate-push.ligugu69.workers.dev') && endpoint === '/estimates') {
      const codes = (url.searchParams.get('codes') || '').split(',').filter(code => /^\d{6}$/.test(code));
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        status: 'degraded', source: 'eastmoney_official_nav', fetched_at: '2026-09-30T05:59:00.000Z',
        items: codes.map(code => ({ code, name: 'Synthetic official interval', kind: 'official_nav', status: 'latest_official', source: 'eastmoney_official_nav',
          value_nav: 3.2259, value_change: 0.692947529, base_nav: 3.2037,
          base_nav_date: '2026-09-28', value_date: '2026-09-29', source_time: '2026-09-29',
          est_nav: null, est_change: null, diagnostics: { primary_reason: 'upstream_empty' },
        })),
      }) });
    } else if ((url.origin === ORIGIN || url.hostname === 'sinan-estimate-push.ligugu69.workers.dev') && endpoint === '/holdings') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'unavailable', report_date: '', source: 'synthetic-fixture', items: [] }) });
    } else if (url.origin === ORIGIN) await route.continue();
    else await route.abort('blockedbyclient');
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await page.locator('#nav-edit').click();
  await page.locator('#i-code').fill('005844');
  await page.locator('#i-name').fill('Synthetic official interval');
  await page.locator('#i-shares').fill('100');
  await page.locator('#i-cost').fill('3');
  await page.locator('#add-btn').click();
  await expect(page.locator('#holdings-list .holding-item').filter({ hasText: '005844' })).toBeVisible();
  await page.locator('#nav-market').click();
  const card = page.locator('#fund-list .fund-card').filter({ hasText: '005844' });
  await expect(card.locator('.nav-cur')).toHaveText('3.2259');
  await card.locator('.fund-card-toggle').click();
  await expect(card.locator('.detail-money .stat-label').first()).toHaveText('最新正式净值变动');
  await expect(card.locator('.detail-money .money').first()).toHaveText(/2\.22/);
  await expect(card.locator('.quote-diagnostics')).toContainText('2026-09-28');
  await expect(card.locator('.quote-diagnostics')).toContainText('2026-09-29');
  await expect(page.locator('#last-upd')).toContainText('今日估算 0/1');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await expect(card.locator('.nav-cur')).toHaveText('3.2259');
  await card.locator('.fund-card-toggle').click();
  await expect(card.locator('.detail-money .stat-label').first()).not.toContainText('今日估算');
});
