import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UsageError } from '../args.mjs';
import { isInside, realpathNearestExisting, resolveStateReal } from '../paths.mjs';
import { prepareExecution, settleExecution, readBoundedJson } from '../budget/execution.mjs';
import { doctor, command, environment, dshPatch, Observation } from './adapters.mjs';
import { supervise, terminationProbe } from './lifecycle.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const save = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
const emit = v => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const warning = 'phase gate, not provider hard token cap; in-flight/unreported calls unknown';
function statePath(input, project) {
  if (!input) throw new UsageError('agent 需要 --state 仓外目录');
  resolveStateReal(input);
  const state = realpathNearestExisting(input).real;
  for (const root of [project, moduleRoot]) if (root && (isInside(root, state) || isInside(state, root))) throw new UsageError('--state 必须在 worktree/devkit 仓外，且不能为它们的祖先');
  return state;
}
function validate(raw) {
  if (raw.schemaVersion !== 1 || typeof raw.taskKey !== 'string' || !/^[\w.-]{1,80}$/.test(raw.taskKey)) throw new UsageError('agent spec 需要 schemaVersion=1 和有限 taskKey');
  if (!raw.runtime?.model || typeof raw.runtime.model !== 'string' || raw.runtime.model.length > 150) throw new UsageError('runtime.model 必须显式指定');
  if (raw.runtime.kind === 'deepseek-harness' && (typeof raw.runtime.provider !== 'string' || !raw.runtime.provider)) throw new UsageError('DSH 需要显式 runtime.provider');
  if (!['read-only', 'workspace-write'].includes(raw.permissions?.mode)) throw new UsageError('permissions.mode 必须显式 read-only / workspace-write');
  if (raw.runtime.contextMode !== 'fresh-exec' || raw.budget?.maxAttempts !== 1 || (raw.retries ?? 0) !== 0) throw new UsageError('只支持 fresh-exec、maxAttempts=1、retries=0');
  for (const [key, cap] of [['maxTokens', 10000000], ['maxWallSeconds', 3600]]) if (!Number.isSafeInteger(raw.budget[key]) || raw.budget[key] < 1 || raw.budget[key] > cap) throw new UsageError(`budget.${key} 必须为 1..${cap} 整数`);
  for (const key of ['resume', 'sessionId', 'parentId', 'history', 'command', 'args', 'patch', 'home']) if (raw.runtime[key] !== undefined) throw new UsageError(`runtime.${key} 不支持；客户端只启动新会话`);
  const project = realpathNearestExisting(raw.worktree).real;
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: project, encoding: 'utf8', timeout: 5000 });
  if (git.status !== 0 || realpathNearestExisting(git.stdout.trim()).real !== project) throw new UsageError('worktree 必须是显式 Git checkout 根目录');
  return { ...raw, worktree: project };
}
function load(state) {
  const spec = validate(readBoundedJson(path.join(state, 'request.json')));
  statePath(state, spec.worktree);
  return spec;
}
export async function prepare(opts) {
  if (!opts.spec || !opts['brief-file']) throw new UsageError('agent prepare 需要 --spec --brief-file --state');
  const spec = validate(readBoundedJson(opts.spec));
  const state = statePath(opts.state, spec.worktree);
  if (existsSync(state)) throw new UsageError('--state 必须是不存在的新目录，每个任务独立且只运行一次');
  const briefFile = path.resolve(opts['brief-file']);
  if (!statSync(briefFile).isFile() || statSync(briefFile).size > 65536) throw new UsageError('brief 必须是 ≤64KiB 普通文件');
  const brief = readFileSync(briefFile, 'utf8');
  if (!brief.trim() || brief.includes('\0')) throw new UsageError('brief 必须是非空文本');
  const probe = doctor(spec.runtime); spec.runtime = { ...spec.runtime, binary: probe.binary };
  const prompt = `独立新任务。不要读取其它会话、凭据或全量历史，不另派代理，不重试。仅在工作目录执行本任务，权限为 ${spec.permissions.mode}。完成与产品验收分别报告。\n\n${brief}`;
  const cmd = command(spec, state);
  const decision = prepareExecution({ spec: spec.budgetSpec, remainingTokens: spec.budget.maxTokens, brief: prompt,
    context: spec.context, worktree: spec.worktree, command: cmd, requiredModel: spec.runtime.model });
  if (!probe.supported) { decision.allowed = false; decision.reason = 'unsupported-cli-protocol'; }
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(state, 'brief.txt'), prompt, { mode: 0o600 });
  save(path.join(state, 'request.json'), spec); save(path.join(state, 'doctor.json'), probe);
  save(path.join(state, 'command.json'), cmd); save(path.join(state, 'budget-guard.json'), decision);
  save(path.join(state, 'context-manifest.json'), decision.context);
  if (spec.runtime.kind === 'deepseek-harness') save(path.join(state, 'dsh.patch.json'), dshPatch(spec, state));
  const manifest = { kind: 'client-agent-run-v1', taskKey: spec.taskKey, status: decision.allowed ? 'prepared' : 'blocked',
    runtime: probe, contextHash: decision.context ? hash(JSON.stringify(decision.context)) : null,
    permissions: spec.permissions, maxAttempts: 1, modelDispatched: false, processPassed: false,
    agentCompleted: false, acceptancePassed: null, reason: decision.reason, warning };
  save(path.join(state, 'manifest.json'), manifest); return { ...manifest, state };
}
export function reconcile(state) {
  const spec = load(state), manifestFile = path.join(state, 'manifest.json');
  const manifest = readBoundedJson(manifestFile), guard = readBoundedJson(path.join(state, 'budget-guard.json'));
  if (!guard.estimate) throw new UsageError('没有可结算的预算预测');
  const observer = new Observation(spec.runtime.kind), log = path.join(state, 'stdout.jsonl');
  let validLog = true;
  if (existsSync(log) && statSync(log).size <= 8 * 1048576) {
    for (const line of readFileSync(log, 'utf8').split('\n').filter(s => s.trim())) try { observer.push(JSON.parse(line)); } catch { validLog = false; observer.bad('malformed-jsonl'); }
  } else { validLog = false; observer.bad('missing-or-oversized-log'); }
  const actual = observer.result(validLog && manifest.processPassed === true);
  save(path.join(state, 'usage.json'), actual);
  const settlement = settleExecution({ estimate: guard.estimate, actual });
  const lowerBound = actual.observation.reportedTokensLowerBound;
  settlement.observedBudget = { maxTokens: spec.budget.maxTokens, reportedTokensLowerBound: lowerBound,
    verdict: lowerBound !== null && lowerBound > spec.budget.maxTokens ? 'exceeds' : 'unknown',
    note: '已报告用量下界（含缓存输入），不是完整账单；低于限额不能证明预算达标。' };
  save(path.join(state, 'budget-reconcile.json'), settlement);
  const result = { ...manifest, agentCompleted: actual.observation.agentCompleted, usageKnown: actual.observation.known,
    budgetPassed: settlement.reconciliation.budget.verdict === 'within' && settlement.observedBudget.verdict !== 'exceeds', chargedTokens: settlement.chargedTokens,
    observedBudget: settlement.observedBudget,
    acceptancePassed: null, warning };
  result.status = result.processPassed && result.agentCompleted && result.budgetPassed ? 'completed' : result.modelDispatched ? 'failed' : 'blocked';
  save(manifestFile, result); return { ...result, state };
}
export async function run(state, lifecycleOptions = {}) {
  const spec = load(state), manifestFile = path.join(state, 'manifest.json');
  const manifest = readBoundedJson(manifestFile);
  if (manifest.status !== 'prepared') throw new UsageError('只运行 prepared 的新任务；失败/完成后禁止 retry/resume');
  const prompt = readFileSync(path.join(state, 'brief.txt'), 'utf8'), cmd = command(spec, state);
  const decision = prepareExecution({ spec: spec.budgetSpec, remainingTokens: spec.budget.maxTokens, brief: prompt,
    context: spec.context, worktree: spec.worktree, command: cmd, requiredModel: spec.runtime.model });
  const probe = doctor(spec.runtime);
  if (!decision.allowed || !probe.supported || hash(JSON.stringify(decision.context)) !== manifest.contextHash) {
    const blocked = { ...manifest, status: 'blocked', reason: 'pre-run-guard-or-context-changed' }; save(manifestFile, blocked); return { ...blocked, state };
  }
  // Atomic claim survives crashes. No second model dispatch from this state.
  let claim; try { claim = openSync(path.join(state, 'run.claim'), 'wx', 0o600); closeSync(claim); } catch { throw new UsageError('此 state 已启动过一次，禁止再次运行'); }
  const env = environment(spec.runtime.kind, state);
  const termination = await terminationProbe({ ...lifecycleOptions, cwd: spec.worktree, env });
  save(path.join(state, 'termination-probe.json'), termination);
  if (!termination.passed) {
    const blocked = { ...manifest, status: 'blocked', reason: 'termination-probe-blocked', modelDispatched: false,
      cleanupFailed: termination.cleanupFailed, usageKnown: false, chargedTokens: null, budgetPassed: false, terminationProbe: termination };
    save(manifestFile, blocked); return { ...blocked, state };
  }
  const output = openSync(path.join(state, 'stdout.jsonl'), 'wx', 0o600), error = openSync(path.join(state, 'stderr.log'), 'wx', 0o600);
  manifest.status = 'running'; manifest.modelDispatched = true; manifest.startedAt = new Date().toISOString(); save(manifestFile, manifest);
  const observer = new Observation(spec.runtime.kind);
  let pending = '', bytes = 0, lifecycle;
  try {
    lifecycle = await supervise(cmd, { ...lifecycleOptions, cwd: spec.worktree, env, stdin: prompt, wallMs: spec.budget.maxWallSeconds * 1000,
      onStderr: (chunk, stop) => { bytes += chunk.length; if (bytes > 8 * 1048576) { stop('output-limit'); return; } writeFileSync(error, chunk); },
      onStdout: (chunk, stop) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 8 * 1048576) { stop('output-limit'); return; }
        writeFileSync(output, chunk); pending += chunk;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines.filter(x => x.trim())) {
          try { observer.push(JSON.parse(line)); } catch { observer.bad('malformed-jsonl'); stop('malformed-jsonl'); }
        }
        const u = observer.result(false).usage;
        if (u.inputTokens !== null && u.outputTokens !== null && u.inputTokens + u.outputTokens > spec.budget.maxTokens) stop('observed-token-budget-exceeded');
      },
    });
  } finally { closeSync(output); closeSync(error); }
  save(manifestFile, { ...manifest, ...lifecycle, terminationProbe: termination, finishedAt: new Date().toISOString(),
    processPassed: lifecycle.returnCode === 0 && !lifecycle.signal && !lifecycle.stopReason && !lifecycle.cleanupFailed && !lifecycle.launchError });
  return reconcile(state);
}
export async function runAgent(opts) {
  let result;
  if (opts.subcommand === 'doctor') result = doctor({ kind: opts.runtime, binary: opts.binary });
  else if (opts.subcommand === 'prepare') result = await prepare(opts);
  else if (['run', 'reconcile'].includes(opts.subcommand)) {
    const state = statePath(opts.state);
    result = opts.subcommand === 'run' ? await run(state) : reconcile(state);
  } else throw new UsageError('agent 需要 doctor / prepare / run / reconcile');
  emit(result);
  process.exitCode = result.supported === false || result.status === 'blocked' ? 3 : result.status === 'failed' ? 1 : 0;
}
