// 只用离线 marker 和合成 SDK；不调用模型、不连接 GUI/CDP。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareExecution, contextManifest, settleExecution } from '../lib/budget/execution.mjs';

const bin = fileURLToPath(new URL('../bin/nuwax-devkit.mjs', import.meta.url));
const spec = over => ({ schemaVersion: 1, id: 'fixture-only', mode: 'model', model: { name: 'fixture' },
  taskKind: 'text-implementation', expectedCalls: 1, perCallOutputTokens: 10, initialContextTokens: 100,
  budgetTokens: 10000, ...over });
const guiRecipe = () => ({ guiRecipeSchemaVersion: 1, id: 'no-live-fixture', level: 'gui-product-scenario', scenarioVersion: 1,
  declaredBuild: { repo: '/no-real-business-repo', head: 'fixture-only' },
  target: { kind: 'guest', expectedOrigin: 'https://agent.example.com', type: 'webview' },
  ready: { titlePattern: '\\S' }, loginPrecondition: { selector: '.signed-in' }, selectorBindings: {},
  scenario: { steps: [{ id: 'visual', op: 'aiBoolean', instruction: '固定合成测试，不连接真实目标', expect: true }] },
  model: { authMode: 'siwc', name: 'fixture', family: 'fixture', maxAiOperations: 1, maxWallSeconds: 5 },
});
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-execution-budget-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('执行 guard 与既有算法共用：unknown、HIGH、实际上下文下界、no-model 欺骗均拦截', () => {
  const req = { spec: spec(), remainingTokens: 10000, brief: 'fixed' };
  assert.equal(prepareExecution(req).allowed, true);
  assert.equal(prepareExecution({ ...req, spec: spec({ perCallOutputTokens: undefined }) }).reason, 'prediction-unknown');
  assert.equal(prepareExecution({ ...req, spec: spec({ budgetTokens: 1 }) }).reason, 'prediction-high-exceeds-budget');
  assert.equal(prepareExecution({ ...req, spec: spec({ initialContextTokens: 0, budgetTokens: 200 }), brief: 'x'.repeat(1000) }).allowed, false);
  assert.equal(prepareExecution({ ...req, spec: spec({ mode: 'no-model', expectedCalls: 0 }) }).allowed, false);
  assert.equal(prepareExecution({ ...req, spec: spec({ initialContextTokens: -1 }) }).reason, 'invalid-budget-or-context');
});

test('context manifest 只给路径/hash/字节/token，超限、越界、凭据与 symlink 逃逸拒绝', t => {
  const dir = temp(t), wt = path.join(dir, 'wt'); fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'brief.txt'), 'bounded source');
  const got = contextManifest({ brief: 'task', worktree: wt, context: { contextFiles: ['brief.txt'] } });
  assert.equal(got.entries[1].path, fs.realpathSync(path.join(wt, 'brief.txt')));
  assert.match(got.entries[1].sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(got).includes('bounded source'));
  assert.throws(() => contextManifest({ brief: 'too long', context: { maxBytes: 2 } }), /超限/);
  assert.throws(() => contextManifest({ brief: '汉字'.repeat(10), context: { maxTokens: 2 } }), /HIGH/);
  fs.writeFileSync(path.join(wt, '.env'), 'secret fixture');
  assert.throws(() => contextManifest({ worktree: wt, context: { contextFiles: ['.env'] } }), /凭据/);
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside fixture');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(wt, 'link.txt'));
  assert.throws(() => contextManifest({ worktree: wt, context: { contextFiles: ['link.txt'] } }), /越界/);
});

test('结算保留 Claude 累计与 cache 原始数字，累计不记可消费 0、不落样本', t => {
  const history = path.join(temp(t), 'history.jsonl');
  const estimate = prepareExecution({ spec: spec(), remainingTokens: 10000, brief: 'task' }).estimate;
  const cumulative = settleExecution({ estimate, history, actual: { modelUsage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 8 } } });
  assert.equal(cumulative.chargedTokens, null);
  assert.equal(cumulative.reconciliation.actual.usage.inputTokens, 5);
  assert.equal(cumulative.reconciliation.actual.usageScope, 'session-cumulative');
  assert.equal(fs.existsSync(history), false);
  const segmented = settleExecution({ estimate, history, actual: { usageScope: 'run-segment', inputSemantics: 'excludes-cache',
    usage: { inputTokens: 5, outputTokens: 1, cachedReadTokens: 8 } } });
  assert.equal(segmented.chargedTokens, 14);
  assert.equal(fs.readFileSync(history, 'utf8').trim().split('\n').length, 1);
});

test('历史低耗校准不能压低真实交接输入的执行HIGH下界', t => {
  const history = path.join(temp(t), 'history.jsonl');
  fs.writeFileSync(history, JSON.stringify({ kind: 'token-budget-calibration', schemaVersion: 1, sampleVersion: 2,
    model: 'fixture', taskKind: 'text-implementation', inputSemantics: 'includes-cache', usageScope: 'run-segment',
    baselineExpected: { inputTokens: 1000, outputTokens: 10 }, actual: { inputTokens: 0, outputTokens: 0 } }) + '\n');
  const decision = prepareExecution({ spec: spec({ initialContextTokens: 0, budgetTokens: 100 }), history,
    remainingTokens: 10000, brief: 'x'.repeat(1000) });
  assert.equal(decision.allowed, false);
  assert.equal(decision.estimate.totalTokens.high, 0);
  assert.ok(decision.estimate.executionGuardHighTokens >= 334);
});

test('显式原生上下文附加到输入基线并按既有多轮模型计入 HIGH，省略保留旧 manifest', () => {
  const req = { spec: spec(), remainingTokens: 10000, brief: 'fixed' };
  const legacy = prepareExecution(req);
  assert.equal(Object.hasOwn(legacy.context, 'runtimeContextTokens'), false);
  const known = prepareExecution({ ...req, context: { runtimeContextTokens: 10000 } });
  assert.equal(known.allowed, false);
  assert.equal(known.reason, 'prediction-high-exceeds-budget');
  assert.equal(known.context.runtimeContextTokens, 10000);
  assert.equal(known.estimate.contextFloorTokens, legacy.context.highTokens + 10000);
  const repeated = { ...req, spec: spec({ expectedCalls: 3, perCallToolResultTokens: 100 }) };
  const before = prepareExecution(repeated);
  const after = prepareExecution({ ...repeated, context: { runtimeContextTokens: 500 } });
  assert.equal(after.estimate.baselineTokens.inputTokens.median - before.estimate.baselineTokens.inputTokens.median, 1500);
  for (const value of [null, -1, 0.1, '1000', 10000001]) {
    assert.equal(prepareExecution({ ...req, context: { runtimeContextTokens: value } }).reason, 'invalid-budget-or-context');
  }
  assert.equal(prepareExecution({ ...req, context: { runtimeContextTokens: 0 } }).reservedTokens, legacy.reservedTokens);
});

function guiFixture(t) {
  const dir = temp(t), marker = path.join(dir, 'sdk-loaded');
  const sdk = path.join(dir, 'sdk'), runtime = path.join(dir, 'runtime'), state = path.join(dir, 'state');
  fs.mkdirSync(sdk); fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@midscene/web', version: 'fixture', exports: { './puppeteer': { require: './fake.cjs' } } }));
  fs.writeFileSync(path.join(sdk, 'fake.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)},'loaded');exports.PuppeteerAgent=class {};`);
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'puppeteer-core', version: 'fixture', main: './fake.cjs' }));
  fs.writeFileSync(path.join(runtime, 'fake.cjs'), "exports.connect=async()=>{throw new Error('isolated fixture: no CDP connection attempted')};");
  const recipeFile = path.join(dir, 'recipe.json');
  fs.writeFileSync(recipeFile, JSON.stringify(guiRecipe()));
  const run = budgetSpec => {
    const argv = [bin, 'gui', 'run', '--recipe', recipeFile, '--state', state, '--sdk', sdk, '--runtime', runtime, '--cdp', 'http://127.0.0.1:19222', '--json'];
    if (budgetSpec !== undefined) {
      const specFile = path.join(dir, 'budget.json'); fs.writeFileSync(specFile, JSON.stringify(budgetSpec));
      argv.push('--budget-spec', specFile);
    }
    return spawnSync(process.execPath, argv, { env: { ...process.env, MIDSCENE_MODEL_AUTH_MODE: 'siwc', MIDSCENE_MODEL_NAME: 'fixture', MIDSCENE_MODEL_FAMILY: 'fixture' }, encoding: 'utf8', timeout: 10000 });
  };
  return { dir, marker, state, run };
}

test('GUI 真实入口：缺预算/unknown/HIGH超限在 SDK加载与runner派发之前阻断并留 manifest', t => {
  const f = guiFixture(t);
  for (const budgetSpec of [undefined, spec({ taskKind: 'gui-visual' }), spec({ taskKind: 'gui-visual', imageTokensPerCall: 10, budgetTokens: 1 })]) {
    const result = f.run(budgetSpec);
    assert.equal(result.status, 3, result.stderr);
    assert.equal(fs.existsSync(f.marker), false);
    const out = JSON.parse(result.stdout), manifest = JSON.parse(fs.readFileSync(out.manifestFile, 'utf8'));
    assert.equal(manifest.status, 'blocked');
    assert.equal(manifest.modelCalled, false);
    assert.equal(fs.existsSync(path.join(path.dirname(out.manifestFile), 'job.json')), false);
  }
});

test('GUI 预算放行后模拟runner故障：自动 reconcile 写 unknown，不调用模型/GUI', t => {
  const f = guiFixture(t);
  const result = f.run(spec({ taskKind: 'gui-visual', imageTokensPerCall: 100 }));
  assert.equal(result.status, 1, result.stderr);
  const out = JSON.parse(result.stdout), attempt = path.dirname(out.manifestFile);
  const settlement = JSON.parse(fs.readFileSync(path.join(attempt, 'budget-reconcile.json'), 'utf8'));
  assert.equal(settlement.chargedTokens, null);
  assert.equal(settlement.reconciliation.budget.verdict, 'unknown');
  assert.equal(JSON.parse(fs.readFileSync(out.manifestFile, 'utf8')).budget.verdict, 'unknown');
});

test('公开 run 入口实际执行受治理固定配方，输出有限摘要与仓外 manifest', t => {
  const dir = temp(t), project = path.join(dir, 'wt'), state = path.join(dir, 'new', 'state'); fs.mkdirSync(project);
  const brief = path.join(dir, 'brief.txt'), plan = path.join(dir, 'plan.json'); fs.writeFileSync(brief, 'fixed offline fixture');
  const marker = path.join(project, 'marker');
  fs.writeFileSync(plan, JSON.stringify({ taskKey: 'public-entry', mode: 'model', budget: { maxTokens: 10000, maxAttempts: 1 }, budgetSpec: spec(),
    assignments: [{ executor: 'fixture', role: 'check', command: [process.execPath, '-e',
      `require('node:fs').writeFileSync(process.argv[1], 'ok');require('node:fs').writeFileSync(process.argv[2], JSON.stringify({usage:{input_tokens:50,output_tokens:5}}))`, marker, '{stepArtifacts}/usage.json'] }] }));
  const result = spawnSync(process.execPath, [bin, 'run', '--plan', plan, '--project', project, '--state', state, '--brief-file', brief], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(out.budget.knownSpentTokens, 55);
  assert.equal(out.budgetPassed, true);
  assert.ok(out.artifacts.startsWith(fs.realpathSync(state) + path.sep));
  assert.ok(out.results[0].summary.length <= 400);
});

test('公开 run 无模型/无模型声明时fail closed，不能走legacy默认绕开guard', t => {
  const dir = temp(t), project = path.join(dir, 'wt'), state = path.join(dir, 'state'); fs.mkdirSync(project);
  const brief = path.join(dir, 'brief.txt'), plan = path.join(dir, 'plan.json'), marker = path.join(project, 'never');
  fs.writeFileSync(brief, 'fixed');
  fs.writeFileSync(plan, JSON.stringify({ taskKey: 'missing-declaration', assignments: [{ executor: 'fixture', role: 'check',
    command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'must not run')`] }] }));
  const result = spawnSync(process.execPath, [bin, 'run', '--plan', plan, '--project', project, '--state', state, '--brief-file', brief], { encoding: 'utf8' });
  assert.equal(result.status, 3, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'missing-execution-declaration');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(JSON.parse(result.stdout).entryFile), true);
});
