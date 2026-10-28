// live 前置解析：外部 SDK / puppeteer 运行时位置由用户显式指定（--sdk / --runtime 或
// NUWAX_MIDSCENE_SDK / NUWAX_MIDSCENE_PUPPETEER）。发布源码不硬编码任何本机缓存绝对路径，
// 缺依赖时给出结构化错误与修复指引，不联网、不装全局、不动 client 仓依赖。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const HINT = '指向包含 @midscene/web 的 node_modules 目录或包目录本身（只读复用，不修改原仓依赖）；'
  + '或先在仓外建隔离 runtime（npm install --prefix <仓外目录> @midscene/web@1.17.1 puppeteer-core@25.16.0）再把该目录传给 --runtime';

export function resolvePackageRoot(rawPath, packageName) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return { ok: false, reason: `未指定 ${packageName} 位置`, hint: HINT };
  const direct = join(rawPath, 'package.json');
  if (existsSync(direct)) {
    try {
      const pkg = JSON.parse(readFileSync(direct, 'utf8'));
      if (pkg.name === packageName) return { ok: true, root: rawPath, version: pkg.version ?? null };
    } catch { /* 落到 node_modules 探测 */ }
  }
  const nested = join(rawPath, 'node_modules', packageName, 'package.json');
  if (existsSync(nested)) {
    try {
      const pkg = JSON.parse(readFileSync(nested, 'utf8'));
      if (pkg.name === packageName) return { ok: true, root: join(rawPath, 'node_modules', packageName), version: pkg.version ?? null };
    } catch { /* 继续 */ }
  }
  return { ok: false, reason: `${rawPath} 下没有找到 ${packageName}（既不是包目录，也不含 node_modules/${packageName}）`, hint: HINT };
}

// deps 注入可测：默认用 createRequire 真实探测入口文件可加载性（不 import 执行，只 resolve）。
export function preflightSdk({ sdk, runtime, env = process.env, require_ = null, load = false }) {
  const problems = [];
  const web = resolvePackageRoot(sdk ?? env.NUWAX_MIDSCENE_SDK, '@midscene/web');
  if (!web.ok) problems.push(`--sdk / NUWAX_MIDSCENE_SDK: ${web.reason}；${web.hint}`);
  const pptr = resolvePackageRoot(runtime ?? env.NUWAX_MIDSCENE_PUPPETEER ?? sdk ?? env.NUWAX_MIDSCENE_SDK, 'puppeteer-core');
  if (!pptr.ok) problems.push(`--runtime / NUWAX_MIDSCENE_PUPPETEER: ${pptr.reason}；${pptr.hint}`);
  if (web.ok && pptr.ok) {
    const req = require_ ?? createRequire(join(web.root, 'package.json'));
    for (const [label, root, sub] of [['@midscene/web/puppeteer', web.root, './puppeteer'], ['puppeteer-core 主入口', pptr.root, null]]) {
      try {
        if (sub) {
          const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
          const entry = pkg.exports?.[sub]?.require;
          if (!entry || !existsSync(join(root, entry))) throw new Error(`exports["${sub}"].require 缺失`);
          if (load) req(join(root, entry));
          else req.resolve(join(root, entry)); // 预算前只解析路径；通过 guard 后再验证可加载性
        } else {
          if (load) req(join(root, 'package.json'));
          else req.resolve(join(root, 'package.json'));
        }
      } catch (error) {
        problems.push(`${label} 在指定位置不可加载: ${error.message}`);
      }
    }
  }
  const auth = {
    authMode: env.MIDSCENE_MODEL_AUTH_MODE ?? null,
    name: env.MIDSCENE_MODEL_NAME ?? null,
    family: env.MIDSCENE_MODEL_FAMILY ?? null,
  };
  return { problems, web, pptr, auth };
}

// 认证前置：只看环境变量是否声明 siwc；不读取/不复制/不打印 ~/.midscene/siwc.json，
// 不自动重新授权。缺声明或模型调用的认证错误 → blocked，交给用户手动完成。
export function authPrecondition(auth, recipe) {
  if (auth.authMode !== 'siwc') {
    return { ok: false, blocked: true, reason: `MIDSCENE_MODEL_AUTH_MODE 必须为 siwc（收到 ${JSON.stringify(auth.authMode)}）；driver 不自动授权、不读取凭据文件，请用户自行完成认证后再跑 live` };
  }
  const want = recipe?.model;
  if (want?.name && auth.name && want.name !== auth.name) {
    return { ok: false, blocked: true, reason: `MIDSCENE_MODEL_NAME=${auth.name} 与配方声明 ${want.name} 不一致：不改账号/模型，请用户显式确认` };
  }
  if (!auth.name || !auth.family) {
    return { ok: false, blocked: true, reason: '缺少 MIDSCENE_MODEL_NAME / MIDSCENE_MODEL_FAMILY 环境声明（siwc 模式必填）' };
  }
  return { ok: true };
}

// 认证类错误分类（模型调用失败时）：blocked 而不是 failed，绝不伪通过。
export function isAuthError(error) {
  const msg = String(error?.message ?? error ?? '').toLowerCase();
  return /siwc|unauthorized|forbidden|\b401\b|\b403\b|credential|token.*expire|auth/i.test(msg);
}
