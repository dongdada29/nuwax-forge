// verify：调用本安装 stack 的 run_verification.py + crew-root + 明确可信 Node。
// 顺序契约：参数 → project → state（realpath 包含检查，在任何 mkdir 之前）→
// 配方/level 门（GUI level 未实现，拒绝）→ 解释器版本（实际调用探测）→ 才创建 state 并执行。
// 桥接 JSON 透传；进程 exit 0 不等于产品验收通过（还要看 passed 字段）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { resolvePackage, allDevkitRoots } from './resolve.mjs';
import { validateProjectBinding } from './recipe.mjs';
import { checkNode, checkPython } from './env.mjs';
import { realpathNearestExisting, resolveStateReal, isInside } from './paths.mjs';

function childExit(child) {
  return new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (code, signal) => res(signal ? 1 : code));
  });
}

function lastJsonLine(text) {
  for (const line of text.trimEnd().split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && 'passed' in parsed) return parsed;
    } catch { /* 非 JSON 行跳过 */ }
  }
  return null;
}

export async function runVerify({ project, state, 'task-key': taskKey, node, python, reuse = false }) {
  const missing = ['project', 'state', 'task-key'].filter(k => !({ project, state, 'task-key': taskKey }[k]));
  if (missing.length) throw new Error(`verify 缺少必填参数: --${missing.join(' --')}`);
  if (String(taskKey).trim().length === 0) throw new Error('--task-key 不能为空');

  const projectDir = resolve(project);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`--project 不是存在的目录: ${projectDir}`);
  }
  const projectReal = realpathNearestExisting(projectDir).real;

  // state 包含检查：逐组件 realpath 归一（含 symlink 别名与失效链接），先于任何 mkdir。
  const stateReal = resolveStateReal(resolve(state));
  if (isInside(projectReal, stateReal)) {
    throw new Error(`--state 必须在项目仓之外（realpath 解析为仓内: ${stateReal}）`);
  }
  for (const root of allDevkitRoots()) {
    const rootReal = realpathNearestExisting(root).real;
    if (isInside(rootReal, stateReal) || isInside(stateReal, rootReal)) {
      throw new Error(`--state 不得写入或覆盖 devkit 安装目录（${rootReal}）`);
    }
  }

  const stack = resolvePackage('@nuwax-ai/devkit-stack');
  const crew = resolvePackage('@nuwax-ai/devkit-crew');
  if (!stack) throw new Error('未找到 @nuwax-ai/devkit-stack（先安装 6 个 devkit 包，或运行 nuwax-forge doctor）');
  if (!crew) throw new Error('未找到 @nuwax-ai/devkit-crew（先安装 6 个 devkit 包，或运行 nuwax-forge doctor）');

  // 配方门：结构最小验证 + level 收紧（在创建 state 之前失败）
  const binding = validateProjectBinding(projectDir);
  if (binding.problems) throw new Error('配方验证失败（未创建 state）：\n  - ' + binding.problems.join('\n  - '));
  const bridge = join(stack.root, 'skills', 'nuwax-stack', 'scripts', 'run_verification.py');
  if (!existsSync(bridge)) throw new Error(`stack 桥接脚本缺失: ${bridge}`);

  // 解释器版本：实际调用被指定解释器探测（在创建 state 之前失败）
  const nodeCheck = checkNode(node);
  if (nodeCheck.problems.length) throw new Error(nodeCheck.problems.join('；'));
  const pythonCheck = checkPython(python);
  if (pythonCheck.problems.length) throw new Error(pythonCheck.problems.join('；'));

  mkdirSync(stateReal, { recursive: true });

  const argv = [pythonCheck.resolvedBin, '-B', bridge,
    '--repo', projectReal,
    '--crew-root', crew.root,
    '--state', stateReal,
    '--task-key', taskKey,
    '--node', nodeCheck.bin];
  if (reuse) argv.push('--reuse');

  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const code = await childExit(child);
  process.stdout.write(out);
  if (err.trim()) process.stderr.write(err);

  const verdict = lastJsonLine(out);
  if (code !== 0) {
    process.stderr.write(`verify 未通过：桥接退出码 ${code}${verdict ? '' : '（且没有可解析的桥接 JSON 结论）'}\n`);
    process.exitCode = code || 1;
    return;
  }
  if (!verdict || verdict.passed !== true) {
    // 进程 exit 0 不是产品通过：passed!==true 或无法解析结论都按失败处理
    process.stderr.write('verify 未通过：桥接进程退出 0，但产品验收结论不是 passed=true（进程退出码不代表验收）\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}
