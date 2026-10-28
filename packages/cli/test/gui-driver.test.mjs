// GUI live driver 的离线反例测试：全部用合成数据 / 注入 fake 依赖，不需要 Midscene SDK、
// 不联网、不启动 GUI、不调模型。fake 注入与 runner 的真实适配实现**同一接口**
// （locateEditor 返回 {kind,read,focus}；keyboard.insertText/selectAllDelete 需先 focus），
// 不把实现镜像成假 value 求绿。覆盖：配方契约（含 webview/安装身份）、目标锁定、报告提取与
// 计量合并（正本 known 传递/缺 retry/预算）、buildVerdict 严格判定、场景引擎（真实输入语义、
// Boolean false、条件恢复、并发不覆盖、身份漂移、ai 硬中止）、CDP 端点校验、证据一次性写入、
// CLI 结构化失败（缺 SDK→4、缺认证→3、launch-config unsupported→2、非回环 CDP→2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGuiRecipe } from '../lib/gui/contract.mjs';
import { lockTarget, checkReady } from '../lib/gui/target.mjs';
import { extractFixtureFromHtml, mergeObservations, buildVerdict } from '../lib/gui/report.mjs';
import { parseFixture } from '@nuwax-ai/devkit-contracts/gui/midscene-report.mjs';
import { runScenarioSteps } from '../lib/gui/scenario.mjs';
import { preflightSdk, authPrecondition, isAuthError } from '../lib/gui/preflight.mjs';
import { createAttemptDir, newAttemptId, writeManifestOnce } from '../lib/gui/evidence.mjs';
import { parseCdpEndpoint } from '../lib/gui.mjs';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(pkgRoot, 'bin', 'nuwax-devkit.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nuwax-gui-test-'));
const EDITOR_SEL = 'div[contenteditable="true"][class*="mention-editor"]';

// ---- 合成 GUI 配方（对齐安装版实测：webview guest + contenteditable 编辑器 + 安装身份） ----
const recipe = () => ({
  guiRecipeSchemaVersion: 1,
  id: 'synthetic-guest-draft',
  level: 'gui-product-scenario',
  scenarioVersion: 1,
  declaredBuild: { installVersion: '3.0.23', asarSha256: 'a'.repeat(64) },
  target: { kind: 'guest', expectedOrigin: 'https://agent.example.com', urlPattern: '^https://agent\\.example\\.com/home', type: 'webview' },
  ready: { titlePattern: '\\S', settleMs: 0 },
  loginPrecondition: { selector: EDITOR_SEL },
  selectorBindings: { draftInput: EDITOR_SEL },
  scenario: { steps: [
    { id: 'initial-empty', op: 'domValueEquals', selector: 'draftInput', expected: '' },
    { id: 'fill-marker', op: 'fill', selector: 'draftInput', value: 'NUWAX_PROBE_X' },
    { id: 'dom-verify', op: 'domValueEquals', selector: 'draftInput', expected: 'NUWAX_PROBE_X' },
    { id: 'visual-verify', op: 'aiBoolean', expect: true, instruction: '页面上是否显示 NUWAX_PROBE_X？' },
    { id: 'cleanup-clear', op: 'fill', selector: 'draftInput', value: '' },
    { id: 'restored-empty', op: 'domValueEquals', selector: 'draftInput', expected: '' },
  ] },
  model: { authMode: 'siwc', name: 'gpt-6.1-sol', family: 'gpt-6', maxAiOperations: 1, maxModelRequestsObserved: 2, maxWallSeconds: 60 },
});

// ---- 配方契约 ----
test('GUI 配方契约：webview/安装身份通过；占位符/错 type/缺身份/散文绑定结构化拒绝', () => {
  assert.equal(validateGuiRecipe(recipe()), null);
  const src = recipe(); src.declaredBuild = { repo: '/tmp/synthetic-repo', head: 'deadbeef' };
  assert.equal(validateGuiRecipe(src), null); // 源码身份也合法
  const bad1 = recipe(); bad1.selectorBindings = { draftInput: 'note: 运行前现场确认' };
  assert.ok(validateGuiRecipe(bad1).some(p => p.includes('选择器')));
  const bad2 = recipe(); bad2.target.type = 'iframe';
  assert.ok(validateGuiRecipe(bad2).some(p => p.includes('page/webview')));
  const bad3 = recipe(); bad3.declaredBuild = { repo: 'x' };
  assert.ok(validateGuiRecipe(bad3).some(p => p.includes('declaredBuild')));
  const bad4 = recipe(); delete bad4.loginPrecondition;
  assert.ok(validateGuiRecipe(bad4).some(p => p.includes('loginPrecondition')));
  const bad5 = recipe(); bad5.scenario.steps = [{ id: 'q', op: 'aiQuery', instruction: 'x' }];
  assert.ok(validateGuiRecipe(bad5).some(p => p.includes('明确拒绝')));
});

// ---- 目标锁定（真实类型反例：安装版 shell=file://page，guest=webview） ----
const cdpTargets = (list) => list.map(([type, url], i) => ({ targetId: 't' + i, type, url, title: 'T' + i }));
const REAL_LIKE = [
  ['page', 'file:///Applications/Nuwax.app/Contents/Resources/app.asar/dist/index.html'],
  ['webview', 'https://agent.example.com/home'],
];

test('目标锁定：webview guest 唯一匹配；多候选/找不到/类型不符（page 同 origin）/shell 冒充都失败', () => {
  const spec = { kind: 'guest', expectedOrigin: 'https://agent.example.com', type: 'webview' };
  const ok = lockTarget(spec, cdpTargets(REAL_LIKE));
  assert.equal(ok.ok, true);
  assert.equal(ok.target.targetId, 't1');
  // 类型声明为 page：同 origin 的 webview 不匹配，且 reason 点名类型不符候选
  const wrongType = lockTarget({ ...spec, type: 'page' }, cdpTargets(REAL_LIKE));
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.reason.includes('类型不符'));
  const multi = lockTarget(spec, cdpTargets([['webview', 'https://agent.example.com/a'], ['webview', 'https://agent.example.com/b']]));
  assert.equal(multi.ok, false); assert.ok(multi.reason.includes('歧义'));
  const none = lockTarget(spec, cdpTargets([['webview', 'https://evil.example.com/a']]));
  assert.equal(none.ok, false); assert.ok(none.reason.includes('不回落'));
  // shell 页（file:// page）不能冒充 guest
  const shellOnly = lockTarget(spec, cdpTargets([REAL_LIKE[0]]));
  assert.equal(shellOnly.ok, false);
  assert.equal(lockTarget({ kind: 'shell', urlPattern: '^file://' }, cdpTargets(REAL_LIKE)).ok, true);
  assert.equal(lockTarget(spec, null).ok, false);
  assert.equal(lockTarget({ ...spec, type: 'iframe' }, cdpTargets(REAL_LIKE)).ok, false);
});

test('就绪判定：空标题（加载页）不算就绪', () => {
  assert.equal(checkReady({ titlePattern: '\\S' }, '').ok, false);
  assert.equal(checkReady({ titlePattern: '\\S' }, null).ok, false);
  assert.equal(checkReady({ titlePattern: '\\S' }, '女娲 3.0').ok, true);
});

// ---- 场景引擎：与 runner 同接口的 contenteditable 行为模拟 ----
function fakeEditorHost({ initial = '', duplicates = 1, visible = true } = {}) {
  const state = { buffer: initial, focused: false };
  const page = {
    locateEditor: async sel => {
      if (duplicates !== 1) throw new Error(`选择器 ${sel} 匹配 ${duplicates} 个元素（需唯一）`);
      if (!visible) throw new Error(`选择器 ${sel} 元素不可见`);
      return {
        kind: 'contenteditable',
        read: async () => state.buffer,
        focus: async () => { state.focused = true; },
      };
    },
    mutate: text => { state.buffer = text; }, // 模拟用户/页面并发修改
  };
  const keyboard = {
    insertText: async text => { if (!state.focused) throw new Error('insertText 需要先 focus'); state.buffer += text; },
    selectAllDelete: async () => { if (!state.focused) throw new Error('selectAllDelete 需要先 focus'); state.buffer = ''; },
  };
  return { page, keyboard, state };
}

const run = (host, agent, extra = {}) => runScenarioSteps({
  steps: recipe().scenario.steps, bindings: recipe().selectorBindings,
  page: host.page, keyboard: host.keyboard, agent, maxAiOperations: 1,
  expectedOrigin: 'https://agent.example.com',
  checkTargetIdentity: extra.checkTargetIdentity ?? (async () => ({ origin: 'https://agent.example.com' })),
});

test('场景引擎：完整通过（真实输入语义：focus+全选删+insertText；恢复为条件恢复）', async () => {
  const host = fakeEditorHost({ initial: '' });
  const r = await run(host, { aiBoolean: async () => true });
  assert.equal(r.status, 'passed');
  assert.equal(r.aiOperationsUsed, 1);
  assert.equal(host.state.buffer, '');
  assert.equal(r.restoreOk, true);
});

test('场景引擎反例：aiBoolean=false 即失败；失败后仍条件恢复清空', async () => {
  const host = fakeEditorHost({ initial: '' });
  const r = await run(host, { aiBoolean: async () => false });
  assert.equal(r.status, 'failed');
  assert.ok(r.failure.includes('aiBoolean 实际值 false'));
  assert.equal(host.state.buffer, '');
});

test('场景引擎反例：模型调用期间内容被并发修改 → 不覆盖他人输入，整体 failed', async () => {
  const host = fakeEditorHost({ initial: '' });
  const steps = recipe().scenario.steps.slice(0, 4); // 到 visual-verify 为止（不含自带 cleanup）
  const r = await runScenarioSteps({ steps, bindings: recipe().selectorBindings, page: host.page, keyboard: host.keyboard,
    agent: { aiBoolean: async () => { host.page.mutate('USER_TYPED_SOMETHING'); return true; } },
    maxAiOperations: 1, expectedOrigin: 'https://agent.example.com', checkTargetIdentity: async () => ({ origin: 'https://agent.example.com' }) });
  assert.equal(r.status, 'failed');
  assert.ok(r.failure.includes('并发') || r.failure.includes('不覆盖'));
  assert.equal(host.state.buffer, 'USER_TYPED_SOMETHING'); // 他人输入原样保留
});

test('场景引擎反例：初始非空（前提不成立）失败且不清空原草稿（未成功写入不恢复不破坏）', async () => {
  const host = fakeEditorHost({ initial: '用户已有草稿' });
  const r = await run(host, { aiBoolean: async () => true });
  assert.equal(r.status, 'failed');
  assert.ok(r.failure.includes('initial-empty'));
  assert.equal(r.restoreAttempted, false); // 没有任何成功 fill → 不进入恢复
  assert.equal(host.state.buffer, '用户已有草稿');
});

test('场景引擎反例：aiBoolean 前后目标身份漂移即失败（不在未知页面继续操作）', async () => {
  const host = fakeEditorHost({ initial: '' });
  let calls = 0;
  const r = await run(host, { aiBoolean: async () => true }, { checkTargetIdentity: async () => ({ origin: ++calls === 1 ? 'https://agent.example.com' : 'https://evil.example.com' }) });
  assert.equal(r.status, 'failed');
  assert.ok(r.failure.includes('目标身份变化'));
  assert.equal(host.state.buffer, ''); // 身份漂移发生在模型调用后：条件恢复仍执行
});

test('场景引擎：多元素匹配/不可见编辑器结构化失败；ai* 超硬 cap 拦截；无 agent 失败', async () => {
  const dup = fakeEditorHost({ duplicates: 2 });
  assert.equal((await run(dup, { aiBoolean: async () => true })).status, 'failed');
  const invis = fakeEditorHost({ visible: false });
  assert.equal((await run(invis, { aiBoolean: async () => true })).status, 'failed');
  const two = await runScenarioSteps({ steps: [
    { id: 'v1', op: 'aiBoolean', expect: true, instruction: 'a?' },
    { id: 'v2', op: 'aiBoolean', expect: true, instruction: 'b?' },
  ], page: fakeEditorHost().page, keyboard: fakeEditorHost().keyboard, agent: { aiBoolean: async () => true }, maxAiOperations: 1, expectedOrigin: null, checkTargetIdentity: null });
  assert.equal(two.status, 'failed'); assert.ok(two.failure.includes('maxAiOperations')); assert.equal(two.aiOperationsUsed, 1);
  const noAgent = await run(fakeEditorHost(), null);
  assert.equal(noAgent.status, 'failed'); assert.ok(noAgent.failure.includes('无可用视觉 agent'));
});

// ---- 报告提取与计量合并 ----
const reportHtml = (title, taskOutput, usageObj, gid = 'g1') => `<html><head><title>${title}</title></head><body>
<script type="midscene_web_dump" data-group-id="${gid}">${JSON.stringify({ sdkVersion: '1.17.1', executions: [{ id: 'e1', tasks: [{ taskId: 'task-1', type: 'Insight', subType: 'Boolean', status: 'finished', output: taskOutput, usage: usageObj }] }] })}</script>
</body></html>`;
const usageOk = (id) => ({ _midscene_call_id: id, prompt_tokens: 3600, completion_tokens: 100, total_tokens: 3700, retry_count: 0 });
const parseOf = html => { const ex = extractFixtureFromHtml(html); return { ex, parsed: ex.ok ? parseFixture(ex.fixture) : { failures: ex.failures, anomalies: [], tasks: [] } }; };
const mergedOf = (...htmls) => mergeObservations(htmls.map(h => { const { ex, parsed } = parseOf(h); return { parsed, fixture: ex.fixture ?? { fixtureSchemaVersion: 1, scripts: [] } }; }));

test('报告提取与合并：正常 known；同快照复制两份 callId 去重不重复计数', () => {
  const m = mergedOf(reportHtml('Nuwax', true, usageOk('c1')));
  assert.equal(m.modelObservation.known, true);
  assert.deepEqual(m.booleanTaskOutputs, [true]);
  const dup = mergedOf(reportHtml('Nuwax', true, usageOk('c1')), reportHtml('Nuwax', true, usageOk('c1')));
  assert.equal(dup.modelObservation.uniqueCalls, 1);
  assert.equal(dup.modelObservation.totalTokens, 3700);
});

test('计量合并反例：缺 retry_count / 负数 / 非整数 usage → known=false（正本语义传递，不伪记完整）', () => {
  const noRetry = { _midscene_call_id: 'c1', prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  const m1 = mergedOf(reportHtml('Nuwax', true, noRetry));
  assert.equal(m1.modelObservation.known, false);
  assert.ok(m1.modelObservation.reason.includes('缺字段') || m1.modelObservation.reason.includes('不完整'));
  const negative = mergedOf(reportHtml('Nuwax', true, { ...usageOk('c1'), total_tokens: -5 }));
  assert.equal(negative.modelObservation.known, false);
  const frac = mergedOf(reportHtml('Nuwax', true, { ...usageOk('c1'), prompt_tokens: 1.5 }));
  assert.equal(frac.modelObservation.known, false);
});

test('计量合并反例：retry / 空报告 / 损坏 JSON / 同 callId 冲突 / Boolean 跨快照冲突', () => {
  const mRetry = mergedOf(reportHtml('Nuwax', true, { ...usageOk('c2'), retry_count: 1 }));
  assert.equal(mRetry.modelObservation.known, false);
  assert.equal(mRetry.modelObservation.retryObserved, true);
  assert.equal(mRetry.modelObservation.uniqueCalls, 1); // 下界不是 0
  const empty = extractFixtureFromHtml('<html><title>x</title><body></body></html>');
  assert.equal(empty.ok, false); assert.ok(empty.failures[0].includes('空报告'));
  assert.equal(extractFixtureFromHtml('').ok, false);
  const corrupt = extractFixtureFromHtml('<html><title>x</title><script type="midscene_web_dump" data-group-id="g">{oops</script></html>');
  assert.equal(corrupt.ok, false);
  const mConflict = mergedOf(reportHtml('Nuwax', true, usageOk('c1')), reportHtml('Nuwax', true, { ...usageOk('c1'), total_tokens: 9999 }));
  assert.equal(mConflict.modelObservation.known, false);
  const mBoolConflict = mergedOf(reportHtml('Nuwax', true, usageOk('c1'), 'g1'), reportHtml('Nuwax', false, usageOk('c1'), 'g1'));
  assert.equal(mBoolConflict.modelObservation.known, false); // 正本已知异常(任务终值冲突)也必须传递为 unknown
});

// ---- buildVerdict 严格判定 ----
const verdictOf = (over = {}) => buildVerdict({
  result: { status: 'passed', scenario: { steps: [{ id: 'v', op: 'aiBoolean', actual: true, expect: true }] } },
  timedOut: false, reportCount: 1,
  merged: { modelObservation: { known: true, uniqueCalls: 1, reason: null }, booleanTaskOutputs: [true], anomalies: [], failures: [] },
  recipe: recipe(), ...over,
});

test('buildVerdict：正常通过；unknown/缺报告/超观测预算/aiBoolean 无交叉核对均不通过', () => {
  assert.equal(verdictOf().status, 'passed');
  assert.equal(verdictOf({ merged: { modelObservation: { known: false, uniqueCalls: 1, reason: '存在缺字段的 usage' }, booleanTaskOutputs: [true], anomalies: [], failures: [] } }).status, 'failed');
  assert.equal(verdictOf({ reportCount: 0 }).status, 'failed');
  assert.equal(verdictOf({ merged: { modelObservation: { known: true, uniqueCalls: 3, reason: null }, booleanTaskOutputs: [true], anomalies: [], failures: [] } }).status, 'failed'); // 超预算 2
  assert.equal(verdictOf({ merged: { modelObservation: { known: true, uniqueCalls: 1, reason: null }, booleanTaskOutputs: [false], anomalies: [], failures: [] } }).status, 'failed'); // 值无对应
});

test('buildVerdict：多个 aiBoolean 步骤必须逐一交叉核对，报告终态数少于步骤数不通过', () => {
  const twoSteps = { status: 'passed', scenario: { steps: [
    { id: 'v1', op: 'aiBoolean', actual: true, expect: true },
    { id: 'v2', op: 'aiBoolean', actual: false, expect: false },
  ] } };
  const ok = verdictOf({ result: twoSteps, merged: { modelObservation: { known: true, uniqueCalls: 2, reason: null }, booleanTaskOutputs: [true, false], anomalies: [], failures: [] } });
  assert.equal(ok.status, 'passed');
  const missing = verdictOf({ result: twoSteps, merged: { modelObservation: { known: true, uniqueCalls: 2, reason: null }, booleanTaskOutputs: [true], anomalies: [], failures: [] } });
  assert.equal(missing.status, 'failed');
  assert.ok(missing.failures.some(f => f.includes('v2')));
  assert.ok(missing.failures.some(f => f.includes('少于')));
});

// ---- CDP 端点校验 ----
test('CDP 端点：仅 http + 本机回环 + 整数端口；其余拒绝', () => {
  assert.deepEqual(parseCdpEndpoint('http://127.0.0.1:19222'), { ok: true, endpoint: 'http://127.0.0.1:19222' });
  assert.equal(parseCdpEndpoint('http://localhost:19222').ok, true);
  assert.equal(parseCdpEndpoint('http://[::1]:19222').ok, true);
  for (const bad of ['http://0.0.0.0:9222', 'http://192.168.1.5:9222', 'ws://127.0.0.1:9222', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'not-a-url', '']) {
    assert.equal(parseCdpEndpoint(bad).ok, false, bad);
  }
});

// ---- 前置/认证/证据 ----
test('SDK 前置：缺 SDK/runtime 给结构化错误与修复指引（不联网，不硬编码本机路径）', () => {
  const pre = preflightSdk({ sdk: undefined, runtime: undefined, env: {} });
  assert.ok(pre.problems.length >= 1);
  assert.ok(pre.problems.some(p => p.includes('--sdk')));
  assert.ok(pre.problems.every(p => !p.includes('/Users/apple/workspace/nuwax-client')));
});

test('认证前置：非 siwc / 缺模型声明 → blocked；认证类错误识别', () => {
  assert.equal(authPrecondition({ authMode: 'openai', name: 'x', family: 'y' }, recipe()).blocked, true);
  assert.equal(authPrecondition({ authMode: 'siwc', name: null, family: null }, recipe()).blocked, true);
  assert.equal(authPrecondition({ authMode: 'siwc', name: 'gpt-6.1-sol', family: 'gpt-6' }, recipe()).ok, true);
  assert.equal(isAuthError(new Error('SIWC credential expired')), true);
  assert.equal(isAuthError(new Error('Timeout')), false);
});

test('证据目录：attempt 不覆盖、manifest 只写一次', () => {
  const dir = tmp();
  const id = newAttemptId();
  createAttemptDir(dir, id);
  assert.throws(() => createAttemptDir(dir, id), /拒绝覆盖/);
  const a1 = createAttemptDir(dir, newAttemptId());
  writeManifestOnce(a1, { x: 1 });
  assert.throws(() => writeManifestOnce(a1, { x: 2 }), /拒绝重复写入/);
});

// ---- CLI 层（无 SDK 环境，真实子进程） ----
const AUTH_ENV = { MIDSCENE_MODEL_AUTH_MODE: 'siwc', MIDSCENE_MODEL_NAME: 'gpt-6.1-sol', MIDSCENE_MODEL_FAMILY: 'gpt-6' };

test('CLI：默认命令不受影响；gui 缺参/launch-config unsupported/非回环 CDP → 用法错误 2', () => {
  assert.equal(spawnSync(process.execPath, [bin, 'help']).status, 0);
  assert.equal(spawnSync(process.execPath, [bin, 'doctor']).status, 0);
  assert.equal(spawnSync(process.execPath, [bin, 'gui']).status, 2);
  assert.equal(spawnSync(process.execPath, [bin, 'gui', 'run']).status, 2);
  const state = tmp();
  const recipeFile = path.join(state, 'recipe.json');
  fs.writeFileSync(recipeFile, JSON.stringify(recipe()));
  const lc = spawnSync(process.execPath, [bin, 'gui', 'run', '--recipe', recipeFile, '--state', state, '--launch-config', 'x.json']);
  assert.equal(lc.status, 2);
  assert.ok(lc.stderr.toString().includes('unsupported'));
  const remote = spawnSync(process.execPath, [bin, 'gui', 'run', '--recipe', recipeFile, '--state', state, '--cdp', 'http://192.168.1.5:9222']);
  assert.equal(remote.status, 2);
  assert.ok(remote.stderr.toString().includes('回环'));
  const badWall = spawnSync(process.execPath, [bin, 'gui', 'run', '--recipe', recipeFile, '--state', state, '--cdp', 'http://127.0.0.1:19222', '--max-wall-seconds', 'abc']);
  assert.equal(badWall.status, 2);
});

test('CLI：gui run 缺 SDK → 4；缺认证声明 → 3（都在派发 runner 之前，不联网不拉依赖）', () => {
  const state = tmp();
  const recipeFile = path.join(state, 'recipe.json');
  fs.writeFileSync(recipeFile, JSON.stringify(recipe()));
  const env = { ...process.env, ...AUTH_ENV, NUWAX_MIDSCENE_SDK: '', NUWAX_MIDSCENE_PUPPETEER: '' };
  const missing = spawnSync(process.execPath, [bin, 'gui', 'run', '--recipe', recipeFile, '--state', state, '--cdp', 'http://127.0.0.1:19222'], { env });
  assert.equal(missing.status, 4);
  assert.ok(missing.stderr.toString().includes('--sdk'));
  const env2 = { ...process.env, MIDSCENE_MODEL_AUTH_MODE: '', MIDSCENE_MODEL_NAME: '', MIDSCENE_MODEL_FAMILY: '' };
  delete env2.NUWAX_MIDSCENE_SDK; delete env2.NUWAX_MIDSCENE_PUPPETEER;
  const noAuth = spawnSync(process.execPath, [bin, 'gui', 'run', '--recipe', recipeFile, '--state', state, '--cdp', 'http://127.0.0.1:19222'], { env: env2 });
  assert.equal(noAuth.status, 3);
  assert.ok(noAuth.stderr.toString().includes('blocked'));
});

// ---- 真实序列化边界 + 真实 Puppeteer API 面（live-01 实测回归） ----
// fake 复刻浏览器执行环境：evaluate 把函数 toString 后重建（闭包丢失，只有显式实参可用），
// document 由 fake 提供（浏览器全局）；keyboard 只暴露实测存在的 Puppeteer 方法（无 insertText）。
import { makePageAdapter, makeKeyboardAdapter } from '../lib/gui/page-adapter.mjs';

function fakePuppeteerEnv({ matches = 1, visible = true, kind = 'contenteditable' } = {}) {
  const state = { buffer: '', focused: false, typed: [], selectionActive: false };
  const el = {
    tagName: 'DIV', isContentEditable: kind === 'contenteditable',
    get textContent() { return state.buffer; }, set textContent(v) { state.buffer = v; },
    get value() { return kind === 'contenteditable' ? undefined : state.buffer; }, set value(v) { state.buffer = v; },
    get offsetParent() { return visible ? {} : null; },
    select() { state.selectionActive = true; },
    setSelectionRange(a, b) { if (a === 0) state.selectionActive = true; },
  };
  const handle = {
    focus: async () => { state.focused = true; },
    evaluate: async (fn, ...args) => {
      const revived = eval('(' + fn.toString() + ')'); // 序列化边界：闭包变量不复存在
      const prevDocument = globalThis.document, prevGetSelection = globalThis.getSelection;
      globalThis.document = {
        querySelectorAll: () => Array.from({ length: matches }),
        createRange: () => ({ selectNodeContents: () => { state.selectionActive = true; } }),
      };
      globalThis.getSelection = () => ({ removeAllRanges: () => {}, addRange: () => {} });
      try { return await revived(el, ...args); } finally { globalThis.document = prevDocument; globalThis.getSelection = prevGetSelection; }
    },
  };
  const keyboard = { // 实测 puppeteer-core 25.16.0 CDPKeyboard：down/up/sendCharacter/type/press，无 insertText
    down: async () => {}, up: async () => {},
    // 真实键盘语义：Backspace 有选区=全删，无选区=只删最后一字（macOS Electron guest 实测残留根因）
    press: async key => {
      if (key !== 'Backspace') return;
      if (state.selectionActive) { state.buffer = ''; state.selectionActive = false; }
      else state.buffer = state.buffer.slice(0, -1);
    },
    type: async text => { if (!state.focused) throw new Error('keyboard.type 需要先 focus'); state.typed.push(text); state.buffer += text; },
    sendCharacter: async () => {},
  };
  const page = { $: async sel => (matches > 0 ? handle : null), keyboard };
  return { page, state };
}

test('page-adapter：evaluate 序列化边界下 selector 必须走实参（闭包捕获=ReferenceError 回归）', async () => {
  const { page, state } = fakePuppeteerEnv({});
  const adapter = makePageAdapter(page);
  const editor = await adapter.locateEditor('div[contenteditable="true"]');
  assert.equal(editor.kind, 'contenteditable');
  assert.equal(await editor.read(), '');
  await editor.focus();
  const kb = makeKeyboardAdapter(page, adapter);
  await kb.insertText('NUWAX_PROBE_X'); // 内部必须是 keyboard.type（真实 API），不是不存在的 insertText
  assert.deepEqual(state.typed, ['NUWAX_PROBE_X']);
  await kb.selectAllDelete();
  assert.equal(state.buffer, '');
});

test('page-adapter 反例：多匹配/不可见/找不到元素结构化失败（同样在序列化边界下）', async () => {
  const multi = fakePuppeteerEnv({ matches: 2 });
  await assert.rejects(() => makePageAdapter(multi.page).locateEditor('x'), /匹配 2 个元素/);
  const invis = fakePuppeteerEnv({ visible: false });
  await assert.rejects(() => makePageAdapter(invis.page).locateEditor('x'), /不可见/);
  const none = fakePuppeteerEnv({ matches: 0 });
  await assert.rejects(() => makePageAdapter(none.page).locateEditor('x'), /找不到元素/);
});

test('buildVerdict：result.scenario.failure 必须进 failures（不被"缺报告"掩盖真实原因）', () => {
  const v = buildVerdict({
    result: { status: 'failed', scenario: { failure: '步骤 visual-verify: 执行异常 host.mutate is not a function' }, steps: [] },
    timedOut: false, reportCount: 0,
    merged: { modelObservation: { known: false, uniqueCalls: 0, reason: '报告中没有 usage 观测' }, booleanTaskOutputs: [], anomalies: [], failures: [] },
    recipe: recipe(),
  });
  assert.equal(v.status, 'failed');
  assert.ok(v.failures.some(f => f.includes('场景失败') && f.includes('host.mutate')));
  assert.ok(v.failures.some(f => f.includes('缺报告')));
});

test('page-adapter：selectAllDelete 用 Range 选区+Backspace 全删（非快捷键；无选区时 Backspace 只删末字的真实语义下仍全清）', async () => {
  const { page, state } = fakePuppeteerEnv({});
  const adapter = makePageAdapter(page);
  const editor = await adapter.locateEditor('div[contenteditable="true"]');
  const kb = makeKeyboardAdapter(page, adapter);
  await editor.focus();
  await kb.insertText('NUWAX_GUI_PROBE_9F2K');
  assert.equal(state.buffer, 'NUWAX_GUI_PROBE_9F2K');
  await kb.selectAllDelete();
  assert.equal(state.buffer, ''); // Range 选区生效：多字符全删，无 44 字类残留
  // 反例语义：没有选区时 Backspace 只删末字（真实键盘行为，正是旧快捷键方案残留的根因）
  state.buffer = 'AB';
  await page.keyboard.press('Backspace');
  assert.equal(state.buffer, 'A');
});

test('page-adapter 反例：未 focus 任何编辑器时 selectAllDelete 拒绝执行（不在 body 上盲按）', async () => {
  const { page } = fakePuppeteerEnv({});
  const adapter = makePageAdapter(page);
  const kb = makeKeyboardAdapter(page, adapter);
  await assert.rejects(() => kb.selectAllDelete(), /无活动编辑器|先 focus/);
});

test('报告提取：普通 JS script 内的假 dump 模板字面量不被解析；只认真实标签；真实坏 JSON 仍 fail', () => {
  const usageObj = { _midscene_call_id: 'c1', prompt_tokens: 3720, completion_tokens: 44, total_tokens: 3764, retry_count: 1 };
  const realDump = JSON.stringify({ sdkVersion: '1.17.1', executions: [{ id: 'e1', tasks: [{ taskId: 'task-1', type: 'Insight', subType: 'Boolean', status: 'finished', output: true, usage: usageObj }] }] });
  const html = `<html><head><title>报告</title></head><body>
<script>const tpl = \`<script type="midscene_web_dump">{"broken": true}<\\/script>\`; const x = 1;</script>
<script type='midscene_web_dump' data-group-id='g1'>${realDump}</script>
</body></html>`;
  const ex = extractFixtureFromHtml(html);
  assert.equal(ex.ok, true);
  assert.equal(ex.fixture.scripts.length, 1); // 只解析 1 个真实 dump，模板字面量被整体跳过
  assert.equal(ex.fixture.scripts[0].attributes['data-group-id'], 'g1'); // 单引号 attrs 也认
  const parsed = parseFixture(ex.fixture);
  assert.equal(parsed.ok, true);
  const merged = mergeObservations([{ parsed, fixture: ex.fixture }]);
  assert.deepEqual(merged.booleanTaskOutputs, [true]);
  assert.equal(merged.modelObservation.known, false); // retry_count=1：真重试，保守 unknown（不伪造零重试）
  assert.equal(merged.modelObservation.retryObserved, true);
  // 真实坏 JSON 仍 fail
  const badHtml = '<html><title>t</title><script type="midscene_web_dump" data-group-id="g">{oops</script></html>';
  assert.equal(extractFixtureFromHtml(badHtml).ok, false);
});
