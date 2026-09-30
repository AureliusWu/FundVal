import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCandidate, inventorySite, validateCandidateManifest, verifyAndExtractCandidate } from '../scripts/release-candidate.mjs';
import { validateCandidateRun } from '../scripts/resolve-release-candidate.mjs';
import { validateInstallPolicy } from '../scripts/dependency-install-policy.mjs';

const origin = { repository: 'AureliusWu/FundVal', sha: 'a'.repeat(40), runId: '123', attempt: '1' };
const verifiedRun = {
  id: 123, workflow_id: 88, path: '.github/workflows/ci.yml',
  repository: { full_name: origin.repository }, head_repository: { full_name: origin.repository },
  event: 'push', head_branch: 'main', head_sha: origin.sha, status: 'completed', conclusion: 'success', run_attempt: 1,
};

test('candidate provenance rejects failed, fork, PR, branch, mismatched SHA and unrelated workflow runs', () => {
  const expected = { ...origin, workflowId: 88 };
  assert.equal(validateCandidateRun(verifiedRun, expected).artifactName, `fundval-candidate-${origin.sha}-1`);
  assert.equal(validateCandidateRun({ ...verifiedRun, run_attempt: 2 }, expected).artifactName, `fundval-candidate-${origin.sha}-2`);
  for (const mutation of [
    { status: 'in_progress' }, { conclusion: 'failure' }, { event: 'pull_request' },
    { head_branch: 'feature/v16' }, { head_sha: 'b'.repeat(40) }, { id: 456 }, { workflow_id: 89 },
    { path: '.github/workflows/untrusted.yml' }, { run_attempt: 0 },
    { repository: { full_name: 'Other/FundVal' } }, { head_repository: { full_name: 'Fork/FundVal' } },
  ]) assert.throws(() => validateCandidateRun({ ...verifiedRun, ...mutation }, expected));
  assert.throws(() => validateCandidateRun(verifiedRun, { ...expected, sha: '$(echo invalid)' }));
});

test('candidate packing and extraction preserve every byte and reject modified archive or provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fundval-candidate-'));
  try {
    const site = join(directory, 'site');
    await mkdir(join(site, 'js'), { recursive: true });
    await mkdir(join(site, '.playwright-results'), { recursive: true });
    await writeFile(join(site, 'index.html'), '<html>synthetic</html>\r\n');
    await writeFile(join(site, 'js', 'app.js'), 'export const value = 0;\n');
    await writeFile(join(site, '.playwright-results', 'ignored.txt'), 'test output');
    const output = join(directory, 'bundle');
    const manifest = await createCandidate({ ...origin, site, output, event: 'push', branch: 'main', releaseFingerprint: 'c'.repeat(64) });
    assert.equal(manifest.site.files.length, 2);
    assert.equal(manifest.site.files.some(file => file.path.includes('playwright')), false);
    const extracted = join(directory, 'extracted');
    await verifyAndExtractCandidate({ ...origin, bundle: output, output: extracted });
    assert.deepEqual(await inventorySite(extracted), manifest.site);
    assert.deepEqual(await readFile(join(extracted, 'index.html')), await readFile(join(site, 'index.html')));
    assert.throws(() => validateCandidateManifest(manifest, { ...origin, sha: 'b'.repeat(40) }));
    assert.throws(() => validateCandidateManifest({ ...manifest, event: 'pull_request' }, origin));
    assert.throws(() => validateCandidateManifest({ ...manifest, branch: 'feature/v16' }, origin));
    assert.throws(() => validateCandidateManifest({ ...manifest, site: { ...manifest.site, fingerprint: 'd'.repeat(64) } }, origin));
    const traversal = structuredClone(manifest);
    traversal.site.files[0].path = '../escape.js';
    assert.throws(() => validateCandidateManifest(traversal, origin));
    const duplicate = structuredClone(manifest);
    duplicate.site.files.push(duplicate.site.files[0]);
    assert.throws(() => validateCandidateManifest(duplicate, origin));
    await assert.rejects(() => verifyAndExtractCandidate({ ...origin, bundle: output, output: extracted }), /empty directory/);
    await writeFile(join(output, 'site.tar'), 'tampered archive');
    await assert.rejects(() => verifyAndExtractCandidate({ ...origin, bundle: output, output: join(directory, 'bad') }), /checksum/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('review branch candidates keep their origin and cannot enter production verification', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fundval-review-'));
  try {
    const site = join(directory, 'site');
    await mkdir(site);
    await writeFile(join(site, 'index.html'), 'synthetic');
    const manifest = await createCandidate({ ...origin, site, output: join(directory, 'bundle'), event: 'pull_request', branch: 'feature/v16', releaseFingerprint: 'c'.repeat(64) });
    assert.equal(manifest.event, 'pull_request');
    assert.equal(manifest.branch, 'feature/v16');
    assert.throws(() => validateCandidateManifest(manifest, origin), /provenance/);
    await assert.rejects(() => createCandidate({ ...origin, site, output: join(site, 'bad'), event: 'push', branch: 'main', releaseFingerprint: 'c'.repeat(64) }), /outside/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('install policy requires an exact reviewed set of lifecycle scripts with unchanged integrity', async () => {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const policy = JSON.parse(await readFile(new URL('../.github/dependency-install-policy.json', import.meta.url), 'utf8'));
  assert.equal(validateInstallPolicy(lock, policy).length, 5);
  for (const key of ['version', 'integrity']) {
    const changed = structuredClone(lock);
    changed.packages['node_modules/esbuild'][key] = 'unreviewed';
    assert.throws(() => validateInstallPolicy(changed, policy), /Unreviewed/);
  }
  const injected = structuredClone(lock);
  injected.packages['node_modules/unknown'] = { hasInstallScript: true, version: '1.0.0' };
  assert.throws(() => validateInstallPolicy(injected, policy), /set changed/);
});
