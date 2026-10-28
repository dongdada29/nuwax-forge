// GUI 证据写入：仓外 attempt 专属目录 + manifest（一次性写入，不覆盖历史，不复用 GUI 动态证据）。
// attemptId 含 UTC 时间戳 + 随机后缀；同 ID 二次创建失败；manifest 已存在即拒绝。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
export function sha256String(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function newAttemptId(now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `attempt-${ts}-${rand}`;
}

// 创建一次性 attempt 目录；已存在（碰撞或重放）直接失败——GUI 动态证据不覆盖、不复用。
export function createAttemptDir(stateDir, attemptId) {
  const dir = join(stateDir, attemptId);
  if (existsSync(dir)) throw new Error(`attempt 目录已存在，拒绝覆盖/复用 GUI 动态证据: ${dir}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// manifest 一次性写入：目标文件已存在即失败（防重复写同一次 attempt 的不同结论）。
export function writeManifestOnce(attemptDir, manifest) {
  const file = join(attemptDir, 'manifest.json');
  if (existsSync(file)) throw new Error(`manifest.json 已存在，拒绝重复写入: ${file}`);
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return file;
}
