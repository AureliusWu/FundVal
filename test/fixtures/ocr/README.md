# Synthetic long-image OCR corpus

`synthetic-alipay-1440x9317.png` is an actual15-row,1440×9317 PNG. It contains **public fund identities and independently authored synthetic values**, not a user's screenshot, holdings, account or investment recommendation. The image explicitly says it is synthetic. The adjacent `.expected.json` was generated and locked **before** OCR; it must not be reconstructed from observed OCR output.

- PNG SHA-256:`487ec86fc114732a3350e02b53c99aa7dfbd7f7e85d9299bda3144d986a0b314`,785,150B.
- Original expected JSON SHA-256:`f5fd86504bab0972d97542d924d3e5da364b9137c544b28781b1452d4c54aaea` (original generated UTF-8/LF artifact).
- Generator definition: `../ocr-synthetic-corpus.mjs`; it exports a self-contained canvas renderer and independently authored expected fields. The Windows font/browser information in JSON is **regeneration provenance only**. Tests read the fixed PNG and JSON; they do not load that font, access a Windows font path, generate an image or require Windows.
- The reference was rasterized three times with identical PNG bytes. No fonts or other OCR models were added or upgraded. Binary PNG is test data, not part of site/runtime assets or SW CORE.

## Coverage and expectations

14 exact public identities plus a15th row deliberately missing A/C class. The full public catalog has two alternatives006228/006229 for that last name; it must remain empty-code/default-skip until explicit manual confirmation. Synthetic fields cover positive/negative values,3 real zeros,2 unknown fields, wrapped names, and numeric lines crossing the first tile-core boundary.

In the initial **Windows desktop Chrome/WebGPU** actual-Paddle experiment, all3 fresh-context runs returned15/15 rows,13 automatically trusted matches,0 wrong automatic identities,0A/C mismatches and60/60 numeric field comparisons. The UI summary has14 identity matches, but one long QDII name remains a correctly identified/manual-check row; that is not an automatically trusted match. Row15 is the intentional A/C ambiguity. Do not replace the13 auto result with the UI's14 count.

No confirmation checkbox/click or write was performed; synthetic empty canonical holdings remained unchanged. Actual select-to-preview times were10,408/7,715/8,257ms. These are a new desktop baseline, not old/new speedup evidence, network-cold internet performance, physical-phone acceptance or actual-cancellation proof.

## Running

After the repository's normal build, the standard E2E configuration discovers `e2e/v16-ocr-real-corpus.spec.js`. It uses the production page, real Paddle SDK/models/Workers and real fund catalog, with no recognizer/manifest/preprocessor route replacement. Only same-origin static GET/HEAD is allowed; the local development data proxy and all external/write requests are blocked. Each sample keeps the existing30s timeout and0retry. No temporary directory or historical build receipt is required.

The helper checks current OCR source/site equality, exact runtime versions and all23 actual manifest assets, and records current builder hashes. It does not invent an independent build-input receipt or full-tree freeze. The original strict-parent-receipt experiment and source snapshots remain private development evidence; permanent-path syntax/collection checks are **not** a rerun of its browser results.

## Later desktop verification (2026-10-26)

The permanent-path tests subsequently ran in the full `candidate-e2e-1` local suite: native exit0,70/70 cases passed, including all3 real-corpus cases and2 actual heavy-init/inference cancellation cases. Each corpus case again returned15 rows,13 automatically trusted matches,0 wrong identities/A-C/numeric differences, with unchanged canonical holdings. Times6,294/6,422/6,347ms are observations of this desktop run, not a paired speedup claim. Init/predict cancellation native Worker-close upper bounds were94.3/1,120.6ms; the test waits for closure before retry, so it does not establish zero transient overlap for an immediate earlier retry or physical GPU-memory reclamation.

Raw native receipt/stdout/stderr and per-case JSON remain in `Temp/m5-qa-20261026-parent/candidate-e2e-1*`; summarized scope is in `docs/v16.0.0/M5_STATUS.md`. A JSON `PASS` is a pre-teardown assertion checkpoint, not a replacement for the final native framework result. The standard green CI currently does not retain detailed receipts, so local evidence is not a claim of immutable CI acceptance.

**Not yet verified:** Linux/Chrome/WASM, dynamic-import cancellation, resource peak, or any of the three physical device classes. No RC/release is admitted; total bundle and other remaining gates still apply. Never fix these gaps by silently widening timeouts, replacing inference, dropping ambiguity/null cases, rewriting expected fields from OCR or counting a skip as a pass.
