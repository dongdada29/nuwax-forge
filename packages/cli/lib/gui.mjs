// `nuwax-forge gui run`：显式 live GUI 验证入口（与 source-tooling `verify` 完全分开；
// verify 仍只放行 source-tooling 配方）。默认安装/测试/pack 完全不触发本路径、不装 SDK、不联网。
//
// 仅支持外部附着（--cdp，且只接受本机回环端点）：自有实例 launch 无真实可证明的数据目录隔离，
// 明示 unsupported，不做空壳支持。父进程职责：配方契约校验、state/仓边界、SDK 前置、attempt 目录、
// runner 子进程派发（受信 argv、自有进程组、cwd=attempt 目录、maxWallSeconds 真实硬超时：
// TERM → 宽限 → KILL，定时器正确清理）、报告观测与严格判定、一次性 manifest、退出码。
// 判定严格：观测 unknown / 缺报告 / 观测预算超限 / 任一 aiBoolean 无报告交叉核对都不通过。
// 退出码：0=passed（仅本次 driver 实际执行且断言校验通过）；1=failed；2=用法错误；3=blocked；
// 4=前置错误。进程退出码本身不构成产品通过声明。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGuiRecipe } from './gui/contract.mjs';
import { extractFixtureFromHtml, mergeObservations, buildVerdict } from './gui/report.mjs';
import { parseFixture } from '@nuwax-ai/devkit-contracts/gui/midscene-report.mjs';
import { preflightSdk, authPrecondition } from './gui/preflight.mjs';
import { createAttemptDir, newAttemptId, sha256File, sha256String, writeManifestOnce } from './gui/evidence.mjs';
import { allDevkitRoots } from './resolve.mjs';
import { realpathNearestExisting, resolveStateReal, isInside } from './paths.mjs';
import { UsageError } from './args.mjs';
import { prepareExecution, settleExecution, readBoundedJson } from './budget/execution.mjs';
import { guardOutPath } from './budget/cli.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function childExit(child) {
  return new Promise((res, rej) => { child.on('error', rej); child.on('close', (code, signal) => res(signal ? 1 : code)); });
}

function listHtmlFiles(dir) {
  const out = [];
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else if (name.endsWith('.html')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function killGroup(pid, sig) { try { process.kill(-pid, sig); } catch { /* 组已退出 */ } }

// CDP 端点严格校验：仅 http + 本机回环（127.0.0.1 / localhost / [::1]）+ 整数端口 1..65535。
// 不接受非回环地址（不附着远程/局域目标）、不接受 file/ws 等其它方案。
export function parseCdpEndpoint(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: '--cdp 必须是 http://127.0.0.1:<端口> 形式的本机回环端点' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: `--cdp 不是有效 URL: ${raw}` }; }
  if (u.protocol !== 'http:') return { ok: false, reason: `--cdp 仅支持 http（收到 ${u.protocol}//）` };
  const host = u.hostname;
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (!loopback) return { ok: false, reason: `--cdp 仅允许本机回环地址（收到 ${host}）：不附着非本机目标` };
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: `--cdp 端口必须是 1..65535 整数（收到 ${u.port || '空'}）` };
  return { ok: true, endpoint: `http://127.0.0.1:${port}` };
}

export async function runGui({ recipe: recipeArg, state, sdk, runtime, cdp, 'launch-config': launchConfigArg, json = false, 'max-wall-seconds': wallOverride,
  'budget-spec': budgetSpecArg, 'budget-history': budgetHistoryArg }) {
  const say = m => { if (!json) process.stderr.write(m + '\n'); };

  if (!recipeArg || !state) throw new UsageError('gui run 缺少必填参数: --recipe --state');
  if (launchConfigArg) {
    throw new UsageError('--launch-config 当前 unsupported：自有实例启动缺少真实可证明的数据目录隔离（userDataDir 声明不等于隔离生效），本版本只支持外部附着 --cdp <http://127.0.0.1:端口>。不做空壳支持');
  }
  if (!cdp) throw new UsageError('必须显式提供 --cdp <http://127.0.0.1:端口>（外部附着，仅本机回环）；不自动发现端口、不猜第一个 HTTP page');
  const cdpCheck = parseCdpEndpoint(cdp);
  if (!cdpCheck.ok) throw new UsageError(cdpCheck.reason);
  cdp = cdpCheck.endpoint;
  if (wallOverride !== undefined) {
    const n = Number(wallOverride);
    if (!Number.isInteger(n) || n < 1 || n > 3600) throw new UsageError('--max-wall-seconds 必须是 1..3600 的整数');
  }

  const recipeFile = resolve(recipeArg);
  if (!existsSync(recipeFile) || !statSync(recipeFile).isFile()) throw new Error(`--recipe 不是存在的文件: ${recipeFile}`);
  if (statSync(recipeFile).size > 1048576) throw new Error('--recipe 超过 1MiB 输入上限');
  const recipeText = readFileSync(recipeFile, 'utf8');
  let recipe;
  try { recipe = JSON.parse(recipeText); } catch (error) { throw new Error(`GUI 配方不是有效 JSON: ${error.message}`); }
  const problems = validateGuiRecipe(recipe);
  if (problems) throw new Error('GUI 配方验证失败:\n  - ' + problems.join('\n  - '));

  // 边界：state 仓外且不落 devkit 安装目录/声明业务仓（工件不得写回任何源仓）
  const stateReal = resolveStateReal(resolve(state));
  for (const root of allDevkitRoots()) {
    const rootReal = realpathNearestExisting(root).real;
    if (isInside(rootReal, stateReal) || isInside(stateReal, rootReal)) throw new Error(`--state 不得写入或覆盖 devkit 安装目录（${rootReal}）`);
  }
  const declaredRepo = recipe.declaredBuild?.repo;
  if (declaredRepo && existsSync(declaredRepo)) {
    const repoReal = realpathNearestExisting(declaredRepo).real;
    if (isInside(repoReal, stateReal)) throw new Error(`--state 解析到声明业务仓内（${repoReal}）：GUI 工件必须仓外`);
  }

  const budgetHistory = budgetHistoryArg ? realpathNearestExisting(resolve(budgetHistoryArg)).real : null;
  if (budgetHistory) {
    for (const root of [...allDevkitRoots(), ...(declaredRepo ? [declaredRepo] : [])]) {
      if (isInside(realpathNearestExisting(root).real, budgetHistory)) throw new UsageError('--budget-history 必须在业务仓与 devkit 安装目录之外');
    }
    guardOutPath(budgetHistory, [['recipe', recipeFile], ['budget-spec', budgetSpecArg]], 'gui --budget-history');
  }

  // live 前置：认证声明优先（blocked 交用户），再 SDK / puppeteer 运行时（前置错误）。
  const auth = authPrecondition({ authMode: process.env.MIDSCENE_MODEL_AUTH_MODE ?? null, name: process.env.MIDSCENE_MODEL_NAME ?? null, family: process.env.MIDSCENE_MODEL_FAMILY ?? null }, recipe);
  if (!auth.ok) {
    process.stderr.write('blocked: ' + auth.reason + '\n');
    process.exitCode = 3;
    return;
  }
  const pre = preflightSdk({ sdk, runtime });
  if (pre.problems.length) {
    process.stderr.write(pre.problems.map(p => '前置错误: ' + p).join('\n') + '\n');
    process.exitCode = 4;
    return;
  }

  let maxWallSeconds = recipe.model.maxWallSeconds;
  if (wallOverride !== undefined) maxWallSeconds = Number(wallOverride); // 已在用法阶段校验整数范围

  const attemptId = newAttemptId();
  const attemptDir = createAttemptDir(stateReal, attemptId);
  const startedAt = new Date();
  let budgetSpec = null, specError = null;
  try { if (budgetSpecArg) budgetSpec = readBoundedJson(resolve(budgetSpecArg), 'budget spec'); }
  catch (error) { specError = error.message; }
  const contextRoot = declaredRepo && existsSync(declaredRepo) ? declaredRepo : dirname(recipeFile);
  const budgetGuard = prepareExecution({ spec: budgetSpec, history: budgetHistory,
    remainingTokens: budgetSpec?.budgetTokens, brief: recipeText, context: recipe.context ?? {}, worktree: contextRoot,
    requiredModel: recipe.model.name, minCalls: recipe.model.maxAiOperations, requiresVision: true });
  if (specError) { budgetGuard.allowed = false; budgetGuard.reason = 'invalid-budget-spec'; budgetGuard.error = specError; }
  const guardFile = join(attemptDir, 'budget-guard.json');
  writeFileSync(guardFile, JSON.stringify(budgetGuard, null, 2) + '\n');
  if (budgetGuard.context) writeFileSync(join(attemptDir, 'context-manifest.json'), JSON.stringify(budgetGuard.context, null, 2) + '\n');
  if (!budgetGuard.allowed) {
    const failures = [`预算 blocked: ${budgetGuard.reason}${budgetGuard.error ? ': ' + budgetGuard.error : ''}`];
    const manifestFile = writeManifestOnce(attemptDir, { kind: 'gui-verification-v1', attemptId, status: 'blocked',
      startedAt: startedAt.toISOString(), failures, modelCalled: false, budget: budgetGuard,
      note: '执行前预算 guard：runner 未派发、无 CDP 连接；前置认证/SDK 检查仍保持原退出码含义' });
    if (json) process.stdout.write(JSON.stringify({ status: 'blocked', attemptId, manifestFile, failures, reason: budgetGuard.reason }, null, 2) + '\n');
    else say(failures[0] + '\nmanifest: ' + manifestFile);
    process.exitCode = 3;
    return;
  }
  // 已过预算再运行 SDK 的原有可加载性检查；转依赖/导出损坏仍保持前置错误退出 4。
  const loaded = preflightSdk({ sdk, runtime, load: true });
  if (loaded.problems.length) {
    const failures = loaded.problems.map(p => '前置错误: ' + p);
    const manifestFile = writeManifestOnce(attemptDir, { kind: 'gui-verification-v1', attemptId, status: 'blocked',
      failures, modelCalled: false, budget: { guardFile, reservedTokens: budgetGuard.reservedTokens }, preconditionError: true });
    process.stderr.write(failures.join('\n') + '\n');
    if (json) process.stdout.write(JSON.stringify({ status: 'blocked', manifestFile, failures, preconditionError: true }, null, 2) + '\n');
    process.exitCode = 4;
    return;
  }
  const jobFile = join(attemptDir, 'job.json');
  writeFileSync(jobFile, JSON.stringify({ recipe, attemptDir, attemptId, webRoot: pre.web.root, pptrRoot: pre.pptr.root, cdpUrl: cdp,
    budgetSpec, budgetHistory, contextRoot }, null, 2), { mode: 0o600 });

  const runnerPath = join(HERE, 'gui', 'runner.mjs');
  const runner = spawn(process.execPath, [runnerPath, jobFile], { cwd: attemptDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let runnerLog = '';
  const logFile = join(attemptDir, 'runner.log');
  writeFileSync(logFile, '');
  const captureLog = d => { appendFileSync(logFile, d); runnerLog = (runnerLog + d.toString()).slice(-400); };
  runner.stdout.on('data', captureLog);
  runner.stderr.on('data', captureLog);

  // maxWallSeconds：对 runner 子进程组的真实硬超时。TERM 的 KILL 宽限定时器在子进程退出时清理，不泄漏。
  let timedOut = false;
  let cancelled = false;
  let killTimer = null;
  let spawnError = null;
  const wallTimer = setTimeout(() => {
    timedOut = true;
    killGroup(runner.pid, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(runner.pid, 'SIGKILL'), 10_000);
  }, maxWallSeconds * 1000);
  const cancel = () => {
    cancelled = true;
    killGroup(runner.pid, 'SIGTERM');
    if (!killTimer) killTimer = setTimeout(() => killGroup(runner.pid, 'SIGKILL'), 10_000);
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let code;
  try {
    code = await childExit(runner);
  } catch (error) {
    spawnError = error; // spawn 失败（如 node 不可用）：结构化失败，不留悬挂定时器
  } finally {
    clearTimeout(wallTimer);
    if (killTimer) clearTimeout(killTimer);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    if (timedOut || cancelled) killGroup(runner.pid, 'SIGKILL'); // 组长退出也清掉残留子进程
  }
  const elapsedMs = Date.now() - startedAt.getTime();

  // 报告快照与模型观测（仓外 attempt 目录内收集；原文件即证据，不复制）
  const reportFiles = spawnError ? [] : listHtmlFiles(attemptDir).filter(f => f !== jobFile);
  const extracted = reportFiles.map(f => {
    const ex = extractFixtureFromHtml(readFileSync(f, 'utf8'), f);
    return { file: f, ex, parsed: ex.ok ? parseFixture(ex.fixture) : null };
  });
  const merged = mergeObservations(extracted.map(e => ({ parsed: e.parsed ?? { failures: e.ex.failures, anomalies: [], tasks: [] }, fixture: e.ex.fixture ?? { fixtureSchemaVersion: 1, scripts: [] } })));

  const resultFile = join(attemptDir, 'result.json');
  let result = null;
  if (existsSync(resultFile)) { try { result = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { result = { runner: 'error', status: 'failed', failure: 'result.json 不可解析' }; } }
  if (spawnError) result = { runner: 'error', status: 'failed', failure: `runner 派发失败: ${spawnError.message}` };

  // 严格判定（纯函数，测试直测）：unknown/缺报告/超预算/交叉核对缺失都不通过
  let { status, failures } = buildVerdict({ result, timedOut, reportCount: reportFiles.length, merged, recipe });
  if (cancelled) { failures.push('用户取消：runner 进程组已停止，不自动重试/恢复'); status = 'failed'; }

  const observed = merged.modelObservation;
  const budgetExceeded = observed.uniqueCalls > (recipe.model.maxModelRequestsObserved ?? Infinity);
  const manifest = {
    kind: 'gui-verification-v1',
    note: '独立 GUI 验证契约：不导入 source-tooling TaskStore；本 manifest 只声明本次 driver 实际执行与断言校验，不复用历史 GUI 动态证据',
    level: recipe.level, attemptId, startedAt: startedAt.toISOString(), elapsedMs,
    command: { bin: 'nuwax-forge', argv: ['gui', 'run', '--recipe', recipeArg, '--state', state, '--cdp', cdp] },
    recipe: { id: recipe.id, scenarioVersion: recipe.scenarioVersion, sha256: sha256String(recipeText), file: recipeFile },
    declaredBuild: recipe.declaredBuild, // 声明式，未验证；实际身份看 observedIdentity
    observedIdentity: result?.observedIdentity ?? null, // CDP Browser 版本/目标 URL(去敏感参数)/targetId/SDK 版本
    target: result?.target ?? null,
    loginPrecondition: result?.login ?? null,
    scenario: result?.scenario ?? null,
    restored: result?.restored ?? null,
    aiOperationsUsed: result?.aiOperationsUsed ?? 0,
    model: { ...(result?.model ?? {}), puppeteerRuntime: pre.pptr.version, authEnv: { authMode: pre.auth.authMode, name: pre.auth.name, family: pre.auth.family },
      observation: observed, observationBudget: recipe.model.maxModelRequestsObserved ?? null, observationBudgetExceeded: budgetExceeded,
      maxAiOperations: recipe.model.maxAiOperations, maxWallSeconds,
      note: 'maxAiOperations 是 driver 对 ai* 操作的硬中止；模型网络请求只有报告观测（下界/unknown），不做传输层硬计量；超预算/unknown 均不通过' },
    budget: { guardFile, reservedTokens: budgetGuard.reservedTokens, managed: true },
    artifacts: [{ file: 'job.json', sha256: sha256File(jobFile) },
      { file: 'budget-guard.json', sha256: sha256File(guardFile) },
      ...(existsSync(resultFile) ? [{ file: 'result.json', sha256: sha256File(resultFile) }] : []),
      ...reportFiles.map(f => ({ file: f.slice(attemptDir.length + 1), sha256: sha256File(f) }))],
    status, failures, timedOut, cancelled,
  };
  let settlement;
  try { settlement = settleExecution({ estimate: budgetGuard.estimate, actual: manifest, history: budgetHistory,
    inputs: [['recipe', recipeFile], ['budget-spec', budgetSpecArg]] }); }
  catch (error) { settlement = { chargedTokens: null, error: error.message }; }
  const reconcileFile = join(attemptDir, 'budget-reconcile.json');
  writeFileSync(reconcileFile, JSON.stringify(settlement, null, 2) + '\n');
  manifest.budget.reconcileFile = reconcileFile;
  manifest.budget.chargedTokens = settlement.chargedTokens;
  manifest.budget.verdict = settlement.reconciliation?.budget?.verdict ?? 'unknown';
  if (manifest.budget.verdict !== 'within') {
    failures.push(`实耗 token 预算 ${manifest.budget.verdict}：unknown/超限不通过`);
    if (status === 'passed') status = 'failed';
  }
  manifest.status = status;
  manifest.runnerSummary = runnerLog;
  manifest.artifacts.push({ file: 'budget-reconcile.json', sha256: sha256File(reconcileFile) });
  manifest.artifacts.push({ file: 'runner.log', sha256: sha256File(join(attemptDir, 'runner.log')) });
  const mFile = writeManifestOnce(attemptDir, manifest);

  if (json) process.stdout.write(JSON.stringify({ status, attemptId, manifestFile: mFile, failures, modelObservation: observed }, null, 2) + '\n');
  else say(`gui run 完成: status=${status} attempt=${attemptId}\nmanifest: ${mFile}\n模型观测: uniqueCalls=${observed.uniqueCalls} known=${observed.known}${observed.known ? '' : ` (${observed.reason})`}`);
  process.exitCode = status === 'passed' ? 0 : status === 'blocked' ? 3 : 1;
}
