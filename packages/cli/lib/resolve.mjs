// 包定位：以 CLI 自身安装位置为基准 require.resolve；NUWAX_DEVKIT_RESOLVE_ROOT 仅是
// 诊断/测试钩子（指向另一个 node_modules 根），不影响生产路径，也不含任何试点绝对路径。
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

function requireFrom(base) {
  try {
    return createRequire(base + '/');
  } catch {
    return null;
  }
}

export function resolvePackage(name) {
  let bases;
  const env = process.env.NUWAX_DEVKIT_RESOLVE_ROOT;
  if (env) {
    bases = [env]; // 诊断/测试钩子：只看指定根，不回退（用于缺依赖诊断）
  } else {
    bases = [dirname(SELF)]; // lib/ → 包根；再向上走 node_modules 链
  }
  for (const base of bases) {
    const req = requireFrom(base);
    if (!req) continue;
    try {
      const pkgJson = req.resolve(name + '/package.json');
      const meta = JSON.parse(readFileSync(pkgJson, 'utf8'));
      return { root: dirname(pkgJson), version: meta.version, pkgJson };
    } catch { /* 该根下没有此包 */ }
  }
  return null;
}

export const PACKAGE_ARTIFACTS = {
  '@nuwax-ai/devkit-stack': root => join(root, 'skills', 'nuwax-stack', 'scripts', 'run_verification.py'),
  '@nuwax-ai/devkit-crew': root => join(root, 'crew', '__init__.py'),
  '@nuwax-ai/devkit-dashboard': root => join(root, 'forge_dashboard', '__init__.py'),
  '@nuwax-ai/nuwa-sdlc-kit': root => join(root, 'kit', 'engine', 'verify.mjs'),
  '@nuwax-ai/devkit-contracts': root => join(root, 'schemas', 'verification-v1.schema.json'),
};

export function locate(name) {
  const pkg = resolvePackage(name);
  if (!pkg) return { found: false, problems: [`包未安装或不可解析: ${name}`] };
  const artifact = PACKAGE_ARTIFACTS[name]?.(pkg.root);
  const problems = [];
  if (artifact && !existsSync(artifact)) problems.push(`${name} 缺关键工件: ${artifact}`);
  return { found: problems.length === 0, root: pkg.root, version: pkg.version, artifact, problems };
}

export function stackBridgePath() {
  return join(resolvePackage('@nuwax-ai/devkit-stack')?.root ?? '', 'skills', 'nuwax-stack', 'scripts', 'run_verification.py');
}

// CLI 自身包根（lib/ 的上一级）
export function cliRoot() {
  return dirname(dirname(SELF));
}

// state 写入禁区：任何 devkit 包内部
export function allDevkitRoots() {
  const roots = [cliRoot()];
  for (const name of Object.keys(PACKAGE_ARTIFACTS)) {
    const pkg = resolvePackage(name);
    if (pkg) roots.push(pkg.root);
  }
  return roots;
}
