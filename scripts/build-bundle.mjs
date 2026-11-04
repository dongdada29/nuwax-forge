#!/usr/bin/env node
// Offline runtime allowlist, independent of npm package.json.files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safePath, inside, fileMap, read, write } from './bundle-lib.mjs';
import { copyBridgeRuntime } from './bridge-runtime.mjs';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out') throw Error('build-bundle.mjs --out <不存在的仓外绝对目录>');
const out = safePath(args[1]);
if (inside(source, out) || inside(out, source) || fs.existsSync(out)) throw Error('out 必须不存在且在源码仓外');
fs.mkdirSync(out, { recursive: true });
function copy(from, to) {
  const s = fs.lstatSync(from);
  if (s.isSymbolicLink()) throw Error('拒绝源码 symlink');
  const name = path.basename(from);
  if (['node_modules', '.git', '__pycache__', '.DS_Store'].includes(name) || name.endsWith('.pyc')) return;
  if (['test', 'tests', 'docs', 'examples'].includes(name) || /^test_.*\.py$|\.test\.mjs$/.test(name)) return;
  if (s.isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) copy(path.join(from, f), path.join(to, f)); }
  else if (s.isFile()) {
    if (/^\.env($|\.)|credential/i.test(name)) throw Error('拒绝配置/凭据');
    const data = fs.readFileSync(from);
    if (data.includes('/Users/apple/') || data.includes('/home/apple/')) throw Error(`开发机路径: ${from}`);
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, data, { mode: s.mode & 0o777 });
  } else throw Error('拒绝特殊文件');
}
const versions = {};
// Keep runtime code/resources only: npm pack intentionally retains its own broader list.
const runtime = {
  cli: ['bin/nuwax-forge.mjs', 'bin/nuwax-devkit.mjs', 'lib/'],
  contracts: ['schemas/', 'gui/'],
  'nuwax-crew': ['crew/'],
  dashboard: ['forge_dashboard/', 'web/'],
  'nuwax-stack': ['modules/stack/', 'skills/nuwax-stack/scripts/run_verification.py', 'skills/nuwax-stack/scripts/task_state.py', 'skills/nuwax-stack/scripts/verification.py'],
  'nuwa-sdlc-kit': ['cli.mjs', 'kit/'],
};
for (const [dir, resources] of Object.entries(runtime)) {
  const root = path.join(source, 'packages', dir), pkg = read(path.join(root, 'package.json'));
  versions[pkg.name] = pkg.version;
  const dest = path.join(out, 'payload', 'packages', pkg.name);
  for (const rel of ['package.json', ...resources]) {
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) throw Error('包 files 路径非法');
    copy(path.join(root, rel), path.join(dest, rel));
  }
}
copyBridgeRuntime(source, path.join(out, 'payload', 'packages', '@nuwax-ai', 'devkit-cli', 'lib', 'bots', 'bridge-runtime'));
copy(path.join(source, 'skills', 'nuwax-forge'), path.join(out, 'payload', 'skill'));
copy(path.join(source, 'scripts', 'offline-install.mjs'), path.join(out, 'install.mjs'));
copy(path.join(source, 'scripts', 'migrate-forge.mjs'), path.join(out, 'migrate.mjs'));
copy(path.join(source, 'scripts', 'bundle-lib.mjs'), path.join(out, 'bundle-lib.mjs'));
copy(path.join(source, 'docs', 'INSTALLATION.md'), path.join(out, 'docs', 'INSTALLATION.md'));
write(path.join(out, 'manifest.json'), { schemaVersion: 1, version: versions['@nuwax-ai/devkit-cli'], packages: versions, files: fileMap(out) });
console.log(JSON.stringify({ bundle: out, files: Object.keys(fileMap(out)).length, versions }));
