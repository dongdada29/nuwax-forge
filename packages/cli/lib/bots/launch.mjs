import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { startBot } from './profile.mjs';

// Accept only the pinned host's local bootstrap link, never a URL printed by a
// plugin pointing at another service. No link or cookie is saved by this helper.
export function browserCommand(value, platform = process.platform) {
  const url = new URL(value);
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d*\//.test(value) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.pathname !== '/' || url.hash ||
      !/^\?token=[A-Za-z0-9_-]+$/.test(url.search)) {
    throw new Error('Expected the native DSH loopback launch URL');
  }
  if (platform === 'darwin') return ['open', [url.href]];
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]];
  if (platform === 'linux') return ['xdg-open', [url.href]];
  throw new Error('Automatic browser opening is unavailable on this platform');
}

export function openBotBrowser(url, { signal } = {}) {
  const [command, args] = browserCommand(url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', timeout: 10000, signal });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Browser opener failed')));
  });
}

// Keep foreground ownership and signal forwarding even if opening the browser
// fails. The default path retains native stdio and never invokes an opener.
export async function runBotForeground(options, {
  start = startBot, openBrowser = openBotBrowser,
  stdout = process.stdout, stderr = process.stderr, signals = process,
} = {}) {
  const child = start(options, options.open ? ['inherit', 'pipe', 'pipe'] : 'inherit');
  const controller = new AbortController();
  let opened = false;
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  signals.on('SIGINT', interrupt); signals.on('SIGTERM', terminate);
  const listeners = [];
  if (options.open) {
    for (const [source, destination] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      let pending = '';
      const forward = chunk => {
        destination.write(chunk);
        if (opened) return;
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop().slice(-8192);
        for (const line of lines) {
          const candidate = stripVTControlCharacters(line).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
          if (!candidate) continue;
          try { browserCommand(candidate); } catch { continue; }
          opened = true;
          pending = '';
          Promise.resolve().then(() => {
            if (!controller.signal.aborted) return openBrowser(candidate, { signal: controller.signal });
          }).catch(() => {
            if (!controller.signal.aborted) stderr.write('forge bots: Browser could not open. Open the native local link printed above; the foreground host is still running.\n');
          });
          break;
        }
      };
      source.on('data', forward);
      listeners.push([source, forward]);
    }
  }
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
  } finally {
    controller.abort();
    signals.off('SIGINT', interrupt); signals.off('SIGTERM', terminate);
    for (const [source, listener] of listeners) source.off('data', listener);
  }
}
