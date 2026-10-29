import { spawn } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const MAX_LINK_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_LINK_OUTPUT_BYTES = 64 * 1024;
const LINK_TIMEOUT_MS = 10_000;
const CHUNK_PATH = /^js\/(?:app-shell|chunks\/[A-Za-z0-9._-]+)\.js$/;
const ROOT_IDENTIFIER = 'fundval:link-only-root';

function resolveDependency(specifier, owner, files) {
  if (typeof specifier !== 'string' || !/^(?:\.\/|\.\.\/)/.test(specifier)
    || specifier.includes('//') || /[\u0000-\u0020\u007f\\%?#]/.test(specifier)) {
    throw new Error(`App module has an unsupported import specifier: ${owner}`);
  }
  const path = posix.normalize(posix.join(posix.dirname(owner), specifier));
  if (!CHUNK_PATH.test(path) || !files.has(path)) {
    throw new Error(`App module references an unlisted file: ${owner}`);
  }
  return path;
}

function visitAst(program, visit) {
  const queue = [program];
  while (queue.length) {
    const node = queue.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.type === 'string') visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'comments', 'parent'].includes(key)) continue;
      if (Array.isArray(value)) queue.push(...value);
      else if (value && typeof value === 'object') queue.push(value);
    }
  }
}

function collectClosure(roots, byFile, dynamic) {
  const files = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    const record = byFile.get(file);
    if (!record) throw new Error('App module closure references an unlisted file.');
    files.add(file);
    queue.push(...record.static);
    if (dynamic) queue.push(...record.dynamic);
  }
  return files;
}

function validateModules(modules) {
  if (!Array.isArray(modules) || modules.length < 2 || modules.length > 64) {
    throw new Error('App module inputs must contain 2 to 64 chunks.');
  }
  const files = new Map();
  for (const item of modules) {
    if (!item || typeof item.path !== 'string' || !CHUNK_PATH.test(item.path)
      || typeof item.code !== 'string' || !item.code || files.has(item.path)) {
      throw new Error('App module inputs contain an invalid or duplicate chunk.');
    }
    files.set(item.path, item.code);
  }
  if (Buffer.byteLength(JSON.stringify(modules)) > MAX_LINK_INPUT_BYTES) {
    throw new Error('App module link input exceeds its 16 MiB tool limit.');
  }
  return files;
}

async function analyzeModuleGraph(manifest, modules) {
  const files = validateModules(modules);
  if (manifest?.entry !== 'js/app-shell.js' || !files.has(manifest.entry)
    || !Array.isArray(manifest.coldStart) || !Array.isArray(manifest.lazy)) {
    throw new Error('App module graph requires a valid manifest partition.');
  }
  const { parseSync } = await import('rolldown/utils');
  const byFile = new Map();
  for (const [path, code] of files) {
    const parsed = parseSync(path, code);
    if (parsed.errors.length) throw new Error(`App module syntax verification failed: ${path}`);
    const statics = new Set(), dynamics = new Set();
    visitAst(parsed.program, node => {
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
        if (node.attributes?.length || node.assertions?.length || (node.phase && node.phase !== 'evaluation')) {
          throw new Error(`App module import attributes or phases are unsupported: ${path}`);
        }
        statics.add(resolveDependency(node.source.value, path, files));
      }
      if (node.type === 'ImportExpression') {
        if (node.options || (node.phase && node.phase !== 'evaluation')) {
          throw new Error(`App module dynamic import options or phases are unsupported: ${path}`);
        }
        const source = node.source;
        const specifier = source.type === 'Literal' && typeof source.value === 'string' ? source.value
          : source.type === 'TemplateLiteral' && source.expressions.length === 0 && source.quasis.length === 1
            ? source.quasis[0].value.cooked : null;
        if (typeof specifier !== 'string') throw new Error(`App module has a nonliteral dynamic import: ${path}`);
        dynamics.add(resolveDependency(specifier, path, files));
      }
    });
    byFile.set(path, { static: statics, dynamic: dynamics });
  }
  const cold = collectClosure([manifest.entry, ...byFile.get(manifest.entry).dynamic], byFile, false);
  const declaredCold = new Set(manifest.coldStart), declaredLazy = new Set(manifest.lazy);
  if (declaredCold.size !== manifest.coldStart.length || declaredLazy.size !== manifest.lazy.length
    || [...files.keys()].some(file => cold.has(file) !== declaredCold.has(file)
      || cold.has(file) === declaredLazy.has(file))
    || [...declaredCold, ...declaredLazy].some(file => !files.has(file))) {
    throw new Error('App module actual cold partition does not match its manifest.');
  }
  if (collectClosure([manifest.entry], byFile, true).size !== files.size) {
    throw new Error('App module manifest contains unreachable chunks.');
  }
  return {
    chunkCount: files.size,
    staticEdgeCount: [...byFile.values()].reduce((total, record) => total + record.static.size, 0),
    dynamicEdgeCount: [...byFile.values()].reduce((total, record) => total + record.dynamic.size, 0),
    actualColdChunkCount: cold.size,
  };
}

// A separate Node process enables the experimental VM module API without
// changing the application's runtime or requiring flags on existing commands.
// The worker only parses and links supplied source strings; it never evaluates
// modules, reads their dependency files, or follows network imports.
export function verifyNativeModuleBindings(modules, { timeoutMs = LINK_TIMEOUT_MS } = {}) {
  const files = validateModules(modules);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LINK_TIMEOUT_MS) {
    throw new Error('App module link timeout is invalid.');
  }
  const payload = JSON.stringify(modules);
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--experimental-vm-modules', fileURLToPath(import.meta.url), '--link-stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const output = [], errors = [];
    let outputBytes = 0, errorBytes = 0, failure = null, settled = false;
    const timer = setTimeout(() => {
      failure = new Error('App static module binding verification timed out.');
      child.kill();
    }, timeoutMs);
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.on('error', fail);
    child.stdin.on('error', error => { failure ||= error; });
    for (const [stream, parts, kind] of [[child.stdout, output, 'output'], [child.stderr, errors, 'error']]) {
      stream.on('data', bytes => {
        if (kind === 'output') outputBytes += bytes.length;
        else errorBytes += bytes.length;
        if (outputBytes + errorBytes > MAX_LINK_OUTPUT_BYTES) {
          failure ||= new Error('App static module binding verifier output exceeded its limit.');
          child.kill();
        } else parts.push(bytes);
      });
    }
    child.on('close', code => {
      if (settled) return;
      clearTimeout(timer);
      if (failure) return fail(failure);
      if (code !== 0) return fail(new Error(`App static module binding verification failed: ${Buffer.concat(errors).toString('utf8').trim() || `exit ${code}`}`));
      try {
        const report = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (report.chunkCount !== files.size || report.staticBindingsVerified !== true || report.evaluated !== false) {
          throw new Error('App static module binding verifier returned an invalid result.');
        }
        settled = true;
        accept(report);
      } catch (error) { fail(error); }
    });
    child.stdin.end(payload);
  });
}

export async function verifyAppModuleGraph(manifest, modules) {
  const graph = await analyzeModuleGraph(manifest, modules);
  const bindings = await verifyNativeModuleBindings(modules);
  return Object.freeze({
    ...graph,
    literalImportClosureVerified: true,
    staticBindingsVerified: bindings.staticBindingsVerified,
    evaluated: false,
    startupOrderVerified: false,
    dynamicNamespaceMembersVerified: false,
  });
}

async function linkStdin() {
  if (typeof vm.SourceTextModule !== 'function') throw new Error('VM module linking is unavailable.');
  const parts = [];
  let bytes = 0;
  for await (const part of process.stdin) {
    bytes += part.length;
    if (bytes > MAX_LINK_INPUT_BYTES) throw new Error('App module link input exceeds its 16 MiB tool limit.');
    parts.push(part);
  }
  const files = validateModules(JSON.parse(Buffer.concat(parts).toString('utf8')));
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const modules = new Map([...files].map(([path, code]) => [path, new vm.SourceTextModule(code, { context, identifier: path })]));
  const root = new vm.SourceTextModule([...files.keys()].map(path => `import ${JSON.stringify(path)};`).join('\n'), {
    context, identifier: ROOT_IDENTIFIER,
  });
  await root.link((specifier, owner, extra) => {
    if (extra?.attributes && Object.keys(extra.attributes).length) {
      throw new Error('App module native linker does not accept import attributes.');
    }
    const path = owner === root ? specifier : resolveDependency(specifier, owner.identifier, files);
    const module = modules.get(path);
    if (!module) throw new Error('App module native linker requested an unlisted file.');
    return module;
  });
  if (root.status !== 'linked' || [...modules.values()].some(module => module.status !== 'linked')) {
    throw new Error('App module native linker did not link every chunk.');
  }
  process.stdout.write(`${JSON.stringify({ chunkCount: modules.size, staticBindingsVerified: true, evaluated: false })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3 || process.argv[2] !== '--link-stdin') {
    process.stderr.write('Usage: app-module-graph.mjs --link-stdin (internal link-only worker)\n');
    process.exitCode = 1;
  } else linkStdin().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
