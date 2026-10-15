# M3 larger estimate DTO design review — 2026-10-15

Repository `D:\AI项目\FundVal`; inspected HEAD `f926ee5c11d13c68802dfda3fd4ec3cfd5e50a96`, clean before/after the review. Read-only source/test/design inspection. No builds, variants, probes, tests, live provider requests, cache/user-data writes or repository/site edits. All gzip80477 / gap3250 are parent context, not newly measured evidence.

## Decision

**Do not start a DTO implementation/build series for M3 on this evidence.** The actual graph does not have one late legacy-output boundary. Merely adding an internal Quote/period DTO would add adapters while the large existing legacy constructors remain reachable through public holdings parsing, strict estimate resource caches, raw legacy aggregate hydration, local model enrichment and secondary UI/accuracy consumers. This is a bounded absence of a qualified deletion slice, not a claim that a future larger redesign can never reduce code.

This review does NOT repeat the old private HTTP projection -120B experiment, ChangingDate failure, two-function tail sharing, field tables or small return projections. No byte saving is proposed or claimed.

## Real flow (not the proposed simplified flow)

```text
HTTP JSON /estimates
  -> parseWorkerEnvelope (metadata/accounting/full v1-v2 wire validation)
  -> normalized wire row + transport_status + original source status
  -> normalizeEstimateRow (second wire clock/validation + ROW_INVALID rescue)
  -> presentation/legacy row + immutable source_quote
  -> executeRefreshPlan estimate resource acquisition
  -> makeRefreshResourceEntry -> estimateRow/payloadFor
       alias consistency + current quote checks + ROW_FIELDS projection
  -> CacheEnvelope with legacy estimate resource rows
       -> private staging copy + use-time revalidation
       -> persisted refreshResources[key].payload.rows
  -> UI primary / official fallback
  -> local holdings enrichment / overseas enrichment
  -> buildFundData -> candidates -> selected quote -> holding/period amounts
  -> render rechecks quote freshness and current holdings at a later clock
  -> aggregate data[] compatibility write (separate from resource rows)

Old aggregate data[] without quote
  -> tryShowCache -> generic buildFundQuoteCandidates and all legacy adapters
  -> normalizeCachedQuote -> current holding/period projection -> same UI

Holding edits/external document installation
  -> reconcileActiveFundState -> reproject holding amounts
  -> saveCache (preserve old acquisition clocks; not the refresh serializer)
```

## Concrete closure blockers

### 1. Removing a fresh-estimates caller does not eliminate the public wire constructor

`js/fund-holdings.js:3,67` imports/calls public `parseWorkerEnvelope` for the holdings endpoint in production. The same generic parser contains the full estimates branch (`js/runtime/worker-contract.js:197-238`) and calls public `normalizeWorkerEstimateRow` at `:225,229`. The row's legacy constructor remains at `:145-159`.

A private estimate DTO caller alone therefore does not remove this generic parser/normalizer from the production graph. Any real tree-shaking claim would first need a separately proved endpoint split and shared validators with unchanged public APIs, not an assertion that a literal holdings argument makes the entire unrelated branch disappear. No such rewrite or measurement was made here.

`js/runtime/business-features.js:4,6-7` and `test/business-features-v16.test.js:16-29` also explicitly preserve the live runtime surface/function identities. Switching the facade is a real integration change, not automatically a private dead-code removal.

### 2. The estimate resource cache is an earlier legacy compatibility sink

`js/runtime/refresh-execution.js:103-116` converts every usable HTTP batch to `makeRefreshResourceEntry` BEFORE exposing its rows to `ui.primary`/`buildFundData`. `js/runtime/refresh-resource-cache.js:39-93` checks a row's aliases against `source_quote`, checks source/kind/date/model/freshness metadata, applies the ROW_FIELDS allowlist, and makes a canonical source_quote. `:135-160` builds the batch; `:166-188` implement public make/read validation.

`stageCache` privately copies then validates; `serializeRefreshAggregate:244-250` validates staged entries again, and `readRefreshResources:208-223` revalidates persisted/legacy entries. The existing persisted resource `payload.rows` is therefore a separate contract from aggregate `data[]`.

If a new DTO arrives here and is immediately re-expanded to the old row, the proposed alias materialization has merely moved and a new adapter is retained. If resource rows also become DTOs, preserving old public make/validate/read/stage/serialize semantics requires an additional dual-representation conversion boundary. Neither option by itself proves a large old constructor can disappear.

Important correction: HTTP opaque fields do NOT all directly reach the current fresh app path. The resource allowlist prunes them first. That does not authorize using this allowlist for old aggregate rows or deleting public HTTP opaque preservation.

### 3. A selected quote plus period does not contain all live financial evidence

The project already has the canonical immutable Quote Envelope and `holdingQuoteAmounts` (`js/runtime/holding-quote-amounts.js:7-15`). The latter computes period/P&L from the CURRENT repository's shares/cost and current time; HTTP transport does not own those inputs. `createValuationPeriod` (`valuation-period.js:11-72`) checks source/base/target dates, single-session, cache state, and current China date.

Primary source quote, latest official NAV pair, selected quote and alternative local model are not interchangeable projections of one value:

- `holdings-estimate.js:137-151` chooses a trustworthy official baseline from original provenance, with legacy fallback ONLY when provenance is absent.
- `:156-184` writes a separate lookthrough interval/evidence/note; `:192-200` composes from the immutable primary so async completion order cannot change the baseline.
- `runtime/fund-model-enrichment.js:12-57` can retain a separate overseas target/base/weight/version/note while source_quote and official NAV remain available.
- `quote-normalizer.js:293-302` creates candidates from source_quote, latest_nav_move, lookthrough and overseas evidence; they are not aliases of the selected quote.
- `app.js:1421-1429` renders model/official secondary notes, including an alternative model NAV/change even when the selected quote is official. `accuracy.js:59-78` additionally reads model flags/version/label/confidence plus the official NAV pair.

A valid DTO would have to retain all this evidence, not just `quote` and `period`. Replacing these fields with a larger sidecar may be good modeling, but the adapters/readers/writer logic would still exist unless a separately identified complete implementation becomes unreachable.

### 4. Old aggregate hydration keeps the generic adapters live

`app.js:998-1039` explicitly handles matching quote, matching source_quote, and raw legacy rows with neither. The latter calls `buildFundQuoteCandidates` at `:1013`; its generic path at `quote-normalizer.js:293-302` reaches `normalizeEstimateQuote`, `normalizeOfficialNavQuote`, `normalizeMarketModelQuote` and `normalizeHoldingLookthroughQuote`.

Even if all fresh HTTP/model paths were quote-first, these adapters remain needed by actual legacy-cache startup, not merely by public tests. `test/cache-fund-identity-v16.test.js:193-200` is the concrete raw-legacy control; `:209-250` checks full mismatched identity isolation, mixed rows, null/missing cost and zero shares.

Do not relabel a mismatched quote or keep its residual aliases/secondary fields: `app.js:1004-1007` deliberately discards the whole bad financial snapshot before recomputing trusted projections. `:1029-1032` re-overrides primary/display fields after the old row spread. A new representation must not leak old opaque same-named financial values through that guard.

### 5. There are two aggregate-writing situations, not only one final serializer

Refresh flush uses `refresh-execution.js:278-279` -> `serializeRefreshAggregate` (`refresh-resource-cache.js:233-271`). It blacklists only `_cached/message/quoteCandidates` from aggregate rows at `:256-260`, preserves accepted old resource objects, and renews fund acquisition clocks only for real new fund acquisitions.

Holding edits/external document installation use `app.js:245-265` -> `saveCache:592-598`, which preserves the previous aggregate clock/source/resources and rewrites projected data/hash only. Canonical holding projection is also recomputed at render (`app.js:1370-1374`), with later quote freshness, and after repository changes (`:250-251`).

Centralizing aliases only in the refresh serializer would miss edit-time persistence. Moving one writer under another without retaining exact clocks, unknown fields and failure behavior is not a no-semantics-change transformation.

## Existing compatibility evidence inspected (not rerun)

- `test/estimate-http-characterization-v16.test.js:9-107`: complete fields, own-key order, JSON byte order, NaN/null distinctions, freezing and references; public HTTP output is intentionally more than a selected quote.
- `:243-276`: three clock reads and second-validation ROW_INVALID safe rescue. Any canonical core must preserve this observable phase boundary and selective rescue, not treat a first validation as permanent trust.
- `:279-315`: model evidence and future QDII target differ from observation time; `:358-415`: opaque metadata/sanitization and fetched_at precedence/field order; `:545-616`: public getters/symbols/errors and selective rescue.
- `test/refresh-resource-cache-v16.test.js:160-217`: resource whitelist, strict alias conflict checks, legal NaN-to-JSON-null placeholders and real zero preserved; `:218-300`: unchanged clocks and old-envelope preservation.
- `test/cache-fund-identity-v16.test.js:145-165,193-250`: bad-snapshot isolation and valid old-cache fallback.
- `test/holdings-estimate.test.js:111-135`: immutable primary composition, completion-order independence and correct official baseline.

No new provider/data trust acceptance is claimed. Engineering interpretation remains conditional on preserving those checks; live source availability, data freshness and independent NAV reconciliation were not evaluated in this no-network design review.

## Bounded recommendation

For this M3 target, close this direction without a build probe. The required DTO is at least `{sourceQuote, officialMove, model/lookthrough evidence, opaque compatibility row state, current holding projection}` and has two cache-shape outputs plus two aggregate-writing contexts. That is not a small closed replacement for multiple currently dead alias constructors. A future wider design would need its own endpoint/resource-cache/cache-hydration/model/serializer plan and complete old-output qualification before any bundle-saving claim. No present number of removable production bytes follows from this review.

## Raw source SHA256

| File | SHA256 |
| --- | --- |
| js/runtime/worker-contract.js | 54BAB1E12F3127B8D28B98185175864EA4DC420B2C862954AB542B3293AA2B44 |
| js/eastmoney-estimate.js | 5ED4A84B2D513C7289AFD5FACFE961F86CCC9D01653E72915A96C5BB5C5BD1D6 |
| js/runtime/refresh-resource-cache.js | 7F0103A803F83B31DF0631CB3A7C53949E7F80259C909BECF4ECCC6CE0FB6231 |
| js/runtime/refresh-execution.js | 6CE61199E3C8DC32E9B23F03F758AFD2F0A745A21707CE4365F01D6E49F53583 |
| js/runtime/quote-normalizer.js | 9454458C08316229F3DFAB94C50AE2A3792611A80EC0193CB790A1CDE665D76B |
| js/app.js | DDC8B53AC9F8035749F6AB2478B3AC0D3D1B1BB6B37C3340396439CFF9DE8318 |
| js/holdings-estimate.js | 72DADAF00F44E8E388044B7BFADA6AF4EB2B6F1DE75056B16803EE32C7A9DCF2 |
| js/runtime/fund-model-enrichment.js | 94424E9C72658BD84175F4E8743A1B13416A0E7E4207D169BC1A432DC2CC51C4 |
| js/runtime/holding-quote-amounts.js | 0B885A19013DB710005ECDD247B95ED317C4CAEC4F39773FD84959727D5F17B1 |
| js/accuracy.js | EED3F70300A5CD43C387052512BCFC5BF99B574C94F56E74CAFBA2A59C998581 |
