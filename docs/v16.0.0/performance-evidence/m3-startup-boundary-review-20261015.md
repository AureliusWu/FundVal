# Startup/resilience/repository closed-boundary audit

Verdict: `NO_MATERIAL_BUNDLE_BOUNDARY_FOUND`. No virtual candidate or build is proposed for this scope.

Exact inspected HEAD: `f926ee5c11d13c68802dfda3fd4ec3cfd5e50a96`. The working tree was clean before and after this read-only audit. Source hashes for twelve relevant files were equal before and after the local synthetic probe; see `audit.json`.

## Actual import and execution boundaries

```text
bootstrap.js
  static -> resilience.js
    static -> integrity.js (four concrete functions, not a namespace)
    static -> holdings-repository.js -> schema + holdings-migration
  awaited import -> startup-repository.js (recovery + lock facade)
  awaited import -> startup-migrations.js -> migrations.js -> storage.js
  one WebLock callback:
    recoverPendingRepositoryTransaction
    runLocalMigrations (metadata markers only)
    runStartupIntegrityChecks
      recoverPendingRepositoryTransaction
      loadHoldingsRepository
        recoverPendingRepositoryTransaction
        read/migrate/recover/validate current repository
      repair fund-cache membership/timestamps, remove orphan NAV cache keys
  release lock
  installRuntimeGuards
  awaited import -> app.js
    separate WebLock -> loadHoldingsRepository -> recovery/current read
```

- `bootstrap.js:16-31` is the real order. Existing facades preserve original function references; they are not duplicate recovery/migration implementations.
- `migrations.js:34-71` only retires old metadata flags, preserves manual-review evidence and never mutates holdings or invokes the accepted compatibility `transaction` argument. It is not a second Schema 3 data migration engine.
- `resilience.js:75-142` reads/reconciles the repository and cleans cache membership. `holdings-repository.js:353-425` owns real legacy projection reconciliation, backup recovery, device ownership and transaction persistence. These are separate responsibilities.
- `app.js:218` reloads authoritative state after the earlier lock has been released and app's module awaited. Reusing the earlier integrity result would cross a real concurrency window.
- The direct OCR entry (`ocr-import-page.js:160-175`) must independently gate its storage before importing. It does not execute main bootstrap and cannot assume startup already ran.

## Repeated calls are not repeated retained algorithms

Normal already-valid V3 startup makes three calls to the same recovery implementation: one explicit bootstrap call plus two inside integrity/load. The local synthetic profile confirmed journal read counts 1 /0 /2 for explicit recovery /metadata migration /integrity.

The recovery implementation is retained once and is also required by `loadHoldingsRepository`, `persistHoldingsDocument`, save/edit/import and direct OCR paths. Removing one or two startup callsites would not remove that implementation or its helpers from the production graph. It may reduce some localStorage work, but no latency or gzip effect was measured and it is not a plausible several-KB bundle reduction.

The explicit outer recovery also prevents migration metadata writes when future-schema/journal protection already blocks startup. Folding it into later integrity changes failure ordering. Inside the shared helpers, fresh journal/schema reads and CAS remain security/data-preservation boundaries. No unchecked/cached-recovery bypass is proposed.

## Cross-lock snapshot counterexample

The synthetic probe executes the actual repository, migration and integrity functions with memory storage and the actual `withHoldingsLock` wrapper using a synthetic lock adapter. Its host orchestration models the observed source callsites; it is not an execution of the full bootstrap/app.

1. Integrity observes a synthetic holding with 10 shares.
2. After the startup lock is released, a separate synthetic writer commits 20 shares through real `persistHoldingsDocument` with expected-document CAS.
3. The subsequent app-like locked load observes 20; the earlier integrity snapshot still contains 10.

This is an explicit reason not to pass the earlier holdings snapshot through app's dynamic-import boundary to skip its load. Only in-memory synthetic data were written; no browser/local user storage or repository files were changed.

## Legacy compatibility code already excluded from emitted runtime

An existing actual retained-module report was read, not rerun:

`C:/Users/84046/AppData/Local/Temp/fundval-m3-retained-growth-20261015-d73c47c77dfa4e9a817e3e62f2bd5a57/report.json`

Its source HEAD is **fb559**, not f926. All four relevant source LF hashes were independently verified equal to the current f926 files. These are old pre-final-minify module metadata observations, not a fresh f926 build or gzip measurement.

- `integrity.js` retains seven functions for cache/diagnostics. Old `repairHoldingsState`, `normalizeHoldings`, `mergeHoldingsByTimestamp` and their repair helpers are not retained.
- `storage.js` retains only `safeSetItem`, `safeGetItem`, `safeStorageKeys`, `safeRemoveItem`. Old generic cache/cloud helpers and `backupHoldings` are not retained.
- `resilience.js` retains `installRuntimeGuards` and `runStartupIntegrityChecks`; the public `runStartupIntegrityChecksLocked` wrapper is not retained.
- Repository recovery, persistence, projection reconciliation and backups are real current consumers. There is no extra legacy repair engine to delete from the main bundle.

Deleting those original public legacy APIs would violate scope and would not recover the raw source bytes as compressed production savings.

## Cache and UI paths are not duplicate complete responsibilities

- Integrity's `reconcileFundCache` (`integrity.js:153`) sanitizes cache structure/duplicate identity, active membership and aggregate timestamps and may persist repairs.
- App's `loadCache` (`app.js:576`) binds cache to the exact holdings fingerprint; `tryShowCache` (`app.js:999`) validates quote identity, normalizes stale/offline source semantics, recomputes holding amounts and renders. Passing a pre-normalized cache across startup would change timing and cross-lock behavior. This is not one algorithm implemented twice.
- `showStartupFailure` handles failed imports/locks/migrations before app starts; integrity recovery notices preserve raw data/manual recovery; app's holding load toast covers failure after app's own authoritative load. Merging these messages would change failure domains and UX rather than remove duplicate logic.
- The old startup migration marker cleanup remains necessary for unopened old clients. Its comments describe retired behavior, not an extra hidden runtime remover/cloud sync.

## Close-out

No materials-worthy closed boundary was found. Do not spend a new three-round build experiment on deleting repeated calls or moving these modules. No changes to Schema 3, legacy compatibility, public APIs, locks, CAS, recovery, validation, diagnostic/privacy behavior, config, grouping, dependencies or budgets were made.

No build, site write, network request, real-user-data access, commit or push occurred. All conclusions distinguish existing emitted metadata from fresh source inspection and a bounded local synthetic function probe.
