// One background invocation of the existing bounded runner. The state directory
// and its durable run.claim remain the task identity and execution authority.
import { fork } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionStatus } from './index.mjs';

export function status(state) {
  const manifest = executionStatus(state);
  const cancellationRequested = existsSync(path.join(state, 'cancel.request'));
  if (manifest.status === 'prepared' && cancellationRequested
      && !existsSync(path.join(state, 'job.claim')) && !existsSync(path.join(state, 'run.claim'))) {
    manifest.status = 'cancelled';
    manifest.stopReason = 'cancelled';
  }
  let heartbeatAt = null;
  try { heartbeatAt = JSON.parse(readFileSync(path.join(state, 'job-heartbeat.json'), 'utf8')).at; } catch {}
  let controllerError = null;
  try { controllerError = JSON.parse(readFileSync(path.join(state, 'job-error.json'), 'utf8')).message; } catch {}
  const age = Date.now() - Date.parse(heartbeatAt);
  return { ...manifest, cancellationRequested,
    heartbeatAt, heartbeatRecent: typeof heartbeatAt === 'string' && age >= 0 && age < 5000, controllerError };
}

export function cancel(state) {
  const current = status(state);
  if (!['prepared', 'running'].includes(current.status)) return current;
  try {
    writeFileSync(path.join(state, 'cancel.request'), JSON.stringify({ requestedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return status(state);
}

export async function start(state) {
  const current = status(state);
  if (current.status !== 'prepared' || current.cancellationRequested || existsSync(path.join(state, 'run.claim'))) throw new Error('后台启动需要未执行且未取消的 prepared 任务');
  const claim = openSync(path.join(state, 'job.claim'), 'wx', 0o600);
  closeSync(claim);
  const log = openSync(path.join(state, 'job.log'), 'ax', 0o600);
  let child;
  try {
    child = fork(fileURLToPath(new URL('./job-runner.mjs', import.meta.url)), [state], {
      detached: true, stdio: ['ignore', log, log, 'ipc'], execArgv: [],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('后台启动状态未知，请查询同一 state')), 5000);
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once('message', message => message?.ready && finish());
      child.once('error', finish);
      child.once('exit', code => finish(new Error('后台启动退出 ' + code)));
    });
    return { taskKey: current.taskKey, state, status: 'starting', cancellationRequested: false };
  } finally {
    closeSync(log);
    if (child?.connected) child.disconnect();
    child?.unref();
  }
}
