# Independent read-only pair824 preflight review

2026-10-22. Verdict: no blocking principle or identity issue found before measurement.

Read the complete PROTOCOL.md, create-reference.mjs, reference.json,
preflight.mjs/json and launch.mjs in the pair824 Temp directory. Did not invoke
build/test/install/network/sampler; only read, hash, parse and call the existing
pure normalizedLock/read-only artifactFingerprint exports.

- Independently read Git objects: ref resolves to
  057042963a33579c624a41404a6d533dfda29768; parent c2980265d3c89f960517ced1527ba9cb85bf7c2b;
  tree40098290fb64d31e0c8fcc12e552b3a913b5c715. Of164 recursive tree entries,
  exactly package.json/package-lock.json differ; other162 retain exact object
  identity. Parsed leaf diff is exactly the declared five Vite8.2.2-to8.2.4
  fields, no business/static changes. c298's parent is original40e68eda.
- Existing normalizedLock(reference)==normalizedLock(current), SHA256
  db9079726ec21ffe25c4882b47c5c8d5b03a4b5ef3036a587cee9c2e2b6336dc.
  Only the original packages[''].engines omission remains. Declared dependencies
  match. No compatibility waiver or changed lock-comparison algorithm.
- Synthetic local reference timestamp1791676800 equals its parent and is
  explicitly not a publication/product date. Creation uses a separate Temp
  GIT_INDEX_FILE and absent-only update-ref. Root HEAD170fd3ea/continuation
  branch/staged diff remain unchanged; report's index digest is a cached-diff
  digest, not a raw index-file-byte digest. This distinction is nonblocking.
- Independently re-read270 current source files against the frozen B inventory:
  all same, inventory a93ec47713269596123a672c43af9e8740b47bcf8ec19c7f700249cb0bdb3a16.
  Re-read every current site file:127 /92537133 bytes; exact whole inventory
  matches all frozen rows, sorted-JSON5b946d23a08cd42743e5151b3ba5bb62ec52b7b6016dcd83eafaac42817124a9.
  Also independently called original artifactFingerprint:4e8dddb5ce4f81992f384afd0ee552431787c6b30600a643bcb97f6a0837e4e4.
  These two hashes use different documented algorithms, not conflicting content.
- Independently rehashed68 installed inventory rows from audit-closure's frozen
  result: all unchanged. Root audit closure marks qualification complete; no new
  audit request was made by this review.
- Sampler raw SHA2ca754524871b72c3c41f17ec2b6052ac74e3334ad034bf522a933cd9df295d7;
  collector raw SHA8a98f57980cfcde94e4035987c974b149c80bc27b51a1ca2309d3aed9d85bdd0.
  LF source also equals HEAD for sampler/collector/build-site/v15 fixture and
  performance-pair tests. Existing thresholds, transport, fixture and cleanup
  remain unchanged. Protocol's CI/absolute/stability wording matches the code.
- launch.mjs pins the full057042... SHA (not moving ref/default40e),800 retained,
  four warmups,bootstrap5000,seed160003,timeout30000 and fresh exclusive raw path.
  It records actual native exit, not expected-status reinterpretation. At review
  time the raw output and launch-reservation file do not exist.

Scope is an independent new-source/new-lock/new-Chrome experiment, not pooled
or extended prior800. Preserve all failures/warmups, no optional stopping,
reruns/seed changes/N rescue, and no parallel build/test/variant work. One live
session must be resumed after observation timeouts, not relaunched. Report final
actual protocol identity and cleanup/instrumentation limits honestly.

No timing or PASS result is granted here. The reference is v15 business with
only declared security alignment; it does not reset the40e70207B budget anchor.
Current all84187>77227.7 still independently FAIL; even latency PASS cannot
admit M4, CI, production, physical devices or release. The protocol states these
boundaries explicitly and needs no principle-level amendment before the single
predeclared managed run.
