import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS, LEVEL_IDS, levelById } from '../gui/levels.mjs';
import { parseFixture, evaluateProduct } from '../gui/midscene-report.mjs';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonical = () => fs.readFileSync(path.join(pkg, 'schemas', 'verification-v1.schema.json'));
const stackCopy = path.resolve(pkg, '../nuwax-stack/skills/nuwax-stack/references/verification-v1.schema.json');

test('verification-v1 正本可解析且保留 v1 必填面', () => {
  const schema = JSON.parse(canonical().toString('utf8'));
  assert.equal(schema.title, 'Nuwax verification evidence v1');
  assert.deepEqual(schema.required,
    ['schemaVersion', 'kind', 'recipe', 'recipePath', 'level', 'passed', 'source', 'environment', 'predicates', 'stages', 'artifacts', 'command']);
  assert.equal(schema.properties.source.required.includes('inputDigest'), true);
});

test('stack 技能副本与 contracts 正本字节一致（单正本防漂移）', () => {
  assert.equal(fs.existsSync(stackCopy), true, 'stack 自包含副本应存在于 monorepo');
  assert.ok(canonical().equals(fs.readFileSync(stackCopy)), '字节漂移：运行 npm run contracts:sync');
});

test('level 边界：source-tooling 已实现；GUI 两级 live driver 已实现（真实产品场景待独立验收）', () => {
  assert.deepEqual(LEVEL_IDS, ['source-tooling', 'gui-toolchain-smoke', 'gui-product-scenario']);
  assert.equal(levelById('source-tooling').status, 'implemented');
  assert.equal(levelById('gui-toolchain-smoke').status, 'optional-live-driver');
  assert.equal(levelById('gui-product-scenario').status, 'optional-live-driver');
  assert.ok(levelById('gui-product-scenario').canClaim[0].includes('live driver 已实现'));
  const product = levelById('gui-product-scenario');
  const joined = product.requires.join(';');
  for (const keyword of ['false 即失败', 'finished', 'unknown', 'origin', '登录']) assert.ok(joined.includes(keyword));
  assert.ok(product.cannotClaim.some(c => c.includes('复用')));
});

// ---- 合成 fixture 反例（全部虚构，来自脱敏评审文档第 6 节） ----
const usage = { _midscene_call_id: 'synthetic-call', prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, retry_count: 0 };
const task = (status, output, usageObj) => ({
  taskId: 'synthetic-task', type: 'Insight', subType: 'Boolean', status,
  ...(output === undefined ? {} : { output }),
  ...(usageObj ? { usage: usageObj, log: { data: { Boolean: output }, taskInfo: { formatResponse: { data: { Boolean: output } }, usage: usageObj } } } : {}),
});
const snap = t => ({
  attributes: { type: 'midscene_web_dump', 'data-group-id': 'synthetic-group' },
  payload: { sdkVersion: '1.17.1', executions: [{ id: 'synthetic-execution', tasks: [t] }] },
});
const baseFixture = { fixtureSchemaVersion: 1, documentTitle: '合成页面标题', reportId: 'synthetic-report', scripts: [snap(task('running')), snap(task('finished', false, usage)), snap(task('finished', false, usage))] };

test('合成 fixture：任务按身份去重、usage 去重后为 1 次调用 12/3/15', () => {
  const parsed = parseFixture(baseFixture);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].status, 'finished');
  assert.equal(parsed.tasks[0].output, false);
  assert.deepEqual(parsed.modelObservation, { known: true, uniqueCalls: 1, promptTokens: 12, completionTokens: 3, totalTokens: 15, orphanUsageCopies: 0, retryObserved: false, note: 'known=true 仅表示报告内观测完整一致，不表示网络请求硬计量' });
});

test('反例：Boolean=false + finished + 进程 exit0 不可通过产品谓词', () => {
  const result = evaluateProduct({ fixture: baseFixture, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: true }] } });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('断言值 false')));
  const exitZero = evaluateProduct({ fixture: baseFixture, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: true }] } });
  assert.equal(exitZero.passed, false); // exitCode 不参与判定，见 note
});

test('反例：终态冲突（第三个快照改为 true）必须检出而不是“最后值覆盖后通过”', () => {
  const conflict = { ...baseFixture, scripts: [...baseFixture.scripts, snap(task('finished', true, usage))] };
  const result = evaluateProduct({ fixture: conflict, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: true }] } });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('output 冲突')));
});

test('反例：空标题不满足产品场景 ready 前提', () => {
  const empty = { ...baseFixture, documentTitle: '  ' };
  const result = evaluateProduct({ fixture: empty, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: false }] } });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('页面标题为空')));
});

test('反例：缺必需任务 / 只有 running / 空 scripts 均不通过', () => {
  const missing = evaluateProduct({ fixture: baseFixture, expectations: { requiredTasks: [{ taskId: 'absent', subType: 'Boolean', expectOutput: true }] } });
  assert.equal(missing.passed, false);
  const runningOnly = evaluateProduct({ fixture: { fixtureSchemaVersion: 1, documentTitle: 't', scripts: [snap(task('running'))] }, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: true }] } });
  assert.equal(runningOnly.passed, false);
  const empty = parseFixture({ fixtureSchemaVersion: 1, scripts: [] });
  assert.equal(empty.ok, false);
});

test('模型观测缺失记 unknown；要求计量完整的产品配方因此失败', () => {
  const noUsage = { ...baseFixture, scripts: [snap(task('finished', false))] };
  const parsed = parseFixture(noUsage);
  assert.equal(parsed.modelObservation.known, false);
  const strict = evaluateProduct({ fixture: noUsage, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: false }], requireKnownModelUsage: true } });
  assert.equal(strict.passed, false);
  // 不要求计量完整时，产品判定可保留（unknown 不冒充 0）
  const lenient = evaluateProduct({ fixture: noUsage, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: false }] } });
  assert.equal(lenient.passed, true);
  assert.equal(lenient.summary.modelObservation.known, false);
});

test('usage 多副本计量冲突 → unknown 且不通过（不任择较小值放行）', () => {
  const conflicting = { ...baseFixture, scripts: [snap(task('finished', false, usage)), snap(task('finished', false, { ...usage, total_tokens: 99 }))] };
  const parsed = parseFixture(conflicting);
  assert.equal(parsed.modelObservation.known, false);
  assert.ok(parsed.anomalies.some(a => a.includes('计量冲突')));
});
