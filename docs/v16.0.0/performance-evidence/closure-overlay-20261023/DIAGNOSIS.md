# Fixed Closure overlay probe: optimizer exception (2026-10-23)

## Verdict and boundary

The exact pinned SIMPLE / ES2022-in-and-out / NONE / module-rewriting-disabled / LOCAL configuration is **NOT_QUALIFIED**. B1 got beyond the former parser bridge failure, but F01 terminated inside `RemoveUnusedCode` before producing compiled JavaScript. This is an **OPTIMIZER_INTERNAL_EXCEPTION**, not a FundVal financial-behavior RED and not a successful semantic comparison. The driver's original `SETUP_OR_DRIVER_FAILURE` label remains untouched. No compiler fix, option change, rerun, fixture change, product transformation, build, or size measurement was performed in this audit. This does not prove that every Closure strategy is impossible.

This audit used performance-regression-check's evidence separation: a failed prerequisite cannot imply behavior preservation or compressed-size benefit. Only this new report is written; old source, receipts, probes, A/B workspaces, and root remain independent evidence.

## Actual receipt

Input evidence is `C:/Users/84046/AppData/Local/Temp/FundVal-closure-overlay-probe-20261023-parent/run-01/`.

- F01 original sanity: native 0; denied fetch/storage 0/0. F01 Java: native 2; `java.lang.NullPointerException: NAME publicFn 5:21 [length: 8] [source_file: fixtures/F01-exports.mjs]`. Controller native 2. No compiled output or transformed-F01 observation exists; F02–F08 remain NOT_RUN.
- Actual Java stderr is **2789 bytes**, not an estimated 3029. SHA256 `04fc38704a441d9caffe574e5de32a28b40bb74341048ee4273f703fbbe30a29`.
- Java stdout: 485 bytes, SHA256 `ce55d911fe7c94240e4f0a262ec9f69d224da7b1a728325ab0675faf288fd192`.
- `summary.json`: 12743 bytes, SHA256 `c02d5e866bd572e803400a0a09f8f4b5a7134e63ead28a6aba525395d9cffa2d`; `frozenSourcesUnchanged: true`.
- F01 fixture: 321 bytes, SHA256 `4f254c48c8328930a2a8bb3b292f9be70b1de993ed3a96acf85f9459f9f29b35`.
- Parent execution `C:/Users/84046/AppData/Local/Temp/FundVal-closure-overlay-execution-20261023-parent/RESULT.json`: 5990 bytes, SHA256 `ab0adf23afd49fbd002f4ae78d248b6e8b4966eb49b3307a1ed37c13edce55a1`, status PREREQUISITE_STOP, postflightError null. Recorded before/after source 273 / row SHA `d0d9554fef7d2ef4b75f67a7db4fef558e03bb03f0897f2305617c6361090a3e`; site 127 / row SHA `0641039bb788b27c58c0ec0dc3d93b40cbc95bc2c51c935c105c9354c9b29d31`; installed count 68, HEAD/branch/index unchanged. These are the existing wrapper's measurements, not a new product gate.

## Narrow source diagnosis

All official sources below were read at tag **v20261020**. Source bytes were fetched into memory only and SHA256 checked in this read-only audit; no source artifact/toolchain was installed or changed.

1. F01 line 5 begins `export { original as publicFn, ... }`. Its zero-based column 21 is the **external export alias** `publicFn`, not the local function declared on line 3. The original Node observation already accepted this legal module and its aliases/identity/arity.
2. [IRFactory.java:3417–3428](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/parsing/IRFactory.java#L3417-L3428) creates an EXPORT_SPEC with two NAME children; the destination/exported alias is the second child. [NodeUtil.java:2341–2370](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/NodeUtil.java#L2341-L2370) explicitly classifies that child as a nonlocal module export name, not a module lexical variable.
3. [RemoveUnusedCode.java:407–487](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/RemoveUnusedCode.java#L407-L487) enters a scope for MODULE_BODY, has generic child traversal for unhandled nodes, and processes NAME references without excluding the nonlocal export-name category. Its [641–650 and 825–826](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/RemoveUnusedCode.java#L641-L650) route reaches `checkNotNull(scope.getVar(nameNode.getString()), nameNode)`.
4. The actual stack is `getVarForNameNode:826 → traverseNameNode:650 → traverseNode:481`, with generic traversals at 487 and module scope at 454, then `PhaseOptimizer` and `Compiler.performTranspilationAndOptimizations:3181`. Thus the observed failure is a null lexical-Var lookup for that external alias in an optimizer pass. It is not the earlier missing parser-enum mapping, a Java launch/compile error, a missing import target warning, or a financial input rejection.
5. [MakeDeclaredNamesUnique.java:146–162](https://github.com/google/closure-compiler/blob/v20261020/src/com/google/javascript/jscomp/MakeDeclaredNamesUnique.java#L146-L162) deliberately skips nonlocal export names while other local names can be renamed. This supports why treating the two roles as interchangeable is invalid. **It does not prove which prior pass renamed, removed, or otherwise affected the local `publicFn` in this run.** No intermediate AST, scope inventory, or pass history was captured. That deeper causal attribution remains unproven; no further instrumentation is authorized here. Independent read-only review reached the same limit.

Source inventory (UTF-8 bytes; SHA256):

| Official file under `src/com/google/javascript/jscomp/` | Bytes | SHA256 |
| --- | ---: | --- |
| RemoveUnusedCode.java | 127846 | b9c3d7a661a27ceb7d51f86479710228879c714b38cd0c3943158761278db7e3 |
| NodeUtil.java | 204477 | d493fa4a84278d2672c9d83bae8e64e1b4c3a12f131f016ae1ee9b95a8682ea5 |
| parsing/IRFactory.java | 161388 | b9eec78612a5989d0d819ef07b354d4dc19cdce162efbecc1604adaf6af2670a |
| MakeDeclaredNamesUnique.java | 35557 | f8034a8ced7982437de18d0f6705ae2bb015deea150515641ed55c26213c6c10 |

The running B1 Compiler source was separately pinned by the existing probe to SHA256 `7974acca148ffea2650f57a632372e60b68aa1f93092abef4c25e016c005485a`; the JAR to `7dfedc111cb06024d3aa132443cd4952da415635c59342d84d96883083df853c`. Prior finite enum/ABI PASS only qualified the packaging overlay and bridge, not this optimizer path. No new semantic PASS can be inherited from those checks.

## Different next architecture, not another compiler patch

A worthwhile architectural cut would make the private runtime **source-Quote-centric end to end**, with one lossless boundary codec for old row/cache APIs and a separate view projection, rather than revive the old worker-only validation/legacy-finisher split. Actual current seams are `js/eastmoney-estimate.js:13,56,83–85` (wire → legacy row → source Quote), `js/runtime/refresh-resource-cache.js:40–91,166,179,233` (row/Quote validation and persistence), and `js/app.js:659,945,949,1028–1041` (consumer and old-cache hydration). Closing the whole cut could remove default-graph legacy-row constructors/re-normalization only after every internal acquisition, resource read/write, hydration, and consumer has moved; merely adding a new DTO/facade cannot do so. Old public API/source/site remain independently available; all strict validation, presence/opaque semantics, model evidence, clocks, failure ordering, generation/accuracy lifecycle and legacy codecs still require preservation.

This is a materially larger implementation boundary than the former partial seam, **not a claim that the already proposed whole private-pipeline idea is novel or qualified**. The next honest prerequisite is a current-source complete import/deletion map plus finite boundary equivalence coverage before a complete isolated candidate and budget measurement. No raw-byte addition, gzip estimate, 8742-byte promise, permission expansion, or production qualification is asserted here. Stop after this report; no more Closure patches/flags/probes are proposed in this audit.
