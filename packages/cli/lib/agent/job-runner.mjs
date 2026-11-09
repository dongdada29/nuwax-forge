import { writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { run } from './index.mjs';

const state = process.argv[2];
function heartbeat() {
  const file = path.join(state, 'job-heartbeat.json');
  const temporary = file + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString() }), { mode: 0o600 });
  renameSync(temporary, file);
}
heartbeat();
const timer = setInterval(() => {
  try { heartbeat(); } catch { process.kill(process.pid, 'SIGTERM'); }
}, 1000);
process.send?.({ ready: true });
try {
  const result = await run(state);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  writeFileSync(path.join(state, 'job-error.json'), JSON.stringify({ message: error.message }), { mode: 0o600 });
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
} finally {
  clearInterval(timer);
  if (process.connected) process.disconnect();
}
