import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
export const sha = data => createHash('sha256').update(data).digest('hex');
export const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
export const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
export const inside = (base, child) => child === base || child.startsWith(base + path.sep);
export function safePath(input) {
  if (!path.isAbsolute(input) || /[\r\n\0]/.test(input) || input.split(/[\\/]/).includes('..')) throw Error('需要绝对路径，拒绝路径逃逸');
  const target = path.resolve(input);
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const s = fs.lstatSync(current);
      if (s.isSymbolicLink()) throw Error(`拒绝 symlink: ${current}`);
      if (current !== target && !s.isDirectory()) throw Error(`祖先不是目录: ${current}`);
      if (fs.realpathSync(current) !== current) throw Error(`realpath 不一致: ${current}`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const home = fs.realpathSync(os.homedir());
  if (target.split(path.sep).filter(Boolean).length < 3 || inside(target, home)) throw Error(`危险根/祖先路径: ${target}`);
  return target;
}
export function fileMap(root) {
  safePath(root);
  const result = {};
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name), rel = prefix + name, s = fs.lstatSync(full);
      if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) throw Error(`拒绝特殊文件: ${full}`);
      if (s.isDirectory()) walk(full, rel + '/');
      else result[rel] = sha(fs.readFileSync(full));
    }
  }
  walk(root); return result;
}
export function verifyBundle(bundle) {
  bundle = safePath(bundle);
  const manifest = read(path.join(bundle, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || !/^[\w.-]{1,100}$/.test(manifest.version) || !manifest.files || Array.isArray(manifest.files)) throw Error('无效 manifest');
  const files = fileMap(bundle); delete files['manifest.json'];
  if (Object.keys(files).length !== Object.keys(manifest.files).length || Object.keys(files).some(k => files[k] !== manifest.files[k])) throw Error('bundle hash/文件清单不匹配');
  for (const rel of Object.keys(files)) {
    if (rel.startsWith('/') || rel.split('/').some(p => !p || p === '..' || p === '.' || p.includes('\\'))) throw Error('manifest 路径逃逸');
  }
  return { ...manifest, id: manifest.version + '-' + sha(JSON.stringify(manifest)).slice(0, 16) };
}
export function snapshot(target, kind) {
  safePath(target);
  if (!fs.existsSync(target)) return null;
  if (kind === 'file') {
    if (!fs.statSync(target).isFile()) throw Error('目标不是普通文件');
    return { data: fs.readFileSync(target).toString('base64'), mode: fs.statSync(target).mode & 0o777 };
  }
  if (!fs.statSync(target).isDirectory()) throw Error('目标不是目录');
  const files = {};
  for (const rel of Object.keys(fileMap(target))) files[rel] = { data: fs.readFileSync(path.join(target, rel)).toString('base64'), mode: fs.statSync(path.join(target, rel)).mode & 0o777 };
  return { files };
}
export function restore(target, kind, content) {
  safePath(target);
  if (kind === 'file') {
    if (content === null) { fs.rmSync(target, { force: true }); return; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = target + '.devkit-tmp';
    const fd = fs.openSync(temp, 'wx', content.mode);
    try { fs.writeFileSync(fd, Buffer.from(content.data, 'base64')); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, target); return;
  }
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
  if (content === null) return;
  fs.mkdirSync(target, { recursive: true });
  for (const [rel, value] of Object.entries(content.files)) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw Error('snapshot 路径逃逸');
    const full = path.join(target, rel); fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(value.data, 'base64'), { mode: value.mode });
  }
}
