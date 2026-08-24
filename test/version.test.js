import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_VERSION } from '../js/version.js';

test('runtime, release metadata and maintained documentation versions stay synchronized', async () => {
  const [sw, pkg, lock, manifest, index, readme, agents, claude, changelog, feedback] = await Promise.all([
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../manifest.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8'),
    readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/v14.0.0/IMPLEMENTATION_FEEDBACK.md', import.meta.url), 'utf8'),
  ]);
  assert.match(sw, new RegExp(`fuyu-v${APP_VERSION.replaceAll('.', '\\.')}`));
  assert.equal(pkg.version, APP_VERSION);
  assert.equal(lock.version, APP_VERSION);
  assert.equal(lock.packages?.['']?.version, APP_VERSION);
  assert.match(manifest.description, new RegExp(`v${APP_VERSION.replaceAll('.', '\\.')}`, 'i'));
  assert.match(index, new RegExp(`V${APP_VERSION.replaceAll('.', '\\.')}`));
  const escapedVersion = APP_VERSION.replaceAll('.', '\\.');
  assert.match(readme, new RegExp(`^\\s*当前版本：[\`]${escapedVersion}[\`]。`, 'm'));
  assert.match(agents, new RegExp(`^## 当前架构（V${escapedVersion}）`, 'm'));
  assert.match(claude, new RegExp(`本项目当前版本为 [\`]${escapedVersion}[\`]`));
  assert.match(changelog, new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
  assert.match(feedback, new RegExp(`^# 蜉蝣基金（FundVal）v${escapedVersion} 实施反馈$`, 'm'));
});
