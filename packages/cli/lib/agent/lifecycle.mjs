// POSIX ownership/termination only: mirror bounded.py's live-member checks.
// Every wait has a deadline; denial never means that the process was cleaned up.
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function processTable() {
  const p = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1048576 });
  if (p.error || p.status !== 0) throw new Error('process-inspection-unavailable');
  return p.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pid, parent, group, state] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), state };
  });
}
function members(pid, known, inspect) {
  const rows = inspect();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of rows) if (p.group === pid || known.has(p.parent)) {
      if (!known.has(p.pid)) { known.add(p.pid); changed = true; }
    }
  }
  return rows.filter(p => known.has(p.pid) && !p.state.includes('Z'));
}
export async function supervise(command, options = {}) {
  const { cwd, env, stdin = '', onStdout = () => {}, onStderr = () => {}, wallMs = 1000,
    graceMs = 250, pollMs = 20, signalProcess = process.kill.bind(process), inspectProcesses = processTable } = options;
  const began = performance.now(), known = new Set(), signals = [], cleanupErrors = [];
  let child, closed = false, exited = false, code = null, signal = null, launchError = null, stopReason = null;
  const stop = reason => { stopReason ??= reason; };
  const interrupt = () => stop('interrupted');
  const report = () => ({ pid: child?.pid ?? null, returnCode: code, signal, launchError, stopReason,
    cleanupFailed: cleanupErrors.length > 0, cleanupErrors, signals, closed, wallMs: Math.ceil(performance.now() - began) });
  const live = () => members(child.pid, known, inspectProcesses);
  const settle = async () => {
    if (!child.pid) return [];
    let alive;
    try { alive = live(); } catch (e) { cleanupErrors.push(e.message); return null; }
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      // A normal exit / successful TERM with no live descendants needs no KILL.
      if (!alive.length) break;
      const targets = [...(alive.some(p => p.group === child.pid) ? [-child.pid] : []), ...alive.filter(p => p.group !== child.pid).map(p => p.pid)];
      for (const target of targets) {
        signals.push({ target, signal: sig });
        try { signalProcess(target, sig); } catch (e) { if (e.code !== 'ESRCH') cleanupErrors.push(`${sig}:${e.code ?? e.message}`); }
      }
      const deadline = performance.now() + graceMs;
      do {
        await pause(pollMs);
        try { alive = live(); } catch (e) { cleanupErrors.push(e.message); return null; }
      } while (alive.length && performance.now() < deadline);
    }
    if (alive.length) cleanupErrors.push('live-owned-processes-remain');
    return alive.map(p => p.pid);
  };
  try {
    child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) known.add(child.pid);
    child.once('error', e => { launchError = e.message; });
    child.once('exit', (c, s) => { exited = true; code = c; signal = s; });
    child.once('close', () => { closed = true; });
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { try { onStdout(chunk, stop); } catch { stop('stdout-handler-failed'); } });
    child.stderr.on('data', chunk => { try { onStderr(chunk, stop); } catch { stop('stderr-handler-failed'); } });
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    while (!closed && !exited && !launchError && !stopReason) {
      if (performance.now() - began >= wallMs) { stop('wall-timeout'); break; }
      await pause(pollMs);
      // Remember descendants while the leader is still present, including ones
      // which later escape its group. Metadata only; never inspect their text.
      try { live(); } catch (e) { cleanupErrors.push(e.message); stop('process-inspection-unavailable'); }
    }
    const remainingPids = await settle();
    // exit can precede close indefinitely when an inaccessible process retains
    // a pipe. A fixed drain grace is the final wait, never await child.close.
    const closeDeadline = performance.now() + graceMs;
    while (!closed && performance.now() < closeDeadline) await pause(pollMs);
    if (!closed) cleanupErrors.push('client-close-deadline-exceeded');
    return { ...report(), remainingPids };
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy(); child?.unref();
  }
}
export async function terminationProbe(options = {}) {
  // Trusted fixed Node, not a Codex/DSH prompt. Self-expiry limits the damage if
  // the outer host cannot signal it. Same cwd/env/detached supervisor as run.
  let ready = false, output = '';
  const source = 'process.stdout.write("probe-ready\\n");setTimeout(()=>process.exit(0),3000);';
  const result = await supervise([process.execPath, '-e', source], { ...options, stdin: '', wallMs: 1000,
    onStdout: (chunk, stop) => { output += chunk; if (output.includes('probe-ready')) { ready = true; stop('probe-ready'); } }, onStderr: () => {} });
  const passed = ready && result.stopReason === 'probe-ready' && !result.cleanupFailed && result.signals.some(s => s.signal === 'SIGTERM');
  return { ...result, passed, ready, modelRequests: 0, executable: process.execPath,
    boundary: 'Fixed Node validates outer host spawn/inspect/signal supervision only; not Codex/DSH internal sandbox, provider access, or future permission stability.' };
}
