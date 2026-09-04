import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('production build emits a budgeted split homepage graph without OCR', async () => {
  const [build, worker] = await Promise.all([
    readFile(new URL('../scripts/build-site.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  ]);

  assert.match(build, /const APP_SHELL_GZIP_BUDGET = 52_241/);
  assert.match(build, /const APP_CHUNK_MANIFEST = 'js\/app-chunks\.json'/);
  assert.match(build, /codeSplitting: true/);
  assert.match(build, /minify: 'esbuild'/);
  assert.match(build, /entryFileNames: APP_SHELL_FILENAME/);
  assert.match(build, /chunkFileNames: APP_CHUNK_FILENAME/);
  assert.match(build, /collectStaticChunkGraph/);
  assert.match(build, /\[entry\.fileName, \.\.\.entry\.dynamicImports\]/);
  assert.match(build, /chunk\.isDynamicEntry && Object\.keys\(chunk\.modules\)\.length > 0/);
  assert.match(build, /Homepage build must retain at least one non-OCR on-demand feature chunk/);
  assert.match(build, /Homepage chunk \$\{chunk\.fileName\} unexpectedly contains an OCR runtime or asset reference/);
  assert.match(build, /for \(const \{ chunk \} of measurements\)/);
  assert.match(build, /sha256: createHash\('sha256'\)\.update\(chunk\.code\)\.digest\('hex'\)/);
  assert.match(build, /replaceExactlyOnce\([\s\S]*src="js\/bootstrap\.js"[\s\S]*src="\$\{APP_SHELL_FILENAME\}"/);
  assert.match(build, /\[APP_CHUNK_MANIFEST, \.\.\.generatedFiles\]\.sort\(\)\.map/);
  assert.match(build, /Built Service Worker did not replace the source module graph with every non-OCR homepage chunk/);
  assert.match(build, /!core\.includes\("'\.\/js\/update-compat\.js'"\)/);
  assert.match(build, /'quote-bridge\.html'/);
  assert.match(build, /function resolveSiteSourceDateEpoch\(\)/);
  assert.match(build, /execFileSync\('git', \['log', '-1', '--format=%ct'\]/);
  assert.match(build, /sourceDateEpoch: resolveSiteSourceDateEpoch\(\)/);
  assert.equal((worker.match(/BUILD_APP_SHELL_CORE_START/g) || []).length, 1);
  assert.equal((worker.match(/BUILD_APP_SHELL_CORE_END/g) || []).length, 1);
  const core = worker.slice(worker.indexOf('const CORE'), worker.indexOf('self.addEventListener'));
  assert.match(core, /\.\/quote-bridge\.html/);
  assert.match(core, /\.\/js\/sandbox\/quote-bridge-runtime\.js/);
  assert.match(core, /\.\/js\/update-compat\.js/);
  assert.doesNotMatch(core, /assets\/ocr/);
});
