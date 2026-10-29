import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile as readSource } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseSync } from 'rolldown/utils';

const source = (await readSource(new URL('../scripts/build-paddle-ocr.mjs', import.meta.url), 'utf8'))
  .replaceAll('\r\n', '\n');
const program = parseSync('build-paddle-ocr.mjs', source).program;
const WORKER_PATH = 'synthetic/engine/assets/fundval-paddle-worker.js';
const WORKER_REFERENCE = 'assets/fundval-paddle-worker.js';
const MISSING_MESSAGE = `PaddleOCR build emitted a missing Worker resource: ${WORKER_REFERENCE}`;
const PROTOCOL_MESSAGE = 'PaddleOCR emitted Worker is incomplete or missing the pinned worker protocol.';
const MIN_WORKER_BYTES = 10_000_000;

function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, callback));
    else if (value && typeof value === 'object') visit(value, callback);
  }
}

function declaration(name) {
  return program.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
    .find(node => node?.type === 'FunctionDeclaration' && node.id.name === name);
}

function contains(node, predicate) {
  let found = false;
  visit(node, value => { if (predicate(value)) found = true; });
  return found;
}

const privateHelper = declaration('readEmittedPaddleWorker');
const build = declaration('buildPaddleOcrAssets');
assert.ok(build, 'The real OCR build function must exist.');
let executable;
if (privateHelper) {
  executable = `${source.slice(privateHelper.start, privateHelper.end)}\nreadEmittedPaddleWorker;`;
} else {
  const statements = build.body.body;
  const start = statements.findIndex(node => node.type === 'TryStatement' && contains(node, value => (
    value.type === 'CallExpression' && value.callee.type === 'Identifier' && value.callee.name === 'access'
      && value.arguments[0]?.type === 'Identifier' && value.arguments[0].name === 'emittedWorkerPath'
  )));
  const end = statements.findIndex((node, index) => index > start && node.type === 'IfStatement'
    && contains(node, value => value.type === 'Identifier' && value.name === 'workerProtocolMarkers'));
  assert.ok(start >= 0 && end > start, 'The real legacy read and protocol-check statements must remain extractable.');
  // Execute the actual old access/read/size/three-marker statements, not a copy
  // of their algorithm. Only the return is added to observe the checked Buffer.
  executable = `async function readEmittedPaddleWorker(emittedWorkerPath, workerReference) {\n`
    + source.slice(statements[start].start, statements[end].end)
    + '\nreturn emittedWorker;\n}\nreadEmittedPaddleWorker;';
}

const executableAst = parseSync('extracted-worker-read.js', executable).program;
let markerDeclaration;
visit(executableAst, node => {
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'workerProtocolMarkers') {
    markerDeclaration = node;
  }
});
assert.equal(markerDeclaration?.init?.type, 'ArrayExpression', 'Use the real protocol marker declaration.');
const markers = markerDeclaration.init.elements.map(node => node.value);
assert.deepEqual(markers, ['worker-transport-request', 'worker-transport-response', 'sourcePayloadToMat']);

function fixture(omittedMarker = null, bytes = MIN_WORKER_BYTES) {
  const buffer = Buffer.alloc(bytes);
  buffer.write(markers.filter(marker => marker !== omittedMarker).join('\n'));
  return buffer;
}

function ioError(code) { return Object.assign(new Error(`synthetic ${code}`), { code }); }

function harness({ buffer = fixture(), accessFailure = null, readFailure = null } = {}) {
  const calls = { access: [], read: [] };
  const access = async (...args) => {
    calls.access.push(args);
    assert.deepEqual(args, [WORKER_PATH, constants.R_OK]);
    if (accessFailure) throw accessFailure;
  };
  const readFile = async (...args) => {
    calls.read.push(args);
    assert.deepEqual(args, [WORKER_PATH], 'Read the real Worker as a Buffer without an encoding.');
    if (readFailure) throw readFailure;
    return buffer;
  };
  // Direct eval preserves the real Buffer/constants bindings. Only the two fs
  // operations are replaced; Vite, OCR, files, images and network never run.
  const read = eval(executable);
  return { calls, buffer, run: () => read(WORKER_PATH, WORKER_REFERENCE) };
}

test('emitted Worker is read once without an access precheck', async () => {
  const subject = harness();
  assert.equal(await subject.run(), subject.buffer);
  assert.equal(subject.calls.read.length, 1);
  assert.equal(subject.calls.access.length, 0, 'Do not precheck accessibility before reading the emitted Worker.');
  if (privateHelper) {
    const calls = [];
    visit(build, node => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
        && node.callee.name === 'readEmittedPaddleWorker') calls.push(node);
    });
    assert.equal(calls.length, 1, 'The actual build must use the private read helper exactly once.');
    assert.deepEqual(calls[0].arguments.map(node => node.name), ['emittedWorkerPath', 'workerReference']);
    assert.equal(contains(build, node => node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && node.callee.name === 'access' && node.arguments[0]?.name === 'emittedWorkerPath'), false);
  }
});

test('the actual size and all three protocol checks inspect the returned Buffer', async () => {
  const buffer = fixture();
  const checkedMarkers = [];
  let checkedSize = 0;
  Object.defineProperty(buffer, 'byteLength', {
    get() { checkedSize += 1; assert.equal(this, buffer); return MIN_WORKER_BYTES; },
  });
  buffer.includes = function (needle, ...args) {
    assert.equal(this, buffer, 'Protocol checks must inspect the exact read result.');
    assert.ok(Buffer.isBuffer(needle));
    checkedMarkers.push(needle.toString());
    return Buffer.prototype.includes.call(this, needle, ...args);
  };
  const subject = harness({ buffer });
  assert.equal(await subject.run(), buffer, 'Return the checked Buffer, not another read or reconstructed value.');
  assert.ok(checkedSize > 0);
  assert.deepEqual(checkedMarkers, markers);
  assert.equal(subject.calls.read.length, 1);
});

for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP']) {
  test(`common Worker ${code} failure preserves the existing missing-resource message`, async () => {
    const failure = ioError(code);
    // The old failure occurs at access; the new one occurs at read. This is an
    // intentional I/O timing change, not universal equivalence of both flows.
    const subject = harness({ accessFailure: failure, readFailure: failure });
    await assert.rejects(subject.run(), error => {
      assert.notEqual(error, failure);
      assert.equal(error.constructor, Error);
      assert.equal(error.message, MISSING_MESSAGE);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
    assert.equal(subject.calls.read.length, privateHelper ? 1 : 0);
  });
}

for (const code of ['EISDIR', 'EIO', 'EMFILE']) {
  test(`Worker ${code} read failure is rethrown with its original identity`, async () => {
    const failure = ioError(code);
    const subject = harness({ readFailure: failure });
    await assert.rejects(subject.run(), error => error === failure);
    assert.equal(subject.calls.read.length, 1);
  });
}

test('the actual Worker size guard still rejects a short Buffer containing every marker', async () => {
  const subject = harness({ buffer: fixture(null, 256) });
  await assert.rejects(subject.run(), error => error.message === PROTOCOL_MESSAGE);
  assert.equal(subject.calls.read.length, 1);
});

for (const marker of markers) {
  test(`the actual Worker protocol guard rejects a full-size Buffer missing ${marker}`, async () => {
    const subject = harness({ buffer: fixture(marker) });
    await assert.rejects(subject.run(), error => error.message === PROTOCOL_MESSAGE);
    assert.equal(subject.calls.read.length, 1);
  });
}
