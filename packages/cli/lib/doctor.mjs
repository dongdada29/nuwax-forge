// doctor：只读本机信息与已安装包；不联网、不授权、不启动应用、不改全局。
import { readFileSync } from 'node:fs';
import { locate } from './resolve.mjs';
import { nodeMajorOf as nodeMajor, pythonMinorOf as pythonMinor, checkPython, MIN_NODE_MAJOR, MIN_PYTHON } from './env.mjs';

export { nodeMajor, pythonMinor };

function compareTuple(a, b) {
  for (let i = 0; i < b.length; i++) {
    const d = (a[i] ?? 0) - b[i];
    if (d !== 0) return d;
  }
  return 0;
}

export async function runDoctor({ json = false } = {}) {
  const checks = [];
  const problems = [];

  const major = nodeMajor(process.version);
  if (major === null || major < MIN_NODE_MAJOR) {
    problems.push(`Node 版本过低：${process.version}，需要 >=${MIN_NODE_MAJOR}`);
    checks.push({ check: 'node', ok: false, found: process.version, need: `>=${MIN_NODE_MAJOR}` });
  } else {
    checks.push({ check: 'node', ok: true, found: process.version, need: `>=${MIN_NODE_MAJOR}` });
  }

  const pythonCheck = checkPython(process.env.NUWAX_DEVKIT_PYTHON);
  if (pythonCheck.problems.length) {
    problems.push(...pythonCheck.problems);
    checks.push({ check: 'python', ok: false, found: pythonCheck.version, bin: pythonCheck.bin, need: `>=${MIN_PYTHON.join('.')}` });
  } else {
    checks.push({ check: 'python', ok: true, found: pythonCheck.version, bin: pythonCheck.bin, need: `>=${MIN_PYTHON.join('.')}` });
  }

  const packages = ['@nuwax-ai/devkit-stack', '@nuwax-ai/devkit-crew', '@nuwax-ai/nuwa-sdlc-kit', '@nuwax-ai/devkit-contracts'];
  const packageResults = {};
  for (const name of packages) {
    const result = locate(name);
    packageResults[name] = result;
    if (!result.found) problems.push(...result.problems);
    checks.push({ check: 'package:' + name, ok: result.found, version: result.version ?? null, artifact: result.artifact ?? null });
  }
  // CLI 自身（运行中的这个包）
  const selfVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  checks.push({ check: 'package:@nuwax-ai/devkit-cli', ok: true, version: selfVersion });

  const ok = problems.length === 0;
  if (json) {
    process.stdout.write(JSON.stringify({ ok, problems, checks, node: process.version, python: pythonCheck.version ?? null }, null, 2) + '\n');
  } else {
    for (const c of checks) {
      const line = c.ok ? ' ok ' : 'FAIL';
      const detail = c.version ? ` v${c.version}` : c.found ? ` ${c.found}` : '';
      process.stdout.write(`[${line}] ${c.check}${detail}${c.artifact ? ' → ' + c.artifact : ''}\n`);
    }
    for (const p of problems) process.stdout.write(`! ${p}\n`);
    process.stdout.write(ok ? 'doctor: 全部检查通过\n' : `doctor: ${problems.length} 项问题\n`);
  }
  process.exitCode = ok ? 0 : 1;
}
