import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const png = (await readFile(resolve(root, 'icon-maskable-512.png'))).toString('base64');
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 360 }, deviceScaleFactor: 1 });
  await page.route('**/*', route => route.abort('blockedbyclient'));
  await page.setContent(`<!doctype html><meta charset="utf-8"><title>Maskable visual audit</title>
    <style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#f0f0ed;color:#203a32;font:14px Arial,sans-serif}
    h1{font-size:18px;font-weight:600;margin:0 0 20px}main{display:flex;gap:18px}.card{background:white;border:1px solid #ddd;border-radius:12px;width:224px;padding:12px;text-align:center}
    .art{width:192px;height:192px;position:relative;margin:auto}img{width:100%;height:100%;display:block}.circle{clip-path:circle(50%)}.round{border-radius:24%;overflow:hidden}.squircle{border-radius:39%;overflow:hidden}
    .guide:after{content:'';position:absolute;width:80%;height:80%;left:10%;top:10%;border:1px dashed #df553c;border-radius:50%}p{margin:14px 0 0}small{display:block;font-size:11px;color:#777;margin-top:5px}</style>
    <h1>FundVal maskable icon — desktop crop audit, not a physical-device screenshot</h1><main>
    ${[['guide','Safe circle','0.4 × width radius'],['circle','Circle','platform-mask simulation'],['round','Rounded square','platform-mask simulation'],['squircle','Squircle approximation','not an exact OS mask']].map(([style,title,caption]) => `<section class="card"><div class="art ${style}"><img src="data:image/png;base64,${png}"></div><p>${title}<small>${caption}</small></p></section>`).join('')}
    </main>`);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await writeFile(resolve(root, 'docs/design/MASKABLE_PREVIEW.png'), await page.screenshot(), { flag: 'wx' });
  console.log('Created docs/design/MASKABLE_PREVIEW.png (synthetic desktop mask preview only).');
} finally { await browser?.close(); }
