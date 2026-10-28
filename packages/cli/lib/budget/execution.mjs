// 真执行共用 guard：只复用既有预算/结算算法；不调用模型，不提供 provider 内部硬 token 限额。
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BudgetDataError, computeEstimate, parseSpec, parseHistoryLines, heuristicTextTokens } from './core.mjs';
import { parseActual, reconcileEstimate } from './actual.mjs';
import { appendSampleText, guardOutPath, readHistoryText } from './cli.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const CONTEXT_DEFAULTS = { maxBytes: 65536, maxTokens: 16000, maxFiles: 16 };
const CAPS = { maxBytes: 1048576, maxTokens: 262144, maxFiles: 64 };
const secretName = /^(\.env(?:\..*)?|\.envrc|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.ssh|\.aws|\.codex|\.git|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)(?:\.pub)?)$/i;

function positiveLimit(value, key) {
  const n = value ?? CONTEXT_DEFAULTS[key];
  if (!Number.isInteger(n) || n < 1 || n > CAPS[key]) throw new BudgetDataError(`context.${key} 必须为 1..${CAPS[key]} 整数`);
  return n;
}

export function readBoundedJson(file, label = 'JSON') {
  const st = statSync(file);
  if (!st.isFile() || st.size > CAPS.maxBytes) throw new BudgetDataError(`${label} 必须是 ≤1MiB 的普通文件`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// 不扫描项目，只读取显式白名单中的普通文本文件。每个文件先 stat，再按剩余字节上限读。
export function contextManifest({ brief = '', context = {}, worktree, command = null, inputs = [] } = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new BudgetDataError('context 必须是对象');
  const limits = Object.fromEntries(Object.keys(CONTEXT_DEFAULTS).map(k => [k, positiveLimit(context[k], k)]));
  const files = context.contextFiles ?? [];
  if (!Array.isArray(files) || files.some(f => typeof f !== 'string') || files.length > limits.maxFiles) throw new BudgetDataError('context.contextFiles 超限或不是路径数组');
  if (typeof brief !== 'string' || !Array.isArray(inputs) || inputs.some(s => typeof s !== 'string')) throw new BudgetDataError('brief/inputs 必须是文本');
  const entries = [];
  let bytes = 0, high = 0;
  const add = (text, metadata) => {
    const size = Buffer.byteLength(text);
    bytes += size;
    if (bytes > limits.maxBytes) throw new BudgetDataError(`context 超限：${bytes} bytes > ${limits.maxBytes}`);
    const tokens = heuristicTextTokens(text);
    high += tokens.high;
    if (high > limits.maxTokens) throw new BudgetDataError(`context 超限：启发式 HIGH ${high} > ${limits.maxTokens} tokens`);
    entries.push({ ...metadata, sha256: hash(text), bytes: size, tokens });
  };
  add(brief, { kind: 'brief' });
  // 命令文本中的内联 prompt 同样受界限约束；command 不在 manifest/日志中重复展开。
  if (command !== null) add(JSON.stringify(command), { kind: 'command' });
  inputs.forEach((text, i) => add(text, { kind: 'spec-input', index: i }));
  const root = files.length ? realpathSync(worktree) : null;
  for (const file of files) {
    const absolute = realpathSync(path.resolve(worktree, file));
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
      || [...file.split(/[\\/]/), ...relative.split(path.sep)].some(p => secretName.test(p))) throw new BudgetDataError(`context 文件越界或属于凭据/历史目录：${file}`);
    const st = statSync(absolute);
    if (!st.isFile() || st.size > limits.maxBytes - bytes) throw new BudgetDataError(`context 文件超字节上限或不是普通文件：${file}`);
    const data = readFileSync(absolute);
    if (data.includes(0)) throw new BudgetDataError(`context 文件必须是文本：${file}`);
    add(data.toString('utf8'), { kind: 'file', path: absolute });
  }
  return { kind: 'bounded-context-v1', limits, bytes, highTokens: high, entries,
    note: '显式输入快照 hash/字节/启发式 token；不扫描仓库。此界限不限制执行器运行后自行读取的文件/历史。' };
}

export function prepareExecution({ spec, history, remainingTokens, brief, context, worktree, command, requiredModel, minCalls = 1, requiresVision = false }) {
  let manifest = null, estimate = null;
  const blocked = reason => ({ managed: true, allowed: false, reason, context: manifest, estimate, reservedTokens: null });
  try {
    if (!spec) return blocked('missing-budget-spec');
    if (spec.mode !== 'model' || spec.expectedCalls < minCalls) return blocked('model-spec-mismatch');
    if (requiredModel && spec.model?.name !== requiredModel) return blocked('model-spec-mismatch');
    if (requiresVision && !/^gui\b|visual/i.test(spec.taskKind ?? '')) return blocked('vision-spec-required');
    parseSpec(spec); // 先验证原始字段；上下文 floor 不能把非法负数/字符串悄悄修正成合法值。
    manifest = contextManifest({ brief, context, worktree, command, inputs: spec.inputs ?? [] });
    // 输入显式数字只能增加基线，不能把实际交付文本的 HIGH 压低到 0。
    const effective = { ...spec, initialContextTokens: Math.max(spec.initialContextTokens ?? 0, manifest.highTokens) };
    if (history && statSync(history, { throwIfNoEntry: false })?.size > 4 * 1048576) return blocked('budget-history-too-large');
    estimate = computeEstimate(parseSpec(effective), parseHistoryLines(history ? readHistoryText(history) : ''));
    estimate.contextFloorTokens = manifest.highTokens;
    // 历史低耗样本不能压低本次已知交接上下文。复用核心给出的未校准 HIGH，不重抄公式。
    const guardHigh = Math.max(estimate.totalTokens.high ?? 0, estimate.baselineTokens.totalTokens.high);
    estimate.executionGuardHighTokens = guardHigh;
    if (estimate.budget.verdict === 'not-set') return blocked('missing-token-budget');
    if (estimate.totalTokens.status === 'partial-unknown' || !Number.isFinite(estimate.totalTokens.high)) return blocked('prediction-unknown');
    if (estimate.budget.verdict !== 'within' || guardHigh > estimate.budget.budgetTokens) return blocked('prediction-high-exceeds-budget');
    if (remainingTokens === null) return blocked('shared-usage-unknown');
    if (typeof remainingTokens !== 'number' || !Number.isFinite(remainingTokens)) return blocked('missing-shared-token-budget');
    if (remainingTokens < 0) return blocked('shared-budget-exhausted');
    if (guardHigh > remainingTokens) return blocked('prediction-high-exceeds-remaining');
    return { managed: true, allowed: true, reason: null, context: manifest, estimate, reservedTokens: guardHigh };
  } catch (error) { return { ...blocked('invalid-budget-or-context'), error: error.message }; }
}

// 结算未知保持 null；原始 scope/cache 数字全保留，不把 Claude 累计 result 当本阶段。
export function settleExecution({ estimate, actual = { usage: {} }, history, sourceHash, inputs = [] }) {
  if (history) guardOutPath(history, inputs, 'execution --budget-history');
  let reconciliation;
  try { reconciliation = reconcileEstimate(estimate, parseActual(actual), { sourceHash: sourceHash ?? hash(JSON.stringify(actual)) }); }
  catch (error) {
    reconciliation = reconcileEstimate(estimate, parseActual({ usage: {} }));
    reconciliation.actual.notes.push(`实耗文件不可用：${error.message}`);
  }
  if (history) {
    const prior = readHistoryText(history);
    reconciliation.historyWrite = reconciliation.usableForCalibration
      ? appendSampleText(history, reconciliation.sample, prior)
      : { appended: false, reason: '实耗/口径/scope unknown，不写校准样本' };
  }
  const total = reconciliation.comparison.dimensions.find(d => d.dimension === 'totalTokens')?.actual;
  return { reconciliation, chargedTokens: reconciliation.usableForCalibration && Number.isFinite(total) ? total : null };
}
