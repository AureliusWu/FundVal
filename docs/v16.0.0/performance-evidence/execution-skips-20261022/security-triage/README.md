# FundVal Vite audit: read-only triage, 2026-10-22

## Conclusion and limits

The smallest published fix within the currently supported Vite 8.2 minor is **8.2.4**, for the six GHSA identifiers supplied by the root task. All six official advisories specify affected Vite 8.2 versions `>=8.2.0, <=8.2.3` and first patched version `8.2.4`. This is not a claim that all possible dependency vulnerabilities are closed, that this project's upgrade is qualified, or that a live installation/artifact has been verified safe.

[Vite's current support policy](https://vite.dev/releases#supported-versions) explicitly lists 8.2 for important/security backports while 8.3 receives regular patches. [The official 8.2.4 release](https://github.com/vitejs/vite/releases/tag/v8.2.4) exists. npm registry metadata reports 8.2.4 published at `2026-10-06T04:48:20.112Z`, no deprecation field, and stable 8.2 versions 8.2.0, 8.2.1, 8.2.2, 8.2.4. Thus 8.2.4 is a supported-branch candidate, not an unsupported historical fallback. Latest tag is 8.3.5; latest is not itself a reason to accept a forced minor upgrade for these six fixes.

## Official advisory matrix

| GHSA | Severity | Scope summary | Fixed Vite 8.2 |
| --- | --- | --- | --- |
| [698v-4r3x-3vcv](https://github.com/vitejs/launch-editor/security/advisories/GHSA-698v-4r3x-3vcv) | moderate | Windows launch-editor argument escaping; attacker-controlled path/environment/NTFS prerequisites matter. | 8.2.4 |
| [r825-w8mm-5pxw](https://github.com/vitejs/launch-editor/security/advisories/GHSA-r825-w8mm-5pxw) | moderate | Some editors can interpret path values as command flags; Vite's documented condition includes WSL and attacker-created filesystem entries. | 8.2.4 |
| [587h-7wmj-h5pm](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm) | high | Windows path existence check bypass; combining with the percent-escaping issue can reach OS command injection. Do not assume attacker file placement is always required. | 8.2.4 |
| [9jrq-w75r-8gcw](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw) | low | Custom/middleware Vite development-server HTML transformation with an unchanged request URL and inline module scripts can load cross-origin code in the dev origin. This is not automatically production-server RCE. | 8.2.4 |
| [rq7h-c2jc-7f22](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22) | moderate | Non-Windows exposed Vite development server, matching import/root-relative host path and fs-deny prerequisites can disclose host files. | 8.2.4 |
| [vfpm-58rq-9qcg](https://github.com/vitejs/vite/security/advisories/GHSA-vfpm-58rq-9qcg) | moderate | Vite development-server Wasm instance loading may expose the first four bytes of a denied file in Node/Deno errors. This is not evidence of complete-file disclosure or RCE. | 8.2.4 |

The first three also list launch-editor `<=2.14.1` affected / `2.14.2` patched. Local Vite's distributed `node_modules/vite/dist/node/chunks/node.js` contains inline bundled `launch-editor@2.14.1` and mounts `/__open-in-editor` inside its development server. The absence of a standalone launch-editor entry in this project's package-lock does **not** prove the dependency is absent or fixed. A standalone package override alone must not be assumed to patch Vite's already bundled copy.

The [official v8.2.4 changelog](https://github.com/vitejs/vite/blob/v8.2.4/packages/vite/CHANGELOG.md) contains the launch-editor 2.14.2 update and the three Vite middleware/filesystem fixes under its 8.2.3 heading, followed by 8.2.4 as the published release. The registry did not list a stable 8.2.3 package in this read; do not nominate 8.2.3 as an installable/fixed candidate against the advisories.

## Exact npm metadata comparison

Source: GET `https://registry.npmjs.org/vite`, selected fields retained in `registry-metadata.json`. Comparison was structural, with sorted object keys.

- 8.2.2 -> 8.2.4: engines, direct dependencies, optional dependencies and peer dependencies all compare identical as declared metadata. This reduces but does not eliminate compatibility risk; implementation/tarball contents still change.
- Node engines remain `^20.19.0 || >=22.12.0`, compatible with this project's pinned Node 24.14.0.
- 8.2.4 integrity: `sha512-lfauXnrf2x0p+UoA+wXh0dgFWnUjCyG6Js95KBkgaCwUU9k0DAHI4W6Q0WCx+h+5g+Alce1y4Zi2QjjK0UvGBw==`.
- 8.2.4 SHA1 shasum: `228041a755db4667c5a5d93735c8f61da993ccc5`.
- npm latest 8.3.5 additionally changes declared rolldown `~1.2.4` -> `~1.2.14`, postcss `^8.5.26` -> `^8.5.30`, picomatch `^4.0.5` -> `^4.0.7`, and devtools peer ranges. This is broader than the six-advisory minimal patch candidate.

## Repository exposure assessment: source evidence only

Current package.json/package-lock pin Vite 8.2.2 as devDependency. Programmatic Vite calls found are build APIs:

- `scripts/build-site.mjs:8,140`: imports build as viteBuild, sets configFile:false and build.write:false, then handles generated application chunks itself.
- `scripts/build-paddle-ocr.mjs:6,500`: imports build for the separately built same-origin OCR assets; configFile:false.
- `npm run serve` uses `node --use-env-proxy scripts/serve-site.mjs`, not Vite dev or Vite preview.
- `scripts/serve-site.mjs:1,22,51` is a custom node:http static server rooted at site/, with its own data proxy and loopback listen at 127.0.0.1. It does not import Vite or mount the editor/transform middleware.
- `playwright.config.mjs` calls npm run serve. The deploy workflow uploads site/ as a Pages artifact.
- A scoped source scan, excluding generated site/, dependency node_modules/ and docs, found no Vite createServer, transformIndexHtml, middlewareMode, --host, vite preview/dev, or npx vite usage.

**Inference:** these repository-defined build/serve/Pages paths do not establish the Vite development-server exposure conditions from the advisories. An installed vulnerable build dependency remains a real dependency-maintenance issue, but it is not proof that the deployed static PWA has OS-command-execution capability. Conversely this scan is not a complete non-impact proof: manual Vite commands, editor plugins, other hosts/CI paths, shared origins, live generated content and all currently running listeners were not exhaustively audited. No exploit was run and no live production claim is made.

## Minimum future isolated qualification (not performed)

1. Reconfirm the existing task authorization and freeze the dirty-source input and baseline package/lock hashes in a separate temporary copy or approved isolated checkout. Keep the active source work and Node/npm pins untouched. This checklist does not impose a new permission or M3 gate beyond the user's existing instructions; judge the concrete qualification against that scope.
2. Candidate exact Vite 8.2.4, not npm audit fix --force. Review package/lock diff and resolved integrity before install; preserve other locked versions where possible. Confirm installed Vite and bundled editor version, and retain dependency tree plus npm audit JSON; require all six advisories absent and review any remaining findings independently.
3. In that isolated candidate, run the existing tests/check/build/e2e gates with raw commands, exit codes, logs, versions and candidate hashes. Compare baseline/candidate finance/null/date behavior, refresh cancellation/no-write guarantees, and built cold/lazy module graph/native bindings. Do not change budgets to obtain a pass.
4. Check generated static artifact imports, CSP, same-origin OCR worker paths and Service Worker/core-cache boundaries. Do a local browser smoke using the project's custom server; record the actual server command and listener rather than substituting Vite dev/preview.
5. Apply the already defined M3 admission/performance protocol before accepting changed build outputs. A clean audit or a smaller bundle alone is not M3 admission, deployment, or release authorization. Keep rollback to the preserved package/lock baseline available.

## Evidence and execution boundaries

- `advisory-matrix.json`: machine-readable selected GitHub advisory API metadata from the successful first read; six rows, each retaining the exact affected/patched range.
- `registry-metadata.json`: selected npm metadata read at 2026-10-22T02:39:08Z, versions 8.2.2/8.2.4/8.3.3/8.3.5 and dist/provenance fields. No tarball was installed or executed.
- `repo-readonly-scan.log`: scoped repository and bundled-Vite scan output.
- A later redundant GitHub API read encountered transport EOFs for the first three rows; that partial response was not used as evidence. The successful initial six-row response and official advisory pages support the matrix.
- A redundant supplemental launch-editor registry/changelog request stalled before producing data and was interrupted. The official changelog was then read successfully through a separate 15-second-timeout GET; no supplemental stalled-request data is used.

Only this new temporary evidence directory was written. No repository code, package.json, lockfile, dependency installation, build, budget, Git branch, commit/push or external state was changed.
