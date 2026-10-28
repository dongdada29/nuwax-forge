// lib/budget/actual.mjs —— 实耗解析（GUI manifest / 规范 usage JSON / Claude result JSON）+ 口径归一 + 差值核对。
// 只抽取数字与结构字段，不读正文、不读凭据；cache 未给就是 unknown（null），绝不默认 0。
import { BudgetDataError, isFiniteNonNegative, isNonNegativeInteger } from './core.mjs';

const r3 = x => Math.round(x * 1000) / 1000;
const KNOWN_SEMANTICS = new Set(['includes-cache', 'excludes-cache', 'unknown']);
const KNOWN_SCOPES = new Set(['run-segment', 'session-cumulative', 'unknown']);

function num(v, label) {
  if (v === undefined || v === null) return null;
  if (!isFiniteNonNegative(v)) throw new BudgetDataError(`actual ${label} 必须为有限非负数（收到 ${JSON.stringify(v)}）`);
  return v;
}
function intOrNull(v, label) {
  const n = num(v, label);
  if (n != null && !isNonNegativeInteger(n)) throw new BudgetDataError(`actual ${label} 必须为非负整数（收到 ${JSON.stringify(v)}）`);
  return n;
}
function declaredSemantics(raw, ...holders) {
  const declared = holders.map(h => h?.inputSemantics).find(v => v !== undefined);
  if (declared === undefined) return null;
  if (!KNOWN_SEMANTICS.has(declared)) throw new BudgetDataError(`inputSemantics 无法识别：${JSON.stringify(declared)}（仅 includes-cache/excludes-cache/unknown；不认识的口径不默默归一，文件：${raw}）`);
  return declared;
}
// usageScope 声明：run-segment=只覆盖本次运行段；session-cumulative=整会话累计；unknown=范围未知。
// 不认识的值直接拒绝（unknown ≠ 0，也不能默默当作任一含义）。
function declaredScope(label, ...holders) {
  const declared = holders.map(h => h?.usageScope).find(v => v !== undefined);
  if (declared === undefined) return null;
  if (!KNOWN_SCOPES.has(declared)) throw new BudgetDataError(`usageScope 无法识别：${JSON.stringify(declared)}（仅 run-segment/session-cumulative/unknown；不认识的 scope 不默默接受，文件：${label}）`);
  return declared;
}
// includes-cache 口径自洽性：cachedRead 是输入子集，超过输入即口径/数字有错，拒绝
function assertCacheSubset(semantics, inputTokens, cachedReadTokens) {
  if (semantics === 'includes-cache' && inputTokens != null && cachedReadTokens != null && cachedReadTokens > inputTokens) {
    throw new BudgetDataError(`actual 口径不一致：includes-cache 下 cachedRead(${cachedReadTokens}) > inputTokens(${inputTokens})，cached 应为输入子集，拒绝接受`);
  }
}

// inputSemantics: includes-cache=输入数含缓存命中部分；excludes-cache=输入数不含缓存读；unknown=口径未知
export function parseActual(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BudgetDataError('actual 必须是 JSON 对象');
  if (raw.model?.observation) return parseGuiManifest(raw);
  if (raw.modelUsage) return parseClaudeResult(raw);
  if (raw.usage) return parseUsageJson(raw);
  throw new BudgetDataError('无法识别 actual 格式：需要 GUI manifest（model.observation）、规范 usage JSON（usage）或 Claude result JSON（modelUsage）');
}

function parseGuiManifest(raw) {
  const o = raw.model.observation;
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new BudgetDataError('actual model.observation 必须为对象');
  const usage = {
    calls: intOrNull(o.uniqueCalls, 'model.observation.uniqueCalls'),
    inputTokens: num(o.promptTokens, 'model.observation.promptTokens'),
    outputTokens: num(o.completionTokens, 'model.observation.completionTokens'),
    totalTokens: num(o.totalTokens, 'model.observation.totalTokens'),
    cachedReadTokens: num(o.cachedReadTokens ?? null, 'model.observation.cachedReadTokens'),
    cacheWriteTokens: null,
  };
  // report 字段齐全时强一致：parts 必须等于 total
  if (usage.inputTokens != null && usage.outputTokens != null && usage.totalTokens != null
    && usage.inputTokens + usage.outputTokens !== usage.totalTokens) {
    throw new BudgetDataError(`actual total 不一致：promptTokens(${usage.inputTokens}) + completionTokens(${usage.outputTokens}) ≠ totalTokens(${usage.totalTokens})，拒绝静默接受`);
  }
  const known = o.known === true, retry = o.retryObserved === true;
  const notes = [];
  if (!known) notes.push('model.observation.known=false：观测不完整，数值只作下界参考，不当完整实耗');
  if (retry) notes.push('retryObserved=true：存在重试，计费口径可能高于观测值');
  if (usage.calls == null) notes.push('uniqueCalls 未提供 → calls unknown（缺失必要数字，complete=false）');
  if (usage.inputTokens == null || usage.outputTokens == null) notes.push('prompt/completion tokens 缺失 → 对应维度 unknown（缺失必要数字，complete=false）');
  if (usage.cachedReadTokens == null) notes.push('cachedRead 未提供 → unknown（非 0）');
  return {
    format: 'gui-manifest',
    usageScope: 'run-segment', // driver manifest 为单次运行观测
    inputSemantics: 'includes-cache', // promptTokens 为整段 prompt（含缓存命中的重复前缀），缓存拆分 unknown
    calls: usage.calls, usage,
    completeness: { known, retryObserved: retry, complete: known && !retry && usage.calls != null && usage.inputTokens != null && usage.outputTokens != null },
    notes,
    ...(o.observedCounts !== undefined ? { rawObserved: o.observedCounts } : {}), // 保留原始观测计数
  };
}

function readClaudeUsage(v, modelName) {
  return {
    model: modelName,
    calls: intOrNull(v.calls ?? null, `modelUsage[${modelName}].calls`),
    inputTokens: num(v.inputTokens, `modelUsage[${modelName}].inputTokens`),
    outputTokens: num(v.outputTokens, `modelUsage[${modelName}].outputTokens`),
    cachedReadTokens: num(v.cacheReadInputTokens ?? null, `modelUsage[${modelName}].cacheReadInputTokens`),
    cacheWriteTokens: num(v.cacheCreationInputTokens ?? null, `modelUsage[${modelName}].cacheCreationInputTokens`),
  };
}
const isUsageObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
  && ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].some(k => typeof v[k] === 'number');

// Claude result JSON。真实 CLI 结构为按模型名 keyed：
//   modelUsage: { "glm-5.3[1m]": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costBasis, num_turns, ... } }
// 兼容旧 flat（modelUsage.inputTokens 直接是数字字段）。
// num_turns 不当 calls；costBasis 等自定义字段忽略、不估费用；
// keyed 结构的自定义 provider 不硬断言 excludes-cache：无显式声明 → unknown，只分列不归一。
// usageScope：--resume 的 modelUsage 是整会话累计而非本次调用，默认 session-cumulative；
// 仅显式 run-segment（顶层或 modelUsage 内）才按本次运行段比对/校准/放行预算。
function parseClaudeResult(raw) {
  const m = raw.modelUsage;
  if (m === null || typeof m !== 'object' || Array.isArray(m)) throw new BudgetDataError('actual modelUsage 必须为对象');
  const declared = declaredSemantics('claude-result', raw, m);
  const scope = declaredScope('claude-result', raw, m) ?? 'session-cumulative';
  const notes = [];
  let usage, perModel = null, semantics;
  const entries = Object.entries(m).filter(([k]) => k !== 'inputSemantics' && k !== 'usageScope');
  if (entries.length && entries.every(([, v]) => isUsageObj(v))) {
    perModel = entries.map(([name, v]) => readClaudeUsage(v, name));
    notes.push('modelUsage 为按模型 keyed 结构；num_turns 等自定义字段不作为 calls，costBasis 等费用字段忽略（不估钱）');
    if (perModel.length === 1) {
      usage = { ...perModel[0], model: undefined };
      delete usage.model;
      semantics = declared ?? 'unknown';
      if (semantics === 'unknown') notes.push('自定义 provider 的 cache 口径未知（未显式声明 inputSemantics）：输入维度只分列、不归一给差值');
    } else {
      const sum = key => perModel.map(p => p[key]).every(v => typeof v === 'number') ? perModel.reduce((a, p) => a + p[key], 0) : null;
      usage = {
        calls: sum('calls'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
        cachedReadTokens: sum('cachedReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'),
      };
      semantics = declared ?? 'unknown';
      notes.push(`多模型（${perModel.length} 个）聚合为总和，per-model 明细保留；口径未知时差值仍不归一`);
    }
  } else if (isUsageObj(m)) {
    usage = readClaudeUsage(m, null);
    delete usage.model;
    semantics = declared ?? 'excludes-cache'; // flat 且为官方字段名：Claude inputTokens 不含 cacheRead
    notes.push('Claude 口径：inputTokens 不含 cacheReadInputTokens（与 Codex/OpenAI input_tokens 含 cached 不同，不可混用）', 'cacheWrite（cache_creation）单列，不并入输入或输出');
  } else {
    throw new BudgetDataError('modelUsage 需为 flat usage 对象（inputTokens/outputTokens 数字字段）或按模型名 keyed 的 usage 映射');
  }
  if (usage.cachedReadTokens == null) notes.push('cacheReadInputTokens 未提供 → cachedRead unknown（非 0）');
  if (usage.calls == null) notes.push('calls 未提供（不用 num_turns 冒充）→ calls unknown');
  assertCacheSubset(semantics, usage.inputTokens, usage.cachedReadTokens);
  const numbersComplete = usage.inputTokens != null && usage.outputTokens != null;
  if (!numbersComplete) notes.push('input/output tokens 缺失 → 缺必要数字，complete=false');
  // 实测：同 session 连续 final 的 modelUsage 只增不减（49319 → 90311 → 99472），本阶段 trace ≈ 相邻 final
  // 之差（9161 = 99472-90311；CDP 恢复 final 30090 vs 本阶段 6094）；num_turns 是本轮字段，不能据此推 usage 范围。
  // 非 run-segment：各维度原始数字/perModel 保留展示、不归零，但 complete=false → 单任务预算 unknown、不写校准样本。
  const scopeConfirmed = scope === 'run-segment';
  if (!scopeConfirmed) notes.push(scope === 'session-cumulative'
    ? 'usageScope=session-cumulative（默认）：modelUsage 为整会话累计（Claude --resume 含此前各轮；num_turns 是本轮字段，不能据此推 usage 范围），数值保留仅作展示、不归零；单任务预算 unknown、不写校准样本。要比对：先减同 session baseline（保证各字段非负）后改用规范 usage JSON，或显式 usageScope=run-segment'
    : 'usageScope=unknown：无法确认 modelUsage 是否只覆盖本次运行段，按非运行段处理：数值保留展示、不归零，单任务预算 unknown、不写校准样本');
  const out = {
    format: 'claude-result', inputSemantics: semantics, usageScope: scope, calls: usage.calls,
    usage,
    completeness: { known: true, retryObserved: false, complete: numbersComplete && scopeConfirmed, scopeConfirmed },
    notes,
  };
  if (perModel) out.perModel = perModel;
  return out;
}

function parseUsageJson(raw) {
  const u = raw.usage;
  if (u === null || typeof u !== 'object' || Array.isArray(u)) throw new BudgetDataError('actual usage 必须为对象');
  const snake = u.input_tokens !== undefined || u.output_tokens !== undefined || u.cached_tokens !== undefined;
  const usage = {
    calls: intOrNull(raw.calls ?? u.calls ?? null, 'calls'),
    inputTokens: num(u.inputTokens ?? u.input_tokens ?? null, 'usage.inputTokens'),
    outputTokens: num(u.outputTokens ?? u.output_tokens ?? null, 'usage.outputTokens'),
    totalTokens: num(u.totalTokens ?? u.total_tokens ?? null, 'usage.totalTokens'),
    cachedReadTokens: num(u.cachedReadTokens ?? u.cached_tokens ?? null, 'usage.cachedReadTokens'),
    cacheWriteTokens: num(u.cacheWriteTokens ?? u.cache_creation_tokens ?? null, 'usage.cacheWriteTokens'),
  };
  // 显式 inputSemantics 只接受三种已知值，不认识的 provider/写法直接拒绝（不默默归一）
  const declared = declaredSemantics('usage-json', raw, u);
  const scope = declaredScope('usage-json', raw, u) ?? 'run-segment';
  let semantics = 'unknown';
  if (declared != null) semantics = declared;
  else if (snake) semantics = 'includes-cache'; // OpenAI/Codex 风格 input_tokens 含 cached
  if (usage.inputTokens != null && usage.outputTokens != null && usage.totalTokens != null
    && usage.inputTokens + usage.outputTokens !== usage.totalTokens) {
    throw new BudgetDataError(`actual total 不一致：input(${usage.inputTokens}) + output(${usage.outputTokens}) ≠ total(${usage.totalTokens})，拒绝静默接受`);
  }
  assertCacheSubset(semantics, usage.inputTokens, usage.cachedReadTokens);
  const notes = [];
  if (semantics === 'unknown') notes.push('inputSemantics 未知：输入是否含缓存命中部分无法确认，输入维度只分列不给差值；可用 inputSemantics=includes-cache/excludes-cache 显式声明');
  if (usage.cachedReadTokens == null) notes.push('cachedRead 未提供 → unknown（非 0）');
  if (usage.calls == null) notes.push('calls 未提供 → calls unknown');
  const numbersComplete = usage.inputTokens != null && usage.outputTokens != null;
  if (!numbersComplete) notes.push('input/output tokens 缺失 → 缺必要数字，complete=false');
  if (scope !== 'run-segment') notes.push(`usageScope=${scope}：未确认为本次运行段，数值保留展示；单任务预算 unknown、不写校准样本`);
  // 规范 usage JSON 默认按 run-segment 处理；显式累计/未知声明仍须保留并限制用途。
  return { format: 'usage-json', usageScope: scope, inputSemantics: semantics, calls: usage.calls, usage, completeness: { known: true, retryObserved: false, complete: numbersComplete && scope === 'run-segment' }, notes };
}

// —— reconcile：估算 vs 实耗。estimate 为 estimate 命令的输出 JSON ——
export function reconcileEstimate(estimate, actual, { sourceHash } = {}) {
  if (estimate?.kind !== 'token-budget-estimate') throw new BudgetDataError(`--estimate 需要 budget estimate 的输出 JSON（kind=token-budget-estimate，收到 ${JSON.stringify(estimate?.kind)}）`);
  const est = {
    calls: estimate.calls?.expected ?? null,
    inputTokens: estimate.tokens?.inputTokens?.median ?? null,
    cachedReadTokens: estimate.tokens?.cachedReadTokens?.median ?? null,
    outputTokens: estimate.tokens?.outputTokens?.median ?? null,
    imageTokens: estimate.tokens?.imageTokens?.total?.median ?? (typeof estimate.tokens?.imageTokens?.median === 'number' ? estimate.tokens.imageTokens.median : null),
  };
  const a = actual.usage;
  const semantics = actual.inputSemantics;
  const scope = actual.usageScope ?? 'run-segment'; // gui-manifest/规范 usage JSON 为单次运行段；claude-result 由 parse 显式给出（默认 session-cumulative）
  const dims = [], notes = [...actual.notes];

  // 输入口径归一：估算 inputTokens 定义为“含缓存命中子集的全量输入”
  let actualComparableInput = null;
  if (a.inputTokens != null) {
    if (semantics === 'excludes-cache') {
      if (a.cachedReadTokens != null) { actualComparableInput = a.inputTokens + a.cachedReadTokens; notes.push(`口径归一：${a.inputTokens}（不含缓存读）+ cacheRead ${a.cachedReadTokens} = 含缓存读输入 ${actualComparableInput}`); }
      else notes.push('口径缺失：inputSemantics=excludes-cache 但 cacheRead unknown，输入维度只分列、不给差值');
    } else if (semantics === 'includes-cache') actualComparableInput = a.inputTokens;
    else notes.push('口径缺失：inputSemantics unknown，输入维度只分列、不给差值（不擅自加减）');
  }
  // raw total 由 parser 按原始 input+output 校验；预算总量须使用含缓存读的可比输入，不能用 raw total 绕过口径归一。
  const actualTotal = actualComparableInput != null && a.outputTokens != null ? r3(actualComparableInput + a.outputTokens) : null;
  if (semantics === 'excludes-cache' && a.totalTokens != null && actualTotal != null) {
    notes.push(`总量口径归一：原始 totalTokens ${a.totalTokens}（input+output，不含缓存读）+ cacheRead ${a.cachedReadTokens} = 可比总量 ${actualTotal}；原始 totalTokens 保留展示`);
  }

  const push = (dimension, estV, actV, note) => {
    const row = { dimension, estimateMedian: estV, actual: actV, semanticsOk: true };
    if (note) row.note = note;
    if (estV == null || actV == null) {
      row.delta = null; row.ratio = null;
      if (!('note' in row)) row.note = estV == null && actV == null ? '两侧均缺数据' : `缺少${estV == null ? '估算' : '实耗'}值，不作比较（unknown ≠ 0）`;
      else if (estV == null || actV == null) row.note += '；缺值侧 unknown，不作比较';
    } else {
      row.delta = r3(actV - estV);
      row.ratio = estV > 0 ? r3(actV / estV) : null;
      if (estV === 0 && actV > 0) row.note = '估算为 0 而实耗 >0：估算侧漏维度，需修 spec';
    }
    dims.push(row);
  };
  push('calls', est.calls, actual.calls, actual.completeness.complete ? (actual.calls == null ? '实耗 calls unknown' : null) : 'actual 观测不完整（known/retry/缺必要数字/usageScope 非本次运行段），数值仅供参考');
  push('inputTokens(includes-cached)', est.inputTokens, actualComparableInput, semantics === 'unknown' ? '输入口径未知，仅分列原始值' : null);
  push('cachedReadTokens', est.cachedReadTokens, a.cachedReadTokens);
  push('cacheWriteTokens', null, a.cacheWriteTokens, '估算未建模 cache 写入，仅呈现实耗');
  push('outputTokens', est.outputTokens, a.outputTokens);
  push('totalTokens', estimate.totalTokens?.status === 'partial-unknown' ? estimate.totalTokens.subtotal.median : estimate.totalTokens?.median ?? null,
    actualTotal, estimate.totalTokens?.status === 'partial-unknown' ? '估算 total 含 unknown 维度（如视觉/缺失参数），此处用小计比较' : null);

  const totalRow = dims.find(d => d.dimension === 'totalTokens');
  const percentError = totalRow && totalRow.estimateMedian > 0 && totalRow.actual != null
    ? r3((totalRow.actual - totalRow.estimateMedian) / totalRow.estimateMedian * 100) : null;

  // 预算复核（按实耗）
  let budget = { verdict: 'not-set' };
  const budgetTokens = estimate.budget?.budgetTokens;
  if (budgetTokens != null) {
    if (semantics === 'unknown' || actualComparableInput == null || actualTotal == null || !actual.completeness.complete || scope !== 'run-segment') budget = { budgetTokens, verdict: 'unknown', note: '实耗不完整、口径缺失或 usageScope 未确认为本次运行段（整会话累计/未知 ≠ 单次实耗），guard 不能放行' };
    else if (actualTotal > budgetTokens) budget = { budgetTokens, verdict: 'exceeds', overByTokens: r3(actualTotal - budgetTokens) };
    else budget = { budgetTokens, verdict: 'within', headroomTokens: r3(budgetTokens - actualTotal) };
  }

  const recommendations = [];
  const inRow = dims.find(d => d.dimension === 'inputTokens(includes-cached)');
  if (inRow?.ratio != null && inRow.ratio > 1.3) recommendations.push({ id: 'compress-context', reason: `实耗输入为估算 ${inRow.ratio}×`, suggestion: '压缩上下文/截断工具回包，并把本样本留作下次校准' });
  const outRow = dims.find(d => d.dimension === 'outputTokens');
  if (outRow?.ratio != null && outRow.ratio > 1.5) recommendations.push({ id: 'deterministic-recipe', reason: '输出超预期明显', suggestion: '可判定部分改用已批准确定性 recipe（0 模型调用）' });
  if (budget.verdict === 'exceeds') recommendations.push({ id: 'budget-overflow', reason: '实耗超预算', suggestion: '削减主导维度后重估' });

  // 可校准判定：实耗完整 + 口径已知 + 可比输入与输出齐全，才允许写入历史；
  // 未知/重试/不完整实耗保持 unknown，绝不落成正常样本去降低下次预测。
  const usableForCalibration = scope === 'run-segment' && actual.completeness.complete && semantics !== 'unknown'
    && actualComparableInput != null && a.outputTokens != null && a.inputTokens != null;
  if (!usableForCalibration) notes.push('实耗不完整、口径未知或 usageScope 非本次运行段（如 Claude 整会话累计）：不写入校准样本（防止污染下次预测）');

  // baseline 还原：优先 estimate.baselineTokens（新格式）；
  // 旧估算文件无 baselineTokens 时，用 calibration.appliedFactors（或 confidence.history.*Ratio.factor）
  // 把校准 median 还原为 raw（median ÷ factor）；两样都没有 → null（明示不可校准，不假装可还原）。
  const appliedFactor = dim => estimate.calibration?.appliedFactors?.[dim]
    ?? (dim === 'inputTokens' ? estimate.confidence?.history?.inputRatio?.factor : null)
    ?? (dim === 'outputTokens' ? estimate.confidence?.history?.outputRatio?.factor : null);
  const baselineDim = dim => {
    const b = estimate.baselineTokens?.[dim]?.median;
    if (typeof b === 'number') return { value: b, source: 'baselineTokens' };
    const m = est[dim], f = appliedFactor(dim);
    if (typeof f === 'number' && f > 0 && typeof m === 'number') return { value: r3(m / f), source: 'reconstructed-from-applied-factor' };
    return { value: null, source: 'missing' };
  };
  const bIn = baselineDim('inputTokens'), bOut = baselineDim('outputTokens');

  // 脱敏校准样本：只写数字/ids/模型/任务类型/来源 hash，不含 prompt/截图/会话/凭据。
  // baselineExpected=未校准基准（下次比率分母）；predictedExpected=本次真正预测（仅展示）。
  const sample = {
    kind: 'token-budget-calibration', schemaVersion: 1, sampleVersion: 2,
    estimateId: estimate.spec?.id ?? null,
    model: estimate.spec?.model ?? null, taskKind: estimate.spec?.taskKind ?? null,
    scenario: estimate.spec?.scenario ?? null,
    inputSemantics: semantics, usageScope: scope,
    recordedAt: new Date().toISOString(),
    sourceHash: sourceHash ?? null,
    baselineExpected: { calls: est.calls, inputTokens: bIn.value, outputTokens: bOut.value, cachedReadTokens: est.cachedReadTokens },
    baselineSource: { inputTokens: bIn.source, outputTokens: bOut.source },
    predictedExpected: { calls: est.calls, inputTokens: est.inputTokens, outputTokens: est.outputTokens, cachedReadTokens: est.cachedReadTokens },
    actual: { calls: actual.calls ?? null, inputTokens: actualComparableInput, outputTokens: a.outputTokens, cachedReadTokens: a.cachedReadTokens, imageTokens: null },
    calibrationEligible: usableForCalibration,
  };

  return {
    ok: true, kind: 'token-budget-reconcile', schemaVersion: 1,
    engine: { offline: true, modelCallsUsed: 0 },
    estimate: { id: estimate.spec?.id ?? null, model: estimate.spec?.model ?? null, taskKind: estimate.spec?.taskKind ?? null, medianTokens: estimate.totalTokens ?? null, baseline: { inputTokens: bIn, outputTokens: bOut } },
    actual: {
      format: actual.format, inputSemantics: semantics, usageScope: scope,
      completeness: actual.completeness, notes: actual.notes,
      usage: { ...a, comparableInputIncludingCachedRead: actualComparableInput, derivedTotal: actualTotal != null && a.totalTokens !== actualTotal ? actualTotal : null },
      ...(actual.perModel ? { perModel: actual.perModel } : {}),
      ...(actual.rawObserved ? { rawObserved: actual.rawObserved } : {}),
    },
    comparison: { dimensions: dims, notes, percentError: percentError == null ? null : { totalTokens: percentError } },
    budget, recommendations, usableForCalibration, sample,
  };
}
