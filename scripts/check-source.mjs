import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['sw.js', 'playwright.config.mjs'];
async function collect(directory) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(path);
  }
}
for (const directory of ['js', 'scripts', 'test', 'e2e']) await collect(directory);
for (const path of files.sort()) {
  const target = resolve(root, path);
  if (relative(root, target).startsWith('..')) throw new Error('Source check escaped the project.');
  execFileSync(process.execPath, ['--check', target], { stdio: 'inherit' });
}
process.stdout.write(`Syntax checked ${files.length} JavaScript source and test files.\n`);
