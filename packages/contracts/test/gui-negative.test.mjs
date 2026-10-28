import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFixture, evaluateProduct } from '../gui/midscene-report.mjs';

// ---- 合成 fixture 反例（全部虚构，来自脱敏评审文档第 6 节 + Codex 复审新增项） ----
const usage = { _midscene_call_id: 'synthetic-call', prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, retry_count: 0 };
const task = (status, output, usageObj, overrides = {}) => ({
  taskId: 'synthetic-task', type: 'Insight', subType: 'Boolean', status,
  ...(output === undefined ? {} : { output }),
  ...(usageObj ? { usage: usageObj, log: { data: { Boolean: output }, taskInfo: { formatResponse: { data: { Boolean: output } }, usage: usageObj } } } : {}),
  ...overrides,
});
const snap = (t, attrs = {}) => ({
  attributes: { type: 'midscene_web_dump', 'data-group-id': 'synthetic-group', ...attrs },
  payload: { sdkVersion: '1.17.1', executions: [{ id: 'synthetic-execution', tasks: [t] }] },
});
const baseFixture = { fixtureSchemaVersion: 1, documentTitle: '合成页面标题', reportId: 'synthetic-report', scripts: [snap(task('running')), snap(task('finished', false, usage)), snap(task('finished', false, usage))] };
const expectTrue = { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: true }] };

test('无效输入结构化失败，不抛异常：null/undefined/数组/字符串标题/损坏嵌套', () => {
  for (const bad of [null, undefined, 42, 'string', [], true]) {
    const result = evaluateProduct({ fixture: bad, expectations: expectTrue });
    assert.equal(result.passed, false, `fixture=${String(bad)} 不应通过`);
    assert.ok(Array.isArray(result.failures) && result.failures.length > 0);
  }
  // expectations 自身无效
  for (const badExp of [null, 42, 'x', []]) {
    const result = evaluateProduct({ fixture: baseFixture, expectations: badExp });
    assert.equal(result.passed, false);
  }
  // documentTitle 非字符串 → 结构化失败（不是静默当空标题也不是抛错）
  const badTitle = parseFixture({ ...baseFixture, documentTitle: 42 });
  assert.equal(badTitle.ok, false);
  assert.ok(badTitle.failures.some(f => f.includes('documentTitle')));
  // 损坏嵌套：scripts 里塞非对象 / payload 缺 executions
  const broken = parseFixture({ fixtureSchemaVersion: 1, scripts: [42, { attributes: { type: 'midscene_web_dump' }, payload: { executions: 7 } }] });
  assert.equal(broken.ok, false);
  assert.ok(broken.anomalies.length >= 1);
});

test('Query 不支持：必需任务声明 Query 一律拒绝，期望配置缺字段不得绕过', () => {
  const queryFixture = { ...baseFixture, scripts: [snap({ taskId: 'q', type: 'Insight', subType: 'Query', status: 'finished', output: '' })] };
  const r1 = evaluateProduct({ fixture: queryFixture, expectations: { requiredTasks: [{ taskId: 'q', subType: 'Query', expectOutput: 'expected' }] } });
  assert.equal(r1.passed, false);
  assert.ok(r1.failures.some(f => f.includes('仅支持') && f.includes('Query')));
  // 空 output 曾误判通过的反例：同样拒绝
  const r2 = evaluateProduct({ fixture: queryFixture, expectations: { requiredTasks: [{ taskId: 'q', subType: 'Query' }] } });
  assert.equal(r2.passed, false);
  assert.ok(r2.failures.some(f => f.includes('expectOutput 必须是 boolean') || f.includes('仅支持')));
  // 合法 subType 但缺 expectOutput → 期望配置无效
  const r3 = evaluateProduct({ fixture: baseFixture, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean' }] } });
  assert.equal(r3.passed, false);
  assert.ok(r3.failures.some(f => f.includes('expectOutput')));
  // expectOutput 非布尔
  const r4 = evaluateProduct({ fixture: baseFixture, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: 'yes' }] } });
  assert.equal(r4.passed, false);
});

test('交叉核对冲突：output=true 而 log.data.Boolean=false 必须失败', () => {
  const conflict = snap(task('finished', true, usage, {
    log: { data: { Boolean: false }, taskInfo: { formatResponse: { data: { Boolean: false } }, usage } },
  }));
  const r = evaluateProduct({ fixture: { ...baseFixture, scripts: [conflict] }, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: true }] } });
  assert.equal(r.passed, false);
  assert.ok(r.failures.some(f => f.includes('交叉核对值') && f.includes('冲突')));
  // Assert 的 StatementIsTruthy 交叉值同理
  const assertTask = { taskId: 'a', type: 'Insight', subType: 'Assert', status: 'finished', output: true,
    log: { data: { StatementIsTruthy: false }, taskInfo: { formatResponse: { data: { StatementIsTruthy: false } } } } };
  const r2 = evaluateProduct({ fixture: { ...baseFixture, scripts: [snap(assertTask)] }, expectations: { requiredTasks: [{ taskId: 'a', subType: 'Assert', expectOutput: true }] } });
  assert.equal(r2.passed, false);
  assert.ok(r2.failures.some(f => f.includes('交叉核对值')));
});

test('身份内 type/subType 变化必须失败', () => {
  const changed = { ...baseFixture, scripts: [snap(task('finished', false, usage)), snap(task('finished', false, usage, { subType: 'Assert' }))] };
  const r = evaluateProduct({ fixture: changed, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: false }] } });
  assert.equal(r.passed, false);
  assert.ok(r.failures.some(f => f.includes('type/subType 变化')));
});

test('usage 不完整/重试/负数 → known=false，保留原始观察下界（不伪记 0）', () => {
  const retry = { ...usage, retry_count: 1 };
  const r1 = parseFixture({ ...baseFixture, scripts: [snap(task('finished', false, retry)), snap(task('finished', false, retry))] });
  assert.equal(r1.modelObservation.known, false);
  assert.ok(r1.modelObservation.reason.includes('retry'));
  assert.equal(r1.modelObservation.uniqueCalls, 1); // 下界保留
  assert.deepEqual([r1.modelObservation.promptTokens, r1.modelObservation.completionTokens, r1.modelObservation.totalTokens], [12, 3, 15]);
  assert.equal(r1.modelObservation.retryObserved, true);

  const negative = { ...usage, prompt_tokens: -1 };
  const r2 = parseFixture({ ...baseFixture, scripts: [snap(task('finished', false, negative))] });
  assert.equal(r2.modelObservation.known, false);
  assert.ok(r2.modelObservation.reason.includes('缺字段/负数/非整数'));

  const missing = { _midscene_call_id: 'c', prompt_tokens: 5 }; // 缺 completion/total
  const r3 = parseFixture({ ...baseFixture, scripts: [snap(task('finished', false, missing))] });
  assert.equal(r3.modelObservation.known, false);
  assert.ok(r3.modelObservation.reason.length > 0);

  // known=true 也不声称网络请求硬计量
  const full = parseFixture(baseFixture);
  assert.equal(full.modelObservation.known, true);
  assert.ok(full.modelObservation.note.includes('不表示网络请求硬计量'));

  // requireKnownModelUsage=true 时不完整计量必须失败
  const strict = evaluateProduct({ fixture: { ...baseFixture, scripts: [snap(task('finished', false, retry))] }, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: false }], requireKnownModelUsage: true } });
  assert.equal(strict.passed, false);
  assert.ok(strict.failures.some(f => f.includes('观察下界') && !f.includes('=0') || f.includes('uniqueCalls=1')));
  // 缺 callId 的孤儿副本：无法去重 → unknown，但孤儿计数保留
  const orphan = { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8, retry_count: 0 };
  const r4 = parseFixture({ ...baseFixture, scripts: [snap(task('finished', false, orphan))] });
  assert.equal(r4.modelObservation.known, false);
  assert.equal(r4.modelObservation.orphanUsageCopies, 2); // task.usage 与 log.taskInfo.usage 两处副本都缺 callId
});

test('必需任务身份歧义（同 taskId 多 group/execution）必须拒绝；具名完整身份才可判定', () => {
  const ambiguous = { ...baseFixture, scripts: [
    snap(task('finished', false, usage), { 'data-group-id': 'group-a' }),
    snap(task('finished', false, usage), { 'data-group-id': 'group-b' }),
  ] };
  const vague = evaluateProduct({ fixture: ambiguous, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: false }] } });
  assert.equal(vague.passed, false);
  assert.ok(vague.failures.some(f => f.includes('身份歧义')));
  const named = evaluateProduct({ fixture: ambiguous, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: false, groupId: 'group-a' }] } });
  assert.equal(named.passed, true, named.failures.join(';'));
  // groupId 缺失的任务记录本身不能形成产品通过
  const noGroup = evaluateProduct({ fixture: { ...baseFixture, scripts: [snap(task('finished', false, usage), { 'data-group-id': undefined })] }, expectations: { requiredTasks: [{ taskId: 'synthetic-task', subType: 'Boolean', expectOutput: false }] } });
  assert.equal(noGroup.passed, false);
  assert.ok(noGroup.failures.some(f => f.includes('groupId 缺失')));
});

test('矩阵：无效 fixture × 严格/非严格计量都结构化 passed:false 且不抛（终验组合反例）', () => {
  const strictExp = { requiredTasks: [{ taskId: 't', groupId: 'g', executionId: 'e', subType: 'Boolean', expectOutput: true }], requireKnownModelUsage: true };
  const plainExp = { requiredTasks: [{ taskId: 't', groupId: 'g', executionId: 'e', subType: 'Boolean', expectOutput: true }] };
  const invalid = [
    null,
    {},
    { fixtureSchemaVersion: 1, scripts: [] },
    { fixtureSchemaVersion: 2, scripts: [snap(task('finished', true, usage))] },
    42,
    'json-string',
  ];
  for (const fixture of invalid) {
    for (const expectations of [strictExp, plainExp]) {
      let result;
      assert.doesNotThrow(() => { result = evaluateProduct({ fixture, expectations }); }, `不应抛出：fixture=${JSON.stringify(fixture)}`);
      assert.equal(result.passed, false, `不应通过：fixture=${JSON.stringify(fixture)}`);
      assert.ok(Array.isArray(result.failures) && result.failures.length > 0);
      assert.ok(result.summary && result.summary.modelObservation && result.summary.modelObservation.known === false);
    }
  }
});

test('对照：完整正确 fixture 在严格/非严格两种模式都真实通过（不被反例修复波及）', () => {
  const good = { fixtureSchemaVersion: 1, documentTitle: '合成页面标题', reportId: 'synthetic-report', scripts: [
    snap(task('finished', true, usage), { 'data-group-id': 'g' }),
  ] };
  // snap 内 executions id 固定为 synthetic-execution；期望具名 groupId/executionId
  const exp = { taskId: 'synthetic-task', groupId: 'g', executionId: 'synthetic-execution', subType: 'Boolean', expectOutput: true };
  const strict = evaluateProduct({ fixture: good, expectations: { requiredTasks: [exp], requireKnownModelUsage: true } });
  assert.equal(strict.passed, true, strict.failures.join(';'));
  assert.equal(strict.summary.modelObservation.known, true);
  assert.equal(strict.summary.modelObservation.uniqueCalls, 1);
  const plain = evaluateProduct({ fixture: good, expectations: { requiredTasks: [exp] } });
  assert.equal(plain.passed, true, plain.failures.join(';'));
});
