import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as release from '../scripts/release-fingerprint.mjs';
import { verifyNativeModuleBindings } from '../scripts/app-module-graph.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = 'js/app-shell.js';
const app = 'js/chunks/app-test.js';
const feature = 'js/chunks/feature-test.js';
const other = 'js/chunks/other-test.js';
const graph = (entryCode, appCode, extras = []) => [
  [entry, 'cold', entryCode], [app, 'cold', appCode], ...extras,
];

async function withFixture(definitions, run, alterManifest = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fundval-module-graph-'));
  try {
    const chunks = [];
    for (const [path, role, code] of definitions) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), code);
      chunks.push({ path, role, bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length,
        sha256: createHash('sha256').update(code).digest('hex') });
    }
    const manifest = { schema: 1, entry, chunks,
      coldStart: chunks.filter(chunk => chunk.role === 'cold').map(chunk => chunk.path),
      lazy: chunks.filter(chunk => chunk.role === 'lazy').map(chunk => chunk.path) };
    alterManifest(manifest);
    await writeFile(join(directory, 'js/app-chunks.json'), JSON.stringify(manifest));
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const verify = directory => {
  assert.equal(typeof release.verifyAppModuleGraphReleaseDirectory, 'function', 'Independent module graph verifier must exist.');
  return release.verifyAppModuleGraphReleaseDirectory(directory);
};

test('byte accounting alone accepts self-consistent bytes with a broken named binding', async () => {
  await withFixture(graph('import { missing } from "./chunks/app-test.js";', 'export const present = 1;'), async directory => {
    assert.equal((await release.verifyAppChunkReleaseDirectory(directory)).chunkCount, 2);
    await assert.rejects(() => verify(directory), /does not provide an export named 'missing'/);
  });
});

test('actual graph accepts literal dynamic templates and links without evaluating DOM, throw or top-level await', async () => {
  await withFixture(graph('await import(`./chunks/app-test.js`); document.notExecuted(); throw new Error("NOT_EXECUTED");',
    'export const n = 1; import("./feature-test.js");', [[feature, 'lazy', 'export default 2;']]), async directory => {
    const result = await verify(directory);
    assert.equal(result.chunkCount, 3);
    assert.equal(result.staticEdgeCount, 0);
    assert.equal(result.dynamicEdgeCount, 2);
    assert.equal(result.actualColdChunkCount, 2);
    assert.equal(result.literalImportClosureVerified, true);
    assert.equal(result.staticBindingsVerified, true);
    assert.equal(result.evaluated, false);
    assert.equal(result.startupOrderVerified, false);
    assert.equal(result.dynamicNamespaceMembersVerified, false);
  });
});

const validBindings = [
  ['aliases and default', graph('import value, { n as renamed } from "./chunks/app-test.js";', 'const value = 1; export { value as default, value as n };')],
  ['namespace reexport and star chain', graph('import { ns, n } from "./chunks/app-test.js";',
    'export * as ns from "./feature-test.js"; export * from "./feature-test.js";', [[feature, 'cold', 'export const n = 1;']])],
  ['legal cycle', graph('import { n } from "./chunks/app-test.js"; export const base = 1;', 'import { base } from "../app-shell.js"; export const n = () => base;')],
  ['star diamond with one underlying binding', graph('import { n } from "./chunks/app-test.js";',
    'export * from "./feature-test.js"; export * from "./other-test.js";',
    [[feature, 'cold', 'export const n = 1;'], [other, 'cold', 'export { n } from "./feature-test.js";']])],
  ['string-named binding', graph('import { "a-b" as n } from "./chunks/app-test.js";', 'const n = 1; export { n as "a-b" };')],
];
for (const [name, definitions] of validBindings) test(`native static linking accepts ${name}`, async () => {
  await withFixture(definitions, async directory => assert.equal((await verify(directory)).staticBindingsVerified, true));
});

const invalidBindings = [
  ['missing default', graph('import missing from "./chunks/app-test.js";', 'export const n = 1;')],
  ['indirect missing export', graph('import { n } from "./chunks/app-test.js";', 'export { missing as n } from "./feature-test.js";', [[feature, 'cold', 'export const n = 1;']])],
  ['star does not pass default', graph('import missing from "./chunks/app-test.js";', 'export * from "./feature-test.js";', [[feature, 'cold', 'export default 1;']])],
  ['ambiguous star consumed as named', graph('import { n } from "./chunks/app-test.js";',
    'export * from "./feature-test.js"; export * from "./other-test.js";', [[feature, 'cold', 'export const n = 1;'], [other, 'cold', 'export const n = 2;']])],
  ['cycle with no underlying binding', graph('import { n } from "./chunks/app-test.js"; export { n };', 'export { n } from "../app-shell.js";')],
];
for (const [name, definitions] of invalidBindings) test(`native static linking rejects ${name}`, async () => {
  await withFixture(definitions, async directory => assert.rejects(() => verify(directory), /App static module binding verification failed/));
});

const unsafeImports = [
  ['computed expression', 'import(location.hash);'],
  ['interpolated template', 'import(`./${location.hash}.js`);'],
  ['dynamic options', 'import("./chunks/app-test.js", { with: { type: "json" } });'],
  ['static attributes', 'import "./chunks/app-test.js" with { type: "json" };'],
  ['bare package', 'import "some-package";'],
  ['remote URL', 'import "https://example.invalid/app.js";'],
  ['query', 'import "./chunks/app-test.js?v=1";'],
  ['hash', 'import "./chunks/app-test.js#x";'],
  ['encoded traversal', 'import "./chunks/%2e%2e/app-test.js";'],
  ['root escape', 'import "../../outside.js";'],
  ['unlisted static file', 'import "./chunks/missing.js";'],
  ['unlisted dynamic file', 'import("./chunks/missing.js");'],
  ['static double slash', 'import "./chunks//app-test.js";'],
  ['dynamic double slash', 'import("./chunks//app-test.js");'],
  ['syntax error', 'import {'],
];
for (const [name, code] of unsafeImports) test(`actual graph rejects ${name}`, async () => {
  await withFixture(graph(code, 'export const n = 1;'), async directory => {
    assert.equal((await release.verifyAppChunkReleaseDirectory(directory)).chunkCount, 2);
    await assert.rejects(() => verify(directory), /App module/);
  });
});

test('actual cold partition rejects omitted static closure, extra cold members and unreachable files', async () => {
  const definitions = graph('import "./chunks/app-test.js";', 'import("./feature-test.js");', [[feature, 'lazy', 'export const n = 1;']]);
  await withFixture(definitions, async directory => assert.equal((await verify(directory)).actualColdChunkCount, 2));
  await withFixture(definitions, async directory => assert.rejects(() => verify(directory), /cold partition/), manifest => {
    manifest.coldStart = [entry]; manifest.lazy = [app, feature]; manifest.chunks[1].role = 'lazy';
  });
  await withFixture(definitions, async directory => assert.rejects(() => verify(directory), /cold partition/), manifest => {
    manifest.coldStart.push(feature); manifest.lazy = []; manifest.chunks[2].role = 'cold';
  });
  await withFixture([...definitions, [other, 'lazy', 'export const unused = 1;']], async directory => {
    await assert.rejects(() => verify(directory), /unreachable/);
  });
});

test('link-only scope does not promise dynamic namespace member validation or runtime TDZ safety', async () => {
  for (const code of ['import * as ns from "./chunks/app-test.js"; ns.missing();',
    'import("./chunks/app-test.js").then(ns => ns.missing());']) {
    await withFixture(graph(code, 'export const n = 1;'), async directory => {
      const result = await verify(directory);
      assert.equal(result.staticBindingsVerified, true);
      assert.equal(result.dynamicNamespaceMembersVerified, false);
      assert.equal(result.evaluated, false);
    });
  }
  await withFixture(graph('import { n } from "./chunks/app-test.js"; export const base = 1;',
    'import { base } from "../app-shell.js"; export const n = base;'), async directory => {
    const result = await verify(directory);
    assert.equal(result.staticBindingsVerified, true);
    assert.equal(result.evaluated, false);
    assert.equal(result.startupOrderVerified, false);
  });
});

test('all lazy chunks are linked, including a broken binding reachable only behind dynamic imports', async () => {
  await withFixture(graph('import("./chunks/app-test.js");', 'import("./feature-test.js");',
    [[feature, 'lazy', 'import { missing } from "./other-test.js";'], [other, 'lazy', 'export const n = 1;']]), async directory => {
    await assert.rejects(() => verify(directory), /does not provide an export named 'missing'/);
  });
});

test('native link worker is dependency-free, finite and does not evaluate supplied sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fundval-native-link-isolated-'));
  const source = new URL('../scripts/app-module-graph.mjs', import.meta.url);
  const worker = join(directory, 'worker.mjs');
  const modules = [{ path: entry, code: 'import "./chunks/app-test.js"; throw new Error("NOT_EXECUTED");' },
    { path: app, code: 'document.notExecuted();' }];
  try {
    await cp(source, worker);
    const output = execFileSync(process.execPath, ['--experimental-vm-modules', worker, '--link-stdin'], {
      input: JSON.stringify(modules), cwd: directory, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
    });
    assert.deepEqual(JSON.parse(output), { chunkCount: 2, staticBindingsVerified: true, evaluated: false });
    for (const input of ['not-json', JSON.stringify([modules[0], modules[0]])]) {
      assert.throws(() => execFileSync(process.execPath, ['--experimental-vm-modules', worker, '--link-stdin'], {
        input, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
      }));
    }
    assert.throws(() => execFileSync(process.execPath, [worker, '--link-stdin'], {
      input: JSON.stringify(modules), cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
    }), error => error.status === 1 && /VM module linking is unavailable/.test(String(error.stderr)));
    await assert.rejects(() => verifyNativeModuleBindings(modules, { timeoutMs: 1 }), /timed out/);
    assert.throws(() => verifyNativeModuleBindings(modules, { timeoutMs: 0 }), /timeout is invalid/);
    assert.throws(() => verifyNativeModuleBindings([{ path: entry, code: ' '.repeat(16 * 1024 * 1024) }, modules[1]]), /16 MiB/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('new graph CLI uses the same verified bytes and reports only link evidence', async () => {
  await withFixture(graph('import "./chunks/app-test.js";', 'throw new Error("DO_NOT_RUN");'), async directory => {
    const output = execFileSync(process.execPath, ['scripts/release-fingerprint.mjs', '--verify-app-module-graph', directory], { cwd: root, encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.staticBindingsVerified, true);
    assert.equal(result.evaluated, false);
    await writeFile(join(directory, app), 'throw new Error("tampered");');
    await assert.rejects(() => verify(directory), /manifest verification/);
  });
});

test('graph checks reject invalid UTF-8 after byte verification without changing legacy accounting', async () => {
  await withFixture(graph('import "./chunks/app-test.js";', Buffer.from([0x2f, 0x2f, 0x80])), async directory => {
    assert.equal((await release.verifyAppChunkReleaseDirectory(directory)).chunkCount, 2);
    await assert.rejects(() => verify(directory), /encoded data was not valid/);
  });
});

test('native-only mode intentionally does not prove a computed dynamic dependency or cold partition', async () => {
  await withFixture(graph('import(location.hash);', 'export const n = 1;'), async directory => {
    const result = await release.verifyAppStaticBindingsReleaseDirectory(directory);
    assert.equal(result.staticBindingsVerified, true);
    assert.equal(result.literalImportClosureVerified, false);
    await assert.rejects(() => verify(directory), /nonliteral dynamic import/);
  });
});

test('native link rejects unsupported static attributes and bounds oversized error output', async () => {
  const modules = [{ path: entry, code: 'import "./chunks/app-test.js" with { type: "json" };' },
    { path: app, code: 'export const n = 1;' }];
  await assert.rejects(() => verifyNativeModuleBindings(modules), /does not accept import attributes/);
  const missing = 'x'.repeat(70_000);
  modules[0].code = `import { ${JSON.stringify(missing)} as n } from "./chunks/app-test.js";`;
  await assert.rejects(() => verifyNativeModuleBindings(modules), /output exceeded its limit/);
});

test('CI, candidate deploy and production smoke all invoke the independent module gate', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const deploy = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(ci, /--verify-app-module-graph site/);
  assert.match(deploy, /--verify-app-static-bindings site/);
  assert.match(deploy, /--verify-app-static-bindings "\$\{smoke_dir\}\/release"/);
  assert.doesNotMatch(deploy, /npm (?:ci|install|run build)|node scripts\/build-site/);
  assert.equal(release.analyzeAppChunkBudgets({ actualColdStartGzipBytes: 42985, actualAllNonOcrGzipBytes: 80494 }).importClosureVerified, false);
});

test('deployment static-binding CLI works without node_modules and never claims dynamic closure', async () => {
  const tools = await mkdtemp(join(tmpdir(), 'fundval-deploy-verifier-isolated-'));
  try {
    for (const path of ['scripts/release-fingerprint.mjs', 'scripts/app-module-graph.mjs', 'js/ocr/asset-manifest.js']) {
      const target = join(tools, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(new URL(`../${path}`, import.meta.url), target);
    }
    await withFixture(graph('import "./chunks/app-test.js";', 'throw new Error("NOT_EXECUTED");'), async directory => {
      const args = [join(tools, 'scripts/release-fingerprint.mjs'), '--verify-app-static-bindings', directory];
      const result = JSON.parse(execFileSync(process.execPath, args, { cwd: tools, encoding: 'utf8', timeout: 10_000 }));
      assert.equal(result.staticBindingsVerified, true);
      assert.equal(result.literalImportClosureVerified, false);
      assert.equal(result.evaluated, false);
    });
    await withFixture(graph('import { missing } from "./chunks/app-test.js";', 'export const n = 1;'), async directory => {
      assert.throws(() => execFileSync(process.execPath,
        [join(tools, 'scripts/release-fingerprint.mjs'), '--verify-app-static-bindings', directory],
        { cwd: tools, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 }), error => error.status === 1
          && /does not provide an export named 'missing'/.test(String(error.stderr)));
    });
  } finally { await rm(tools, { recursive: true, force: true }); }
});
