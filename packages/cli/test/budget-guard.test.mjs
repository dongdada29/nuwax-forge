// budget guard 测试：真实 CLI 子进程 + 临时目录生成的伪造（脱敏）codex 会话 JSONL。
// 绝不读取 ~/.codex 真实会话；0 次模型调用、0 网络。覆盖：正常通过、超限非 0、
// worker 汇总与过滤、缺 token_count（unknown 非 0）、坏行容错、marker 未找到、
// 预算 JSON 非法、目录多宿主歧义与 --parent-id、human 输出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'budget-guard-test-'));

// —— 脱敏 fixture 构造：编造的 session_meta / token_count / user_message / tool call ——
const HOST_ID = 'host-thread-0001';
const T0 = '2026-10-28T01:50:00.000Z', T1 = '2026-10-28T01:55:00.000Z', T2 = '2026-10-28T02:00:00.000Z';
const T3 = '2026-10-28T02:05:00.000Z', T4 = '2026-10-28T02:08:00.000Z', T5 = '2026-10-28T02:10:00.000Z';
const MARKER = '总消耗还是太高，继续压宿主上下文';

const metaLine = (id, ts, parentId = null, agentPath = null) => ({
  type: 'session_meta', timestamp: ts,
  payload: parentId == null
    ? { id, timestamp: ts }
    : { id, timestamp: ts, source: { subagent: { thread_spawn: { parent_thread_id: parentId, ...(agentPath ? { agent_path: agentPath } : {}) } } } },
});
const tokenLine = (ts, u) => ({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: u } } });
const userMsgLine = (ts, text) => ({ type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: text } });
const toolCallLine = ts => ({ type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'shell' } });
const u = (inp, cached, out, reason) => ({ input_tokens: inp, cached_input_tokens: cached, output_tokens: out, reasoning_output_tokens: reason, total_tokens: inp + out });

// 宿主：marker 前基线 total 1000（800+200），marker 后最后 total 2500（2000+500）→ 自差 1500（1200+300）
function writeHostSession(dir, { name = `rollout-${HOST_ID}.jsonl`, badLines = false } = {}) {
  const lines = [
    metaLine(HOST_ID, T0),
    tokenLine(T1, u(800, 700, 200, 100)),
    userMsgLine(T2, `前一轮内容。${MARKER}。后续开始计量`),
    tokenLine(T3, u(1800, 1500, 450, 250)),
    ...(badLines ? ['{ 这是一行坏 JSON 不完整'] : []),
    toolCallLine(T4),
    tokenLine(T5, u(2000, 1600, 500, 300)),
    ...(badLines ? ['另一坏行 [[['] : []),
  ];
  const p = path.join(dir, name);
  writeFileSync(p, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
}
// worker：parent_thread_id 匹配宿主，marker 之后 spawn，total 400（300+100）
function writeWorkerSession(dir, { id = 'worker-thread-a', parentId = HOST_ID, ts = T3, usage = u(300, 100, 100, 50), name = `rollout-${id}.jsonl` } = {}) {
  const p = path.join(dir, name);
  writeFileSync(p, [metaLine(id, ts, parentId, '/root/client_end_to_end'), tokenLine(T4, usage)]
    .map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const BASE_BUDGET = {
  totalTokens: 100000, parentTokens: 2000, executorTokens: 1000,
  acceptanceReserveTokens: 5000, stopBeforeTotalTokens: 80000, wallMinutes: 60,
  measurement: 'sum input+output including cache subset; reasoning is output subset; phase gate, not provider hard cap',
};
const wf = (dir, name, obj) => { const p = path.join(dir, name); writeFileSync(p, JSON.stringify(obj)); return p; };

test('guard：marker 自差 + worker 合计均在相位阈值内 → exit 0（--json 结构化）', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir);
    writeWorkerSession(dir); // 400
    const r = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'budget.json', BASE_BUDGET), '--marker', MARKER, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.equal(g.kind, 'codex-budget-guard');
    assert.equal(g.engine.modelCallsUsed, 0); // 离线、0 模型调用
    assert.equal(g.verdict, 'within');
    assert.equal(g.host.threadId, HOST_ID);
    assert.equal(g.host.ownTokens.inputTokens, 1200); // 2000−800，含缓存读口径
    assert.equal(g.host.ownTokens.outputTokens, 300); // 500−200
    assert.equal(g.host.ownTokens.totalTokens, 1500); // input+output，cached 不重复加
    assert.equal(g.host.ownTokens.cachedReadTokens, 900); // 1600−700（输入子集）
    assert.equal(g.host.responses, 2); // marker 后唯一 (input,output) 对
    assert.equal(g.host.toolCalls, 1);
    assert.equal(g.workers.length, 1);
    assert.equal(g.workers[0].threadId, 'worker-thread-a');
    assert.equal(g.workers[0].tokens.totalTokens, 400);
    assert.equal(g.workersTotalTokens, 400);
    assert.equal(g.observedTotalTokens, 1900); // 1500 + 400
    assert.ok(g.wall.minutesUsed > 0 && g.wall.minutesUsed <= 60);
    assert.ok(g.checks.every(c => !c.breached));
    assert.match(g.warning, /phase gate, not provider hard cap/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：observed ≥ stopBeforeTotalTokens → verdict over、exit 2、结构化原因', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir);
    writeWorkerSession(dir);
    const r = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'budget.json', { ...BASE_BUDGET, stopBeforeTotalTokens: 1500 }), '--marker', MARKER, '--json']);
    assert.equal(r.code, 2, `stderr=${r.stderr}`);
    const g = JSON.parse(r.stdout);
    assert.equal(g.verdict, 'over');
    assert.ok(g.reasons.some(x => x.includes('stop-before-total')));
    const stop = g.checks.find(c => c.id === 'stop-before-total');
    assert.equal(stop.observedTokens, 1900);
    assert.equal(stop.thresholdTokens, 1500);
    assert.equal(stop.breached, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：worker 合计 ≥ executorTokens 相位到顶 → exit 2（worker 汇总生效）', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir);
    writeWorkerSession(dir, { id: 'w-a', usage: u(600, 200, 200, 100) }); // 800
    writeWorkerSession(dir, { id: 'w-b', ts: T4, usage: u(200, 0, 100, 0) }); // 300 → 合计 1100
    const r = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'budget.json', { ...BASE_BUDGET, executorTokens: 1000 }), '--marker', MARKER, '--json']);
    assert.equal(r.code, 2, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.equal(g.workersTotalTokens, 1100);
    assert.equal(g.observedTotalTokens, 2600);
    assert.ok(g.checks.find(c => c.id === 'executor-phase').breached);
    assert.ok(g.reasons.some(x => x.includes('executor-phase')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：worker 按 parent_thread_id 匹配，且排除 marker 之前 spawn 与他人 worker', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir);
    writeWorkerSession(dir, { id: 'w-match', usage: u(300, 100, 100, 50) }); // 匹配且 marker 后
    writeWorkerSession(dir, { id: 'w-other-parent', parentId: 'other-host-999', usage: u(9999, 0, 9999, 0) }); // 他人 worker：排除
    writeWorkerSession(dir, { id: 'w-pre-start', ts: T1, usage: u(5000, 0, 5000, 0) }); // marker 前 spawn：排除
    const r = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'budget.json', BASE_BUDGET), '--marker', MARKER, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.deepEqual(g.workers.map(w => w.threadId), ['w-match']);
    assert.equal(g.workersSkippedPreStart, 1);
    assert.equal(g.observedTotalTokens, 1900); // 不含 9999/5000 的干扰
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：宿主缺 token_count 事件 → 数据不足 unknown、exit 3（unknown ≠ 0）', async () => {
  const dir = tmp();
  try {
    const p = path.join(dir, 'rollout-empty.jsonl');
    writeFileSync(p, [metaLine(HOST_ID, T0), userMsgLine(T2, MARKER)].map(l => JSON.stringify(l)).join('\n') + '\n');
    const r = await run(['budget', 'guard', '--sessions', p, '--budget', wf(dir, 'budget.json', BASE_BUDGET), '--marker', MARKER, '--json']);
    assert.equal(r.code, 3, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.equal(g.verdict, 'unknown');
    assert.equal(g.observedTotalTokens, null);
    assert.ok(g.unknowns.some(x => /token_count/.test(x)));
    assert.ok(g.checks.every(c => c != null && !c.breached) || g.checks.length === 0); // unknown 不放行也不伪造超限
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：marker 未在会话中找到 → unknown、exit 3', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir);
    const r = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'budget.json', BASE_BUDGET), '--marker', '不存在的起点标记', '--json']);
    assert.equal(r.code, 3, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.equal(g.verdict, 'unknown');
    assert.ok(g.unknowns.some(x => /marker/.test(x)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：坏行容错——跳过坏 JSON 行仍完成计量（exit 0）并如实计数', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir, { badLines: true });
    writeWorkerSession(dir);
    const r = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'budget.json', BASE_BUDGET), '--marker', MARKER, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.equal(g.verdict, 'within');
    assert.equal(g.host.badLines, 2); // 容错计数，不隐吞
    assert.equal(g.host.ownTokens.totalTokens, 1500); // 计量不受坏行影响（以最后可用快照为准）
    assert.equal(g.observedTotalTokens, 1900);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：无 marker 时按整会话计量（基线 0，worker 不按时间排除）', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir);
    writeWorkerSession(dir, { id: 'w-early', ts: T1, usage: u(100, 0, 50, 0) }); // 无 marker：早期 worker 也计入
    const r = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'budget.json', { ...BASE_BUDGET, parentTokens: 3000 }), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const g = JSON.parse(r.stdout);
    assert.equal(g.host.ownTokens.totalTokens, 2500); // 整会话最后值（2000+500），基线 0
    assert.equal(g.workersTotalTokens, 150);
    assert.equal(g.observedTotalTokens, 2650);
    assert.equal(g.workersSkippedPreStart, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：目录多宿主歧义 → unknown exit 3；--parent-id 显式指定后通过', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir);
    writeWorkerSession(dir);
    writeWorkerSession(dir, { id: 'host-thread-0002', parentId: null, usage: u(10, 0, 5, 0), name: 'rollout-host2.jsonl' }); // 另一宿主
    const r1 = await run(['budget', 'guard', '--sessions', dir, '--budget', wf(dir, 'budget.json', BASE_BUDGET), '--marker', MARKER, '--json']);
    assert.equal(r1.code, 3, r1.stderr);
    assert.ok(JSON.parse(r1.stdout).unknowns.some(x => /--parent-id/.test(x)));
    const r2 = await run(['budget', 'guard', '--sessions', dir, '--budget', wf(dir, 'budget.json', BASE_BUDGET), '--marker', MARKER, '--parent-id', HOST_ID, '--json']);
    assert.equal(r2.code, 0, r2.stderr);
    const g = JSON.parse(r2.stdout);
    assert.equal(g.host.threadId, HOST_ID);
    assert.equal(g.observedTotalTokens, 1900);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：坏预算 JSON（stopBefore>total / 缺必填 / 非法数字）→ 数据错误 exit 1', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir);
    for (const bad of [
      { ...BASE_BUDGET, stopBeforeTotalTokens: 200000 },
      { parentTokens: 1000 },
      { ...BASE_BUDGET, wallMinutes: -5 },
    ]) {
      const r = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'budget.json', bad), '--json']);
      assert.equal(r.code, 1, `期望 exit 1：${JSON.stringify(bad)}`);
      assert.match(r.stderr, /错误/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard：human 输出与参数拒绝（--spec 属 estimate/reconcile；缺 --sessions 用法错误）', async () => {
  const dir = tmp();
  try {
    const host = writeHostSession(dir);
    writeWorkerSession(dir);
    const human = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'budget.json', BASE_BUDGET), '--marker', MARKER]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /verdict=within/);
    assert.match(human.stdout, /1900/);
    assert.match(human.stdout, /phase gate/);
    const badFlag = await run(['budget', 'guard', '--sessions', host, '--budget', wf(dir, 'b.json', BASE_BUDGET), '--spec', wf(dir, 's.json', {})]);
    assert.equal(badFlag.code, 2); // 用法错误
    const missing = await run(['budget', 'guard', '--budget', wf(dir, 'b.json', BASE_BUDGET)]);
    assert.equal(missing.code, 2);
    const nosub = await run(['budget']);
    assert.equal(nosub.code, 2);
    assert.match(nosub.stderr, /guard/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
