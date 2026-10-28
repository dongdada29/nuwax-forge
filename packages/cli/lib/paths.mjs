// 路径规范化：按最近存在祖先的 realpath 解析（覆盖未创建后缀与项目别名/symlink），
// 用于在任何 mkdir 之前做包含关系检查。
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export function realpathNearestExisting(p) {
  let abs = resolve(p);
  const missing = [];
  for (;;) {
    try {
      const realAncestor = realpathSync(abs);
      return { real: missing.length ? join(realAncestor, ...missing) : realAncestor, existedFully: missing.length === 0 };
    } catch {
      missing.unshift(basename(abs));
      const parent = dirname(abs);
      if (parent === abs) return { real: abs, existedFully: false }; // 到根都不存在
      abs = parent;
    }
  }
}

// 逐组件解析 state 路径：遇到符号链接立即按其目标（绝对或相对）realpath 归一，
// 失效链接（目标不存在）直接报错；首个不存在的组件之后的后缀保持原样（待创建部分）。
// 返回归一后的绝对路径；抛错即结构化拒绝。
export function resolveStateReal(p) {
  const abs = resolve(p);
  const parts = abs.split(sep).filter(Boolean);
  let current = abs.startsWith(sep) ? sep : dirname(abs);
  for (const part of parts) {
    const next = join(current, part);
    let stat;
    try {
      stat = lstatSync(next);
    } catch {
      return next; // 该组件不存在：其后为待创建后缀，不再解析
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(next);
      const resolved = isAbsolute(target) ? target : resolve(current, target);
      if (!existsSync(resolved)) {
        throw new Error(`--state 路径包含失效符号链接: ${next} -> ${target}`);
      }
      current = realpathSync(resolved);
    } else {
      current = next;
    }
  }
  return current;
}

export function isInside(parent, child) {
  const p = resolve(parent), c = resolve(child);
  return c === p || c.startsWith(p + sep);
}
