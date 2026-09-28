import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('malformed percent encoding returns 400 and the preview server survives', { timeout: 10_000 }, async () => {
  const url = new URL('../scripts/serve-site.mjs', import.meta.url);
  const source = (await readFile(url, 'utf8'))
    .replace("'./dev-data-proxy.mjs'", JSON.stringify(new URL('../scripts/dev-data-proxy.mjs', import.meta.url).href))
    .replace("new URL('../site/', import.meta.url)", `new URL(${JSON.stringify(new URL('../', import.meta.url).href)})`)
    .replace(".listen(port, '127.0.0.1');", ".listen(0, '127.0.0.1', function() { console.log(this.address().port); });");
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { windowsHide: true });
  try {
    const [data] = await once(child.stdout, 'data');
    const port = Number(String(data).trim());
    assert.ok(port > 0);
    const bad = await fetch(`http://127.0.0.1:${port}/%ZZ`);
    assert.equal(bad.status, 400);
    const good = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(good.status, 200);
    assert.match(await good.text(), /蜉蝣基金/);
  } finally {
    child.kill();
    await once(child, 'exit');
  }
});
