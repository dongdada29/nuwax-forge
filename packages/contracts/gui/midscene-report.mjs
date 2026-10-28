// 合成 fixture 校验器（离线）：按脱敏评审文档第 6 节的合并/计量/失败语义实现。
// 输入是 fixture 外壳（fixtureSchemaVersion=1，scripts[].attributes/payload），
// 不是真实 Midscene HTML parser，也没有任何 live 命令；live GUI driver 状态见 gui/levels.mjs（pending）。
// 本模块只做合成 fixture 的结构化判定，**不替代真实 target/login 验证**（未实现，不假装能做）。
// 安全默认：不 eval、不执行 HTML、不访问报告内 URL；输入尺寸/数量受限；
// 任何无效输入（null/错类型/损坏嵌套结构）都返回结构化失败，绝不抛出、不误判通过。
// 断言类型只支持 Boolean/Assert（评审实测字段）；Query 不支持——必需任务声明 Query 一律拒绝，
// 不虚构等值判断。usage 计量只保留原始观察下界：缺字段/负数/非整数/重试/孤儿副本都记不完整（unknown），
// 绝不把 unknown 伪记为 0；known=true 也不表示网络请求硬计量。

const MAX_SCRIPTS = 200;
const MAX_TASKS_PER_EXECUTION = 200;
const MAX_BYTES = 5 * 1024 * 1024;
const SUPPORTED_SUBTYPES = ['Boolean', 'Assert'];
const TERMINAL = new Set(['finished']);
const CROSS_KEY = { Boolean: 'Boolean', Assert: 'StatementIsTruthy' };

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isCount(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// 单个 usage 副本是否构成"完整一致"的观测
function usageComplete(usage) {
  return typeof usage._midscene_call_id === 'string' && usage._midscene_call_id !== ''
    && isCount(usage.prompt_tokens) && isCount(usage.completion_tokens) && isCount(usage.total_tokens)
    && isCount(usage.retry_count) && usage.retry_count === 0;
}

// 早退时的统一默认形状：无论何种失败，summary/modelObservation 字段始终存在，
// 下游（严格计量模式等）不得因缺字段抛 TypeError；known=false + reason 说明"未观察到"。
const NO_OBSERVATION = { known: false, reason: 'fixture 无效或不可解析，没有可消费的 usage 观测', uniqueCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, orphanUsageCopies: 0, retryObserved: false, note: '0 表示本次无效输入中未观察到任何调用，不代表真实执行零模型调用' };

export function parseFixture(input) {
  const failures = [];
  const anomalies = [];
  if (!isPlainObject(input)) return { ok: false, failures: ['fixture 必须是对象（收到 ' + typeof input + '）'], anomalies, tasks: [], documentTitle: null, modelObservation: NO_OBSERVATION };
  if (input.fixtureSchemaVersion !== 1) return { ok: false, failures: [`未知 fixtureSchemaVersion: ${JSON.stringify(input.fixtureSchemaVersion)}`], anomalies, tasks: [], documentTitle: null, modelObservation: NO_OBSERVATION };
  let documentTitle = input.documentTitle ?? null;
  if (documentTitle !== null && typeof documentTitle !== 'string') {
    failures.push(`documentTitle 必须是字符串（收到 ${typeof input.documentTitle}）`);
    documentTitle = null;
  }
  const scripts = input.scripts;
  if (!Array.isArray(scripts) || scripts.length === 0 || scripts.length > MAX_SCRIPTS) {
    return { ok: false, failures: ['scripts 必须是非空数组且不超过 ' + MAX_SCRIPTS], anomalies, tasks: [], documentTitle, modelObservation: NO_OBSERVATION };
  }
  const reportId = typeof input.reportId === 'string' && input.reportId ? input.reportId : 'report';
  const tasks = new Map(); // 身份键 -> 记录
  const calls = new Map(); // callKey -> 首个非空观测
  let usageUnknown = false;
  let orphanUsageCopies = 0;
  let retryObserved = false;
  let incompleteUsage = false;
  for (const script of scripts) {
    if (!isPlainObject(script)) { failures.push('script 项必须是对象'); continue; }
    const attrs = isPlainObject(script.attributes) ? script.attributes : {};
    if (attrs.type !== 'midscene_web_dump') continue; // 只消费精确 type 的惰性文本
    if (!isPlainObject(script.payload)) { anomalies.push('payload 缺失或不可解析'); continue; }
    const payload = script.payload;
    if (payload.sdkVersion !== '1.17.1') anomalies.push(`未知 sdkVersion: ${JSON.stringify(payload.sdkVersion)}（仅实测过 1.17.1 字段）`);
    const groupId = attrs['data-group-id'];
    if (typeof groupId !== 'string' || groupId === '') anomalies.push('script 缺 data-group-id：身份不完整');
    const executions = payload.executions;
    if (!Array.isArray(executions)) { anomalies.push('executions 缺失或不是数组'); continue; }
    for (const execution of executions) {
      if (!isPlainObject(execution) || typeof execution.id !== 'string' || !execution.id) { anomalies.push('execution.id 缺失：身份不完整'); continue; }
      const list = execution.tasks;
      if (!Array.isArray(list) || list.length > MAX_TASKS_PER_EXECUTION) { anomalies.push('tasks 缺失或超限'); continue; }
      for (const task of list) {
        if (!isPlainObject(task) || typeof task.taskId !== 'string' || !task.taskId) { anomalies.push('taskId 缺失'); continue; }
        const key = JSON.stringify([reportId, groupId ?? '', execution.id, task.taskId]);
        const status = task.status;
        if (typeof status !== 'string') { anomalies.push(`任务 ${task.taskId} 缺 status`); continue; }
        if (typeof task.type !== 'string' || typeof task.subType !== 'string') { anomalies.push(`任务 ${task.taskId} 缺 type/subType`); continue; }
        const prev = tasks.get(key);
        if (prev) {
          if (prev.type !== task.type || prev.subType !== task.subType) {
            anomalies.push(`任务 ${task.taskId} 身份内 type/subType 变化: ${prev.type}/${prev.subType} -> ${task.type}/${task.subType}`);
          }
          if (TERMINAL.has(prev.status) && !TERMINAL.has(status)) anomalies.push(`任务 ${task.taskId} finished 后退回 ${status}`);
          if (TERMINAL.has(prev.status) && TERMINAL.has(status)) {
            const a = prev.hasOutput ? JSON.stringify(prev.output) : '<缺失>';
            const b = Object.hasOwn(task, 'output') ? JSON.stringify(task.output) : '<缺失>';
            if (a !== b) anomalies.push(`任务 ${task.taskId} 终态 output 冲突: ${a} vs ${b}`);
          }
        }
        // 交叉核对：Boolean/Assert 的 output 必须与两处交叉值一致（存在且为布尔时）
        if (TERMINAL.has(status) && Object.hasOwn(task, 'output') && typeof task.output === 'boolean') {
          const crossKey = CROSS_KEY[task.subType];
          if (crossKey) {
            const log = isPlainObject(task.log) ? task.log : {};
            const data = isPlainObject(log.data) ? log.data : {};
            const taskInfo = isPlainObject(log.taskInfo) ? log.taskInfo : {};
            const formatResponse = isPlainObject(taskInfo.formatResponse) ? taskInfo.formatResponse : {};
            const formatData = isPlainObject(formatResponse.data) ? formatResponse.data : {};
            const crosses = [data[crossKey], formatData[crossKey]].filter(v => typeof v === 'boolean');
            for (const cross of crosses) {
              if (cross !== task.output) anomalies.push(`任务 ${task.taskId} output=${task.output} 与交叉核对值 ${cross} 冲突`);
            }
          }
        }
        const merged = {
          taskId: task.taskId, executionId: execution.id, groupId: typeof groupId === 'string' ? groupId : null,
          type: task.type, subType: task.subType, status,
          hasOutput: Object.hasOwn(task, 'output'), output: task.output,
        };
        if (!prev || TERMINAL.has(status) || !TERMINAL.has(prev.status)) tasks.set(key, merged);
        // usage 观测：含 T.log.taskInfo.usage 兼容副本，按 (reportId, groupId, callId) 去重；
        // 缺 callId 的副本无法去重 → 只记孤儿计数，不并入已知计量。
        const usageCopies = [task.usage, isPlainObject(task.log) && isPlainObject(task.log.taskInfo) ? task.log.taskInfo.usage : undefined]
          .filter(isPlainObject);
        for (const usage of usageCopies) {
          const callId = usage._midscene_call_id;
          if (typeof callId !== 'string' || !callId) { orphanUsageCopies++; usageUnknown = true; continue; }
          if (isCount(usage.retry_count) && usage.retry_count > 0) retryObserved = true;
          if (!usageComplete(usage)) incompleteUsage = true;
          const callKey = JSON.stringify([reportId, typeof groupId === 'string' ? groupId : '', callId]);
          const seen = calls.get(callKey);
          const sig = JSON.stringify([usage.prompt_tokens, usage.completion_tokens, usage.total_tokens, usage.retry_count ?? null]);
          if (seen === undefined) calls.set(callKey, { sig, prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens });
          else if (seen.sig !== sig) { usageUnknown = true; anomalies.push(`callId ${callId} 多副本计量冲突`); }
        }
      }
    }
  }
  if (tasks.size === 0) failures.push('没有可消费的任务终态（只解析 type=midscene_web_dump 的 script）');
  const observed = [...calls.values()];
  const reasons = [];
  if (calls.size === 0) reasons.push('报告中没有 usage 观测');
  if (orphanUsageCopies) reasons.push('存在缺 callId 的 usage 副本');
  if (incompleteUsage) reasons.push('存在缺字段/负数/非整数的 usage');
  if (retryObserved) reasons.push('观察到 retry_count>0（重试只给请求下界）');
  if (usageUnknown && reasons.length === 0) reasons.push('存在冲突/缺ID的 usage 副本');
  const modelObservation = reasons.length
    ? { known: false, reason: reasons.join('；'), uniqueCalls: calls.size, promptTokens: observed.reduce((s, c) => s + (isCount(c.prompt) ? c.prompt : 0), 0), completionTokens: observed.reduce((s, c) => s + (isCount(c.completion) ? c.completion : 0), 0), totalTokens: observed.reduce((s, c) => s + (isCount(c.total) ? c.total : 0), 0), orphanUsageCopies, retryObserved, note: 'known=false 时 uniqueCalls/tokens 是原始观察下界，不是 0，也不是完整计量' }
    : { known: true, uniqueCalls: calls.size, promptTokens: observed.reduce((s, c) => s + c.prompt, 0), completionTokens: observed.reduce((s, c) => s + c.completion, 0), totalTokens: observed.reduce((s, c) => s + c.total, 0), orphanUsageCopies: 0, retryObserved: false, note: 'known=true 仅表示报告内观测完整一致，不表示网络请求硬计量' };
  return { ok: failures.length === 0, failures, anomalies, reportId, documentTitle, tasks: [...tasks.values()], modelObservation };
}

function validExpectation(req) {
  if (!isPlainObject(req)) return 'requiredTasks 项必须是对象';
  if (typeof req.taskId !== 'string' || !req.taskId) return 'requiredTasks.taskId 必填';
  if (req.groupId !== undefined && typeof req.groupId !== 'string') return 'groupId 必须是字符串';
  if (req.executionId !== undefined && typeof req.executionId !== 'string') return 'executionId 必须是字符串';
  if (!SUPPORTED_SUBTYPES.includes(req.subType)) {
    return `requiredTasks.subType 仅支持 ${SUPPORTED_SUBTYPES.join('/')}（收到 ${JSON.stringify(req.subType)}）；Query 等值判断未实现，明确拒绝，不虚构`;
  }
  if (typeof req.expectOutput !== 'boolean') return `任务 ${req.taskId} 的 expectOutput 必须是 boolean（Boolean/Assert 必填）`;
  return null;
}

// 产品谓词判定：processExitCode / status=finished / HTML 存在一律不构成通过。
// 只做合成 fixture 判定；真实 target 锁定、origin、登录前提属于 live driver（pending），本函数不做也不假装做。
export function evaluateProduct({ fixture, expectations } = {}) {
  const failures = [];
  if (fixture !== undefined && fixture !== null && typeof fixture === 'string') {
    if (fixture.length > MAX_BYTES) return { passed: false, failures: ['输入超限'], summary: { tasks: 0, modelObservation: NO_OBSERVATION, documentTitle: null } };
    try { fixture = JSON.parse(fixture); } catch { return { passed: false, failures: ['fixture JSON 不可解析'], summary: { tasks: 0, modelObservation: NO_OBSERVATION, documentTitle: null } }; }
  }
  if (expectations !== undefined && !isPlainObject(expectations)) {
    return { passed: false, failures: ['expectations 必须是对象'], summary: { tasks: 0, modelObservation: NO_OBSERVATION, documentTitle: null } };
  }
  const parsed = parseFixture(fixture);
  failures.push(...parsed.failures);
  const title = parsed.documentTitle;
  if (typeof title !== 'string' || !title.trim()) {
    failures.push('页面标题为空或缺失：不满足产品场景 ready 前提');
  }
  const required = Array.isArray(expectations?.requiredTasks) ? expectations.requiredTasks : [];
  if (required.length === 0) failures.push('产品场景必须声明具名 requiredTasks（具名完成条件）');
  const allTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  for (const req of required) {
    const invalid = validExpectation(req);
    if (invalid) { failures.push(invalid); continue; }
    const candidates = allTasks.filter(t => t.taskId === req.taskId
      && (req.groupId === undefined || t.groupId === req.groupId)
      && (req.executionId === undefined || t.executionId === req.executionId));
    if (candidates.length === 0) { failures.push(`必需任务缺失: ${req.taskId}`); continue; }
    if (candidates.length > 1) {
      const ids = candidates.map(t => JSON.stringify([t.groupId, t.executionId])).join(', ');
      failures.push(`必需任务 ${req.taskId} 身份歧义（${candidates.length} 个: ${ids}）：需用 groupId/executionId 具名完整身份`);
      continue;
    }
    const task = candidates[0];
    if (task.groupId === null) failures.push(`任务 ${req.taskId} 的 groupId 缺失：身份不完整不能形成产品通过`);
    if (!TERMINAL.has(task.status)) { failures.push(`任务 ${req.taskId} 终态为 ${task.status}，不是 finished`); continue; }
    if (!task.hasOutput) { failures.push(`任务 ${req.taskId} finished 但缺 output（不得用字段缺失当成功）`); continue; }
    if (task.subType !== req.subType) failures.push(`任务 ${req.taskId} subType=${task.subType}，期望 ${req.subType}`);
    if (typeof task.output !== 'boolean') failures.push(`任务 ${req.taskId} output 不是 boolean: ${JSON.stringify(task.output)}`);
    else if (task.output !== req.expectOutput) failures.push(`任务 ${req.taskId} 断言值 ${task.output} ≠ 期望 ${req.expectOutput}`);
  }
  if (expectations?.requireKnownModelUsage && !parsed.modelObservation?.known) {
    failures.push(`模型观测不完整（${parsed.modelObservation.reason}），配方要求计量完整；观察下界 uniqueCalls=${parsed.modelObservation.uniqueCalls} 不是 0`);
  }
  return {
    passed: failures.length === 0 && parsed.anomalies.length === 0,
    failures: [...failures, ...parsed.anomalies.map(a => '证据异常: ' + a)],
    summary: { tasks: allTasks.length, modelObservation: parsed.modelObservation ?? NO_OBSERVATION, documentTitle: parsed.documentTitle ?? null },
    note: '仅合成 fixture 判定；processExitCode/status=finished 不参与判定；live target/login 验证未实现（pending）',
  };
}
