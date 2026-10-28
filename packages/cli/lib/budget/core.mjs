// lib/budget/core.mjs —— token 预算核心：spec 校验、文本启发式、多轮增长模型、历史校准。
// 零外部依赖、默认离线；本模块绝不发起模型/网络调用，预测本身消耗 0 次 LLM 调用。
export class BudgetDataError extends Error {
  constructor(message, details) { super(message); this.details = details ?? null; }
}

const VISION_TASK_RE = /^gui\b|visual/i; // gui-visual / gui-* 等视为需要视觉输入
const KNOWN_MODES = new Set(['model', 'no-model']);
const KNOWN_SEMANTICS = new Set(['includes-cache', 'excludes-cache', 'unknown']);
export const SCOPE_NOTE = '估算仅覆盖本次运行段（run segment）的模型调用；不含发起任务的对话、开发过程与上层会话 token。';

export function isFiniteNonNegative(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }
export function isNonNegativeInteger(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 0; }
const r3 = x => Math.round(x * 1000) / 1000;

function needNumber(raw, field, { integer = false, max = Infinity } = {}) {
  const v = raw[field];
  if (v === undefined) return undefined;
  const ok = integer ? isNonNegativeInteger(v) : isFiniteNonNegative(v);
  if (!ok || v > max) {
    throw new BudgetDataError(`spec.${field} 必须为有限非负${integer ? '整数' : '数'}${max !== Infinity ? ` 且 ≤ ${max}` : ''}（收到 ${JSON.stringify(v)}）`);
  }
  return v;
}

// 显式文本按 UTF-8/码点粗分档给区间。这不是模型 tokenizer，输出必须带此标注；
// 不假设“中文 1 字 = 1 token”，也不冒充任何厂商精确分词。
export function heuristicTextTokens(text) {
  let ascii = 0, nonAscii = 0;
  for (const ch of String(text)) (ch.codePointAt(0) < 0x80 ? ascii++ : nonAscii++);
  return {
    low: Math.ceil(ascii / 4 + nonAscii * 0.6),
    median: Math.ceil(ascii / 3.5 + nonAscii * 1.0),
    high: Math.ceil(ascii / 3 + nonAscii * 1.5),
    asciiCodePoints: ascii, nonAsciiCodePoints: nonAscii,
    method: 'utf8/codepoint-heuristic（非模型 tokenizer，仅区间估计）',
  };
}

function parseImageTokens(v) {
  if (v === undefined) return { status: 'not-provided' };
  if (v === 'unknown') return { status: 'unknown' };
  if (isFiniteNonNegative(v)) return { status: 'known', low: v, median: v, high: v };
  if (Array.isArray(v) && v.length === 2 && isFiniteNonNegative(v[0]) && isFiniteNonNegative(v[1]) && v[0] <= v[1]) {
    return { status: 'known', low: v[0], median: (v[0] + v[1]) / 2, high: v[1] };
  }
  throw new BudgetDataError('spec.imageTokensPerCall 必须为非负数、[low,high] 区间或 "unknown"');
}

export function parseSpec(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BudgetDataError('spec 必须是 JSON 对象');
  if (raw.schemaVersion !== 1) throw new BudgetDataError(`spec.schemaVersion 必须为 1（收到 ${JSON.stringify(raw.schemaVersion)}）`);
  if (typeof raw.id !== 'string' || !raw.id) throw new BudgetDataError('spec.id 必须为非空字符串');
  if (typeof raw.taskKind !== 'string' || !raw.taskKind) throw new BudgetDataError('spec.taskKind 必须为非空字符串（如 gui-visual / text-implementation / deterministic）');
  if (!KNOWN_MODES.has(raw.mode)) throw new BudgetDataError(`spec.mode 必须为 model 或 no-model（收到 ${JSON.stringify(raw.mode)}）`);
  const expectedCalls = needNumber(raw, 'expectedCalls', { integer: true });
  if (expectedCalls === undefined) throw new BudgetDataError('spec.expectedCalls 必填（非负整数；不确定就给保守上界）');
  let modelName = null;
  if (raw.model !== undefined) {
    if (raw.model === null || typeof raw.model !== 'object' || Array.isArray(raw.model) || typeof raw.model.name !== 'string' || !raw.model.name) {
      throw new BudgetDataError('spec.model 必须为 { name: 非空字符串 } 或省略');
    }
    modelName = raw.model.name;
  }
  if (raw.mode === 'model' && !modelName) throw new BudgetDataError('mode=model 时需要 spec.model.name');
  if (raw.mode === 'no-model' && expectedCalls !== 0) throw new BudgetDataError('mode=no-model 时 expectedCalls 必须为 0（运行段不含任何模型调用）');
  if (raw.inputs !== undefined && (!Array.isArray(raw.inputs) || raw.inputs.some(t => typeof t !== 'string'))) {
    throw new BudgetDataError('spec.inputs 必须为字符串数组（显式文本输入，按启发式估区间）');
  }
  const spec = {
    schemaVersion: 1, id: raw.id, taskKind: raw.taskKind, mode: raw.mode, expectedCalls,
    model: modelName, scenario: typeof raw.scenario === 'string' && raw.scenario ? raw.scenario : null,
    initialContextTokens: needNumber(raw, 'initialContextTokens'),
    perCallOutputTokens: needNumber(raw, 'perCallOutputTokens'),
    perCallToolResultTokens: needNumber(raw, 'perCallToolResultTokens'),
    cacheHitRatio: needNumber(raw, 'cacheHitRatio', { max: 1 }),
    budgetTokens: needNumber(raw, 'budgetTokens'),
    imageTokensPerCall: parseImageTokens(raw.imageTokensPerCall),
    imageTokensIncludedInContext: raw.imageTokensIncludedInContext === true,
    inputs: Array.isArray(raw.inputs) ? raw.inputs : null,
  };
  const vision = VISION_TASK_RE.test(raw.taskKind);
  if (raw.modelProfiles !== undefined) {
    if (!Array.isArray(raw.modelProfiles)) throw new BudgetDataError('spec.modelProfiles 必须为数组');
    spec.modelProfiles = raw.modelProfiles.map((p, i) => {
      if (p === null || typeof p !== 'object' || typeof p.name !== 'string' || !p.name) {
        throw new BudgetDataError(`modelProfiles[${i}] 需要 name`);
      }
      return {
        name: p.name,
        capabilities: p.capabilities && typeof p.capabilities === 'object' ? {
          vision: p.capabilities.vision === true, text: p.capabilities.text !== false,
        } : { vision: false, text: true },
        remainingQuotaTokens: isFiniteNonNegative(p.remainingQuotaTokens) ? p.remainingQuotaTokens : null,
      };
    });
  }
  spec.requiresVision = vision;
  return spec;
}

// —— 历史（脱敏校准样本 JSONL）：只存数字/ids/模型/任务类型/来源 hash ——
// 逐条校验：结构、数字维度有限非负、actual 至少含一个数字维度、重复 record 去重并诊断；
// inputSemantics 不认识的值不默默归一。坏行/坏记录进 diagnostics，不隐吞、不伪 0、不参与校准。
export function parseHistoryLines(text) {
  const samples = [], diagnostics = [];
  const seen = new Set();
  const dims = ['calls', 'inputTokens', 'outputTokens', 'cachedReadTokens', 'imageTokens'];
  String(text).split(/\r?\n/).forEach((line, idx) => {
    if (!line.trim()) return;
    let rec;
    try { rec = JSON.parse(line); }
    catch (e) { diagnostics.push({ line: idx + 1, problem: `JSON 解析失败：${e.message}` }); return; }
    if (rec === null || typeof rec !== 'object' || rec.kind !== 'token-budget-calibration' || rec.schemaVersion !== 1
      || typeof rec.model !== 'string' || typeof rec.taskKind !== 'string') {
      diagnostics.push({ line: idx + 1, problem: '记录结构不符合 token-budget-calibration v1（缺 kind/schemaVersion/model/taskKind）' });
      return;
    }
    const problems = [];
    // 新格式：baselineExpected（未校准基准，值可为 null=不可还原）+ predictedExpected（展示用预测）；
    // 旧格式：expected。校准只用 baselineExpected；旧记录缺 baseline 会明示 legacy，不默默假定 expected 为 raw。
    for (const side of ['baselineExpected', 'predictedExpected', 'expected', 'actual']) {
      const o = rec[side];
      if (o === undefined) continue;
      if (o === null || typeof o !== 'object') { problems.push(`${side} 缺失/非对象`); continue; }
      for (const d of dims) {
        const v = o[d];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`${side}.${d} 必须为有限非负数（收到 ${JSON.stringify(v)}）`);
      }
    }
    if (rec.baselineExpected === undefined && rec.expected === undefined) problems.push('无 baselineExpected（旧格式 expected 亦缺）：记录不可校准');
    if (!dims.some(d => typeof rec.actual?.[d] === 'number')) problems.push('actual 无任何数字维度，不可用于校准');
    const key = `${rec.estimateId ?? ''}|${rec.sourceHash ?? ''}`;
    const dedupable = rec.estimateId != null && rec.sourceHash != null;
    if (dedupable && seen.has(key)) problems.push('重复记录（estimateId+sourceHash 相同），已去重不重复计数');
    else if (dedupable) seen.add(key);
    if (rec.inputSemantics !== undefined && !KNOWN_SEMANTICS.has(rec.inputSemantics)) {
      problems.push(`inputSemantics 无法识别：${JSON.stringify(rec.inputSemantics)}（不默默归一）`);
    }
    if (rec.calibrationEligible === false) problems.push('calibrationEligible=false：记录明确不可用于校准');
    if (rec.usageScope !== undefined && rec.usageScope !== 'run-segment') {
      problems.push(`usageScope=${JSON.stringify(rec.usageScope)}：未确认为本次运行段，不可用于校准（显式声明仅接受 run-segment）`);
    }
    if (problems.length) { diagnostics.push({ line: idx + 1, problem: problems.join('；') }); return; }
    samples.push(rec);
  });
  return { samples, diagnostics };
}

// 严格 model+taskKind+scenario（含双方均 null 才算匹配）：不做跨 scenario 回退，
// 避免异场景样本冒充同场景抬高置信。
function matchSamples(samples, spec) {
  const matched = samples.filter(s => s.model === spec.model && s.taskKind === spec.taskKind
    && (s.scenario ?? null) === (spec.scenario ?? null));
  return { samples: matched, matchedBy: spec.scenario ? ['model', 'taskKind', 'scenario'] : ['model', 'taskKind'] };
}

function medianOf(list) {
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 校准因子：actual / baselineExpected（未校准 baseline）的中位比率。
// 绝不用已校准的预测值当基准——否则同成本样本反复 reconcile 会让比率在 0.5 与 1 之间回弹。
// 旧记录无 baselineExpected → 不参与校准（legacyWithoutBaseline 明示），不默默假定 expected 是 raw。
function calibrationFactors(samples, dims) {
  const out = {}, gaps = [];
  let legacy = 0;
  for (const s of samples) if (!s.baselineExpected) legacy++;
  for (const dim of dims) {
    const ratios = [], observed = [];
    for (const s of samples) {
      const a = s.actual?.[dim];
      if (typeof a !== 'number') continue;
      observed.push(a);
      const b = s.baselineExpected?.[dim];
      if (typeof b === 'number' && b > 0) ratios.push(a / b);
      else if (a > 0) gaps.push(dim);
    }
    if (ratios.length) out[dim] = { factor: medianOf(ratios), count: ratios.length, ratioObservedRange: { min: r3(Math.min(...ratios)), max: r3(Math.max(...ratios)) } };
    if (observed.length) out[dim] = out[dim] ?? { factor: null, count: observed.length };
    if (observed.length) out[dim].actualObservedRange = { min: r3(Math.min(...observed)), max: r3(Math.max(...observed)), count: observed.length };
  }
  return { factors: out, gaps: [...new Set(gaps)], legacyWithoutBaseline: legacy };
}

function scaled(range, factor) {
  if (factor == null) return range; // factor=0 是合法校准结果（实耗为 0），不得当“无校准”跳过
  const v = [range.low * factor, range.median * factor, range.high * factor].map(r3).sort((a, b) => a - b);
  return { low: v[0], median: v[1], high: v[2] };
}

function confidenceLevel({ unknownCount, historyCount, ratioSpread }) {
  if (unknownCount > 0) return 'low';
  if (historyCount >= 10 && (!ratioSpread || ratioSpread <= 0.15)) return 'high';
  if (historyCount >= 4) return 'medium';
  return historyCount > 0 ? 'low' : 'medium'; // 无历史时是基于显式参数的算术推演，至多 medium（≠已验证的预测准确度）
}

function confidenceReasons({ unknownCount, missingParams, historyCount, matchedBy, ratioSpread, gaps }) {
  const r = [];
  if (unknownCount) r.push(`存在 ${unknownCount} 个 unknown 维度，区间不完整，预算 guard 不放行`);
  if (missingParams.length) r.push(`未提供 ${missingParams.join('、')}：按 unknown 处理，绝不按 0 放行`);
  if (historyCount > 0) {
    r.push(`历史校准样本 ${historyCount} 个（严格按 ${matchedBy.join('+')} 匹配）${historyCount < 4 ? '，样本过少，偏差不稳，不声称任何分位数稳定性' : ''}`);
    if (ratioSpread != null) r.push(`校准比率观测范围极差 ${ratioSpread}（样本少时不代表 P90）`);
  } else if (gaps?.length) r.push('部分历史样本缺基准值，无法换算比率');
  else r.push('无历史校准：纯参数算术推演，未经实耗核对（medium 只代表算术确定，不代表预测准确度已验证）');
  return r;
}

export function computeEstimate(spec, history) {
  const engine = { offline: true, modelCallsUsed: 0 }; // estimate 自身 0 次模型调用
  const assumptions = [], unknowns = [];
  const n = spec.expectedCalls;

  if (spec.mode === 'no-model') {
    return {
      ok: true, kind: 'token-budget-estimate', schemaVersion: 1, engine,
      spec: { id: spec.id, taskKind: spec.taskKind, model: null, mode: spec.mode, expectedCalls: 0, scenario: spec.scenario },
      runSegment: { modelCalls: 0, tokens: 0, note: '运行段 0 模型调用、0 token' },
      assumptions, unknowns: [],
      confidence: { level: 'high', reasons: ['确定性运行段，无模型调用'] },
      budget: spec.budgetTokens != null ? { budgetTokens: spec.budgetTokens, verdict: 'within', headroomTokens: spec.budgetTokens, note: '仅运行段口径' } : { verdict: 'not-set' },
      recommendations: [], scope: SCOPE_NOTE,
    };
  }

  // 初始上下文：显式数字 > 显式文本启发式区间；都没有则拒绝（不冒充精确）
  let initial;
  if (spec.initialContextTokens != null) {
    initial = { low: spec.initialContextTokens, median: spec.initialContextTokens, high: spec.initialContextTokens };
  } else if (spec.inputs) {
    const parts = spec.inputs.map(heuristicTextTokens);
    initial = {
      low: parts.reduce((a, p) => a + p.low, 0), median: parts.reduce((a, p) => a + p.median, 0),
      high: parts.reduce((a, p) => a + p.high, 0), method: parts[0]?.method,
    };
    assumptions.push({ field: 'initialContextTokens', value: '由 inputs 启发式推导', note: '非模型 tokenizer，仅 UTF-8/码点区间' });
  } else {
    throw new BudgetDataError('mode=model 需要 initialContextTokens 或 inputs 之一（或先用带历史的 reconcile 校准），否则无法给出非伪造估算');
  }

  // 关键成本参数缺失 → unknown，绝不按 0 计（缺失成本不当 0 放行预算）
  const missingParams = [];
  const outPer = spec.perCallOutputTokens;
  if (outPer == null && n > 0) { missingParams.push('perCallOutputTokens'); assumptions.push({ field: 'perCallOutputTokens', value: 'unknown', note: '未提供：输出成本 unknown，不按 0 放行' }); unknowns.push('outputTokens：未提供 perCallOutputTokens → unknown（非 0）'); }
  const toolPer = spec.perCallToolResultTokens;
  if (toolPer == null && n >= 2) { missingParams.push('perCallToolResultTokens'); assumptions.push({ field: 'perCallToolResultTokens', value: 'unknown', note: '未提供：多轮工具回包进后续输入的增长 unknown' }); unknowns.push('toolResultTokens：未提供 → 后续轮输入增长 unknown（非 0）'); }
  const outputKnown = outPer != null;
  const toolKnown = toolPer != null;
  const cacheRatio = spec.cacheHitRatio ?? (assumptions.push({ field: 'cacheHitRatio', value: 0, note: '未提供，按 0 计（仅影响 cachedRead 子集展示，不影响 total/预算判定）' }), 0);

  // 视觉维度：known / history-observed / unknown（绝不把缺数据当 0）
  let image = null;
  const hist = history?.samples?.length ? matchSamples(history.samples, spec) : { samples: [], matchedBy: [] };
  if (spec.imageTokensPerCall.status === 'known') {
    image = { perCall: { low: spec.imageTokensPerCall.low, median: spec.imageTokensPerCall.median, high: spec.imageTokensPerCall.high } };
  } else if (spec.imageTokensPerCall.status === 'unknown') {
    image = { status: 'unknown' };
  } else { // not-provided
    if (spec.requiresVision) image = { status: 'unknown' };
    else image = { perCall: { low: 0, median: 0, high: 0 }, note: '非视觉任务，按 0 计' };
  }
  if (image.status === 'unknown') {
    const imgObs = hist.samples.map(s => s.actual?.imageTokens).filter(v => typeof v === 'number' && v > 0);
    if (imgObs.length) {
      const min = Math.min(...imgObs), max = Math.max(...imgObs);
      image = { perCall: null, total: { low: min, median: r3((min + max) / 2), high: max }, status: 'history-observed', sampleCount: imgObs.length, note: '来自严格同模型+任务类型(+scenario)历史的 observedRange，样本少仅作宽区间' };
      unknowns.push('imageTokens：按历史 observedRange 给宽区间，非精确值');
    } else {
      unknowns.push(spec.requiresVision
        ? 'imageTokens：视觉任务但未提供且无可比历史样本 → unknown；文本小计不含视觉成本，不得当 0 放行'
        : 'imageTokens：未提供 → unknown');
    }
  }

  // 多轮增长模型：context_k = initial + (k-1)*(out+tool) [+ 每轮图像，未含于 initial 时]
  // 缺失维度按 0 参与小计计算，但小计被标记 partial-unknown，预算不放行。
  const growth = (outPer ?? 0) + (toolPer ?? 0);
  const growthSum = n * (n - 1) / 2;
  const imageOnTop = !spec.imageTokensIncludedInContext; // 已含于 initial 时绝不重复叠加
  const textInput = {
    low: n * initial.low + growth * growthSum,
    median: n * initial.median + growth * growthSum,
    high: n * initial.high + growth * growthSum,
  };
  const imageTotal = image?.perCall
    ? { low: n * image.perCall.low, median: n * image.perCall.median, high: n * image.perCall.high }
    : (image?.total ?? null);
  const input = { text: textInput, image: imageOnTop ? imageTotal : null, includedImageNote: spec.imageTokensIncludedInContext ? 'imageTokensPerCall 已含于 initialContextTokens/inputs，不重复叠加' : (image?.status === 'history-observed' ? '历史 observedRange 按未含于 initial 处理（保守叠加）' : null) };
  const inputTotal = {
    low: textInput.low + (imageOnTop && imageTotal ? imageTotal.low : 0),
    median: textInput.median + (imageOnTop && imageTotal ? imageTotal.median : 0),
    high: textInput.high + (imageOnTop && imageTotal ? imageTotal.high : 0),
  };
  const output = outputKnown ? { low: n * outPer, median: n * outPer, high: n * outPer } : null;
  const toolTotal = toolKnown ? { low: n * toolPer, median: n * toolPer, high: n * toolPer } : null;
  const cached = {
    low: inputTotal.low * cacheRatio, median: inputTotal.median * cacheRatio, high: inputTotal.high * cacheRatio,
    note: 'cachedReadTokens 为 inputTokens 的子集（命中率 × 输入），totalTokens 不重复累加',
  };

  // 历史校准：比率只针对未校准 baseline（inputTotal/output 原始算术值）计算；
  // tokens.* 为校准后的预测，baselineTokens 保留 raw 供下次 reconcile 计算比率。
  let cal = { factors: {}, gaps: [], legacyWithoutBaseline: 0 };
  if (hist.samples.length) cal = calibrationFactors(hist.samples, ['inputTokens', 'outputTokens']);
  const sInputRaw = inputTotal; // 未校准 baseline（同 spec 重算即得）
  const sOutputRaw = output ?? null;
  const sInput = scaled(inputTotal, cal.factors.inputTokens?.factor);
  const sOutput = output ? scaled(output, cal.factors.outputTokens?.factor) : null;
  if (cal.factors.inputTokens?.factor != null) assumptions.push({ field: 'inputTokens', value: `×${r3(cal.factors.inputTokens.factor)}`, note: `历史校准中位比率（基准=未校准 baseline，${cal.factors.inputTokens.count} 样本）` });

  const unknownDims = [];
  if (image?.status === 'unknown') unknownDims.push('imageTokens');
  if (!outputKnown && n > 0) unknownDims.push('outputTokens');
  if (!toolKnown && n >= 2) unknownDims.push('toolResultTokens');
  const dims = {
    initialContextTokens: initial,
    inputTokens: {
      ...sInput,
      excludesUnknownImage: image?.status === 'unknown',
      excludesUnknownToolResult: !toolKnown && n >= 2,
      note: [input.includedImageNote ?? '多轮输入含历史输出与工具回包累积', !toolKnown && n >= 2 ? '小计不含未知工具回包增长' : null].filter(Boolean).join('；'),
    },
    cachedReadTokens: { ...cached },
    cacheWriteTokens: { status: 'not-modeled', note: '未建模缓存写入，如 SDK 产生 cache_creation 需在 reconcile 侧单独核对' },
    outputTokens: sOutput ?? { status: 'unknown', note: '未提供 perCallOutputTokens：输出成本 unknown，绝不按 0 放行预算' },
    toolResultTokens: toolTotal ? { ...toolTotal, note: '已计入后续轮输入（最后一轮的回包不再重发）' } : { status: n >= 2 ? 'unknown' : 'not-applicable', note: n >= 2 ? '未提供 perCallToolResultTokens：后续轮输入增长 unknown' : '单轮调用无回包重发' },
    imageTokens: image?.status === 'unknown' ? { status: 'unknown' } : (image?.status === 'history-observed' ? image : { total: imageTotal, note: input.includedImageNote ?? '未含于 initial 时按每轮叠加计入 inputTokens' }),
  };

  const ratioSpread = cal.factors.inputTokens?.ratioObservedRange ? r3(cal.factors.inputTokens.ratioObservedRange.max - cal.factors.inputTokens.ratioObservedRange.min) : null;
  const subtotal = {
    low: r3(sInput.low + (sOutput?.low ?? 0)),
    median: r3(sInput.median + (sOutput?.median ?? 0)),
    high: r3(sInput.high + (sOutput?.high ?? 0)),
  };
  const total = unknownDims.length
    ? { status: 'partial-unknown', subtotal, unknownDimensions: unknownDims, note: `小计仅含已提供参数（${unknownDims.join(',')} 为 unknown）；预算 guard 不放行，不把缺失成本当 0` }
    : { ...subtotal, note: 'input + output（cachedRead 为输入子集，不重复加）' };

  // 预算判定：unknown 不得放行
  let budget = { verdict: 'not-set' };
  if (spec.budgetTokens != null) {
    if (total.status === 'partial-unknown') budget = { budgetTokens: spec.budgetTokens, verdict: 'unknown', note: '存在 unknown 维度，guard 不能放行' };
    else if (total.low > spec.budgetTokens) budget = { budgetTokens: spec.budgetTokens, verdict: 'exceeds', overByTokens: r3(total.low - spec.budgetTokens) };
    else if (total.high <= spec.budgetTokens) budget = { budgetTokens: spec.budgetTokens, verdict: 'within', headroomTokens: r3(spec.budgetTokens - total.high) };
    else budget = { budgetTokens: spec.budgetTokens, verdict: 'uncertain', note: '区间跨越预算线，建议按 high 侧准备' };
  }

  // 主导维度与建议（针对性，不自动改账号/模型）
  const contributions = [
    { dimension: 'inputTokens(text)', value: r3(sInput.median - (imageOnTop && imageTotal ? imageTotal.median : 0)) },
  ];
  if (sOutput) contributions.push({ dimension: 'outputTokens', value: sOutput.median });
  if (imageTotal && image?.status !== 'unknown') contributions.push({ dimension: 'imageTokens', value: imageTotal.median });
  const denom = contributions.reduce((a, c) => a + c.value, 0) || 1;
  const dominantDimensions = contributions.filter(c => c.value / denom >= 0.2).map(c => ({ dimension: c.dimension, shareAtMedian: r3(c.value / denom) }));
  const recommendations = buildRecommendations({ spec, n, dominantDimensions, budget, growth, sInput, sOutput, imageUnknown: image?.status === 'unknown', missingParams });
  const modelProfiles = recommendProfiles(spec, total);

  return {
    ok: true, kind: 'token-budget-estimate', schemaVersion: 1, engine,
    spec: { id: spec.id, taskKind: spec.taskKind, model: spec.model, mode: spec.mode, expectedCalls: n, scenario: spec.scenario, requiresVision: spec.requiresVision },
    calls: { expected: n },
    assumptions, unknowns,
    baselineTokens: {
      inputTokens: sInputRaw,
      outputTokens: sOutputRaw ?? { status: 'unknown', note: '未提供 perCallOutputTokens' },
      totalTokens: { low: r3(sInputRaw.low + (sOutputRaw?.low ?? 0)), median: r3(sInputRaw.median + (sOutputRaw?.median ?? 0)), high: r3(sInputRaw.high + (sOutputRaw?.high ?? 0)) },
      note: '未校准 baseline（同 spec 重算即得）；校准比率只针对本 baseline，绝不针对已校准输出',
    },
    calibration: {
      ratioBasis: 'baselineExpected',
      appliedFactors: { inputTokens: cal.factors.inputTokens?.factor ?? null, outputTokens: cal.factors.outputTokens?.factor ?? null },
      samplesUsed: hist.samples.length,
      legacySamplesWithoutBaseline: cal.legacyWithoutBaseline,
      note: 'appliedFactors 可用于把旧估算文件的校准值还原为 baseline（median ÷ factor）',
    },
    tokens: dims,
    totalTokens: total,
    formula: {
      description: 'context_k = initial + (k-1)×(perCallOutput+perCallToolResult)；totalInput = Σ context_k = n×initial + (out+tool)×n(n-1)/2；cachedRead = cacheHitRatio × totalInput（输入子集）；total = input + output；缺失参数计入 unknown 而非 0',
      inputsFrom: initial.method ?? 'spec.initialContextTokens',
    },
    confidence: {
      level: confidenceLevel({ unknownCount: unknownDims.length, historyCount: hist.samples.length, ratioSpread }),
      reasons: confidenceReasons({ unknownCount: unknownDims.length, missingParams, historyCount: hist.samples.length, matchedBy: hist.matchedBy, ratioSpread, gaps: cal.gaps }),
      history: hist.samples.length ? {
        samples: hist.samples.length, matchedBy: hist.matchedBy,
        inputRatio: cal.factors.inputTokens ?? null, outputRatio: cal.factors.outputTokens ?? null,
        legacySamplesWithoutBaseline: cal.legacyWithoutBaseline || null,
        note: [
          hist.samples.length < 4 ? '样本 <4：仅展示 observedRange，不声称 P90 稳定' : null,
          cal.legacyWithoutBaseline ? `${cal.legacyWithoutBaseline} 条旧记录无 baselineExpected：不参与同口径校准（不默默假定 expected 为 raw）` : null,
        ].filter(Boolean).join('；') || null,
      } : { samples: 0 },
      note: 'level 表征参数完备度与样本量；medium 仅代表显式参数下的算术确定，不代表预测准确度已经实耗验证',
    },
    budget, dominantDimensions, recommendations,
    ...(modelProfiles ? { modelProfiles } : {}),
    scope: SCOPE_NOTE,
  };
}

function buildRecommendations({ spec, n, dominantDimensions, budget, growth, sInput, sOutput, imageUnknown, missingParams }) {
  const recs = [];
  const dom = new Set(dominantDimensions.map(d => d.dimension));
  if (missingParams.length) recs.push({ id: 'missing-params', reason: `未提供 ${missingParams.join('、')}`, suggestion: '补齐参数（或先跑一次 reconcile 留校准样本）后重估；不临时编默认值、不按 0 放行' });
  if (budget.verdict === 'exceeds' || budget.verdict === 'uncertain') recs.push({ id: 'budget-overflow', reason: `预算判定 ${budget.verdict}`, suggestion: '优先削减主导维度；将非必要断言转为离线确定性校验' });
  if (n > 3 && growth > 0 && dom.has('inputTokens(text)')) recs.push({ id: 'reduce-calls', reason: '多轮上下文重复增长主导输入', suggestion: '合并步骤减少调用轮数；对稳定前缀启用 prompt cache 提高命中率' });
  if (dom.has('inputTokens(text)') && sInput.median > 4 * (sOutput?.median ?? 0)) recs.push({ id: 'compress-context', reason: '初始/累积上下文主导', suggestion: '压缩上下文：裁剪无关文件、用摘要替代全量历史、工具回包截断' });
  if (sOutput && dom.has('outputTokens') && spec.taskKind !== 'deterministic') recs.push({ id: 'deterministic-recipe', reason: '输出维度主导', suggestion: '评估改用已批准的确定性 recipe（mode=no-model，运行段 0 token）承接可判定部分' });
  if (dom.has('imageTokens') || imageUnknown) recs.push({ id: 'vision-cost', reason: imageUnknown ? '视觉成本 unknown，未计入 total' : '视觉 token 主导', suggestion: '降低截图分辨率/数量、复用截图；补齐 imageTokensPerCall 或先跑一次 reconcile 留样本' });
  if (spec.taskKind === 'deterministic' && n > 0) recs.push({ id: 'deterministic-recipe', reason: 'taskKind=deterministic 却含模型调用', suggestion: '改 mode=no-model + expectedCalls=0，运行段 0 token' });
  return recs;
}

// 离线候选推荐：仅按能力需求（text/vision）与用户给定剩余额度排序说明，绝不自动切换
function recommendProfiles(spec, total) {
  if (!spec.modelProfiles) return null;
  const needVision = spec.requiresVision;
  const medTotal = total.status === 'partial-unknown' ? total.subtotal.median : total.median;
  const highTotal = total.status === 'partial-unknown' ? total.subtotal.high : total.high;
  const candidates = spec.modelProfiles.map(p => {
    const satisfiesCaps = !needVision || p.capabilities.vision;
    const caveats = [];
    if (needVision && !p.capabilities.vision) caveats.push('缺少 vision 能力，不满足本任务必要视觉验证');
    let quotaOk = null, headroom = null;
    if (p.remainingQuotaTokens != null) {
      quotaOk = p.remainingQuotaTokens >= highTotal;
      headroom = r3(p.remainingQuotaTokens - medTotal);
      if (total.status === 'partial-unknown') caveats.push('total 含 unknown 维度，额度判断按小计/上界，不构成放行');
    } else caveats.push('未提供剩余额度，无法核对预算');
    return { name: p.name, satisfies: satisfiesCaps && quotaOk !== false, satisfiesCapabilities: satisfiesCaps, quotaOk, headroomTokens: headroom, caveats };
  });
  candidates.sort((a, b) => (b.satisfies - a.satisfies) || ((b.headroomTokens ?? -1) - (a.headroomTokens ?? -1)));
  return {
    requiredCapabilities: needVision ? ['text', 'vision'] : ['text'],
    candidates,
    note: '离线静态推荐，仅基于用户给定档案；不修改账号/模型，必要视觉验证不可为省 token 而裁撤',
  };
}
