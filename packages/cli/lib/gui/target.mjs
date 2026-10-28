// 目标锁定（纯函数，离线可测）：从 CDP 枚举的 target 列表里按配方显式声明选择唯一目标。
// 禁止"选第一个 HTTP page"；guest 与 shell 用不同匹配语义；多候选/找不到/类型不符一律失败。
// 输入 targets 项形如 CDP /json/list：{ id/targetId, type, url, title, webSocketDebuggerUrl }。

function originOf(url) {
  if (typeof url !== 'string') return null;
  try { return new URL(url).origin; } catch { return null; }
}

// spec: { kind:'guest'|'shell', expectedOrigin, urlPattern?, type:'page'|'webview' }
// 实测（安装版 3.0.23 CDP）：商业 guest 是 type='webview'，shell 是 file://…app.asar 的 type='page'。
// 返回 { ok:true, target } 或 { ok:false, reason, candidates }（失败必须结构化，不抛出）。
export function lockTarget(spec, targets) {
  if (!Array.isArray(targets)) return { ok: false, reason: 'targets 不是数组（CDP 枚举失败或端点不可用）', candidates: [] };
  const wantType = spec?.type ?? 'page';
  if (wantType !== 'page' && wantType !== 'webview') {
    return { ok: false, reason: `target.type 仅支持 page/webview（收到 ${JSON.stringify(wantType)}）`, candidates: [] };
  }
  const urlRe = spec?.urlPattern ? new RegExp(spec.urlPattern) : null;
  const candidates = [];
  for (const t of targets) {
    if (!t || typeof t !== 'object') continue;
    const type = t.type ?? 'page';
    const url = typeof t.url === 'string' ? t.url : '';
    const origin = originOf(url);
    let matches;
    if (spec?.kind === 'shell') {
      // shell：Electron 主窗口，非 http(s) 协议（file:/app:/about:），按 urlPattern 显式匹配
      matches = type === wantType && !/^https?:/i.test(url) && (!urlRe || urlRe.test(url));
    } else {
      // guest：商业 webview，http(s) 且 origin 必须与预期**精确相等**（不是前缀、不是第一个HTTP页）
      matches = type === wantType && origin !== null && origin === spec?.expectedOrigin && (!urlRe || urlRe.test(url));
    }
    if (matches) candidates.push({ targetId: t.targetId ?? t.id ?? null, type, url, title: t.title ?? null });
  }
  if (spec?.kind !== 'shell' && spec?.kind !== 'guest') {
    return { ok: false, reason: `target.kind 必须是 guest 或 shell（收到 ${JSON.stringify(spec?.kind)}）`, candidates };
  }
  if (candidates.length === 0) {
    const near = targets.filter(t => t && typeof t === 'object' && originOf(t.url ?? '') === spec?.expectedOrigin && (t.type ?? 'page') !== wantType)
      .map(t => `${t.url} [type=${t.type ?? 'page'}]`);
    const seen = targets.filter(t => t && typeof t === 'object' && (t.type ?? 'page') === wantType).map(t => `${t.url || '(空url)'} [${originOf(t.url ?? '') ?? '无origin'}]`);
    const nearNote = near.length ? `；同 origin 但类型不符的候选（疑似类型声明错误）: ${near.join(' ; ')}` : '';
    return { ok: false, reason: `找不到声明的 ${spec.kind}/${wantType} 目标（expectedOrigin=${spec.expectedOrigin}）：当前 ${wantType} 类候选：${seen.length ? seen.join(' ; ') : '无'}${nearNote}。不回落到第一个 HTTP page，shell 不能替代 guest`, candidates };
  }
  if (candidates.length > 1) {
    return { ok: false, reason: `目标歧义：${candidates.length} 个候选匹配 ${spec.kind}/${spec.expectedOrigin}（${candidates.map(c => `${c.targetId} ${c.url}`).join(' ; ')}），必须唯一`, candidates };
  }
  return { ok: true, target: candidates[0] };
}

// 就绪判定：标题必须非空且匹配 titlePattern；加载页/空标题不算就绪。
export function checkReady(readySpec, documentTitle) {
  const title = typeof documentTitle === 'string' ? documentTitle : '';
  if (!title.trim()) return { ok: false, reason: '页面标题为空或缺失：加载页不算就绪' };
  const re = new RegExp(readySpec?.titlePattern ?? '\\S');
  if (!re.test(title)) return { ok: false, reason: `页面标题 "${title}" 不匹配 ready.titlePattern ${readySpec?.titlePattern}` };
  return { ok: true, title };
}
