/** 在 ego-browser 已登录的 Page 中同步技能；Cookie 留在浏览器，不导出 AK。 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function save(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
}

export async function syncSkills(page, { root, baseUrl, spaceId, category = 'dev', publish = false }) {
  if (!path.isAbsolute(root) || new URL(baseUrl).origin !== baseUrl || !Number.isSafeInteger(spaceId) || spaceId <= 0) throw Error('显式配置仓路径、平台 origin 和空间 ID');
  if (publish && !category) throw Error('发布需要分类');
  const preview = JSON.parse(await fs.readFile(path.join(root, 'dist/production/platform-preview.json'), 'utf8'));
  if (preview.some(x => x.body.spaceId !== spaceId)) throw Error('预演空间不匹配');
  const stateFile = path.join(root, '.local/production-state.json');
  let state;
  try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { base_url: baseUrl, space_id: spaceId, skills: {} }; }
  if (state.base_url !== baseUrl || state.space_id !== spaceId) throw Error('状态环境不匹配');
  async function api(method, endpoint, body) {
    const result = await page.evaluate(async ({ baseUrl, method, endpoint, body }) => {
      if (location.origin !== baseUrl) throw Error('浏览器不在指定生产 origin');
      const response = await fetch(endpoint, { method, credentials: 'include', redirect: 'error', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const payload = await response.json();
      return { status: response.status, code: payload.code, data: payload.data };
    }, { baseUrl, method, endpoint, body });
    if (result.status !== 200 || result.code !== '0000') throw Error(`平台停止：${endpoint} HTTP ${result.status} code ${result.code}`);
    return result.data;
  }
  const spaces = await api('GET', '/api/space/list');
  if (!spaces.some(x => x.id === spaceId && x.type === 'Personal' && x.currentUserRole === 'Owner')) throw Error('未确认个人空间所有权');
  if (publish) {
    const categories = await api('GET', '/api/published/category/list');
    if (!categories.some(x => x.type === 'Skill' && x.children?.some(y => y.key === category))) throw Error('分类在当前平台不存在');
  }
  const receipt = [];
  for (const item of preview) {
    const name = item.body.name;
    const entry = state.skills[name] || {};
    if (entry.pending_create) throw Error(`${name} 创建结果不明，先核对，禁止重复 add`);
    let id = entry.id;
    if (id) {
      const detail = await api('GET', '/api/skill/' + id);
      if (detail.name !== name || detail.spaceId !== spaceId) throw Error('技能身份不匹配');
      const oldNames = new Set((detail.files || []).filter(x => !x.isDir).map(x => x.name));
      const localNames = new Set(item.body.files.map(x => x.name));
      const files = item.body.files.map(x => ({ ...x, operation: oldNames.has(x.name) ? 'modify' : 'create' }));
      for (const rel of oldNames) if (!localNames.has(rel)) files.push({ name: rel, contents: '', operation: 'delete', isDir: false });
      await api('POST', '/api/skill/update', { ...item.body, id, files });
    } else {
      const matches = await api('GET', '/api/skill/list?spaceId=' + spaceId + '&name=' + encodeURIComponent(name));
      const list = Array.isArray(matches) ? matches : matches.records || matches.data || [];
      if (list.some(x => x.name === name)) throw Error(`${name} 在平台已有同名项，先核对 ID`);
      state.skills[name] = { pending_create: true }; await save(stateFile, state);
      id = Number(await api('POST', '/api/skill/add', item.body));
      if (!Number.isSafeInteger(id) || id <= 0) throw Error('创建 ID 未确认');
      state.skills[name] = { id }; await save(stateFile, state);
    }
    const exportFile = path.join(root, '.local/production-exports', name + '.zip');
    await fs.mkdir(path.dirname(exportFile), { recursive: true });
    const exported = await page.fetch('/api/skill/export/' + id, { credentials: 'include', timeout: 15000, saveAs: exportFile });
    if (!exported.ok) throw Error('导出失败');
    const code = 'import sys,pathlib;sys.path.insert(0,sys.argv[1]+"/scripts");import sync_platform as s;local=s.collect_skill(pathlib.Path(sys.argv[1])/"skills"/sys.argv[2]);remote=s.export_files(pathlib.Path(sys.argv[3]).read_bytes(),sys.argv[2]);assert local["files"]==remote,"export mismatch"';
    const verified = spawnSync('python3', ['-B', '-c', code, root, name, exportFile], { encoding: 'utf8' });
    if (verified.status !== 0) throw Error(`导出核验失败：${name}`);
    if (publish) {
      await api('POST', '/api/publish/apply', { targetType: 'Skill', targetId: id, category, remark: name + ' autonomous/owned-ledger update', items: [{ scope: 'Space', spaceId, allowCopy: 1, onlyTemplate: 0 }] });
      const detail = await api('GET', '/api/skill/' + id);
      if (detail.publishStatus !== 'Published') throw Error('发布状态未确认');
    }
    receipt.push({ name, id, verified: true, published: publish });
    await save(path.join(root, '.local/production-suite-verification.json'), receipt);
    console.log(receipt.at(-1));
  }
  return receipt;
}
