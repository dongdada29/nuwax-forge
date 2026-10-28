#!/usr/bin/env node
// live runner 子进程（受信 argv 调用，不进 shell）：由 `nuwax-devkit gui run` 显式派发。
// cwd 是仓外 attempt 目录 → Midscene 报告落盘在该目录（midscene_report/…），与业务仓隔离。
// 生命周期契约：单一 puppeteer.connect（defaultViewport:null，不改用户视口）；finally 中
// agent.destroy()（等待报告 flush）+ browser.disconnect()（外部附着应用**不关闭**，绝不 browser.close）。
// 目标：商业 guest 实测为 CDP type='webview'，用 target.asPage() 取 Page（Target.page() 对
// webview 返回 null）。身份记录：CDP Browser 版本、当前目标 URL（去敏感参数）、targetId、SDK 版本。
// SIGTERM（maxWallSeconds 组清理）：有限清理——有界时间内尝试条件恢复，失败如实写"无法恢复"。
// 认证类失败 → status=blocked（交用户手动完成，不伪通过）。日志不含 auth header/令牌。
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { lockTarget, checkReady } from './target.mjs';
import { runScenarioSteps } from './scenario.mjs';
import { isAuthError } from './preflight.mjs';
import { makePageAdapter, makeKeyboardAdapter } from './page-adapter.mjs';
import { prepareExecution } from '../budget/execution.mjs';

const jobFile = process.argv[2];
if (!jobFile) { console.error('runner 需要 job 文件参数'); process.exit(2); }
const job = JSON.parse(readFileSync(jobFile, 'utf8'));
const { recipe, attemptDir, webRoot, pptrRoot, cdpUrl } = job;
const resultFile = join(attemptDir, 'result.json');

let bestEffortRestore = null; // scenario 注册的条件恢复闭包（SIGTERM 有限清理用）
let terminating = false;

function writeResult(obj) {
  writeFileSync(resultFile, JSON.stringify(obj, null, 2) + '\n');
}

// 有界恢复：最多 3s；失败/超时都如实记录
process.on('SIGTERM', () => {
  if (terminating) return;
  terminating = true;
  const bounded = Promise.race([
    (async () => { if (bestEffortRestore) await bestEffortRestore(); return true; })().catch(() => false),
    new Promise(r => setTimeout(() => r(false), 3000)),
  ]);
  bounded.then(restored => {
    writeResult({ runner: 'terminated', phase: 'signal-cleanup', status: 'failed',
      failure: `收到 SIGTERM（maxWallSeconds 硬超时）：有限清理${restored ? '已完成条件恢复' : '未能完成（无法保证恢复，草稿可能残留）'}`,
      restored: restored === true, errors: [] });
    process.exit(143);
  });
});

function stripSensitiveUrl(url) {
  try { const u = new URL(url); u.search = ''; u.hash = ''; return u.toString(); } catch { return null; }
}

async function main() {
  const budget = prepareExecution({ spec: job.budgetSpec, history: job.budgetHistory,
    remainingTokens: job.budgetSpec?.budgetTokens, brief: JSON.stringify(recipe), context: recipe.context ?? {}, worktree: job.contextRoot,
    requiredModel: recipe.model?.name, minCalls: recipe.model?.maxAiOperations ?? 1, requiresVision: true });
  if (!budget.allowed) return { runner: 'error', status: 'blocked', phase: 'budget-guard',
    blockedReason: `runner 预算 guard: ${budget.reason}`, modelCalled: false };
  const reqWeb = createRequire(join(webRoot, 'package.json'));
  const reqPptr = createRequire(join(pptrRoot, 'package.json'));
  const webPkg = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8'));
  const pptrPkg = JSON.parse(readFileSync(join(pptrRoot, 'package.json'), 'utf8'));
  const puppeteerMod = reqPptr(join(pptrRoot, pptrPkg.main ?? 'index.js'));
  const { PuppeteerAgent } = reqWeb(join(webRoot, webPkg.exports['./puppeteer'].require));

  let browser = null, agent = null, page = null;
  const errors = [];
  let out = { runner: 'error', phase: 'connect', status: 'failed', errors };
  try {
    browser = await puppeteerMod.connect({ browserURL: cdpUrl, defaultViewport: null }); // 单一连接，不改用户视口
    out.phase = 'target-lock';
    // Electron webview guest 不在 browser.pages()；从 targets() 枚举，title 先 await page 再取（asPage 对 page/webview 都可用）
    const allTargets = await browser.targets();
    const targets = [];
    for (const t of allTargets) {
      const p = await t.asPage().catch(() => null);
      const title = p ? await p.title().catch(() => '') : '';
      targets.push({ targetId: t._targetId ?? null, type: t.type(), url: t.url(), title });
    }
    const locked = lockTarget(recipe.target, targets);
    if (!locked.ok) { out.status = 'failed'; out.failure = locked.reason; out.candidates = locked.candidates; return out; }
    page = locked.target.targetId
      ? await allTargets.find(t => t._targetId === locked.target.targetId)?.asPage().catch(() => null)
      : null;
    if (!page) { out.status = 'failed'; out.failure = `锁定的目标无法取得 Page 上下文（${locked.target.targetId} ${locked.target.url}）`; return out; }

    out.phase = 'ready';
    await new Promise(r => setTimeout(r, recipe.ready?.settleMs ?? 0));
    const title = await page.title();
    const ready = checkReady(recipe.ready, title);
    if (!ready.ok) { out.status = 'failed'; out.failure = ready.reason; return out; }

    // 实际观测身份（区别于声明式 declaredBuild）：Browser 版本 + 当前 URL（去敏感参数）+ targetId
    const browserVersion = await browser.version().catch(() => null);
    const currentUrl = page.url();
    const currentOrigin = (() => { try { return new URL(currentUrl).origin; } catch { return null; } })();
    if (recipe.target.kind === 'guest' && currentOrigin !== recipe.target.expectedOrigin) {
      out.status = 'failed'; out.failure = `锁定后目标 origin 漂移：${currentOrigin} ≠ 声明 ${recipe.target.expectedOrigin}`; return out;
    }
    out.target = { ...locked.target, url: stripSensitiveUrl(currentUrl) ?? locked.target.url, origin: currentOrigin, title, readyTitle: ready.title };
    out.observedIdentity = { browserVersion, targetId: locked.target.targetId, targetType: locked.target.type, url: out.target.url, sdkVersion: webPkg.version ?? null, puppeteerVersion: pptrPkg.version ?? null };

    out.phase = 'login';
    const loginSel = recipe.loginPrecondition.selector;
    const loginVisible = await page.evaluate(sel => {
      const els = Array.from(document.querySelectorAll(sel));
      const visible = els.filter(el => el.offsetParent !== null);
      return { count: els.length, visibleCount: visible.length };
    }, loginSel).catch(() => ({ count: 0, visibleCount: 0 }));
    out.login = { mechanism: 'declared-selector-unique-visible', selector: loginSel, ...loginVisible, satisfied: loginVisible.count === 1 && loginVisible.visibleCount === 1 };
    if (!out.login.satisfied) {
      out.status = 'blocked';
      out.blockedReason = `登录前提不满足：选择器 ${loginSel} 可见实例 ${loginVisible.visibleCount}/${loginVisible.count}（需唯一可见；未登录或页面结构变化）。driver 不注入 ticket/token、不伪造登录，请用户手动确认登录态后重跑`;
      return out;
    }

    out.phase = 'scenario';
    agent = new PuppeteerAgent(page);
    // 真实输入适配：与测试注入同一接口（page-adapter.mjs，序列化边界在模块内注释说明）
    const pageAdapter = makePageAdapter(page);
    const keyboardAdapter = makeKeyboardAdapter(page, pageAdapter); // 选区删除作用于已 focus 的编辑器
    const scenario = await runScenarioSteps({
      steps: recipe.scenario.steps, bindings: recipe.selectorBindings ?? {},
      page: pageAdapter, keyboard: keyboardAdapter,
      agent: {
        aiBoolean: async instruction => {
          const v = await agent.aiBoolean(instruction);
          out.aiBooleanObserved = v;
          return v;
        },
      },
      maxAiOperations: recipe.model.maxAiOperations,
      expectedOrigin: recipe.target.kind === 'guest' ? recipe.target.expectedOrigin : null,
      checkTargetIdentity: async () => { const u = new URL(page.url()); return { origin: u.origin, targetId: out.target?.targetId ?? null }; },
      registerRestore: fn => { bestEffortRestore = fn; },
    });
    out.scenario = scenario;
    out.aiOperationsUsed = scenario.aiOperationsUsed;
    out.status = scenario.status;
    out.model = { sdkVersion: webPkg.version ?? null, authMode: recipe.model.authMode, name: recipe.model.name, family: recipe.model.family };
    return out;
  } catch (error) {
    errors.push(String(error?.stack ?? error));
    if (isAuthError(error)) { out.status = 'blocked'; out.blockedReason = `模型认证失败（${error?.message}）：不自动重新授权，请用户手动完成 SIWC 认证后重跑`; }
    else out.failure = String(error?.message ?? error);
    return out;
  } finally {
    out.phase = out.phase === 'scenario' ? 'teardown' : out.phase;
    try { if (agent) await agent.destroy(); } catch (error) { errors.push(`agent.destroy: ${error?.message}`); } // 等待报告 flush
    try { if (browser) await browser.disconnect(); } catch (error) { errors.push(`browser.disconnect: ${error?.message}`); } // 不 close：外部附着应用绝不关闭
  }
}

try {
  const result = await main();
  result.phase = result.phase ?? 'connect';
  if (result.scenario) { // finally 恢复结果并入（teardown 后仍有条件恢复语义）
    result.restored = result.scenario.restoreAttempted ? result.scenario.restoreOk : null;
  }
  writeResult(result);
  process.stdout.write(JSON.stringify({ runner: 'ok', status: result.status, resultFile }) + '\n');
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'blocked' ? 3 : 1;
} catch (error) {
  writeResult({ runner: 'error', status: 'failed', failure: String(error?.message ?? error), errors: [String(error?.stack ?? error)] });
  process.stdout.write(JSON.stringify({ runner: 'error', resultFile }) + '\n');
  process.exitCode = 1;
}
