import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/utils';
import * as plan from '../js/holding-import-plan.js';

// Execute real page function bodies with synthetic controls/dependencies only.
// This is not browser/layout/OCR evidence and does not import the page entry.
const source = readFileSync(new URL('../js/ocr-import-page.js', import.meta.url), 'utf8');
const ast = parseSync('ocr-import-page.js', source).program;
const functionText = name => {
  const node = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(node, 'Expected actual page helper ' + name); return source.slice(node.start, node.end);
};
const row = (options = {}) => plan.createHoldingImportPlan([{ rawFundName: 'Synthetic A', semanticReliable: true,
  match: { status: 'matched', strategy: 'code', code: '000001', name: 'Synthetic A', candidates: [{ code: '000002', name: 'Synthetic C' }] } }],
[{ code: '000001', name: 'Synthetic A', shares: 100, cost: null }], { importable: false, ...options })[0];

function formHarness(candidate = row()) {
  const fields = Object.fromEntries(['action', 'code', 'name', 'shares', 'cost', 'candidate', 'screenshot-cost', 'enable', 'enable-container']
    .map(name => [name, { value: '', checked: false, hidden: false, dataset: { field: name } }]));
  for (const key of ['action', 'code', 'name', 'shares', 'cost']) fields[key].value = candidate[key];
  const badge = { classList: { add() {} }, textContent: '' }, meta = { textContent: '' };
  const root = { dataset: { rowId: candidate.id, explicitSkip: 'false' },
    querySelector(selector) {
      if (selector === '.ocr-match-badge') return badge; if (selector === '.ocr-candidate-meta') return meta;
      const match = /^\[data-field="([a-z-]+)"\]$/.exec(selector); return match ? fields[match[1]] : null;
    } };
  for (const [name, control] of Object.entries(fields)) control.closest = selector => selector === '[data-row-id]' ? root
    : selector.split(',').some(part => part.trim() === `[data-field="${name}"]`) ? control : null;
  const body = { querySelector: () => root };
  const names = ['escapeHtml', 'finite', 'formatSnapshot', 'candidateOptions', 'actionOptions', 'actionOptionsForExisting',
    'costDisplay', 'existingHoldingHint', 'snapshotItem', 'renderCandidate', 'readRowsFromForm', 'chooseCandidate',
    'existingHoldingForCode', 'refreshManualCandidateState', 'editCandidateIdentity'];
  // New shared form reader is included when the implementation supplies it.
  if (ast.body.some(node => node.id?.name === 'readCandidateFormRow')) names.push('readCandidateFormRow');
  const factory = new Function('element', 'setHoldingImportRowEnabled', 'resolveCandidateSelectionAction', 'initial',
    `let state={rows:[initial],holdings:[{code:'000001',name:'Synthetic A',shares:100,cost:null}]};\n`
    + names.map(functionText).join('\n') + '\nreturn { renderCandidate,readRowsFromForm,chooseCandidate,editCandidateIdentity,getRow:()=>state.rows[0] };');
  const api = factory(id => id === 'ocr-import-body' ? body : null, plan.setHoldingImportRowEnabled,
    plan.resolveCandidateSelectionAction, candidate);
  return { api, fields, root };
}

test('actual rendered risk row exposes an independent unchecked labelled enable control', () => {
  const h = formHarness(), html = h.api.renderCandidate(h.api.getRow());
  assert.match(html, /<label[^>]*class="[^"]*ocr-confirm-check/);
  assert.match(html, /type="checkbox" data-field="enable"/); assert.match(html, /已核对.*启用此行/);
  assert.doesNotMatch(html, /data-field="enable" checked/);
});

test('editing action/shares or a checkbox property cannot mint permission from DOM state', () => {
  const h = formHarness(); h.fields.action.value = 'update'; h.fields.shares.value = '200'; h.fields.enable.checked = true;
  h.api.chooseCandidate({ target: h.fields.action });
  const submitted = h.api.readRowsFromForm()[0];
  assert.equal(submitted.explicitlyEnabled, false); assert.equal(plan.validateHoldingImportPlan([submitted]).ok, false);
});

test('only the actual explicit-enable change handler grants a bound row and enables its action', () => {
  const h = formHarness(); h.fields.enable.checked = true; h.api.chooseCandidate({ target: h.fields.enable });
  const submitted = h.api.readRowsFromForm()[0];
  assert.equal(submitted.explicitlyEnabled, true); assert.equal(submitted.action, 'update');
  assert.equal(plan.validateHoldingImportPlan([submitted]).ok, true);
});

test('an identity edit without a dispatched input event cannot reuse the previous bound grant', () => {
  const h = formHarness(); h.fields.enable.checked = true; h.api.chooseCandidate({ target: h.fields.enable });
  h.fields.code.value = '000002'; h.fields.action.value = 'add';
  assert.equal(plan.validateHoldingImportPlan(h.api.readRowsFromForm()).ok, false);
});

for (const field of ['code', 'name']) test('editing ' + field + ' revokes prior in-memory consent', () => {
  const h = formHarness(); h.fields.enable.checked = true; h.api.chooseCandidate({ target: h.fields.enable });
  h.fields[field].value = field === 'code' ? '000002' : 'Synthetic C';
  h.api.editCandidateIdentity({ target: h.fields[field] });
  assert.equal(h.api.getRow().explicitlyEnabled, false); assert.equal(h.fields.enable.checked, false);
  assert.equal(h.fields.action.value, 'skip'); h.fields.action.value = 'add';
  assert.equal(plan.validateHoldingImportPlan(h.api.readRowsFromForm()).ok, false);
});

test('choosing a catalog candidate is not an explicit activation and revokes old consent', () => {
  const h = formHarness(); h.fields.enable.checked = true; h.api.chooseCandidate({ target: h.fields.enable });
  h.fields.candidate.value = '000002|Synthetic C'; h.api.chooseCandidate({ target: h.fields.candidate });
  assert.equal(h.api.getRow().explicitlyEnabled, false); assert.equal(h.fields.action.value, 'skip');
  assert.equal(h.fields.code.value, '000002');
});

test('identity edits expose the initially hidden gate of a trusted row without silently re-enabling it', () => {
  const h = formHarness(row({ importable: true })); h.fields.name.value = 'Different';
  h.api.editCandidateIdentity({ target: h.fields.name });
  assert.equal(h.api.getRow().requiresExplicitEnable, true); assert.equal(h.fields['enable-container'].hidden, false);
  assert.equal(h.fields.action.value, 'skip');
});

test('actual candidate projection passes structured row risks instead of parsing warning text', () => {
  const build = new Function('reconstructOcrTableLayout', 'detectAlipayHoldingSourceEvidence', 'normalizeFundName', 'monotonicNow',
    'matchFundCandidate', functionText('buildPaddleHoldingCandidates') + '\nreturn buildPaddleHoldingCandidates;');
  const preview = { name: 'Synthetic C', semanticReliable: false, evidence: { middle: 3, right: 2 },
    match: { status: 'matched', strategy: 'fuzzy', code: '000001', name: 'Synthetic A' } };
  const result = build(() => ({ previewRows: [preview], schema: { importable: false, header: { reliable: false }, geometry: { reliable: false } } }),
    () => ({ supported: true }), value => String(value || ''), () => 1, () => null)({ tokens: [], imageWidth: 1440 }, []);
  assert.equal(result.holdings[0].semanticReliable, false);
  assert.equal(result.holdings[0].risks.identityUncertain, true); assert.equal(result.holdings[0].risks.numericAmbiguous, true);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function taskHarness(stage) {
  const held = deferred(), calls = [], controls = Object.fromEntries(['ocr-import-confirm', 'ocr-import-retry', 'ocr-import-pick', 'ocr-import-body', 'ocr-image-input']
    .map(id => [id, { hidden: false, disabled: false, value: '', textContent: '', innerHTML: '' }]));
  const names = ['setRecognitionControlsDisabled', 'beginRecognitionTask', 'finishRecognitionTask', 'processSelectedFile', 'clearSensitiveSession'];
  if (ast.body.some(node => node.id?.name === 'isRecognitionTaskCurrent')) names.push('isRecognitionTaskCurrent');
  const bindings = { element: id => controls[id], AbortController, monotonicNow: () => 1,
    createPerformanceRun: () => ({}), mergeRecognitionPerformance() {}, recordOcrPerformance: () => ({ ok: false }),
    classifyOcrPerformanceError: () => 'synthetic', setWorking() {}, setStatus() {},
    loadFundCatalog: async () => { calls.push('catalog'); if (stage === 'catalog') await held.promise; return []; },
    createFundMatchSession: () => { calls.push('match-session'); return { clear() {} }; },
    buildPaddleHoldingCandidates: () => ({ detection: { supported: true }, holdings: [{ code: '000001' }], layout: { schema: { importable: false } }, performance: {} }),
    currentHoldings: async () => { calls.push('holdings'); if (stage === 'holdings') await held.promise; return { holdings: [], document: {} }; },
    createHoldingImportPlan: (...args) => { calls.push(['plan', args[2]]); return []; }, renderResults: () => calls.push('render'),
    renderIntro: () => calls.push('intro'),
  };
  const api = new Function(...Object.keys(bindings), `let activeSession=0,activeRecognitionTask=null,activeMatchSession=null,state={rows:[]};\n`
    + `let paddleOcrModulePromise=Promise.resolve({recognizeAlipayPaddleImage:async()=>({tokens:[]})});\n`
    + names.map(functionText).join('\n') + '\nreturn {run:()=>processSelectedFile({synthetic:true}),cancel:clearSensitiveSession,state:()=>state};')(...Object.values(bindings));
  return { api, held, calls };
}

for (const stage of ['catalog', 'holdings']) test('cancelled actual page task cannot mutate preview after awaiting ' + stage, async () => {
  const h = taskHarness(stage), running = h.api.run(); await flush(); assert.ok(h.calls.includes(stage));
  const before = h.calls.filter(call => call === 'match-session').length;
  h.api.cancel(); h.held.resolve(); await running;
  assert.equal(h.calls.filter(call => call === 'match-session').length, before);
  assert.equal(h.calls.includes('render'), false); assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'plan'), false);
});

test('actual page passes layout.schema.importable to the import plan', async () => {
  const h = taskHarness('none'); await h.api.run();
  assert.deepEqual(h.calls.find(call => Array.isArray(call) && call[0] === 'plan')[1], { importable: false });
});
