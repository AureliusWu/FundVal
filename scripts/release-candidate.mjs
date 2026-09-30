import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_SITE_BYTES = 256 * 1024 * 1024;
const MAX_SITE_FILES = 5_000;

function safePath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Candidate contains an unsafe relative path.');
  }
  return path;
}

function identity({ repository, sha, runId, attempt }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !SHA.test(sha || '')
    || !/^[1-9]\d*$/.test(String(runId || '')) || !/^[1-9]\d*$/.test(String(attempt || ''))) {
    throw new Error('Candidate identity must include origin repository, exact SHA, CI run and attempt.');
  }
  return { repository, sha, runId: String(runId), attempt: String(attempt) };
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function readBoundedRegularFile(path, maximumBytes) {
  // Open first, then validate/read through that descriptor. O_NOFOLLOW guards
  // Linux CI; checking path/descriptor identity also retains Windows support.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const metadata = await handle.stat();
    const pathMetadata = await lstat(path);
    if (!metadata.isFile() || !pathMetadata.isFile() || pathMetadata.isSymbolicLink()
      || metadata.ino !== pathMetadata.ino || metadata.dev !== pathMetadata.dev) {
      throw new Error('Candidate bundle must contain stable regular files.');
    }
    if (metadata.size > maximumBytes) throw new Error('Candidate bundle exceeds size limits.');
    const bytes = await handle.readFile();
    if (bytes.length > maximumBytes || bytes.length !== metadata.size) {
      throw new Error('Candidate bundle changed while reading or exceeds size limits.');
    }
    return bytes;
  } finally { await handle.close(); }
}

function inventoryHash(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.bytes}\0${file.sha256}\n`);
  return hash.digest('hex');
}

export async function inventorySite(directory) {
  const root = await realpath(resolve(directory));
  const files = [];
  let totalBytes = 0;
  async function walk(folder, prefix = '') {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!prefix && entry.name === '.playwright-results') continue;
      const path = safePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = resolve(folder, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw new Error('Candidate may not contain symlinks.');
      if (metadata.isDirectory()) await walk(absolute, path);
      else if (metadata.isFile()) {
        totalBytes += metadata.size;
        if (totalBytes > MAX_SITE_BYTES || files.length >= MAX_SITE_FILES) throw new Error('Candidate exceeds bounded site limits.');
        files.push({ path, bytes: metadata.size, sha256: await hashFile(absolute) });
      } else throw new Error('Candidate may only contain regular files.');
    }
  }
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!files.length) throw new Error('Candidate site is empty.');
  return { files, totalBytes, fingerprint: inventoryHash(files) };
}

export function validateCandidateManifest(manifest, expected) {
  const expectedIdentity = identity(expected);
  if (manifest?.schema !== 1 || manifest.workflow !== '.github/workflows/ci.yml'
    || manifest.event !== 'push' || manifest.branch !== 'main'
    || Object.entries(expectedIdentity).some(([key, value]) => manifest[key] !== value)
    || !DIGEST.test(manifest.releaseFingerprint || '') || !DIGEST.test(manifest.archiveSha256 || '')
    || !DIGEST.test(manifest.site?.fingerprint || '') || !Array.isArray(manifest.site?.files)
    || !manifest.site.files.length || manifest.site.files.length > MAX_SITE_FILES) {
    throw new Error('Candidate provenance or manifest is invalid.');
  }
  const seen = new Set();
  let total = 0;
  for (const file of manifest.site.files) {
    safePath(file.path);
    if (seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !DIGEST.test(file.sha256 || '')) throw new Error('Candidate file manifest is invalid.');
    seen.add(file.path);
    total += file.bytes;
  }
  if (total > MAX_SITE_BYTES || total !== manifest.site.totalBytes
    || manifest.site.fingerprint !== inventoryHash(manifest.site.files)) {
    throw new Error('Candidate inventory fingerprint is invalid.');
  }
  return manifest;
}

export async function createCandidate({ site, output, releaseFingerprint, event, branch, ...inputIdentity }) {
  const candidateIdentity = identity(inputIdentity);
  if (!DIGEST.test(releaseFingerprint || '')) throw new Error('Missing verified release fingerprint.');
  if (!['push', 'pull_request', 'workflow_dispatch'].includes(event)
    || typeof branch !== 'string' || !branch || branch.length > 255 || /[\u0000-\u0020\u007f]/.test(branch)) {
    throw new Error('Candidate must retain the actual CI event and branch.');
  }
  const root = await realpath(resolve(site));
  const destination = resolve(output);
  const overlap = relative(root, destination);
  if (!overlap || (!isAbsolute(overlap) && overlap !== '..' && !overlap.startsWith(`..${sep}`))) {
    throw new Error('Candidate bundle must be outside the site directory.');
  }
  await mkdir(destination, { recursive: true });
  const inventory = await inventorySite(root);
  const listPath = resolve(destination, 'files.txt');
  await writeFile(listPath, `${inventory.files.map(file => file.path).join('\n')}\n`, 'utf8');
  const archive = resolve(destination, 'site.tar');
  execFileSync('tar', ['-cf', archive, '-C', root, '-T', listPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const manifest = {
    schema: 1,
    ...candidateIdentity,
    workflow: '.github/workflows/ci.yml', event, branch,
    node: process.version, npm: inputIdentity.npm || '',
    releaseFingerprint, archiveSha256: await hashFile(archive), site: inventory,
  };
  await writeFile(resolve(destination, 'candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function verifyAndExtractCandidate({ bundle, output, ...expected }) {
  const root = await realpath(resolve(bundle));
  const metadataPath = resolve(root, 'candidate.json');
  const archive = resolve(root, 'site.tar');
  const metadataBytes = await readBoundedRegularFile(metadataPath, 2 * 1024 * 1024);
  const manifest = validateCandidateManifest(JSON.parse(metadataBytes.toString('utf8')), expected);
  // All tar operations consume the same verified bytes. Never reopen the
  // archive path after validation, even if another process replaces it.
  const archiveBytes = await readBoundedRegularFile(archive, MAX_SITE_BYTES + 10 * 1024 * 1024);
  if (createHash('sha256').update(archiveBytes).digest('hex') !== manifest.archiveSha256) throw new Error('Candidate archive checksum does not match.');
  const names = execFileSync('tar', ['-tf', '-'], { input: archiveBytes, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split(/\r?\n/);
  const types = execFileSync('tar', ['-tvf', '-'], { input: archiveBytes, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split(/\r?\n/);
  if (types.some(line => !line.startsWith('-')) || names.length !== manifest.site.files.length
    || names.some((name, index) => safePath(name) !== manifest.site.files[index].path)) {
    throw new Error('Candidate archive contains unexpected entries or links.');
  }
  const destination = resolve(output);
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length) throw new Error('Candidate extraction requires an empty directory.');
  execFileSync('tar', ['-xf', '-', '-C', destination], { input: archiveBytes, stdio: ['pipe', 'pipe', 'pipe'] });
  const actual = await inventorySite(destination);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.site)) throw new Error('Extracted candidate differs from verified site inventory.');
  return manifest;
}

async function main(args) {
  const options = Object.fromEntries(args.slice(1).reduce((pairs, item, index, values) => {
    if (index % 2 === 0) pairs.push([item.replace(/^--/, ''), values[index + 1]]);
    return pairs;
  }, []));
  const shared = { repository: options.repository, sha: options.sha, runId: options['run-id'], attempt: options.attempt };
  const manifest = args[0] === 'create'
    ? await createCandidate({ ...shared, site: options.site, output: options.output, event: options.event, branch: options.branch, releaseFingerprint: options['release-fingerprint'], npm: options.npm })
    : args[0] === 'verify'
      ? await verifyAndExtractCandidate({ ...shared, bundle: options.bundle, output: options.output })
      : (() => { throw new Error('Usage: release-candidate.mjs create|verify --repository owner/repo --sha SHA --run-id ID --attempt N ...'); })();
  process.stdout.write(`Verified candidate ${manifest.sha}: ${manifest.site.files.length} files, ${manifest.site.fingerprint}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
