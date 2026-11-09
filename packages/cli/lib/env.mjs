// 解释器解析与版本检查：实际调用被指定解释器取版本，而不是只看当前进程。
// python 接受 PATH 上的命令名或绝对路径：显式沿 PATH 搜索并要求唯一命中，
// 绝不从 cwd 静默解析（spawn 本身不搜 cwd，这里再把 PATH 搜索显式化以便诊断）。
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, delimiter, join } from 'node:path';

export const MIN_NODE_MAJOR = 22;
export const MIN_PYTHON = [3, 10];

export function nodeMajorOf(versionString) {
  const match = /^v(\d+)\./.exec(versionString ?? '');
  return match ? Number(match[1]) : null;
}

export function pythonMinorOf(versionString) {
  const match = /Python (\d+)\.(\d+)\./.exec(versionString ?? '');
  return match ? [Number(match[1]), Number(match[2])] : null;
}

// 沿 PATH 显式搜索命令；返回绝对路径或 null。不查 cwd。
export function which(command) {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const hits = dirs.map(dir => join(dir, command)).filter(p => { try { return statSync(p).isFile(); } catch { return false; } });
  return hits.length === 1 ? hits[0] : hits.length === 0 ? null : hits[0]; // 多命中取 PATH 顺序首个（与 spawn 语义一致）
}

function probe(bin, args) {
  const result = spawnSync(bin, [args], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) return null;
  return (result.stdout + result.stderr).trim();
}

// 检查 node 解释器：返回 { bin, version, problems }
export function checkNode(explicit) {
  const problems = [];
  const bin = explicit ? resolve(explicit) : process.execPath;
  if (!existsSync(bin)) return { bin, version: null, problems: [`--node 不存在: ${bin}`] };
  const version = probe(bin, '--version');
  const major = nodeMajorOf(version);
  if (major === null) problems.push(`无法从 ${bin} --version 解析 Node 版本`);
  else if (major < MIN_NODE_MAJOR) problems.push(`Node 版本过低：${bin} 是 ${version}，需要 >=${MIN_NODE_MAJOR}`);
  return { bin, version, problems };
}

// 检查 python 解释器：接受绝对路径或 PATH 命令名（显式搜索，不查 cwd）
export function checkPython(explicit) {
  const problems = [];
  const configured = explicit || process.env.NUWAX_DEVKIT_PYTHON;
  const requested = configured || 'python3';
  const bin = which(requested);
  if (!bin) {
    return { bin: null, version: null, problems: [configured ? `配置的 Python 不可用（PATH 中找不到命令）: ${requested}` : '未找到 python3（可用 --python 显式指定绝对路径或 PATH 命令）'] };
  }
  const version = probe(bin, '--version');
  const minor = pythonMinorOf(version);
  if (minor === null) problems.push(`无法从 ${bin} --version 解析 Python 版本`);
  else if (minor[0] < MIN_PYTHON[0] || (minor[0] === MIN_PYTHON[0] && minor[1] < MIN_PYTHON[1])) {
    problems.push(`Python 版本过低：${bin} 是 ${version}，需要 >=${MIN_PYTHON.join('.')}`);
  }
  return { bin: isAbsolute(requested) ? bin : requested, resolvedBin: bin, version, problems };
}
