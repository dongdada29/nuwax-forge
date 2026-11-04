// Fresh, one-shot clients only. No resume/fork, discovery of sessions, or credential reads.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { statSync, realpathSync } from 'node:fs';

export const KINDS = ['codex', 'deepseek-harness'];
const number = n => Number.isSafeInteger(n) && n >= 0;
export function binaryPath(value, kind) {
  if (value !== undefined && !path.isAbsolute(value)) throw new Error('runtime.binary 必须是可信可执行文件的绝对路径');
  const candidate = value ?? kind;
  if (path.isAbsolute(candidate)) {
    if (!statSync(candidate).isFile()) throw new Error('runtime.binary 必须是普通文件');
    return realpathSync(candidate);
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    try { const p = path.join(dir, kind === 'codex' ? 'codex' : 'dsh'); if (statSync(p).isFile()) return realpathSync(p); } catch {}
  }
  throw new Error(`未找到 ${kind} 可执行文件`);
}
export function doctor(runtime) {
  if (!KINDS.includes(runtime?.kind)) throw new Error('runtime.kind 仅支持 codex / deepseek-harness');
  const binary = binaryPath(runtime.binary, runtime.kind);
  const probe = args => {
    const p = spawnSync(binary, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 262144 });
    if (p.error || p.status !== 0) throw new Error(`CLI 探针失败：${p.error?.message ?? p.status}`);
    return p.stdout;
  };
  const version = probe(['--version']).trim();
  const help = probe(runtime.kind === 'codex' ? ['exec', '--help'] : ['--help']);
  const supported = process.platform !== 'win32' && (runtime.kind === 'codex'
    ? ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', '--cd'].every(k => help.includes(k))
    : version === '0.2.1-rc.5' && help.includes('--patch') && help.includes('headless'));
  return { kind: runtime.kind, binary, version, supported, modelCalls: 0,
    usageProtocol: runtime.kind === 'codex' ? 'exec-json-turn-completed' : 'headless-rc5-step-end-total',
    note: '只核对 CLI 版本/帮助，不验证认证、模型可用性或 live 功能' };
}
export function dshPatch(spec, state) {
  const disabled = ['llm-retry', 'session-title-llm', 'tool-subagent', 'tool-subagent-fork', 'subagent-spawn-in-process',
    'subagent-fork-in-process', 'tool-subagent-control', 'tool-subagent-list-agents', 'goal-round-driver',
    'compaction-basic', 'command-compact', 'image-offload', 'tool-plugin-manager', 'plugin-manager', 'tool-web', 'tool-working-directory', 'workflow-ptc', 'tool-workflow'];
  // JSON is valid YAML; patch rows replace whole config, as the shipped bundle specifies.
  return [
    { id: 'agent-default-model', config: { provider: spec.runtime.provider, model: spec.runtime.model } },
    { id: 'sandbox-policy', config: { mode: spec.permissions.mode, workspaceRoot: spec.worktree } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { presets: { bounded: { sandbox: spec.permissions.mode, approval: 'never' } }, defaultPreset: 'bounded' } },
    { id: 'session-persistence-jsonl', config: { root: path.join(state, 'dsh-home', 'sessions') } },
    ...disabled.map(id => ({ id, disabled: true })),
  ];
}
export function command(spec, state) {
  if (spec.runtime.kind === 'codex') return [spec.runtime.binary, 'exec', '--json', '--ephemeral', '--ignore-user-config',
    '--ignore-rules', '--color', 'never', '--sandbox', spec.permissions.mode, '--cd', spec.worktree,
    '-m', spec.runtime.model, '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0',
    // Codex reserves built-in provider IDs. Keep its native provider/auth routing;
    // provider retries remain CLI-managed, bounded here by the outer wall-time limit.
    '-c', 'features.multi_agent=false', '-'];
  return [spec.runtime.binary, '--profile', 'headless', '--patch', path.join(state, 'dsh.patch.json'), '--json', '-'];
}
export function environment(kind, state) {
  const env = { ...process.env };
  for (const key of ['CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'NUWAX_CREW_BRIEF_FILE',
    'NUWAX_CREW_CONTEXT_MANIFEST', 'NUWAX_CREW_STEP_ARTIFACTS', 'DSH_PERMISSION_MODE', 'DSH_TOOLS_MODE']) delete env[key];
  if (kind === 'deepseek-harness') env.DSH_HOME = path.join(state, 'dsh-home');
  return env;
}

export class Observation {
  constructor(kind) { this.kind = kind; this.rows = []; this.seen = new Map(); this.errors = []; this.steps = new Set(); this.starts = new Set(); this.usage = []; this.final = false; this.completed = false; this.session = null; }
  bad(reason) { if (!this.errors.includes(reason)) this.errors.push(reason); }
  push(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return this.bad('invalid-event');
    if (e.type === 'error' || e.type === 'turn.failed') this.bad('runtime-error');
    if (e.type === 'thread.started' || e.type === 'session') {
      const id = e.thread_id ?? e.sessionId;
      if (typeof id !== 'string' || !id || this.session && this.session !== id) this.bad('session-identity-mismatch');
      else this.session = id;
    }
    if (this.kind === 'codex') {
      if (e.type === 'turn.started') this.starts.add(this.starts.size);
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') this.final = true;
      if (e.type === 'turn.completed') {
        if (this.usage.length) return this.bad('multiple-turn-completions');
        const u = e.usage ?? {};
        if (![u.input_tokens, u.output_tokens].every(number)) return this.bad('missing-usage');
        if (u.cached_input_tokens !== undefined && (!number(u.cached_input_tokens) || u.cached_input_tokens > u.input_tokens)) return this.bad('cache-subset-invalid');
        this.usage.push({ inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedReadTokens: u.cached_input_tokens ?? null,
          raw: u });
        this.completed = true;
      }
      return;
    }
    if (e.type === 'final') this.final = typeof e.text === 'string';
    if (e.type !== 'status') return;
    if (e.phase === 'turn_end') { this.completed = e.reason?.kind === 'completed'; if (!this.completed) this.bad('turn-not-completed'); }
    if (!['step_start', 'step_end'].includes(e.phase)) return;
    const key = JSON.stringify([e.turn, e.step]);
    if (e.turn === undefined || e.step === undefined) return this.bad('missing-step-identity');
    if (e.phase === 'step_start') { this.starts.add(key); return; }
    const fingerprint = JSON.stringify(e.usage ?? null);
    if (this.seen.has(key)) { if (this.seen.get(key) !== fingerprint) this.bad('conflicting-step-usage'); return; }
    this.seen.set(key, fingerprint); this.steps.add(key);
    const u = e.usage ?? {};
    if (e.truncated || ![u.inputTokens, u.outputTokens, u.totalTokens].every(number) || u.totalTokens < u.outputTokens) return this.bad('missing-or-invalid-usage');
    // rc.5 native + pi-ai totals include cache buckets. Count the exact total once;
    // optional cache breakdown remains unknown if absent (never manufacture zero).
    if (u.inputTokens + u.outputTokens > u.totalTokens) return this.bad('inconsistent-total');
    for (const k of ['cacheReadTokens', 'cacheWriteTokens']) if (u[k] !== undefined && (!number(u[k]) || u[k] > u.totalTokens - u.outputTokens)) return this.bad('cache-subset-invalid');
    this.usage.push({ inputTokens: u.totalTokens - u.outputTokens, outputTokens: u.outputTokens,
      cachedReadTokens: u.cacheReadTokens ?? null, cacheWriteTokens: u.cacheWriteTokens ?? null, raw: u });
  }
  result(clean = true) {
    const complete = clean && this.errors.length === 0 && Boolean(this.session) && this.completed && this.final && this.usage.length > 0
      && (this.kind === 'codex' ? this.starts.size === 1 : this.starts.size === this.steps.size && [...this.starts].every(k => this.steps.has(k)));
    const sum = key => {
      if (!this.usage.length || !this.usage.every(u => number(u[key]))) return null;
      const total = this.usage.reduce((s, u) => s + u[key], 0);
      return number(total) ? total : null;
    };
    const inputTokens = sum('inputTokens'), outputTokens = sum('outputTokens');
    // A failed/terminated process cannot establish a complete bill. Valid,
    // identified reports can still prove a lower bound, including cached input.
    const identifiedReports = this.errors.length === 0 && Boolean(this.session) && this.usage.length > 0
      && (this.kind === 'codex' ? this.starts.size === 1 : [...this.steps].every(k => this.starts.has(k)));
    const reportedTotal = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
    const reportedTokensLowerBound = identifiedReports && number(reportedTotal) ? reportedTotal : null;
    return { usageScope: complete ? 'run-segment' : 'unknown', inputSemantics: 'includes-cache', calls: null,
      usage: { inputTokens, outputTokens, cachedReadTokens: sum('cachedReadTokens'), cacheWriteTokens: sum('cacheWriteTokens') },
      observation: { known: complete, sessionId: this.session, agentCompleted: this.completed && this.final,
        reportedTokensLowerBound,
        reportedSteps: this.usage.length, errors: this.errors, rawUsage: this.usage.map(u => u.raw),
        note: 'calls unknown：step/turn 不等于 provider 请求数；缓存拆分未知保持 null；仅新会话 stdout，不读历史' } };
  }
}
