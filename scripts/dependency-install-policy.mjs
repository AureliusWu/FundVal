import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateInstallPolicy(lock, policy) {
  if (lock?.lockfileVersion !== 3 || !lock.packages || policy?.schema !== 1
    || !Array.isArray(policy.packages)) throw new Error('Invalid locked dependency install policy.');
  const approved = new Map(policy.packages.map(entry => [entry.path, entry]));
  if (approved.size !== policy.packages.length) throw new Error('Duplicate dependency policy entry.');
  const actual = Object.entries(lock.packages).filter(([, entry]) => entry.hasInstallScript);
  if (actual.length !== approved.size) throw new Error('Dependency install-script set changed; review the allowlist.');
  for (const [path, entry] of actual) {
    const allowed = approved.get(path);
    if (!allowed || allowed.version !== entry.version || allowed.integrity !== entry.integrity
      || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved || '')
      || !['disabled', 'esbuild-only'].includes(allowed.execution)) {
      throw new Error(`Unreviewed dependency install script: ${path}`);
    }
  }
  return actual.map(([path]) => path);
}

async function main() {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const policy = JSON.parse(await readFile(new URL('../.github/dependency-install-policy.json', import.meta.url), 'utf8'));
  const paths = validateInstallPolicy(lock, policy);
  process.stdout.write(`Reviewed ${paths.length} locked install scripts; npm lifecycle scripts remain disabled.\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
