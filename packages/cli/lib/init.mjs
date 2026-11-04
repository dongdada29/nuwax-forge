// init：显式 opt-in 接线 verification。只调用 kit 的 verify:init（它保留既有
// hook/profile/配方，不覆盖）。本 CLI 在写入口径上先做配方验证：
// 非法 JSON / 结构缺失 / symlink / 越界 / 未实现 level 一律在 kit 执行前拒绝，
// 失败时不改任何 hook/config/runner。成功后回读实际入口。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { resolvePackage } from './resolve.mjs';
import { validateRecipeFile } from './recipe.mjs';

function childExit(child) {
  return new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (code, signal) => res(signal ? 1 : code));
  });
}

export async function runInit({ project, recipe }) {
  if (!project || !recipe) throw new Error('init 需要 --project 与 --recipe');
  const projectDir = resolve(project);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`--project 不是存在的目录: ${projectDir}`);
  }
  // 写入前验证：结构最小面 + level 门（GUI level 未实现即拒绝）
  const problems = validateRecipeFile(projectDir, recipe);
  if (problems) throw new Error('配方验证失败（未做任何写入）：\n  - ' + problems.join('\n  - '));
  const recipeFile = join(projectDir, recipe);

  const kit = resolvePackage('@nuwax-ai/nuwa-sdlc-kit');
  if (!kit) throw new Error('未找到 @nuwax-ai/nuwa-sdlc-kit（先安装 6 个 devkit 包，或运行 nuwax-forge doctor）');
  const kitCli = join(kit.root, 'cli.mjs');
  if (!existsSync(kitCli)) throw new Error(`kit CLI 缺失: ${kitCli}`);

  const child = spawn(process.execPath, [kitCli, 'verify:init', '--dir', projectDir, '--recipe', recipe], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const code = await childExit(child);
  process.stdout.write(out);
  process.stderr.write(err);
  if (code !== 0) {
    process.stderr.write(`init 失败：kit verify:init 退出 ${code}\n`);
    process.exitCode = code || 1;
    return;
  }
  const sdlcPath = join(projectDir, '.sdlc.json');
  const cfg = JSON.parse(readFileSync(sdlcPath, 'utf8'));
  const runner = cfg?.verification?.runner;
  process.stdout.write(`\n实际入口：\n  绑定文件 ${sdlcPath}\n  配方     ${join(projectDir, cfg.verification.recipe)}\n  运行器   ${runner ? join(projectDir, runner) : '(缺失)'}\n`);
  if (!runner || !existsSync(join(projectDir, runner))) {
    process.stderr.write('接线不完整：runner 未生成\n');
    process.exitCode = 1;
  }
}
