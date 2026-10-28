// 真实 Midscene HTML 报告 → 合成 fixture 提取与跨文件合并（复用 contracts 的 parseFixture 语义）。
// 纯字符串处理：不 eval、不执行 HTML、不访问报告内 URL；损坏 JSON/重复快照/计量冲突都结构化失败。
// script 扫描：**先从左到右整体消耗所有 <script …>…</script> 块，再按解析出的 type 精确过滤**——
// 普通 JS bundle 里模板字符串出现的 `<script type=midscene_web_dump>` 字面量不会被误当真实标签
// （live-state-02 实测踩过：regex 直配模板导致 JSON 解析错位）。attrs 单双引号都认。
// 用途：live driver 的模型观测（callId/usage 去重）与 Boolean 任务交叉核对——不是通过判定的来源，
// 通过判定只来自 driver 本次实际执行的断言值；本模块提供报告侧证据与观测下界。
import { parseFixture } from '@nuwax-ai/devkit-contracts/gui/midscene-report.mjs';

const OPEN_SCRIPT_RE = /<script\b([^>]*)>/gi;

function attrsOf(attrText) {
  const attrs = {};
  for (const m of attrText.matchAll(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]] = m[3] ?? m[2] ?? '';
  return attrs;
}

// 从单份报告 HTML 提取 fixture 形状（供 parseFixture 消费）。返回 {ok, fixture|failures, documentTitle}
export function extractFixtureFromHtml(html, reportId = 'report') {
  if (typeof html !== 'string' || html.length === 0 || html.length > 20 * 1024 * 1024) {
    return { ok: false, failures: ['报告 HTML 为空/缺失或超限（20MB）'], documentTitle: null };
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const documentTitle = titleMatch ? titleMatch[1].trim() : null;
  const scripts = [];
  const failures = [];
  let dumpCount = 0;
  OPEN_SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = OPEN_SCRIPT_RE.exec(html)) !== null) {
    const openEnd = m.index + m[0].length;
    const close = html.indexOf('</script>', openEnd);
    if (close === -1) { failures.push(`报告 ${reportId} 存在未闭合的 script 标签`); break; }
    const attrs = attrsOf(m[1]);
    if (attrs.type === 'midscene_web_dump') {
      dumpCount++;
      try {
        scripts.push({ attributes: { ...attrs, type: 'midscene_web_dump' }, payload: JSON.parse(html.slice(openEnd, close)) });
      } catch (error) {
        failures.push(`报告 ${reportId} 第 ${dumpCount} 个 midscene_web_dump script 载荷不是有效 JSON: ${error.message}`);
      }
    }
    // 整体跳过该 script 块内容（含普通 JS 里的模板字面量），从闭合标签后继续
    OPEN_SCRIPT_RE.lastIndex = close + '</script>'.length;
  }
  if (scripts.length === 0) failures.push(`报告 ${reportId} 不含任何 type=midscene_web_dump script（空报告）`);
  return { ok: failures.length === 0, failures, documentTitle, fixture: { fixtureSchemaVersion: 1, reportId, documentTitle, scripts } };
}

// 合并多份报告快照的模型观测与 Boolean 终态：callId 按 (groupId, callId) 跨文件去重，
// 同一快照复制多份不重复计数；任何计量冲突/缺失 → known=false（观察下界，绝不伪记 0）。
// parsedList 项：extractFixtureFromHtml 的结果（含原始 fixture，usage 由本地从 fixture 重取，
// contracts parseFixture 保持判定语义正本不动）。
function usageCopiesOf(fixture) {
  const copies = [];
  for (const script of fixture?.scripts ?? []) {
    const gid = script.attributes?.['data-group-id'];
    for (const execution of script.payload?.executions ?? []) {
      for (const task of execution.tasks ?? []) {
        for (const usage of [task.usage, task.log?.taskInfo?.usage]) {
          if (usage && typeof usage === 'object') copies.push({ gid, usage });
        }
      }
    }
  }
  return copies;
}

// 单个 usage 副本完整性：正本语义（contracts usageComplete 同款）——callId 非空、
// prompt/completion/total 为非负整数、retry_count 存在且为非负整数。缺 retry 字段=不完整。
function usageCopyComplete(usage) {
  const isCount = v => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  return typeof usage._midscene_call_id === 'string' && usage._midscene_call_id !== ''
    && isCount(usage.prompt_tokens) && isCount(usage.completion_tokens) && isCount(usage.total_tokens)
    && isCount(usage.retry_count);
}

export function mergeObservations(extractedList) {
  const failures = [];
  const anomalies = [];
  const calls = new Map(); // callKey -> sig
  const boolTasks = new Map(); // taskKey -> output
  let promptTokens = 0, completionTokens = 0, totalTokens = 0, orphanUsageCopies = 0, retryObserved = false, incompleteUsage = false;
  for (const ex of extractedList) {
    const parsed = ex.parsed;
    failures.push(...(parsed.failures ?? []));
    anomalies.push(...(parsed.anomalies ?? []));
    // 正本 known=false 必须传递（fixture 级判定已发现不完整时不允许这里又报 known=true）
    if (parsed.modelObservation && parsed.modelObservation.known === false) {
      anomalies.push(`快照观测不完整（正本 parseFixture 判定）: ${parsed.modelObservation.reason ?? '未知原因'}`);
    }
    for (const task of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
      const gid = task.groupId ?? '';
      const tKey = JSON.stringify([gid, task.executionId, task.taskId]);
      if (task.subType === 'Boolean' && typeof task.output === 'boolean') {
        const prev = boolTasks.get(tKey);
        if (prev !== undefined && prev !== task.output) anomalies.push(`Boolean 任务 ${task.taskId} 跨快照终值冲突: ${prev} vs ${task.output}`);
        boolTasks.set(tKey, task.output);
      }
    }
    for (const { gid, usage } of usageCopiesOf(ex.fixture)) {
      const callId = usage._midscene_call_id;
      if (typeof callId !== 'string' || !callId) { orphanUsageCopies++; continue; }
      if (!usageCopyComplete(usage)) incompleteUsage = true; // 缺 retry 字段/负数/非整数都算不完整
      if (typeof usage.retry_count === 'number' && usage.retry_count > 0) retryObserved = true;
      const sig = JSON.stringify([usage.prompt_tokens ?? null, usage.completion_tokens ?? null, usage.total_tokens ?? null, usage.retry_count ?? null]);
      const key = JSON.stringify([gid, callId]);
      if (!calls.has(key)) {
        calls.set(key, sig);
        promptTokens += Number.isInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : 0;
        completionTokens += Number.isInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : 0;
        totalTokens += Number.isInteger(usage.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : 0;
      } else if (calls.get(key) !== sig) {
        anomalies.push(`callId ${callId} 跨快照计量冲突`);
      }
    }
  }
  const known = calls.size > 0 && orphanUsageCopies === 0 && incompleteUsage === false && !retryObserved && anomalies.length === 0;
  return {
    failures, anomalies,
    modelObservation: {
      known,
      reason: known ? null : [calls.size === 0 && '报告中没有 usage 观测', orphanUsageCopies && '存在缺 callId 的 usage 副本', incompleteUsage && '存在缺字段/负数/非整数的 usage（含缺 retry_count）', retryObserved && '观察到 retry_count>0（重试只给请求下界）', anomalies.length && '存在计量冲突或快照级不完整'].filter(Boolean).join('；') || '观测不完整',
      uniqueCalls: calls.size, promptTokens, completionTokens, totalTokens, orphanUsageCopies, retryObserved,
      note: 'known=false 时数值是原始观察下界，不是 0，也不是完整计量；不做传输层硬计量',
    },
    booleanTaskOutputs: [...boolTasks.values()],
  };
}

// 最终判定（纯函数）：严格计量——观测 unknown / 缺报告 / 观测预算超限 / 任一 aiBoolean 步骤
// 无对应报告终态交叉核对，都不能 passed。maxAiOperations（driver 硬中止）与供应商请求观测预算
// 是两回事：后者只是观测口径，超限同样不通过。
export function buildVerdict({ result, timedOut, reportCount, merged, recipe }) {
  const failures = [];
  let status = result?.status ?? 'failed';
  if (timedOut) failures.push('超过 maxWallSeconds，runner 进程组已被硬超时清理（有限清理已尽力，无法保证恢复）');
  if (!result) failures.push('runner 未产出 result.json（异常退出）');
  if (result?.failure) failures.push(result.failure);
  if (result?.scenario?.failure) failures.push(`场景失败: ${result.scenario.failure}`); // 真实原因必须进 failures，不许被"缺报告"掩盖
  if (result?.blockedReason && status !== 'blocked') failures.push(result.blockedReason);
  if (reportCount === 0) failures.push('缺报告：attempt 目录没有任何 Midscene 报告 HTML（严格计量下不通过，不记 unknown 为通过）');
  const aiSteps = (result?.scenario?.steps ?? []).filter(s => s.op === 'aiBoolean');
  for (const step of aiSteps) {
    if (typeof step.actual !== 'boolean') { failures.push(`aiBoolean 步骤 ${step.id} 无实际布尔值，无法交叉核对`); continue; }
    if (!(merged?.booleanTaskOutputs ?? []).includes(step.actual)) {
      failures.push(`报告交叉核对失败：aiBoolean 步骤 ${step.id} 实际值 ${step.actual} 在报告 Boolean 终态中无对应`);
    }
  }
  if (aiSteps.length > 0 && (merged?.booleanTaskOutputs?.length ?? 0) < aiSteps.length) {
    failures.push(`报告 Boolean 终态数量 ${(merged?.booleanTaskOutputs?.length ?? 0)} 少于 ai* 步骤数 ${aiSteps.length}：存在未被报告覆盖的模型调用`);
  }
  if (merged?.anomalies?.length) failures.push(...merged.anomalies.map(a => '证据异常: ' + a));
  if (merged?.failures?.length) failures.push(...merged.failures.map(f => '报告解析失败: ' + f));
  const obs = merged?.modelObservation;
  if (reportCount > 0 && !obs?.known) failures.push(`模型观测不完整（${obs?.reason ?? '无观测'}）：严格计量要求 unknown 不通过；观察下界 uniqueCalls=${obs?.uniqueCalls ?? 0} 不是 0`);
  const budget = recipe?.model?.maxModelRequestsObserved;
  if (typeof budget === 'number' && (obs?.uniqueCalls ?? 0) > budget) {
    failures.push(`模型观测 ${obs.uniqueCalls} 次超过配方观测预算 ${budget}：不通过（观测预算超限不是仅记录项）`);
  }
  if (status === 'passed' && failures.length) status = 'failed';
  if (status === 'blocked' && failures.length === 0) failures.push(result?.blockedReason ?? 'blocked');
  return { status, failures };
}
