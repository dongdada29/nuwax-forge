// 配方最小结构验证 + level 门（CLI 收紧到实际支持的层级）。
// kit/stack 本身的通用性保留；统一 CLI 入口只放行 source-tooling，
// GUI 两级明确拒绝（未实现 live driver），防止普通脚本链 exit0 被标成 GUI level 进 TaskStore。
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { LEVELS } from '@nuwax-ai/devkit-contracts/gui/levels.mjs';
import { realpathNearestExisting, isInside } from './paths.mjs';

const SUPPORTED = new Set(LEVELS.filter(l => l.status === 'implemented').map(l => l.id)); // 当前只有 source-tooling

export function supportedLevels() {
  return [...SUPPORTED];
}

// 返回 null（通过）或失败原因数组。验证：非 symlink、相对、不越界、JSON 可解析、最小结构、level 受支持。
export function validateRecipeFile(projectDir, recipeRel) {
  const problems = [];
  if (typeof recipeRel !== 'string' || recipeRel.length === 0) return ['--recipe 必须是非空相对路径'];
  if (isAbsolute(recipeRel)) return ['--recipe 必须是项目内相对路径（收到绝对路径）'];
  const parts = recipeRel.split('/');
  if (parts.includes('..') || parts.includes('.')) return ['--recipe 不得包含 .. 或 . 路径段'];
  const file = resolve(projectDir, recipeRel);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return [`--recipe 在项目内不存在: ${recipeRel}`];
  }
  if (stat.isSymbolicLink()) return [`--recipe 不能是符号链接: ${recipeRel}`];
  if (!stat.isFile()) return [`--recipe 不是普通文件: ${recipeRel}`];
  // 配方完整 realpath 必须落在规范化项目根内：父目录符号链接（alias → 仓外）也算逃逸
  const projectReal = realpathNearestExisting(projectDir).real;
  const fileReal = realpathNearestExisting(file).real;
  if (!isInside(projectReal, fileReal)) {
    return [`--recipe 解析后逃逸出项目仓（${recipeRel} -> ${fileReal}）：父目录符号链接指向仓外同样拒绝`];
  }
  let recipe;
  try {
    recipe = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return [`配方不是有效 JSON（${recipeRel}）: ${error.message}`];
  }
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) return [`配方必须是 JSON 对象: ${recipeRel}`];
  if (recipe.schemaVersion !== 1) problems.push(`配方 schemaVersion 必须为 1（收到 ${JSON.stringify(recipe.schemaVersion)}）`);
  if (typeof recipe.id !== 'string' || !recipe.id.trim()) problems.push('配方 id 必须是非空字符串');
  if (typeof recipe.level !== 'string' || !recipe.level) {
    problems.push('配方 level 必填');
  } else if (!SUPPORTED.has(recipe.level)) {
    const known = LEVELS.some(l => l.id === recipe.level);
    problems.push(known
      ? `配方 level=${recipe.level} 未实现：live GUI driver 状态 pending，统一 CLI 只支持 ${[...SUPPORTED].join('/')}，不能用 source-tooling 脚本链冒充更高 level`
      : `配方 level=${recipe.level} 未注册（合法值：${LEVELS.map(l => l.id).join('/')}，其中 CLI 当前仅支持 ${[...SUPPORTED].join('/')}）`);
  }
  if (!Array.isArray(recipe.inputs) || recipe.inputs.length === 0 || recipe.inputs.some(i => typeof i !== 'string' || !i)) {
    problems.push('配方 inputs 必须是非空字符串数组');
  }
  if (!Array.isArray(recipe.stages) || recipe.stages.length === 0) {
    problems.push('配方 stages 必须是非空数组');
  } else {
    recipe.stages.forEach((stage, index) => {
      const at = `stages[${index}]`;
      if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) { problems.push(`${at} 必须是对象`); return; }
      if (typeof stage.id !== 'string' || !stage.id) problems.push(`${at}.id 必须是非空字符串`);
      if (typeof stage.predicate !== 'string' || !stage.predicate) problems.push(`${at}.predicate 必须是非空字符串`);
      if (!Array.isArray(stage.argv) || stage.argv.length === 0 || stage.argv.some(a => typeof a !== 'string')) {
        problems.push(`${at}.argv 必须是非空字符串数组（argv 数组，不经 shell）`);
      }
    });
  }
  return problems.length ? problems : null;
}

// 读取项目 .sdlc.json 的 verification 绑定并验证其配方（返回 {problems, binding}）
export function validateProjectBinding(projectDir) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(resolve(projectDir, '.sdlc.json'), 'utf8'));
  } catch (error) {
    return { problems: [`项目缺少可解析的 .sdlc.json（先运行 init 接线）: ${error.message}`] };
  }
  const binding = cfg?.verification;
  if (!binding || typeof binding !== 'object') return { problems: ['.sdlc.json 缺 verification 绑定（先运行 init）'] };
  if (typeof binding.recipe !== 'string' || !binding.recipe) return { problems: ['verification.recipe 必须是非空字符串'] };
  const problems = validateRecipeFile(projectDir, binding.recipe);
  return { problems, binding };
}
