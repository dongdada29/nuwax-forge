#!/usr/bin/env node
// 用法：node scripts/bump-version.mjs <x.y.z> —— 同步 kit/VERSION、package.json、引擎文件头、site 版本串四处。
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ver = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(ver ?? '')) {
  console.error('用法: node scripts/bump-version.mjs <x.y.z>');
  process.exit(1);
}
writeFileSync(join(ROOT, 'kit/VERSION'), ver + '\n');
const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = ver;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
for (const f of readdirSync(join(ROOT, 'kit/engine'))) {
  if (!f.endsWith('.mjs')) continue;
  const p = join(ROOT, 'kit/engine', f);
  writeFileSync(p, readFileSync(p, 'utf8')
    .replaceAll(/nuwa-sdlc-kit v\d+\.\d+\.\d+ · engine/g, `nuwa-sdlc-kit v${ver} · engine`));
}
// site 版本串：导航版本章、终端示例、落地 lead、五仓 chip 全部跟随发版
const sitePath = join(ROOT, 'site', 'index.html');
if (existsSync(sitePath)) {
  writeFileSync(sitePath, readFileSync(sitePath, 'utf8').replaceAll(/v\d+\.\d+\.\d+/g, `v${ver}`));
}
console.log(`✅ 版本统一为 ${ver}（kit/VERSION、package.json、引擎文件头、site 版本串）`);
