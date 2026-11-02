// lib/budget/cli.mjs —— `nuwax-forge budget estimate|reconcile` 命令实现。
// 只读显式给出的文件（不扫仓、不读凭据）；输出不覆盖任何输入/源文件；写入原子（tmp+rename）。
// reconcile：全部路径守卫先于任何写副作用（out/history 双向检查），实耗不完整或口径未知时不写校准样本。
import { readFileSync, writeFileSync, renameSync, statSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UsageError } from '../args.mjs';
import { BudgetDataError, parseSpec, computeEstimate, parseHistoryLines } from './core.mjs';
import { parseActual, reconcileEstimate } from './actual.mjs';
import { parseGuardBudget, computeGuard, humanGuard } from './guard.mjs';

function readJsonFile(file, label) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { throw new BudgetDataError(`${label} 文件不可读：${file}（${e.message}）`); }
  try { return JSON.parse(text); }
  catch (e) { throw new BudgetDataError(`${label} 不是合法 JSON：${file}（${e.message}）`); }
}

// 规范路径：存在则 realpath（解析符号链接别名）；不存在则解析父目录 + 文件名
function canonical(p) {
  const abs = path.resolve(p);
  if (existsSync(abs)) { try { return realpathSync(abs); } catch { return abs; } }
  try { return path.join(realpathSync(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}
function sameFile(a, b) {
  if (canonical(a) === canonical(b)) return true;
  try { const sa = statSync(a), sb = statSync(b); return sa.dev === sb.dev && sa.ino === sb.ino; } catch { return false; }
}

export function atomicWriteJson(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

// 历史追加：按 estimateId+sourceHash 去重（重复 reconcile 不重复采样）；tmp+rename 原子重写
export function appendSampleText(historyFile, sample, priorText) {
  const { samples, diagnostics } = parseHistoryLines(priorText);
  const dup = samples.some(s => sample.estimateId != null && sample.sourceHash != null
    && s.estimateId === sample.estimateId && s.sourceHash === sample.sourceHash);
  if (dup) return { file: historyFile, appended: false, duplicateSkipped: true, totalSamples: samples.length, diagnostics };
  const line = JSON.stringify(sample);
  const next = (priorText ? (priorText.endsWith('\n') ? priorText : priorText + '\n') : '') + line + '\n';
  const tmp = path.join(path.dirname(historyFile), `.${path.basename(historyFile)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, historyFile);
  return { file: historyFile, appended: true, duplicateSkipped: false, totalSamples: samples.length + 1, diagnostics };
}

// 目标路径不得覆盖任何输入/源文件（realpath/inode 别名同样拒绝）；也不得指向目录
export function guardOutPath(out, inputs, label) {
  if (!out) return;
  if (existsSync(out) && statSync(out).isDirectory()) throw new BudgetDataError(`${label} 指向目录：${out}`);
  for (const [role, p] of inputs) {
    if (p && sameFile(out, p)) throw new BudgetDataError(`拒绝写入：${label}（${out}）与输入文件（${role}: ${p}）指向同一文件（realpath/inode 别名也拒绝）`);
  }
}

function humanEstimate(r) {
  const t = r.totalTokens;
  const total = t.status === 'partial-unknown' ? `小计 ${t.subtotal.low}–${t.subtotal.high}（unknown: ${t.unknownDimensions.join(',')}）` : `${t.low}–${t.high}`;
  return [
    `估算 ${r.spec.id}（${r.spec.model ?? 'no-model'} / ${r.spec.taskKind}）：${total} tokens（median 口径见 --json）`,
    `预算：${r.budget.verdict}${r.budget.headroomTokens != null ? `，余量 ${r.budget.headroomTokens}` : ''}；置信 ${r.confidence.level}`,
    ...r.unknowns.map(u => `unknown：${u}`),
    ...r.recommendations.map(rec => `建议[${rec.id}] ${rec.suggestion}`),
  ].join('\n');
}

function humanReconcile(r) {
  const rows = r.comparison.dimensions.filter(d => d.actual != null || d.estimateMedian != null)
    .map(d => `${d.dimension}: 估算 ${d.estimateMedian ?? 'unknown'} vs 实耗 ${d.actual ?? 'unknown'}${d.delta != null ? `（Δ${d.delta}${d.ratio != null ? `，×${d.ratio}` : ''}）` : ''}`);
  return [
    `实耗格式 ${r.actual.format}（inputSemantics=${r.actual.inputSemantics}，complete=${r.actual.completeness.complete}）`,
    ...rows,
    `预算（按实耗）：${r.budget.verdict}`,
    r.historyWrite ? `历史：${r.historyWrite.appended ? `追加 1 条（共 ${r.historyWrite.totalSamples}）` : r.historyWrite.duplicateSkipped ? '重复样本，跳过追加' : (r.historyWrite.reason ?? '未追加')}` : '未指定 --history，样本未持久化',
  ].join('\n');
}

export async function runBudget(opts) {
  const sub = opts.subcommand;
  if (!sub) throw new UsageError('budget 需要子命令 estimate、reconcile 或 guard');
  if (sub === 'guard') {
    // 宿主 Codex 会话守卫（phase gate，非供应商硬顶）：离线解析会话 JSONL 的 token_count，
    // 归一口径复用 actual.mjs；超限 exit 2、数据不足/unknown exit 3；只读，无 --out。
    for (const f of ['spec', 'history', 'out', 'estimate', 'actual']) {
      if (opts[f]) throw new UsageError(`budget guard 不接受 --${f}（属于 estimate/reconcile）`);
    }
    if (!opts.sessions || !opts.budget) {
      throw new UsageError('budget guard 需要 --sessions <codex 会话 JSONL 文件或目录> 与 --budget <预算 JSON>');
    }
    const budget = parseGuardBudget(readJsonFile(opts.budget, 'budget'));
    const report = computeGuard({ sessionsPath: opts.sessions, budget, marker: opts.marker ?? null, parentId: opts['parent-id'] ?? null });
    process.stdout.write(opts.json ? JSON.stringify(report, null, 2) + '\n' : humanGuard(report) + '\n');
    if (report.verdict === 'over') process.exitCode = 2;
    else if (report.verdict === 'unknown') process.exitCode = 3;
    return;
  }
  if (sub === 'estimate') {
    if (!opts.spec) throw new UsageError('budget estimate 需要 --spec <JSON>');
    if (opts.estimate || opts.actual) throw new UsageError('budget estimate 不接受 --estimate/--actual（属于 reconcile）');
    guardOutPath(opts.out, [['spec', opts.spec], ['history', opts.history]], 'estimate --out');
    const specRaw = readJsonFile(opts.spec, 'spec');
    const spec = parseSpec(specRaw);
    let history = { samples: [], diagnostics: [] };
    if (opts.history) history = parseHistoryLines(readHistoryText(opts.history));
    const result = computeEstimate(spec, history);
    if (history.diagnostics.length) result.historyDiagnostics = history.diagnostics;
    if (opts.out) atomicWriteJson(opts.out, result);
    process.stdout.write(opts.json ? JSON.stringify(result, null, 2) + '\n' : humanEstimate(result) + '\n');
    return;
  }
  if (sub === 'reconcile') {
    if (!opts.estimate || !opts.actual) throw new UsageError('budget reconcile 需要 --estimate <估算 JSON> 与 --actual <实耗 JSON>');
    if (opts.spec) throw new UsageError('budget reconcile 不接受 --spec（属于 estimate）');
    // 全部路径守卫先于读取与任何写副作用：--out 与 --history 都不得覆盖输入/互写
    const inputs = [['estimate', opts.estimate], ['actual', opts.actual]];
    if (opts.out && opts.history && sameFile(opts.out, opts.history)) throw new BudgetDataError('拒绝：--out 与 --history 指向同一文件');
    guardOutPath(opts.out, [...inputs, ['history', opts.history]], 'reconcile --out');
    if (opts.history) guardOutPath(opts.history, inputs, 'reconcile --history');
    const estimate = readJsonFile(opts.estimate, 'estimate');
    let actualText;
    try { actualText = readFileSync(opts.actual, 'utf8'); }
    catch (e) { throw new BudgetDataError(`actual 文件不可读：${opts.actual}（${e.message}）`); }
    let actualRaw;
    try { actualRaw = JSON.parse(actualText); }
    catch (e) { throw new BudgetDataError(`actual 不是合法 JSON：${opts.actual}（${e.message}）`); }
    const sourceHash = createHash('sha256').update(actualText).digest('hex');
    const parsed = parseActual(actualRaw);
    const result = reconcileEstimate(estimate, parsed, { sourceHash });
    if (opts.history) {
      const prior = readHistoryText(opts.history);
      if (result.usableForCalibration) {
        result.historyWrite = appendSampleText(opts.history, result.sample, prior);
      } else {
        // 未知/重试/不完整实耗不落成校准样本：防止污染并隐性降低下次预测
        result.historyWrite = {
          file: opts.history, appended: false, duplicateSkipped: false,
          reason: '实耗不完整或口径未知：不写入校准样本（不得降低下次预测）',
          diagnostics: parseHistoryLines(prior).diagnostics,
        };
      }
    } else {
      result.historyWrite = { appended: false, duplicateSkipped: false, reason: '未指定 --history，脱敏样本未持久化' };
    }
    if (opts.out) atomicWriteJson(opts.out, result);
    process.stdout.write(opts.json ? JSON.stringify(result, null, 2) + '\n' : humanReconcile(result) + '\n');
    return;
  }
  throw new UsageError(`budget 未知子命令 ${sub}（仅 estimate / reconcile）`);
}

export function readHistoryText(file) {
  try { return readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw new BudgetDataError(`history 文件不可读：${file}（${e.message}）`); }
}
