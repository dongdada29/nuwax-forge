// budget 命令测试：真实 CLI 子进程 + 临时文件。覆盖预测数学/口径/历史/路径安全/去重。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(pkg, 'bin', 'nuwax-devkit.mjs');

function run(args) {
  return new Promise(resolvePromise => {
    execFile(process.execPath, [BIN, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => resolvePromise({ code: error ? error.code : 0, stdout, stderr }));
  });
}
const runJson = async args => { const r = await run([...args, '--json']); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
const wf = (dir, name, objOrText) => {
  const p = path.join(dir, name);
  writeFileSync(p, typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText));
  return p;
};

const BASE_SPEC = {
  schemaVersion: 1, id: 'spec-basic', taskKind: 'text-implementation',
  model: { name: 'model-x' }, mode: 'model', expectedCalls: 4,
  initialContextTokens: 1000, perCallOutputTokens: 200, perCallToolResultTokens: 300,
  cacheHitRatio: 0.5, budgetTokens: 100000,
};

test('estimate：多轮增长 + 缓存子集数学精确（Σcontext=7000、cached=3500、total=7800）', async () => {
  const dir = tmp();
  try {
    const est = await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC)]);
    assert.equal(est.engine.modelCallsUsed, 0);
    assert.equal(est.tokens.inputTokens.median, 7000); // 4*1000 + 500*(0+1+2+3)
    assert.equal(est.tokens.cachedReadTokens.median, 3500); // 输入子集，不重复加进 total
    assert.equal(est.tokens.outputTokens.median, 800);
    assert.equal(est.tokens.toolResultTokens.median, 1200);
    assert.equal(est.totalTokens.median, 7800);
    assert.equal(est.budget.verdict, 'within');
    assert.equal(est.budget.headroomTokens, 92200);
    assert.equal(est.confidence.level, 'medium'); // 无历史：算术推演至多 medium
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('estimate：no-model + calls 0 → 运行段 0 token，且明确不含发起任务/上层对话', async () => {
  const dir = tmp();
  try {
    const est = await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', {
      schemaVersion: 1, id: 'nm', taskKind: 'deterministic', mode: 'no-model', expectedCalls: 0, budgetTokens: 1000,
    })]);
    assert.deepEqual(est.runSegment, { modelCalls: 0, tokens: 0, note: '运行段 0 模型调用、0 token' });
    assert.match(est.scope, /不含发起任务/);
    assert.equal(est.budget.verdict, 'within');
    assert.equal(est.engine.modelCallsUsed, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('estimate：显式中文文本按码点启发式给区间并标注非模型 tokenizer', async () => {
  const dir = tmp();
  try {
    const est = await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', {
      ...BASE_SPEC, id: 'zh', inputs: ['你好世界hello'], initialContextTokens: undefined,
      perCallOutputTokens: 10, perCallToolResultTokens: 0, cacheHitRatio: 0, budgetTokens: undefined,
    })]);
    const init = est.tokens.initialContextTokens;
    assert.ok(init.low <= init.median && init.median <= init.high && init.low > 0);
    assert.match(est.formula.inputsFrom, /utf8\/codepoint-heuristic/);
    assert.ok(est.assumptions.some(a => /非模型 tokenizer/.test(a.note)));
    delete BASE_SPEC.inputs;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('estimate：视觉任务缺图像 token 且无历史 → unknown 而非 0，预算不放行', async () => {
  const dir = tmp();
  try {
    const est = await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', {
      ...BASE_SPEC, id: 'vis', taskKind: 'gui-visual', imageTokensPerCall: 'unknown',
    })]);
    assert.equal(est.tokens.imageTokens.status, 'unknown');
    assert.equal(est.totalTokens.status, 'partial-unknown');
    assert.deepEqual(est.totalTokens.unknownDimensions, ['imageTokens']);
    assert.equal(est.tokens.inputTokens.excludesUnknownImage, true);
    assert.equal(est.budget.verdict, 'unknown');
    assert.ok(est.unknowns.some(u => /视觉/.test(u) && /unknown/.test(u)));
    assert.ok(est.recommendations.some(r => r.id === 'vision-cost'));
    assert.equal(est.confidence.level, 'low');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('estimate：历史按 model+taskKind 隔离、少样本低置信、坏 JSONL 结构化诊断、比率校准生效', async () => {
  const dir = tmp();
  try {
    const hist = wf(dir, 'hist.jsonl', [
      JSON.stringify({ kind: 'token-budget-calibration', schemaVersion: 1, model: 'other-model', taskKind: 'text-implementation', expected: { inputTokens: 1 }, actual: { inputTokens: 999999 } }),
      JSON.stringify({ kind: 'token-budget-calibration', schemaVersion: 1, model: 'model-x', taskKind: 'text-implementation', baselineExpected: { inputTokens: 7000 }, predictedExpected: { inputTokens: 7000 }, actual: { inputTokens: 14000 } }),
      '{"broken json line',
      '',
    ].join('\n'));
    const est = await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--history', hist]);
    assert.equal(est.tokens.inputTokens.median, 14000); // 中位比率 2× 生效
    assert.equal(est.confidence.history.samples, 1);   // other-model 样本被隔离
    assert.equal(est.confidence.level, 'low');          // 1 样本 → 低置信，不声称 P90
    assert.ok(est.confidence.history.note.includes('<4'));
    assert.equal(est.historyDiagnostics.length, 1);
    assert.equal(est.historyDiagnostics[0].line, 3);
    assert.match(est.historyDiagnostics[0].problem, /JSON 解析失败/);
    assert.ok(est.assumptions.some(a => /历史校准中位比率/.test(a.note)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('estimate：非法值（负数/超界比率/非整数调用/Infinity）一律拒绝', async () => {
  const dir = tmp();
  try {
    const bad = [
      { ...BASE_SPEC, perCallOutputTokens: -5 },
      { ...BASE_SPEC, cacheHitRatio: 1.5 },
      { ...BASE_SPEC, expectedCalls: 2.5 },
      JSON.parse('{"schemaVersion":1,"id":"x","taskKind":"t","mode":"model","model":{"name":"m"},"expectedCalls":1,"initialContextTokens":1e999}'),
    ];
    for (const [i, spec] of bad.entries()) {
      const r = await run(['budget', 'estimate', '--spec', wf(dir, `bad${i}.json`, spec), '--json']);
      assert.notEqual(r.code, 0, `case ${i} 应失败`);
      assert.match(r.stderr, /非负|≤ 1|整数|有限/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('estimate：预算超限 → exceeds + 针对性建议', async () => {
  const dir = tmp();
  try {
    const est = await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', { ...BASE_SPEC, budgetTokens: 6000 })]);
    assert.equal(est.budget.verdict, 'exceeds');
    assert.ok(est.recommendations.some(r => r.id === 'budget-overflow'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：GUI manifest（known）差值正确、保留 rawObserved', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    const rec = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'actual.json', {
      model: { observation: { known: true, uniqueCalls: 4, promptTokens: 7200, completionTokens: 820, totalTokens: 8020, retryObserved: false, observedCounts: { steps: 4 } } },
    })]);
    assert.equal(rec.actual.format, 'gui-manifest');
    assert.equal(rec.actual.inputSemantics, 'includes-cache');
    assert.equal(rec.actual.completeness.complete, true);
    assert.deepEqual(rec.actual.rawObserved, { steps: 4 });
    const input = rec.comparison.dimensions.find(d => d.dimension === 'inputTokens(includes-cached)');
    assert.equal(input.actual, 7200); assert.equal(input.delta, 200); assert.equal(input.ratio, 1.029);
    const total = rec.comparison.dimensions.find(d => d.dimension === 'totalTokens');
    assert.equal(total.actual, 8020); assert.equal(total.delta, 220);
    assert.equal(rec.comparison.percentError.totalTokens, 2.821);
    assert.equal(rec.budget.verdict, 'within'); // 按实耗 8020 ≤ 100000
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：GUI manifest known=false / retry → 不当完整数，预算 unknown', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    const rec = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'actual.json', {
      model: { observation: { known: false, uniqueCalls: 2, promptTokens: 3000, completionTokens: 100, retryObserved: true } },
    })]);
    assert.equal(rec.actual.completeness.known, false);
    assert.equal(rec.actual.completeness.complete, false);
    assert.ok(rec.actual.notes.some(n => /known=false/.test(n)));
    assert.ok(rec.actual.notes.some(n => /重试/.test(n)));
    assert.equal(rec.budget.verdict, 'unknown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：Claude excludes-cache 与 usage includes-cache 两种口径归一到同一可比输入', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', { ...BASE_SPEC, initialContextTokens: 3900, cacheHitRatio: 0.75 }), '--out', estPath]);
    // input median = 4*3900+500*6=18600；此处仅核对口径，不需精确匹配
    const claude = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'a1.json', {
      modelUsage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 3000, cacheCreationInputTokens: 200 },
    })]);
    assert.equal(claude.actual.inputSemantics, 'excludes-cache');
    assert.equal(claude.actual.usage.comparableInputIncludingCachedRead, 4000);
    const ci = claude.comparison.dimensions.find(d => d.dimension === 'inputTokens(includes-cached)');
    assert.equal(ci.actual, 4000);
    const cw = claude.comparison.dimensions.find(d => d.dimension === 'cacheWriteTokens');
    assert.equal(cw.actual, 200); // 单列，不并入输入/输出
    assert.ok(claude.comparison.notes.some(n => /cacheRead/.test(n) && /归一/.test(n)));
    const codex = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'a2.json', {
      usage: { input_tokens: 4000, output_tokens: 500, cached_tokens: 3000 },
    })]);
    assert.equal(codex.actual.inputSemantics, 'includes-cache');
    assert.equal(codex.comparison.dimensions.find(d => d.dimension === 'inputTokens(includes-cached)').actual, 4000);
    // 口径未声明且非 snake 风格 → unknown：只分列不给差值
    const unk = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'a3.json', {
      usage: { inputTokens: 4000, outputTokens: 500 },
    })]);
    assert.equal(unk.actual.inputSemantics, 'unknown');
    const ui = unk.comparison.dimensions.find(d => d.dimension === 'inputTokens(includes-cached)');
    assert.equal(ui.actual, null); assert.equal(ui.delta, null);
    assert.ok(ui.note.includes('口径'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：raw total 不能漏算缓存或绕过未知口径；includes-cache GUI 正常放行', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', { ...BASE_SPEC, budgetTokens: 2000 }), '--out', estPath]);
    const excluded = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'excluded.json', {
      inputSemantics: 'excludes-cache', usage: { inputTokens: 1000, outputTokens: 500, cachedReadTokens: 3000, totalTokens: 1500 },
    })]);
    assert.equal(excluded.actual.usage.totalTokens, 1500); // 原始 total 保留
    assert.equal(excluded.actual.usage.comparableInputIncludingCachedRead, 4000);
    assert.equal(excluded.actual.usage.derivedTotal, 4500);
    assert.equal(excluded.comparison.dimensions.find(d => d.dimension === 'totalTokens').actual, 4500);
    assert.ok(excluded.comparison.notes.some(n => /totalTokens 1500/.test(n) && /4500/.test(n)));
    assert.equal(excluded.budget.verdict, 'exceeds');
    assert.equal(excluded.budget.overByTokens, 2500);
    const unknown = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'unknown.json', {
      usage: { inputTokens: 1000, outputTokens: 500, cachedReadTokens: 500, totalTokens: 1500 },
    })]);
    assert.equal(unknown.actual.usage.totalTokens, 1500);
    assert.equal(unknown.actual.inputSemantics, 'unknown');
    assert.equal(unknown.comparison.dimensions.find(d => d.dimension === 'totalTokens').actual, null);
    assert.equal(unknown.budget.verdict, 'unknown');
    assert.equal(unknown.usableForCalibration, false);
    const gui = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'gui.json', {
      model: { observation: { known: true, uniqueCalls: 1, promptTokens: 1000, completionTokens: 500, totalTokens: 1500, cachedReadTokens: 800, retryObserved: false } },
    })]);
    assert.equal(gui.actual.inputSemantics, 'includes-cache');
    assert.equal(gui.actual.usage.totalTokens, 1500);
    assert.equal(gui.comparison.dimensions.find(d => d.dimension === 'totalTokens').actual, 1500);
    assert.equal(gui.budget.verdict, 'within');
    assert.equal(gui.budget.headroomTokens, 500); // 缓存已含在 prompt 中，不重复加算
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：actual total 不一致 / 负数 / 坏 JSON 拒绝；未知格式拒绝', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    const badActuals = [
      '{\"usage\":{\"inputTokens\":100,\"outputTokens\":50,\"totalTokens\":200}}',   // 100+50≠200
      '{\"usage\":{\"inputTokens\":-1,\"outputTokens\":5}}',                          // 负数
      '{ not json',                                                                   // 坏 JSON
      '{\"whatever\":1}',                                                             // 未知格式
    ];
    for (const [i, text] of badActuals.entries()) {
      const r = await run(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, `b${i}.json`, text), '--json']);
      assert.notEqual(r.code, 0, `case ${i}`);
      assert.match(r.stderr, /不一致|非负|合法 JSON|无法识别/);
    }
    const badEst = await run(['budget', 'reconcile', '--estimate', wf(dir, 'notest.json', { hello: 1 }), '--actual', wf(dir, 'b0.json', { usage: { inputTokens: 1, outputTokens: 1 } }), '--json']);
    assert.notEqual(badEst.code, 0);
    assert.match(badEst.stderr, /token-budget-estimate/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：--out/--history 不许覆盖输入或互写（realpath/符号链接别名同样拒绝）', async () => {
  const dir = tmp();
  try {
    const specPath = wf(dir, 'spec.json', BASE_SPEC);
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', specPath, '--out', estPath]);
    const actualPath = wf(dir, 'actual.json', { usage: { inputTokens: 7000, outputTokens: 800, totalTokens: 7800 }, inputSemantics: 'includes-cache' });
    const r1 = await run(['budget', 'estimate', '--spec', specPath, '--out', specPath, '--json']);
    assert.notEqual(r1.code, 0); assert.match(r1.stderr, /拒绝写入/);
    const alias = path.join(dir, 'alias.json');
    symlinkSync(specPath, alias);
    const r2 = await run(['budget', 'estimate', '--spec', specPath, '--out', alias, '--json']);
    assert.notEqual(r2.code, 0); assert.match(r2.stderr, /拒绝写入/);
    const histPath = path.join(dir, 'hist.jsonl');
    const r3 = await run(['budget', 'reconcile', '--estimate', estPath, '--actual', actualPath, '--history', histPath, '--out', histPath, '--json']);
    assert.notEqual(r3.code, 0); assert.match(r3.stderr, /同一文件/);
    const r4 = await run(['budget', 'reconcile', '--estimate', estPath, '--actual', actualPath, '--out', estPath, '--json']);
    assert.notEqual(r4.code, 0); assert.match(r4.stderr, /拒绝写入/);
    // 拒绝后源文件未被破坏
    assert.equal(JSON.parse(readFileSync(specPath, 'utf8')).id, 'spec-basic');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：重复核对按 estimateId+sourceHash 去重，样本只落一条且脱敏', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    const actualPath = wf(dir, 'actual.json', { usage: { inputTokens: 7000, outputTokens: 800, totalTokens: 7800 }, inputSemantics: 'includes-cache', calls: 4 });
    const histPath = path.join(dir, 'hist.jsonl');
    const first = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', actualPath, '--history', histPath]);
    assert.equal(first.historyWrite.appended, true);
    assert.equal(first.historyWrite.totalSamples, 1);
    const second = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', actualPath, '--history', histPath]);
    assert.equal(second.historyWrite.appended, false);
    assert.equal(second.historyWrite.duplicateSkipped, true);
    const lines = readFileSync(histPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const sample = JSON.parse(lines[0]);
    assert.equal(sample.model, 'model-x'); assert.equal(sample.taskKind, 'text-implementation');
    assert.equal(sample.actual.inputTokens, 7000);
    assert.ok(sample.sourceHash.length === 64);
    assert.ok(!JSON.stringify(sample).includes('prompt')); // 脱敏：无 prompt/会话内容
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('estimate：缺 perCallOutputTokens/工具回包 → unknown 而非 0，预算不放行；全显式仍正常预测', async () => {
  const dir = tmp();
  try {
    const { perCallOutputTokens, ...noOut } = BASE_SPEC;
    const est = await runJson(['budget', 'estimate', '--spec', wf(dir, 'a.json', noOut)]);
    assert.equal(est.tokens.outputTokens.status, 'unknown');
    assert.equal(est.totalTokens.status, 'partial-unknown');
    assert.ok(est.totalTokens.unknownDimensions.includes('outputTokens'));
    assert.equal(est.budget.verdict, 'unknown'); // 缺失成本不当 0 给 within
    assert.equal(est.confidence.level, 'low');
    assert.ok(est.recommendations.some(r => r.id === 'missing-params'));
    const { perCallToolResultTokens, ...noTool } = BASE_SPEC;
    const est2 = await runJson(['budget', 'estimate', '--spec', wf(dir, 'b.json', noTool)]);
    assert.ok(est2.totalTokens.unknownDimensions.includes('toolResultTokens'));
    assert.equal(est2.tokens.inputTokens.excludesUnknownToolResult, true);
    assert.equal(est2.tokens.toolResultTokens.status, 'unknown');
    assert.equal(est2.budget.verdict, 'unknown');
    // 对照：所有数值显式给齐 → 正常区间预测（test 1 已覆盖 within/headroom）
    const est3 = await runJson(['budget', 'estimate', '--spec', wf(dir, 'c.json', BASE_SPEC)]);
    assert.equal(est3.totalTokens.median, 7800);
    assert.equal(est3.budget.verdict, 'within');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：真实 Claude CLI keyed-by-model modelUsage 解析非空数字；自定义 provider 默认 unknown 只分列', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    const keyed = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'k.json', {
      modelUsage: { 'glm-5.3[1m]': { inputTokens: 15000, outputTokens: 2400, cacheReadInputTokens: 9000, cacheCreationInputTokens: 1500, costBasis: 'unknown', num_turns: 6 } },
    })]);
    assert.equal(keyed.actual.format, 'claude-result');
    assert.equal(keyed.actual.usage.inputTokens, 15000); // 非空数字，不再全 null
    assert.equal(keyed.actual.usage.outputTokens, 2400);
    assert.equal(keyed.actual.usage.cachedReadTokens, 9000);
    assert.equal(keyed.actual.usage.cacheWriteTokens, 1500);
    assert.equal(keyed.actual.usage.calls, null); // 不盲用 num_turns
    assert.equal(keyed.actual.perModel[0].model, 'glm-5.3[1m]');
    assert.equal(keyed.actual.inputSemantics, 'unknown'); // 不对自定义 provider 硬断言 excludes-cache
    const ki = keyed.comparison.dimensions.find(d => d.dimension === 'inputTokens(includes-cached)');
    assert.equal(ki.actual, null);
    assert.equal(keyed.usableForCalibration, false);
    const declared = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'kd.json', {
      inputSemantics: 'excludes-cache',
      modelUsage: { 'glm-5.3[1m]': { inputTokens: 15000, outputTokens: 2400, cacheReadInputTokens: 9000 } },
    })]);
    assert.equal(declared.actual.inputSemantics, 'excludes-cache');
    assert.equal(declared.actual.usage.comparableInputIncludingCachedRead, 24000);
    const multi = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'm.json', {
      modelUsage: { 'a-model': { inputTokens: 1000, outputTokens: 500 }, 'b-model': { inputTokens: 2000, outputTokens: 100 } },
    })]);
    assert.equal(multi.actual.perModel.length, 2);
    assert.equal(multi.actual.usage.inputTokens, 3000); // 多模型聚合，per-model 保留
    assert.equal(multi.actual.usage.outputTokens, 600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：keyed Claude result（session_id、无 usageScope）→ 累计数保留但预算 unknown 且不写历史', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    // 真实 CLI shape：顶层 session_id + keyed modelUsage；即便声明了 cache 口径，累计 usage 也不是本次运行段实耗
    const cumulative = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'cum.json', {
      session_id: 'session-abc123',
      inputSemantics: 'excludes-cache',
      modelUsage: { 'glm-5.3[1m]': { inputTokens: 90311, outputTokens: 49319, cacheReadInputTokens: 61234, cacheCreationInputTokens: 5000, costBasis: 'unknown', num_turns: 12 } },
    })]);
    assert.equal(cumulative.actual.format, 'claude-result');
    assert.equal(cumulative.actual.usageScope, 'session-cumulative'); // 默认：--resume 的 modelUsage 为整会话累计
    assert.equal(cumulative.actual.usage.inputTokens, 90311);         // 原始数值保留展示，不归零
    assert.equal(cumulative.actual.usage.outputTokens, 49319);
    assert.equal(cumulative.actual.perModel[0].model, 'glm-5.3[1m]');
    assert.ok(cumulative.actual.notes.some(n => /session-cumulative/.test(n) && /累计/.test(n)));
    assert.equal(cumulative.actual.completeness.complete, false);     // scope 未确认 → 不当完整单次实耗
    assert.equal(cumulative.actual.completeness.scopeConfirmed, false);
    assert.equal(cumulative.budget.verdict, 'unknown');               // 累计数（实为 200864 > 100000）也不能给 exceeds/within
    assert.equal(cumulative.usableForCalibration, false);             // 不拿累计数校准单次 estimate
    assert.equal(cumulative.sample.calibrationEligible, false);
    // 累计 scope：不落校准样本
    const histPath = path.join(dir, 'h.jsonl');
    const cum2 = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'cum2.json', {
      session_id: 'session-abc123', inputSemantics: 'excludes-cache',
      modelUsage: { 'glm-5.3[1m]': { inputTokens: 99472, outputTokens: 50100, cacheReadInputTokens: 61234, cacheCreationInputTokens: 5000, num_turns: 6 } },
    }), '--history', histPath]);
    assert.equal(cum2.historyWrite.appended, false);
    assert.ok(!existsSync(histPath)); // 累计实耗不写历史
    // 混 cache 口径 unknown + 无 scope：原 unknown 行为保留（只分列），scope 门同样生效
    const mixed = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'mix.json', {
      session_id: 'session-abc123',
      modelUsage: { 'glm-5.3[1m]': { inputTokens: 15000, outputTokens: 2400, cacheReadInputTokens: 9000, cacheCreationInputTokens: 1500, num_turns: 6 } },
    })]);
    assert.equal(mixed.actual.inputSemantics, 'unknown');
    assert.equal(mixed.actual.usageScope, 'session-cumulative');
    assert.equal(mixed.comparison.dimensions.find(d => d.dimension === 'inputTokens(includes-cached)').actual, null);
    assert.equal(mixed.budget.verdict, 'unknown');
    assert.equal(mixed.usableForCalibration, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：Claude 显式 run-segment 正常比较并写入校准历史', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    // 显式 usageScope=run-segment（已扣 baseline 的分段数据）→ 按已确认分段数据正常比较/放行/校准
    const seg = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'seg.json', {
      usageScope: 'run-segment', inputSemantics: 'excludes-cache',
      modelUsage: { 'glm-5.3[1m]': { inputTokens: 6800, outputTokens: 760, cacheReadInputTokens: 1200, cacheCreationInputTokens: 300, num_turns: 4 } },
    }), '--history', path.join(dir, 'h2.jsonl')]);
    assert.equal(seg.actual.usageScope, 'run-segment');
    assert.equal(seg.actual.completeness.complete, true);
    assert.equal(seg.actual.completeness.scopeConfirmed, true);
    assert.equal(seg.actual.usage.comparableInputIncludingCachedRead, 8000);
    assert.equal(seg.budget.verdict, 'within'); // (6800+1200)+760=8760 ≤ 100000
    assert.equal(seg.usableForCalibration, true);
    assert.equal(seg.sample.calibrationEligible, true);
    assert.equal(seg.historyWrite.appended, true); // 分段数据可落样本
    // 无法识别的 usageScope 值拒绝（不默默接受）
    const bad = await run(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'bad.json', {
      usageScope: 'per-call', modelUsage: { 'glm-5.3[1m]': { inputTokens: 1, outputTokens: 1 } },
    }), '--json']);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /usageScope/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：规范 usage 保留顶层/内层显式 scope，累计/未知不放行或校准，非法值拒绝', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    for (const holder of ['top', 'usage']) {
      for (const scope of ['session-cumulative', 'unknown', 'run-segment', 'per-call']) {
        const raw = { inputSemantics: 'includes-cache', usage: { inputTokens: 100, outputTokens: 5, cachedReadTokens: 20 }, calls: 1 };
        (holder === 'top' ? raw : raw.usage).usageScope = scope;
        const actualPath = wf(dir, `${holder}-${scope}.json`, raw);
        const histPath = path.join(dir, `${holder}-${scope}.jsonl`);
        const args = ['budget', 'reconcile', '--estimate', estPath, '--actual', actualPath, '--history', histPath];
        if (scope === 'per-call') {
          const bad = await run([...args, '--json']);
          assert.notEqual(bad.code, 0);
          assert.match(bad.stderr, /usageScope.*无法识别/);
          assert.ok(!existsSync(histPath));
          continue;
        }
        const rec = await runJson(args);
        const segment = scope === 'run-segment';
        assert.equal(rec.actual.usageScope, scope);
        assert.equal(rec.actual.usage.inputTokens, 100);
        assert.equal(rec.actual.usage.outputTokens, 5);
        assert.equal(rec.actual.usage.cachedReadTokens, 20);
        assert.equal(rec.actual.completeness.complete, segment);
        assert.equal(rec.budget.verdict, segment ? 'within' : 'unknown');
        assert.equal(rec.usableForCalibration, segment);
        assert.equal(rec.sample.calibrationEligible, segment);
        assert.equal(rec.historyWrite.appended, segment);
        assert.equal(existsSync(histPath), segment);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：includes-cache 下 cachedRead>input 拒绝；缺必要数字 complete=false 且不写历史；未知 semantics 拒绝', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    const badCache = await run(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'bc.json', { usage: { input_tokens: 100, output_tokens: 5, cached_tokens: 200 } }), '--json']);
    assert.notEqual(badCache.code, 0);
    assert.match(badCache.stderr, /口径不一致|cachedRead.*>/);
    const histPath = path.join(dir, 'h.jsonl');
    const missing = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'mi.json', { usage: { outputTokens: 5 } }), '--history', histPath]);
    assert.equal(missing.actual.completeness.complete, false);
    assert.equal(missing.historyWrite.appended, false);
    assert.match(missing.historyWrite.reason, /不完整/);
    assert.ok(!existsSync(histPath)); // 不完整实耗不落样本
    const badSem = await run(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'bs.json', { inputSemantics: 'codex-style', usage: { inputTokens: 100, outputTokens: 5 } }), '--json']);
    assert.notEqual(badSem.code, 0);
    assert.match(badSem.stderr, /无法识别/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reconcile：--out 真实落盘；非法 --out 在任何写副作用前被拒（历史不受污染）', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    const actualPath = wf(dir, 'actual.json', { usage: { inputTokens: 7000, outputTokens: 800, totalTokens: 7800 }, inputSemantics: 'includes-cache', calls: 4 });
    const outPath = path.join(dir, 'rec-out.json');
    const okRun = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', actualPath, '--out', outPath]);
    assert.equal(okRun.kind, 'token-budget-reconcile');
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(written.kind, 'token-budget-reconcile');
    assert.equal(written.historyWrite.appended, false); // 未指定 --history
    // 守卫先于写：--out 指向 actual 别名时，--history 不应被创建/修改
    const dir2 = tmp();
    try {
      const est2 = path.join(dir2, 'est.json');
      await runJson(['budget', 'estimate', '--spec', wf(dir2, 'spec.json', BASE_SPEC), '--out', est2]);
      const actual2 = wf(dir2, 'actual.json', { usage: { inputTokens: 1, outputTokens: 1 }, inputSemantics: 'includes-cache' });
      const alias2 = path.join(dir2, 'alias.json');
      symlinkSync(actual2, alias2);
      const hist2 = path.join(dir2, 'h.jsonl');
      const bad = await run(['budget', 'reconcile', '--estimate', est2, '--actual', actual2, '--history', hist2, '--out', alias2, '--json']);
      assert.notEqual(bad.code, 0);
      assert.match(bad.stderr, /拒绝写入/);
      assert.ok(!existsSync(hist2));
      // --history 与输入同路径同样拒绝
      const bad2 = await run(['budget', 'reconcile', '--estimate', est2, '--actual', actual2, '--history', est2, '--json']);
      assert.notEqual(bad2.code, 0);
      assert.match(bad2.stderr, /拒绝写入/);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('历史严格校验：负数/无数字维度/重复记录 → 诊断且不用于校准；scenario 不匹配不回退', async () => {
  const dir = tmp();
  try {
    const bad1 = JSON.stringify({ kind: 'token-budget-calibration', schemaVersion: 1, model: 'model-x', taskKind: 'text-implementation', expected: { inputTokens: 7000 }, actual: { inputTokens: -3 } });
    const good = JSON.stringify({ kind: 'token-budget-calibration', schemaVersion: 1, estimateId: 'spec-basic', sourceHash: 'a'.repeat(64), model: 'model-x', taskKind: 'text-implementation', baselineExpected: { inputTokens: 7000 }, predictedExpected: { inputTokens: 7000 }, actual: { inputTokens: 14000 } });
    const noNum = JSON.stringify({ kind: 'token-budget-calibration', schemaVersion: 1, model: 'model-x', taskKind: 'text-implementation', expected: { inputTokens: 1 }, actual: {} });
    const est = await runJson(['budget', 'estimate', '--spec', wf(dir, 's.json', BASE_SPEC), '--history', wf(dir, 'h1.jsonl', [bad1, noNum, good, good].join('\n'))]);
    assert.equal(est.tokens.inputTokens.median, 14000); // 仅 1 条有效样本参与（重复行去重）
    const dupDiag = est.historyDiagnostics.filter(d => /重复记录/.test(d.problem));
    assert.equal(dupDiag.length, 1);
    assert.ok(est.historyDiagnostics.some(d => /有限非负/.test(d.problem)));
    assert.ok(est.historyDiagnostics.some(d => /无任何数字维度/.test(d.problem)));
    assert.equal(est.confidence.history.samples, 1); // 重复不夸大 sampleCount
    // scenario 严格匹配：spec 有 scenario、样本 scenario 不同 → 0 样本，不回退、不给高置信
    const est2 = await runJson(['budget', 'estimate', '--spec', wf(dir, 's2.json', { ...BASE_SPEC, scenario: 'login-flow' }), '--history', wf(dir, 'h2.jsonl', good)]);
    assert.equal(est2.confidence.history.samples, 0);
    assert.equal(est2.tokens.inputTokens.median, 7000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('历史：明确不可校准/非分段/非法 scope 进入诊断，旧无 scope 与显式分段样本兼容', async () => {
  const dir = tmp();
  try {
    const base = { kind: 'token-budget-calibration', schemaVersion: 1, model: 'model-x', taskKind: 'text-implementation', baselineExpected: { inputTokens: 7000 }, actual: { inputTokens: 0 } };
    const records = [
      { ...base, usageScope: 'run-segment', calibrationEligible: false },
      { ...base, usageScope: 'session-cumulative' },
      { ...base, usageScope: 'unknown' },
      { ...base, usageScope: 'per-call' },
      { ...base, actual: { inputTokens: 14000 } }, // 旧无 scope 声明仍可校准
      { ...base, actual: { inputTokens: 14000 }, usageScope: 'run-segment', calibrationEligible: true },
    ];
    const est = await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--history', wf(dir, 'history.jsonl', records.map(r => JSON.stringify(r)).join('\n'))]);
    assert.equal(est.confidence.history.samples, 2);
    assert.equal(est.tokens.inputTokens.median, 14000); // 被拒的 0 样本不得降低预测
    assert.deepEqual(est.historyDiagnostics.map(d => d.line), [1, 2, 3, 4]);
    assert.match(est.historyDiagnostics[0].problem, /calibrationEligible=false/);
    for (const d of est.historyDiagnostics.slice(1)) assert.match(d.problem, /usageScope.*不可用于校准/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GUI manifest：known=true 但缺 uniqueCalls → complete=false（缺必要数字）', async () => {
  const dir = tmp();
  try {
    const estPath = path.join(dir, 'est.json');
    await runJson(['budget', 'estimate', '--spec', wf(dir, 'spec.json', BASE_SPEC), '--out', estPath]);
    const rec = await runJson(['budget', 'reconcile', '--estimate', estPath, '--actual', wf(dir, 'a.json', {
      model: { observation: { known: true, promptTokens: 7200, completionTokens: 820, totalTokens: 8020 } },
    })]);
    assert.equal(rec.actual.completeness.complete, false);
    assert.ok(rec.actual.notes.some(n => /uniqueCalls/.test(n)));
    assert.equal(rec.budget.verdict, 'unknown');
    assert.equal(rec.usableForCalibration, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('校准反馈闭环（离线反例）：比率始终基于未校准 baseline，重复同成本样本不回弹', async () => {
  const dir = tmp();
  try {
    // 固定 spec：raw input=1000、output=100（n=1，无增长）
    const specPath = wf(dir, 'spec.json', {
      schemaVersion: 1, id: 'cal-loop', taskKind: 'text-implementation', model: { name: 'm-loop' }, mode: 'model',
      expectedCalls: 1, initialContextTokens: 1000, perCallOutputTokens: 100, perCallToolResultTokens: 0, cacheHitRatio: 0,
    });
    const hist = path.join(dir, 'h.jsonl');
    const est1 = await runJson(['budget', 'estimate', '--spec', specPath, '--json']);
    assert.equal(est1.tokens.inputTokens.median, 1000);
    assert.equal(est1.baselineTokens.inputTokens.median, 1000); // baseline=raw
    const actual = (i, inp, out) => wf(dir, `a${i}.json`, { usage: { inputTokens: inp, outputTokens: out, totalTokens: inp + out }, inputSemantics: 'includes-cache', calls: 1 });
    const rec1 = await runJson(['budget', 'reconcile', '--estimate', wf(dir, 'e1.json', est1), '--actual', actual(1, 500, 50), '--history', hist]);
    assert.equal(rec1.sample.baselineExpected.inputTokens, 1000); // 比率分母=baseline，非预测值
    assert.equal(rec1.estimate.baseline.inputTokens.source, 'baselineTokens');
    const est2 = await runJson(['budget', 'estimate', '--spec', specPath, '--history', hist, '--json']);
    assert.equal(est2.tokens.inputTokens.median, 500); // 第 1 次校准后预测 500
    assert.equal(est2.tokens.outputTokens.median, 50);
    assert.equal(est2.baselineTokens.inputTokens.median, 1000); // baseline 不随校准变化
    await runJson(['budget', 'reconcile', '--estimate', wf(dir, 'e2.json', est2), '--actual', actual(2, 500, 50), '--history', hist]);
    const est3 = await runJson(['budget', 'estimate', '--spec', specPath, '--history', hist, '--json']);
    assert.equal(est3.tokens.inputTokens.median, 500); // 第 2、3 次仍是 500/50，绝不回弹到 750
    assert.equal(est3.tokens.outputTokens.median, 50);
    await runJson(['budget', 'reconcile', '--estimate', wf(dir, 'e3.json', est3), '--actual', actual(3, 500, 50), '--history', hist]);
    const est4 = await runJson(['budget', 'estimate', '--spec', specPath, '--history', hist, '--json']);
    assert.equal(est4.tokens.inputTokens.median, 500); // 第 3 次重复样本后依旧稳定
    // 变动 actual（独立历史）：ratios [0.5, 0.7] → 中位 0.6 → 600
    const spec2 = wf(dir, 'spec2.json', { schemaVersion: 1, id: 'cal-loop2', taskKind: 'text-implementation', model: { name: 'm-loop2' }, mode: 'model', expectedCalls: 1, initialContextTokens: 1000, perCallOutputTokens: 100, perCallToolResultTokens: 0, cacheHitRatio: 0 });
    const hist2 = path.join(dir, 'h2.jsonl');
    const estA = await runJson(['budget', 'estimate', '--spec', spec2, '--json']);
    await runJson(['budget', 'reconcile', '--estimate', wf(dir, 'ea.json', estA), '--actual', actual(5, 500, 50), '--history', hist2]);
    const estB = await runJson(['budget', 'estimate', '--spec', spec2, '--history', hist2, '--json']);
    await runJson(['budget', 'reconcile', '--estimate', wf(dir, 'eb.json', estB), '--actual', actual(6, 700, 70), '--history', hist2]);
    const estC = await runJson(['budget', 'estimate', '--spec', spec2, '--history', hist2, '--json']);
    assert.equal(estC.tokens.inputTokens.median, 600); // median(0.5, 0.7)=0.6
    assert.equal(estC.calibration.appliedFactors.inputTokens, 0.6);
    assert.equal(estC.calibration.samplesUsed, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('factor=0 是合法校准（实耗 0 → 预测 0），不被当“无校准”跳过', async () => {
  const dir = tmp();
  try {
    const specPath = wf(dir, 'spec.json', {
      schemaVersion: 1, id: 'cal-zero', taskKind: 'text-implementation', model: { name: 'm-zero' }, mode: 'model',
      expectedCalls: 1, initialContextTokens: 1000, perCallOutputTokens: 100, perCallToolResultTokens: 0, cacheHitRatio: 0,
    });
    const hist = path.join(dir, 'h.jsonl');
    const est1 = await runJson(['budget', 'estimate', '--spec', specPath, '--json']);
    await runJson(['budget', 'reconcile', '--estimate', wf(dir, 'e1.json', est1), '--actual', wf(dir, 'a.json', { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, inputSemantics: 'includes-cache', calls: 1 }), '--history', hist]);
    const est2 = await runJson(['budget', 'estimate', '--spec', specPath, '--history', hist, '--json']);
    assert.equal(est2.calibration.appliedFactors.inputTokens, 0);
    assert.equal(est2.tokens.inputTokens.median, 0); // 校准到 0，而非跳过校准返回 1000
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧估算文件：有 applied 因子可还原 baseline；旧历史记录无 baseline 明示不参与校准', async () => {
  const dir = tmp();
  try {
    const specPath = wf(dir, 'spec.json', {
      schemaVersion: 1, id: 'cal-legacy', taskKind: 'text-implementation', model: { name: 'm-leg' }, mode: 'model',
      expectedCalls: 1, initialContextTokens: 1000, perCallOutputTokens: 100, perCallToolResultTokens: 0, cacheHitRatio: 0,
    });
    // 旧格式估算文件：无 baselineTokens/calibration，但有 confidence.history.inputRatio.factor=0.5 与校准后 median=500
    const legacyEst = {
      ...await runJson(['budget', 'estimate', '--spec', specPath, '--json']),
    };
    delete legacyEst.baselineTokens; delete legacyEst.calibration;
    legacyEst.tokens = { ...legacyEst.tokens, inputTokens: { low: 500, median: 500, high: 500 } };
    legacyEst.confidence = { ...legacyEst.confidence, history: { samples: 1, inputRatio: { factor: 0.5, count: 1 } } };
    const rec = await runJson(['budget', 'reconcile', '--estimate', wf(dir, 'le.json', legacyEst), '--actual', wf(dir, 'a.json', { usage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 }, inputSemantics: 'includes-cache', calls: 1 }), '--json']);
    assert.equal(rec.estimate.baseline.inputTokens.source, 'reconstructed-from-applied-factor');
    assert.equal(rec.sample.baselineExpected.inputTokens, 1000); // 500 ÷ 0.5 还原 raw=1000
    // 旧历史记录（只有 expected、无 baselineExpected）：明示 legacy、不参与校准、不假定 expected 为 raw
    const hist = wf(dir, 'h.jsonl', JSON.stringify({ kind: 'token-budget-calibration', schemaVersion: 1, model: 'm-leg', taskKind: 'text-implementation', expected: { inputTokens: 1000 }, actual: { inputTokens: 500 } }));
    const est = await runJson(['budget', 'estimate', '--spec', specPath, '--history', hist, '--json']);
    assert.equal(est.tokens.inputTokens.median, 1000); // 未被旧记录校准
    assert.equal(est.confidence.history.legacySamplesWithoutBaseline, 1);
    assert.match(est.confidence.history.note, /baselineExpected/);
    // 无任何因子信息的旧估算文件 → baseline missing，样本带 null 并明示
    const bareEst = await runJson(['budget', 'estimate', '--spec', specPath, '--json']);
    delete bareEst.baselineTokens; delete bareEst.calibration; delete bareEst.confidence.history;
    const rec2 = await runJson(['budget', 'reconcile', '--estimate', wf(dir, 'be.json', bareEst), '--actual', wf(dir, 'a2.json', { usage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 }, inputSemantics: 'includes-cache', calls: 1 }), '--json']);
    assert.equal(rec2.estimate.baseline.inputTokens.source, 'missing');
    assert.equal(rec2.sample.baselineExpected.inputTokens, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('用法：budget 缺子命令/缺必填 flag/未知 flag 按用法错误退出 2', async () => {
  assert.equal((await run(['budget'])).code, 2);
  assert.equal((await run(['budget', 'estimate'])).code, 2);
  assert.match((await run(['budget', 'estimate'])).stderr, /--spec/);
  assert.match((await run(['budget', 'reconcile', '--estimate', '/tmp/x'])).stderr, /--actual/);
  assert.match((await run(['budget', 'frobnicate'])).stderr, /未知位置参数|子命令/);
  assert.match((await run(['budget', 'estimate', '--spec', '/tmp/s.json', '--wat'])).stderr, /不支持 --wat/);
  const help = await run(['help']);
  assert.ok(help.stdout.includes('budget estimate'));
});
