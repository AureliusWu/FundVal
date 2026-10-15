# FundVal app rendering responsibility audit, 2026-10-15

## Boundaries / outcome

- HEAD `f926ee5c11d13c68802dfda3fd4ec3cfd5e50a96`, clean before/after source scan.
- `js/app.js` raw SHA256 `ddc8b53ac9f8035749f6ab2478b3ac0d3d1b1bb6b37c3340396439cff9de8318`.
- Only source reading and a Temp AST inventory were performed. No builds, no generated source variants, no repo/site changes, no browser/tests/network, no source/config/version/dependency/budget changes.
- Root's starting actual all/cold is 80477/42992; this audit did not remeasure those bytes. Original all gate77227.7 still requires at least3250 B reduction.
- **No new large, closed reuse was found that is justified to reduce both source and actual product bytes while preserving current HTML and behavior.** This is a bounded negative result, not a claim no future architectural optimization exists. No prospective gzip savings are claimed.

## Evidence

`audit.mjs` extracts actual current source AST, inventories 18 relevant functions and all five HTML assignment sinks, detects exact consecutive statement clones (2..6 statements) and repeated HTML literal values within the render/editor functions, records current function text/hashes and actual direct callsites. `report.json` stores results/source bindings. It additionally confirms all 18 relevant functions are byte-identical after LF normalization to the source used by the prior fb559 retained inventory; no prior measurements are presented as a fresh f926 build.

Exact AST clone search preserves identifiers and string values, so it cannot establish semantic nonduplication by itself. The negative conclusion below combines complete reading of current render/edit/detail/sort functions, event dispatch, markup/CSS consumers and relevant characterization tests. Source/function lengths are not compressed bytes or expected savings.

| Current source function | Line | Characters | Responsibility |
|---|---:|---:|---|
| `renderFundList` | 1363 | 10100 | Quote recheck/projection, ordering, identity/header, optional expanded sections, HTML commit, focus restoration |
| `fetchFundDetails` | 1238 | 2862 | Await owning refresh, disclosure/security/metadata enrichment and guarded incremental re-render |
| `saveFund` | 1599 | 1648 | Input validation, original conflict baseline, save/control ownership and outcome UI |
| `toggleFundDetail` | 1205 | 1094 | Detail generation/cancel, lazy diagnostics/security, expansion state |
| `renderIndexBar` | 1731 | 897 | Five market items with price/percent/stale semantics |
| `editFund` | 1569 | 828 | Capture immutable edit baseline, populate and lock identity input |
| `renderHoldingsList` | 1553 | 773 | Editable repository projection/list with deletion actions |
| `delFund` | 1642 | 552 | Confirm current holding deletion, CAS edit, failure/reconcile/refresh |
| `cancelEdit` | 1586 | 480 | Reset form and conflict baseline when not saving |

The only exact repeated consecutive statement sequence found in the selected render/editor functions is **101 characters**, the two `rules-section`/title append statements repeated at lines1481/1486/1491. The longest repeated HTML literal is its 43-character title, repeated3 times. This is precisely a small wrapper/template duplication, not a large shared data flow. We did not build or propose a new wrapper/helper variant for it.

## Larger seams checked and why they do not close

### 1. Collapsed fund card vs expanded fund view

The single renderer has one `sorted.forEach`, one `if (isExpanded)` and one `list.innerHTML = html`. There are not two parallel fund renderers to converge. Current Quote/amount projection is already shared through `normalizeExistingQuoteFreshness`, `holdingQuoteAmounts`, `createQuotePresentation`, `displayChangeOf`, `fmtQuoteNav`, `fmt`, `fmtM` and `esc`.

The visible duplicated values are not duplicated whole markup. Header uses a button's `span.fund-main`/identity/percent/navigation spans, ARIA expanded/controls, toggle/fund IDs and watch-only classes. Expanded view uses `div.detail-nav.stats-grid` and conditional shares/money/notes/details. CSS `css/style.css:1051-1052` explicitly shows desktop `.fund-nav` and hides `.detail-nav`; mobile has the converse layout. Reusing or deleting one subtree would change HTML output/responsive layout/accessibility, unless replaced with a configurable template grammar. Such a grammar adds layout/optional-branch parameters, rather than eliminating a second large implementation, and returns to the already-excluded stat-cell/template micro-probe direction.

The per-render clock update is not a dead repeat of acquisition-time processing. `renderFundList` reads one `now`, rechecks source freshness, reapplies current holding shares/cost and then sorts by current Quote quality/period comparison. A still-visible quote can age or a holding can change while source data remains unchanged. Removing this step based only on `buildFundData` having run earlier breaks the current data flow; the repeated source callsites are small calls to an already shared implementation.

### 2. Percent / amount presentation across fund, stock, index and profit

These look similar but are not the same closed rendering policy. Fund/index percentage use `up/down/flat` with **0 -> flat**. Stock changes and holding profit/rate use **0 -> up**. Fund percentages use finite validated Quote change, stock rendering uses `assessDetailSecurityQuote`'s display-only result and caption, and index price/percentage availability are independent. Totals have optional money output, `万` scaling, rate suffixes and current profit-period labels. NAV uses four decimals; index prices use rounded locale formatting; shares use two; raw edit list deliberately uses raw canonical numeric values and unknown-cost wording.

One shared percent formatter would need flags for zero class, sign, null gate, units, money scaling, labels and HTML structure. It would not remove an independent larger branch. No attempt was made to erase null/0 differences or rerun the excluded small stat-cell/sign/formatting probes.

### 3. Expanded notes / disclosure / fund rules

The four note paths carry different interval/source meanings: current estimate note, distinct primary note, alternate next-NAV model note with value/change, and official base/target pair. They are not interchangeable strings; their predicates prevent showing model/official history as today's estimate. Disclosure has a distinct state machine: `undefined` means loading, explicit metadata error permits retry, empty items means no public holdings, otherwise each stock is qualified/rendered with report date and its own quote timestamp. Fund type/fee state separately distinguishes undefined/null/objects and only hides the original buy fee when equal.

`ruleRow` is already a single shared full row implementation for the11 type/fee rows. `test/app-rules-row-characterization.test.js` binds exact HTML, 98 fixture combinations,2030 getter/coercion exception boundaries and changing repeated reads; these figures are read from tests, **not rerun here**. Mapping all fields into a descriptor table or caching every property would repeat the explicitly excluded field/DOM table direction and can alter getter/read order. The remaining repeated rules wrapper is only the101-character sequence identified above; it does not establish a material package opportunity.

### 4. Holdings list vs fund list vs edit form

There is only one `renderHoldingsList` implementation. Its editable repository list is not an alternate fund-card renderer: identity/name, raw share count, unknown cost and a delete button use different markup/actions from quote cards. `edit-fund` intentionally enters the existing form from either list and already shares `editFund`. A second renderer cannot be deleted without losing one UI surface.

Editor population and cancellation repeat four input IDs, but do different state changes: opening captures `editingSnapshot.record` plus a legacy copy and disables code; cancelling clears code/baseline and unlocks it; saving disables six controls, retains input on failure and only resets on acknowledged success. `hasUnsavedHoldingEditorInput` compares against the original baseline, and update protection/`beforeunload` consume it. A generic DOM field map or form resetter only moves a handful of assignments and repeats the previously excluded43-DOM micro direction. It is not a large reusable data flow.

Save and delete already converge on `saveHoldingEdit`/`commitHoldingEdit` for conflict-aware writes. Their outer UI lifecycles differ: save validates four inputs and owns disabled controls/`isSavingHolding`; delete first resolves an existing active row and user confirmation, then reconciles visible active data on success. Factoring their small shared `scheduleAutoPush/refresh` tail does not remove their distinct lifecycle policies. This audit does not broaden scope into cloud/repository internals.

### 5. Detail loading and refresh-triggered rerenders

`toggleFundDetail` alone owns `detailToggleGeneration`, cancellation and expansion. `fetchFundDetails` awaits a real ongoing refresh before supplementing missing disclosure/security/type/fee state; after each awaited boundary it rechecks abort/expanded identity and schedules the one existing renderer. Several `renderFundList(fundsData)` calls are not copied HTML implementations. Replacing them with one final render changes the observable loading/progressive detail states, and moving all detail HTML into another JS module without true reuse merely relocates bytes. Moving it into index/data/assets to escape the JS budget is not admissible.

## Closed consumers / invariants to preserve if a new design is proposed later

- Actual HTML sinks are exactly: two in `renderFundList` (empty/full), two in `renderHoldingsList` (empty/full), one in `renderIndexBar`. No `outerHTML` sink or alternate copied card implementation was found in app.
- `handleAppAction` is one document-level delegation implementation. Both list edit buttons invoke the same `editFund`; delete buttons require their existing `data-code`; expand uses `data-fund-toggle`, focus restoration uses the same attribute. The existing dispatch is not a second renderer and was not rewritten.
- Focused toggle code is captured before replacement and restored via `requestAnimationFrame` with `preventScroll:true`. Full-list replacement and keyboard focus state must not silently change.
- Dynamic names, descriptions, dates, source labels, quotes, metadata and captions continue through `esc`. Unescaped rule labels are fixed internal literals; `estimateLabel` is the existing trusted presentation enum label. Canonical code/share/cost values in the edit-list template are a distinct already-normalized input boundary, not permission to accept raw external text without escaping.
- Cost unknown/null, zero shares/watch-only state, zero percentage classes, future/stale/history labels, official-vs-model intervals, optional parenthetical dates, note de-duplication and unknown cache states are not presentation noise that can be removed for size.

## Final disposition

No implementation candidate is recommended from this bounded area. The largest real renderer is a union of unique header, notes, money, stock disclosure and metadata features rather than several copies of one larger responsibility. The few exact clones are small wrapper/closing-tag strings that compression already has the opportunity to share; no compressed savings was measured or assumed. No new candidate variants were generated or measured. Preserve this negative result instead of forcing a configurable renderer/template/DOM micro-framework for the package gate.
