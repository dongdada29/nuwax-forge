// lib/budget/guard.mjs —— 宿主 Codex 会话 token 守卫（phase gate）：解析会话 JSONL 的
// event_msg token_count 事件（取 total_token_usage 最后值），按可选 marker 起点计算宿主
// 自差额 + 匹配 session_meta source.subagent.thread_spawn.parent_thread_id 的 worker 会话
// 合计，与预算相位阈值（stopBeforeTotalTokens / parentTokens / executorTokens /
// acceptanceReserveTokens / wallMinutes）比对。离线、0 次模型调用、不联网、只读显式
// 给出的文件；token 归一口径复用 actual.mjs 的 parseActual（includes-cache：total =
// input + output，cached 为输入子集不重复加），不写第二套公式。
// 诚实边界：只读到快照内的数据——最后一个 token_count 之后的尾部与在途调用未知；
// 这是相位门（phase gate），不是供应商硬顶（no provider hard cap）。
import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { BudgetDataError, isFiniteNonNegative } from './core.mjs';
import { parseActual } from './actual.mjs';

const r3 = x => Math.round(x * 1000) / 1000;
const ZERO_USAGE = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };

export const GUARD_WARNING = 'snapshot tail and in-flight calls unknown; phase gate, not provider hard cap'
  + '（仅计至最后一个 token_count 快照：其后尾部与在途调用未知；按相位阈值停止派发新工作，非供应商硬顶）';
export const MEASUREMENT_NOTE = 'sum input+output including cache subset（cached 为输入子集，不重复累加）'
  + '；宿主自 marker 起差额 + parent_thread_id 匹配 worker 会话合计';

// —— 预算 JSON（结构参照 budget_snapshot.py 内嵌 budget 字段）——
function needBudgetNumber(raw, field, { required = false } = {}) {
  const v = raw[field];
  if (v === undefined || v === null) {
    if (required) throw new BudgetDataError(`budget.${field} 必填（有限非负数）`);
    return null;
  }
  if (!isFiniteNonNegative(v)) throw new BudgetDataError(`budget.${field} 必须为有限非负数（收到 ${JSON.stringify(v)}）`);
  return v;
}

export function parseGuardBudget(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BudgetDataError('budget 必须是 JSON 对象');
  const budget = {
    totalTokens: needBudgetNumber(raw, 'totalTokens', { required: true }),
    stopBeforeTotalTokens: needBudgetNumber(raw, 'stopBeforeTotalTokens', { required: true }),
    parentTokens: needBudgetNumber(raw, 'parentTokens'),
    executorTokens: needBudgetNumber(raw, 'executorTokens'),
    acceptanceReserveTokens: needBudgetNumber(raw, 'acceptanceReserveTokens'),
    wallMinutes: needBudgetNumber(raw, 'wallMinutes'),
  };
  if (budget.stopBeforeTotalTokens > budget.totalTokens) {
    throw new BudgetDataError(`budget.stopBeforeTotalTokens(${budget.stopBeforeTotalTokens}) 不得大于 budget.totalTokens(${budget.totalTokens})`);
  }
  if (budget.acceptanceReserveTokens != null && budget.acceptanceReserveTokens > budget.totalTokens) {
    throw new BudgetDataError(`budget.acceptanceReserveTokens(${budget.acceptanceReserveTokens}) 不得大于 budget.totalTokens(${budget.totalTokens})`);
  }
  if (raw.measurement !== undefined && raw.measurement !== null && typeof raw.measurement !== 'string') {
    throw new BudgetDataError('budget.measurement 必须为字符串（口径声明，可选）');
  }
  return { ...budget, measurement: typeof raw.measurement === 'string' ? raw.measurement : null };
}

// —— 归一口径：复用 actual.mjs 的规范 usage JSON 解析（includes-cache）——
// 构造 snake 风格 usage 交给 parseActual：强校验 input+output=total、cached⊆input，
// 输出归一后的 usage（totalTokens = 含缓存读的 input + output）。绝不另写第二套公式。
function normalizeUsage(snapshot, { segment }) {
  const raw = {
    usage: {
      input_tokens: snapshot.input_tokens ?? null,
      output_tokens: snapshot.output_tokens ?? null,
      cached_tokens: snapshot.cached_input_tokens ?? null,
      total_tokens: snapshot.total_tokens ?? null,
    },
    inputSemantics: 'includes-cache', // Codex/OpenAI 口径：input_tokens 已含 cached（子集）
    usageScope: segment ? 'run-segment' : 'session-cumulative',
  };
  const usage = parseActual(raw).usage;
  if (usage.inputTokens == null || usage.outputTokens == null || usage.totalTokens == null) {
    throw new BudgetDataError(`token_count 快照缺必要数字（input/output/total），无法归一：${JSON.stringify(snapshot)}`);
  }
  return {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cachedReadTokens: usage.cachedReadTokens, totalTokens: usage.totalTokens,
  };
}

function usableUsage(u) {
  return u !== null && typeof u === 'object' && !Array.isArray(u)
    && ['input_tokens', 'output_tokens', 'total_tokens'].every(k => isFiniteNonNegative(u[k]))
    && (u.cached_input_tokens == null || isFiniteNonNegative(u.cached_input_tokens))
    && (u.reasoning_output_tokens == null || isFiniteNonNegative(u.reasoning_output_tokens));
}

// —— 会话 JSONL 解析（新逻辑，token 归一仍走 actual.mjs）——
// 坏行容错：JSON 解析失败的行计入 badLines，不中断、不伪 0。
export function scanSession(file, { marker = null } = {}) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { throw new BudgetDataError(`会话文件不可读：${file}（${e.message}）`); }
  const out = {
    file, metaId: null, parentThreadId: null, agentPath: null, sessionStart: null,
    tokenCountEvents: 0, responses: 0, toolCalls: 0, badLines: 0,
    markerFound: marker == null, startedAt: null,
    baselineUsage: marker == null ? { ...ZERO_USAGE } : null,
    latestUsage: null, latestAt: null,
  };
  let started = marker == null; // 无 marker：从会话头计量（基线为 0）
  let lastUsage = null, lastAt = null, firstParsed = null, baselineAt = null;
  const seenPairs = new Set();
  const lines = String(text).split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineText = lines[idx];
    if (!lineText.trim()) continue;
    let d;
    try { d = JSON.parse(lineText); } catch { out.badLines++; continue; }
    if (d === null || typeof d !== 'object' || Array.isArray(d)) { out.badLines++; continue; }
    if (firstParsed === null) firstParsed = d;
    const p = d.payload;
    const payload = p !== null && typeof p === 'object' && !Array.isArray(p) ? p : {};
    // marker 起点：event_msg user_message 或 response_item role=user 的文本命中即开始计量；
    // 基线 = marker 前最后一个 token_count 快照（此前无事件则按 0 基线）。
    if (!started) {
      let t = '';
      if (d.type === 'event_msg' && payload.type === 'user_message') t = typeof payload.message === 'string' ? payload.message : '';
      if (d.type === 'response_item' && payload.role === 'user' && Array.isArray(payload.content)) {
        t = payload.content.filter(c => c && typeof c === 'object' && typeof c.text === 'string').map(c => c.text).join('');
      }
      if (t && marker != null && t.includes(marker)) {
        started = true;
        out.markerFound = true;
        out.startedAt = typeof d.timestamp === 'string' ? d.timestamp : null;
        out.baselineUsage = lastUsage ? { ...lastUsage } : { ...ZERO_USAGE };
        baselineAt = lastUsage ? lastAt : null;
      }
    }
    if (d.type === 'event_msg' && payload.type === 'token_count') {
      const info = payload.info !== null && typeof payload.info === 'object' && !Array.isArray(payload.info) ? payload.info : {};
      const u = info.total_token_usage;
      if (u !== null && typeof u === 'object' && !Array.isArray(u)) {
        out.tokenCountEvents++;
        lastUsage = u;
        lastAt = typeof d.timestamp === 'string' ? d.timestamp : null;
        if (started) seenPairs.add(`${u.input_tokens}|${u.output_tokens}`);
      }
    }
    if (started && d.type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) out.toolCalls++;
  }
  if (firstParsed !== null) {
    const fp = firstParsed.payload;
    const payload = fp !== null && typeof fp === 'object' && !Array.isArray(fp) ? fp : {};
    const src = payload.source !== null && typeof payload.source === 'object' && !Array.isArray(payload.source) ? payload.source : {};
    const spawn = src.subagent !== null && typeof src.subagent === 'object' && src.subagent.thread_spawn !== null
      && typeof src.subagent.thread_spawn === 'object' ? src.subagent.thread_spawn : {};
    out.metaId = typeof payload.id === 'string' ? payload.id : null;
    out.parentThreadId = typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id : null;
    out.agentPath = typeof spawn.agent_path === 'string' ? spawn.agent_path : null;
    out.sessionStart = typeof payload.timestamp === 'string' ? payload.timestamp
      : (typeof firstParsed.timestamp === 'string' ? firstParsed.timestamp : null);
  }
  out.latestUsage = lastUsage;
  out.latestAt = lastAt;
  out.responses = seenPairs.size;
  if (marker != null) out.baselineAt = baselineAt;
  return out;
}

// —— 文件发现 ——
function listSessionFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { recursive: true }); }
  catch (e) { throw new BudgetDataError(`--sessions 目录不可读：${dir}（${e.message}）`); }
  return entries.filter(n => String(n).endsWith('.jsonl')).map(n => path.resolve(dir, String(n))).sort();
}

// 只读首行取 session_meta（避免为找宿主整读全部会话文件）
function readMetaLine(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString('utf8', 0, n).split(/\r?\n/, 1)[0];
    if (!firstLine.trim()) return { id: null, parentThreadId: null, timestamp: null };
    const d = JSON.parse(firstLine);
    const payload = d && typeof d === 'object' && d.payload !== null && typeof d.payload === 'object' ? d.payload : {};
    const src = payload.source !== null && typeof payload.source === 'object' ? payload.source : {};
    const spawn = src.subagent !== null && typeof src.subagent === 'object' && src.subagent.thread_spawn !== null
      && typeof src.subagent.thread_spawn === 'object' ? src.subagent.thread_spawn : {};
    return {
      id: typeof payload.id === 'string' ? payload.id : null,
      parentThreadId: typeof spawn.parent_thread_id === 'string' ? spawn.parent_thread_id : null,
      timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : null,
    };
  } catch (e) {
    throw new BudgetDataError(`会话文件首行不可解析：${file}（${e.message}）`);
  } finally { closeSync(fd); }
}

// —— 宿主自差额（marker 起点后 last − baseline）——
function deltaUsage(baseline, latest) {
  const out = {};
  for (const f of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']) {
    const b = baseline[f], l = latest[f];
    if (l == null || b == null) { out[f] = null; continue; }
    if (l - b < 0) {
      throw new BudgetDataError(`宿主 token 计数回退（${f}: ${l} < 基线 ${b}）：会话文件可能被截断/重写，拒绝伪造差值`);
    }
    out[f] = l - b;
  }
  return out;
}

function minutesBetween(startTs, endTs) {
  if (typeof startTs !== 'string' || typeof endTs !== 'string') return null;
  const a = Date.parse(startTs), b = Date.parse(endTs);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return r3((b - a) / 60000);
}

// —— 主计算：返回结构化报告（verdict: within | over | unknown；不在此处退进程）——
export function computeGuard({ sessionsPath, budget, marker = null, parentId = null }) {
  const unknowns = [];
  let st;
  try { st = statSync(sessionsPath); }
  catch (e) { throw new BudgetDataError(`--sessions 路径不可访问：${sessionsPath}（${e.message}）`); }

  let hostFile = null, scanned = [];
  if (st.isFile()) {
    hostFile = path.resolve(sessionsPath);
    scanned = listSessionFiles(path.dirname(hostFile));
  } else if (st.isDirectory()) {
    scanned = listSessionFiles(path.resolve(sessionsPath));
    const metas = scanned.map(f => ({ file: f, meta: readMetaLine(f) }));
    let hostMeta = null;
    if (parentId != null) {
      const hits = metas.filter(m => m.meta.id === parentId);
      if (hits.length === 1) hostMeta = hits[0];
      else if (hits.length === 0) unknowns.push(`--parent-id ${parentId} 在目录中未找到对应宿主会话`);
      else unknowns.push(`--parent-id ${parentId} 命中 ${hits.length} 个会话文件（id 应唯一）`);
    } else {
      const cands = metas.filter(m => m.meta.parentThreadId == null);
      if (cands.length === 1) hostMeta = cands[0];
      else if (cands.length === 0) unknowns.push('目录中没有可识别的宿主会话（全部带 parent_thread_id）');
      else unknowns.push(`目录含 ${cands.length} 个非 worker 会话，无法唯一确定宿主；请用 --parent-id <宿主线程 id> 指定`);
    }
    if (hostMeta) hostFile = hostMeta.file;
  } else {
    throw new BudgetDataError(`--sessions 既不是文件也不是目录：${sessionsPath}`);
  }

  const base = {
    ok: true, kind: 'codex-budget-guard', schemaVersion: 1,
    engine: { offline: true, modelCallsUsed: 0 },
    input: { sessions: sessionsPath, marker, parentId, hostFile },
    measurement: MEASUREMENT_NOTE,
    budget, warning: GUARD_WARNING,
  };
  if (!hostFile) {
    return { ...base, verdict: 'unknown', unknowns, checks: [], reasons: ['宿主会话未确定，无计量'], observedTotalTokens: null };
  }

  const host = scanSession(hostFile, { marker });
  if (marker != null && !host.markerFound) {
    // marker 未找到：无法确定计量窗口，不回退整会话伪判（既不 within 放行，也不按错误窗口误报超限）
    unknowns.push(`marker 文本未在宿主会话中找到（${JSON.stringify(marker)}），无法确定计量起点`);
    return {
      ...base,
      host: { file: host.file, threadId: host.metaId, start: null, latestAt: host.latestAt,
        responses: host.responses, toolCalls: host.toolCalls, tokenCountEvents: host.tokenCountEvents,
        badLines: host.badLines, baselineTokens: null, ownTokens: null },
      workers: [], workersTotalTokens: 0, workersSkippedPreStart: 0,
      observedTotalTokens: null, wall: { start: null, end: host.latestAt, minutesUsed: null, budgetMinutes: budget.wallMinutes },
      checks: [], verdict: 'unknown', reasons: [], unknowns,
    };
  }
  if (host.latestUsage == null) unknowns.push('宿主会话无 token_count 事件：实耗不可测（unknown ≠ 0，不放行）');
  else if (!usableUsage(host.latestUsage)) unknowns.push('宿主最后一个 token_count 快照缺必要数字（input/output/total），无法归一');
  if (host.metaId == null) unknowns.push('宿主会话首行缺 session id：无法按 parent_thread_id 匹配 worker（worker 合计 unknown ≠ 0）');
  // 坏行容错：跳过并计数（host.badLines），不中断也不伪 0；计量以最后一个可用 token_count 快照为准

  // worker 会话：parent_thread_id 匹配宿主；marker 模式下只计 marker 之后 spawn 的会话
  const startTs = marker != null ? host.startedAt : host.sessionStart;
  const workers = [];
  let workersTotalTokens = 0;
  let workersSkippedPreStart = 0;
  if (host.metaId != null) {
    for (const f of scanned) {
      if (path.resolve(f) === path.resolve(hostFile)) continue;
      const meta = readMetaLine(f);
      if (meta.parentThreadId !== host.metaId) continue;
      if (startTs != null && meta.timestamp != null && meta.timestamp < startTs) { workersSkippedPreStart++; continue; }
      const w = scanSession(f, { marker: null });
      if (w.latestUsage == null || !usableUsage(w.latestUsage)) {
        unknowns.push(`worker 会话 ${path.basename(f)} 无可用 token_count 快照：其消耗 unknown ≠ 0`);
        workers.push({ file: f, threadId: w.metaId, agentPath: w.agentPath, startedAt: w.sessionStart,
          latestAt: w.latestAt, responses: w.responses, tokenCountEvents: w.tokenCountEvents, badLines: w.badLines, tokens: null });
        continue;
      }
      const tokens = normalizeUsage(w.latestUsage, { segment: true });
      workersTotalTokens += tokens.totalTokens;
      workers.push({ file: f, threadId: w.metaId, agentPath: w.agentPath, startedAt: w.sessionStart,
        latestAt: w.latestAt, responses: w.responses, tokenCountEvents: w.tokenCountEvents, badLines: w.badLines, tokens });
    }
  }

  // 宿主自差额 + 归一
  let hostOwn = null;
  const baselineUsable = host.baselineUsage == null || usableUsage(host.baselineUsage);
  if (host.latestUsage != null && usableUsage(host.latestUsage) && baselineUsable) {
    hostOwn = normalizeUsage(deltaUsage(host.baselineUsage ?? ZERO_USAGE, host.latestUsage), { segment: marker != null });
  } else if (host.latestUsage != null && usableUsage(host.latestUsage)) {
    unknowns.push('宿主基线快照缺必要数字，无法计算 marker 起自差额');
  }
  const hostTotal = hostOwn != null ? hostOwn.totalTokens : null;
  const observedTotalTokens = hostTotal != null ? r3(hostTotal + workersTotalTokens) : null;

  // 墙钟：marker/会话起点 → 最后一次 token_count；测不出则 unknown（不按 0）
  const wallMinutesUsed = minutesBetween(startTs, host.latestAt);
  if (budget.wallMinutes != null && wallMinutesUsed == null) {
    unknowns.push('wallMinutes 已设但时间窗不可测（缺起点/终点时间戳或不可解析）：墙钟维度 unknown ≠ 0');
  }

  // 相位阈值检查（phase gate）：确定性超限即可行动；unknown 只阻止"判定通过"
  const checks = [];
  if (observedTotalTokens != null && budget.stopBeforeTotalTokens != null) {
    checks.push({ id: 'stop-before-total', thresholdTokens: budget.stopBeforeTotalTokens, observedTokens: observedTotalTokens,
      breached: observedTotalTokens >= budget.stopBeforeTotalTokens, note: 'observed ≥ stopBefore → 停止派发新工作' });
  }
  if (hostTotal != null && budget.parentTokens != null) {
    checks.push({ id: 'parent-phase', thresholdTokens: budget.parentTokens, observedTokens: hostTotal,
      breached: hostTotal >= budget.parentTokens, note: '宿主自差额 ≥ parentTokens → 宿主相位到顶' });
  }
  if (host.metaId != null && budget.executorTokens != null) {
    checks.push({ id: 'executor-phase', thresholdTokens: budget.executorTokens, observedTokens: r3(workersTotalTokens),
      breached: workersTotalTokens >= budget.executorTokens, note: 'worker 合计 ≥ executorTokens → 执行器相位到顶' });
  }
  if (budget.acceptanceReserveTokens != null) {
    const line = r3(budget.totalTokens - budget.acceptanceReserveTokens);
    if (observedTotalTokens != null) {
      checks.push({ id: 'acceptance-reserve', thresholdTokens: line, observedTokens: observedTotalTokens,
        breached: observedTotalTokens > line, note: `observed > total(${budget.totalTokens}) − reserve(${budget.acceptanceReserveTokens}) → 已占用验收预留` });
    }
  }
  if (budget.wallMinutes != null && wallMinutesUsed != null) {
    checks.push({ id: 'wall-minutes', thresholdMinutes: budget.wallMinutes, observedMinutes: wallMinutesUsed,
      breached: wallMinutesUsed > budget.wallMinutes, note: '墙钟超限 → 停止派发新工作' });
  }

  const reasons = checks.filter(c => c.breached)
    .map(c => `[${c.id}] ${c.observedTokens != null ? `observed ${c.observedTokens} ≥/超过 阈值 ${c.thresholdTokens ?? c.thresholdMinutes}`
      : `observed ${c.observedMinutes} > 阈值 ${c.thresholdMinutes}`}`);
  // 判定：确定性超限（over）优先于 unknown——超限可立即止损；unknown 阻断 within 放行
  let verdict = 'within';
  if (unknowns.length) verdict = 'unknown';
  if (reasons.length) verdict = 'over';

  return {
    ...base,
    host: {
      file: host.file, threadId: host.metaId, start: startTs, latestAt: host.latestAt,
      responses: host.responses, toolCalls: host.toolCalls, tokenCountEvents: host.tokenCountEvents, badLines: host.badLines,
      baselineTokens: host.baselineUsage, ownTokens: hostOwn,
    },
    workers, workersTotalTokens: r3(workersTotalTokens), workersSkippedPreStart,
    observedTotalTokens, wall: { start: startTs, end: host.latestAt, minutesUsed: wallMinutesUsed, budgetMinutes: budget.wallMinutes },
    checks, verdict, reasons, unknowns,
  };
}

export function humanGuard(r) {
  const head = r.observedTotalTokens != null
    ? `observed ${r.observedTotalTokens} = 宿主 ${r.host?.ownTokens?.totalTokens ?? 'unknown'} + workers ${r.workersTotalTokens}（stopBefore ${r.budget.stopBeforeTotalTokens}）`
    : 'observed unknown（数据不足）';
  return [
    `guard verdict=${r.verdict}${r.host?.threadId ? `（宿主 ${r.host.threadId}，workers ${r.workers.length} 个）` : ''}：${head}`,
    ...r.checks.map(c => `  [${c.breached ? '超限' : 'ok ' }] ${c.id}: observed ${c.observedTokens ?? c.observedMinutes} vs 阈值 ${c.thresholdTokens ?? c.thresholdMinutes}`),
    ...r.unknowns.map(u => `  [unknown] ${u}`),
    `warning: ${r.warning}`,
  ].join('\n');
}
