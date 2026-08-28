import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('production build enforces a single budgeted homepage shell without OCR', async () => {
  const [build, worker] = await Promise.all([
    readFile(new URL('../scripts/build-site.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  ]);

  assert.match(build, /const APP_SHELL_GZIP_BUDGET = 52_254/);
  assert.match(build, /codeSplitting: false/);
  assert.match(build, /minify: 'esbuild'/);
  assert.match(build, /entryFileNames: APP_SHELL_FILENAME/);
  assert.match(build, /Homepage app shell contains a residual module import/);
  assert.match(build, /Homepage app shell unexpectedly contains an OCR runtime or asset reference/);
  assert.match(build, /replaceExactlyOnce\([\s\S]*src="js\/bootstrap\.js"[\s\S]*src="\$\{APP_SHELL_FILENAME\}"/);
  assert.match(build, /Built Service Worker did not replace the source module graph with the app shell/);
  assert.equal((worker.match(/BUILD_APP_SHELL_CORE_START/g) || []).length, 1);
  assert.equal((worker.match(/BUILD_APP_SHELL_CORE_END/g) || []).length, 1);
});
