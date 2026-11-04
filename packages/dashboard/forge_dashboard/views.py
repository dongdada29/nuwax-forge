"""运行看板生成器：本地 JSON 状态 -> 自包含 HTML。纯函数，不联网、无常驻。"""

from __future__ import annotations

import html
import os
import re
import shlex
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from . import sources as unified_dashboard

BOARD_COLUMNS = [
    ("待分诊/待决策", ["pending-triage", "pending", "plan-only", "pending-decision"], "wait"),
    ("进行中", ["partial", "code-landed-unverified", "unmerged-wip", "unmerged-wip-im", "pending-coordination"], "run"),
    ("待复验/验收", ["merged-needs-acceptance", "released-await-verify", "test-verified-web-sample-pending", "mac-verified-win-pending"], "verify"),
    ("已验证完成", ["done-verified-web", "verified-live", "verified-live-partial", "verified-web-partial", "triaged-a-closed-verified"], "done"),
    ("挂起/其它", ["excluded-im-pending"], "hold"),
    ("非本人未接", ["other-owner-not-taken"], "other"),
]
MAX_CARDS = 12

CSS = (Path(__file__).resolve().parent.parent / "web" / "styles.css").read_text(encoding="utf-8")


def esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)


def configured_engine(executor):
    """Best-effort label from the configured executable, never a model claim."""
    command = (executor.get('invocation') or {}).get('command')
    try:
        parts = shlex.split(command) if isinstance(command, str) else list(command) if isinstance(command, list) else []
        parts = [p for p in parts if isinstance(p, str)]
    except ValueError:
        return '未识别'
    if not parts: return '未识别'
    if os.path.basename(parts[0]) == 'env':
        i = 1
        while i < len(parts):
            if parts[i] in ('-u', '--unset'):
                i += 2
            elif re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', parts[i]):
                i += 1
            else:
                break
        parts = parts[i:]
    if not parts: return '未识别'
    command_name = os.path.basename(parts[0]).lower()
    if command_name in ('node', 'bun') and len(parts) > 1:
        command_name = os.path.basename(parts[1]).lower()
    return {'omp': 'OMP', 'dsh': 'DeepSeek Harness', 'zcode': 'Z Code', 'zcode.cjs': 'Z Code',
            'opencode': 'OpenCode', 'claude': 'Claude Code', 'codex': 'Codex',
            'cursor-agent': 'Cursor', 'agy': 'Antigravity'}.get(command_name, '未识别')


def delivery_html(record):
    delivery = unified_dashboard.delivery_fields(record)
    rows = []
    if delivery.get('branch'): rows.append('分支：' + esc(delivery['branch']))
    if delivery.get('commit'): rows.append('提交：<code>' + esc(delivery['commit']) + '</code>')
    if delivery.get('prUrl'):
        rows.append('PR：<a href="' + esc(delivery['prUrl']) + '" target="_blank" rel="noopener noreferrer">查看 PR ↗</a>')
    return ''.join('<div>' + row + '</div>' for row in rows) or '<span class="dim">未记录</span>'


def _status_cell(name: str, meta: dict, health: dict) -> str:
    if not meta.get("enabled", True):
        return '<span class="err">⏹ 下架</span>'
    if name in health:
        reason = health.get(name, {}).get("reason", "")
        until = health.get(name, {}).get("until", "")
        return f'<span class="warn">❄ 冷却</span><div class="dim">{esc(reason)} → {esc(until)}</div>'
    if meta.get("verified"):
        return '<span class="ok">✅ 可用</span>'
    return '<span class="warn">⏳ 未核验</span>'


def board_columns(matrix: list) -> list:
    buckets = {title: [] for title, _, _ in BOARD_COLUMNS}
    mapping = {k: t for t, keys, _ in BOARD_COLUMNS for k in keys}
    for it in matrix:
        col = mapping.get(it.get("status", ""), "挂起/其它")
        buckets[col].append({
            "key": it.get("key", "?"),
            "title": str(it.get("title", "")).replace("**", "")[:72],
            "evidence": str(it.get("evidence", ""))[:180],
        })
    return [(title, cls, buckets[title]) for title, _, cls in BOARD_COLUMNS]


def build_html(usage: dict, registry: dict, health: dict, matrix: list, flow_rows: list, *, generated_at: str, records=None, notes=None, approval_items=None, approvals_actionable=False) -> str:
    ex = usage["perExecutor"]
    subs = usage["perSubscription"]
    total = sum(v["total"] for v in ex.values())
    ok = sum(v["ok"] for v in ex.values())
    failed = sum(v["failed"] for v in ex.values())
    active = [n for n, v in ex.items() if v.get("enabled", True) and n not in health]
    ok_rate = f"{ok / total:.0%}" if total else "—"

    pending_kpi = (f'<div class="kpi hot"><div class="n">{sum(1 for i in approval_items if i.get("status") == "pending")}</div><div class="l">待审批（显示范围）</div></div>' if approval_items is not None else '')
    kpis = f"""
    <div class="kpis">
      {pending_kpi}
      <div class="kpi"><div class="n">{total}</div><div class="l">台账记录</div></div>
      <div class="kpi good"><div class="n">{ok_rate}</div><div class="l">记录成功率</div></div>
      <div class="kpi hot"><div class="n">{len(active)}</div><div class="l">已启用且未冷却</div></div>
      <div class="kpi {'bad' if health else ''}"><div class="n">{len(health)}</div><div class="l">冷却中</div></div>
      <div class="kpi"><div class="n">{len(matrix)}</div><div class="l">看板条目</div></div>
      <div class="kpi bad"><div class="n">{failed}</div><div class="l">失败记录数</div></div>
    </div>"""

    sub_cards = []
    for label in sorted(subs, key=lambda x: -subs[x]["total"]):
        s = subs[label]
        cls = ""
        for name in s["executors"]:
            meta = next((e for e in registry["executors"] if e["name"] == name), {})
            cc = meta.get("costClass")
            if cc == "api":
                cls = "api"
            elif cc == "local":
                cls = "local"
            break
        rate = f"{s['okRate']:.0%}" if s["okRate"] is not None else "—"
        chips = "".join(f'<span class="chip">{esc(n)}</span>' for n in s["executors"])
        sub_cards.append(f"""<div class="sub {cls}"><h3>{esc(label)}</h3>
        <div class="row"><span>记录 <b>{s['total']}</b></span><span>近{usage['days']}天 <b>{s['window']}</b></span>
        <span>记录成功率 <b>{rate}</b></span><span>失败 <b>{s['failed']}</b></span></div>
        <div class="chips">{chips}</div></div>""")
    subs_html = "".join(sub_cards) or '<div class="dim">暂无派工记录</div>'

    tier_order = {"S": 0, "A": 1, "B": 2, "C": 3, "fixed": 4}
    pool_rows = []
    for name, v in sorted(ex.items(), key=lambda kv: (tier_order.get(kv[1].get("tier"), 9), kv[0])):
        cap = str(v['today'])
        rate = f"{v['okRate']:.0%}" if v["okRate"] is not None else "—"
        pool_rows.append(f"""<tr><td><b>{esc(name)}</b></td><td><span class="badge {esc(v.get('tier') or '')}">{esc(v.get('tier') or '-')}</span></td>
        <td>{esc(v.get('subscription') or '-')}</td><td>{_status_cell(name, v, health)}</td>
        <td>{cap}</td><td>{rate}</td><td>{v['total']}</td><td class="dim">{esc(v['lastTs'][:16] or '-')}</td></tr>""")
    pool_html = "".join(pool_rows) or '<tr><td colspan="8" class="dim">注册表为空</td></tr>'

    cols_html = []
    for title, cls, items in board_columns(matrix):
        cards = "".join(
            f'<div class="card" title="{esc(i["evidence"])}"><div class="k">{esc(i["key"])}</div><div class="t">{esc(i["title"])}</div></div>'
            for i in items[:MAX_CARDS])
        more = f'<div class="more">+{len(items) - MAX_CARDS} 更多</div>' if len(items) > MAX_CARDS else ""
        cols_html.append(f'<div class="col {cls}"><header><b>{esc(title)}</b><span>{len(items)}</span></header>{cards}{more}</div>')
    board_html = "".join(cols_html)

    flow_html = "".join(
        f"<tr><td class='dim'>{esc((r.get('ts') or r.get('atUtc') or '')[:16])}</td><td>{esc(r.get('taskKey', '-'))}</td><td><b>{esc(r.get('executor', '-'))}</b></td>"
        f"<td>{esc(r.get('role', ''))}</td>"
        f"<td class=\"{'ok' if r.get('status') in ('completed', 'success') else ('err' if r.get('status') == 'failed' else 'dim')}\">{esc(r.get('status', '-'))}</td></tr>"
        for r in flow_rows)

    records = records or []
    notes_html = ''.join(f'<p class="warn">{esc(note)}</p>' for note in (notes or []))
    groups = unified_dashboard.summarize(records)
    totals = {source: sum(g['attempts'] for g in groups if g['source'] == source) for source in {g['source'] for g in groups}}
    model_rows = ''.join(
        f"<tr><td>{esc(g['source'])}</td><td>{esc(g['executor'])}</td><td>{esc(g['role'])}</td><td>{esc(g['model'])}</td>"
        f"<td>{g['attempts']} ({g['attempts'] / totals[g['source']]:.0%}) <meter min='0' max='{totals[g['source']]}' value='{g['attempts']}'></meter></td>"
        f"<td>{format(g['knownTokens'], ',') if g['knownCount'] else 'unknown'}</td><td>{g['unknownTokens']}</td></tr>"
        for g in groups) or '<tr><td colspan="7">暂无记录</td></tr>'
    task_rows = ''.join(
        f"<tr><td>{esc(r.get('source'))}</td><td>{esc(r.get('taskKey') or 'unknown')}</td>"
        f"<td>{esc(r.get('attemptId') or 'unknown')}</td><td>{esc(r.get('executor') or 'unknown')}</td>"
        f"<td>{esc(r.get('role') or 'unknown')}</td><td>{esc(r.get('model') or 'unknown')}</td>"
        f"<td>{esc(r.get('status') or 'unknown')}</td><td>{esc(r.get('tokens') if r.get('tokens') is not None else 'unknown')}</td>"
        f"<td>{esc(r.get('modelCalls') if r.get('modelCalls') is not None else 'unknown')}</td>"
        f"<td class='delivery-cell'>{delivery_html(r)}</td></tr>"
        for r in records[-200:][::-1]) or '<tr><td colspan="10">暂无记录</td></tr>'
    engine_rows = []
    for meta in registry['executors']:
        stats = ex.get(meta['name'], {})
        engine_rows.append(f"<tr><td>{esc(meta['name'])}</td><td>{esc(configured_engine(meta))}</td>"
                           f"<td>{esc(meta.get('provider') or '未记录')}</td><td>{esc(meta.get('subscription') or '未记录')}</td>"
                           f"<td>{stats.get('total', 0)}</td></tr>")
    engine_table = ''.join(engine_rows) or '<tr><td colspan="5">暂无注册信息</td></tr>'
    engine_groups = {}
    for meta in registry['executors']:
        engine = configured_engine(meta)
        if engine != '未识别':
            engine_groups.setdefault(engine, []).append(meta['name'])
    engine_chips = [f'<span class="engine-chip"><b>{esc(engine)}</b><small>{esc("、".join(items))} · 已登记</small></span>'
                    for engine, items in engine_groups.items()]
    engine_chips_html = ''.join(engine_chips) or '<span class="dim">没有可识别的启动命令</span>'
    edges = unified_dashboard.route_edges(records)
    route_rows = ''.join(
        f"<tr><td>{esc(e['source'])}</td><td>{esc(e['router'])}<span class='route-arrow'>→</span>{esc(e['worker'])}</td>"
        f"<td>{esc(e['role'])}</td><td>{esc(e['model'])}</td><td>{e['count']}</td>"
        f"<td>{esc('、'.join(sorted(e['tasks'])[:8]))}{'…' if len(e['tasks']) > 8 else ''}</td></tr>"
        for e in edges) or '<tr><td colspan="6">暂无路由记录</td></tr>'
    chart_groups = {}
    for r in records:
        key = (r.get('source') or 'unknown', r.get('executor') or 'unknown')
        chart_groups[key] = chart_groups.get(key, 0) + 1
    chart_items = sorted(chart_groups.items(), key=lambda item: (-item[1], item[0]))[:8]
    chart_max = max((count for _, count in chart_items), default=1)
    chart_html = ''.join(
        f'<div class="bar-row"><span>{esc(source)} · 标签：{esc(executor)}</span>'
        f'<div class="bar-track"><div class="bar-fill" style="width:{count / chart_max * 100:.1f}%"></div></div><b>{count}</b></div>'
        for (source, executor), count in chart_items) or '<p class="dim">暂无执行记录</p>'
    # Crew events are grouped into attempts above; never combine them with
    # independent Stack, host-guard or Forge observations in this chart.
    crew_records = [r for r in records if r.get('source') == 'crew']
    status_groups = [
        ('已完成', '#55d9aa', {'completed', 'success'}),
        ('失败', '#ff7c82', {'failed'}),
        ('派工/进行中', '#68b6fa', {'dispatched', 'running', 'in_progress', 'claimed'}),
        ('其他', '#b9a1ff', None),
    ]
    status_counts = [sum(1 for r in crew_records if r.get('status') in statuses)
                     for _, _, statuses in status_groups[:3]]
    status_counts.append(len(crew_records) - sum(status_counts))
    stops, position = [], 0.0
    for (_, color, _), count in zip(status_groups, status_counts):
        end = position + count / len(crew_records) * 100 if crew_records else 0
        if count:
            stops.append(f'{color} {position:.4f}% {end:.4f}%')
        position = end
    donut_fill = f"conic-gradient({', '.join(stops)})" if stops else '#29374a'
    legend = ''.join(f'<li><span class="dot" style="--c:{color}"></span>{esc(label)}<b>{count}</b></li>'
                     for (label, color, _), count in zip(status_groups, status_counts))
    status_chart = (f'<div class="donut-layout"><div class="donut" role="img" '
                    f'aria-label="Crew 状态分布，共 {len(crew_records)} 条尝试记录" style="background:{donut_fill}">'
                    f'<div class="donut-center"><b>{len(crew_records)}</b>尝试记录</div></div><ul class="legend">{legend}</ul></div>')

    today = date.fromisoformat(usage['today'])
    days = [today - timedelta(days=n) for n in reversed(range(7))]
    day_counts = [sum(usage.get('perDay', {}).get(day.isoformat(), {}).values()) for day in days]
    day_max = max(day_counts, default=0) or 1
    trend_html = ''.join(
        f'<div class="trend-col" title="{day.isoformat()}：{count} 条台账记录">'
        f'<span class="trend-count">{count}</span><div class="trend-bar {"trend-zero" if not count else ""}" '
        f'style="--pct:{count / day_max * 75:.2f}"></div><span class="trend-day">{day.strftime("%m/%d")}</span></div>'
        for day, count in zip(days, day_counts))
    route_preview = ''.join(
        f'<li><span class="route-node {"unknown" if e["router"] == "未记录" else ""}">{esc(e["router"])}</span>'
        f'<span class="route-arrow">→</span><span class="route-node">{esc(e["worker"])}</span>'
        f'<span class="route-count">{esc(e["source"])} · {e["count"]} 条</span></li>'
        for e in sorted(edges, key=lambda item: (-item['count'], item['source'], item['router'], item['worker']))[:5]
    ) or '<li class="dim">暂无路由记录</li>'
    ongoing = [r for r in records if r.get('status') in ('dispatched', 'running', 'in_progress', 'claimed')]
    ongoing_html = ''.join(
        f'<li>{esc(r.get("taskKey") or "unknown")} · {esc(r.get("executor") or "unknown")} · {esc(r.get("status"))}</li>'
        for r in ongoing[-5:][::-1]) or '<li class="dim">当前数据中没有进行中记录</li>'
    recent_html = ''.join(
        f'<li>{esc((r.get("ts") or r.get("atUtc") or "")[:19])} · {esc(r.get("taskKey") or "unknown")} · {esc(r.get("status") or "unknown")}</li>'
        for r in flow_rows[:5]) or '<li class="dim">暂无派工流水</li>'
    approved_status = {'pending': '待审批', 'approved': '已通过', 'rejected': '已拒绝'}
    cards = []
    for item in approval_items or []:
        state = item.get('status', 'unknown')
        actions = (f'<div class="approval-actions"><button type="button" data-approval="{esc(item.get("id"))}" data-decision="approved">通过</button>'
                   f'<button type="button" data-approval="{esc(item.get("id"))}" data-decision="rejected">拒绝</button></div>') if state == 'pending' and approvals_actionable else ''
        cards.append(f'<article class="approval-card"><h3>{esc(item.get("summary"))} '
                     f'<span class="approval-{esc(state)}">{esc(approved_status.get(state, "未知"))}</span></h3>'
                     f'<p>任务：{esc(item.get("taskKey"))} · 尝试：{esc(item.get("attemptId"))}</p>'
                     f'<p>范围：{esc(item.get("scope"))}</p><p>验收：{esc(item.get("acceptance"))}</p>'
                     f'<p>工作区：{esc(item.get("worktree"))}</p><p>执行器：{esc("、".join(str(x.get("executor")) + " / " + str(x.get("role")) + " / " + str(x.get("model")) for x in item.get("workers", []) if isinstance(x, dict)))}</p>'
                     f'<p>创建：{esc(item.get("createdAt"))} · 决定：{esc(item.get("decidedAt") or "尚无")}</p>'
                     f'<details><summary>查看完整任务简报与方案指纹</summary><pre>{esc(item.get("brief"))}</pre>'
                     f'<p>方案文件：{esc(item.get("planPath"))}</p><p>简报文件：{esc(item.get("briefPath"))}</p>'
                     f'<p>方案 SHA-256：{esc(item.get("planHash"))}</p><p>简报 SHA-256：{esc(item.get("briefHash"))}</p></details>{actions}</article>')
    approval_cards = ''.join(cards) or '<div class="summary-card">暂无待审批任务</div>'
    footer_note = ('本页读取本地状态；审批按钮会更新本机审批账本。' if approvals_actionable else '本页只读聚合本地状态。')
    approval_section = (f'<section data-view="approvals"><h2>任务审批 <b>APPROVALS</b></h2>'
                        f'<p class="dim">待审批优先显示，最多 200 项。按任务方案与简报审批，内容变化需重新审批；通过仅允许受管流程继续，不代表任务已完成。</p>'
                        f'<div class="approval-list">{approval_cards}</div></section>') if approval_items is not None else ''

    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Nuwax Forge 运行看板</title><style>{CSS}</style></head>
<body><div class="wrap">
<header><h1>Nuwax Forge <span class="tag">// 运行看板</span></h1>
<div class="meta">生成于 {esc(generated_at)}<br>数据：executors.json · crew-usage.jsonl · crew-health.json · matrix.json</div></header>
<div id="dashboard-content">
{approval_section}
<section data-view="overview"><h2>总览 <b>OVERVIEW</b></h2>{kpis}</section>
<section data-view="overview"><div class="summary-grid">
<div class="summary-card wide"><div class="chart-label">Activity · 7 days</div><h3>近七天派工活动</h3><p>以 UTC 当日为截止，按台账时间戳中的日期统计原始记录，包含派工和结果事件。</p><div class="trend" role="img" aria-label="近七天 Crew 台账记录数">{trend_html}</div></div>
<div class="summary-card"><div class="chart-label">Attempt status</div><h3>任务状态分布</h3><p>仅统计 Crew 中可归并的尝试及无法归并的历史记录。</p>{status_chart}</div>
<div class="summary-card"><div class="chart-label">Executors</div><h3>执行器标签分布</h3><p>台账标签不等于模型；按来源分别统计。</p>{chart_html}</div>
<div class="summary-card"><div class="chart-label">Routing</div><h3>Router → Worker</h3><p>来源未记录 Router 身份时显示“未记录”。</p><ul class="route-list">{route_preview}</ul></div>
<div class="summary-card"><div class="chart-label">In progress</div><h3>进行中记录 · {len(ongoing)}</h3><p>依据台账状态，未核验进程是否仍在运行。</p><ul class="summary-list">{ongoing_html}</ul></div>
<div class="summary-card wide"><div class="chart-label">Registered engines</div><h3>已登记引擎</h3><p>按当前注册表启动命令识别，不代表已产生记录或已验证当前运行。</p><div class="engine-grid">{engine_chips_html}</div></div>
<div class="summary-card"><div class="chart-label">Recent dispatches</div><h3>最近派工</h3><ul class="summary-list">{recent_html}</ul></div>
</div></section>
<section data-view="routes"><h2>路由关系 <b>ROUTER → WORKER</b></h2>
<p class="dim">仅 host-guard 记录明确的宿主到 Worker 关联；其他来源的 Router 身份未记录，不能据此推断具体路由者。记录数按来源分开，不跨来源合并。</p>
<table data-paginate="routes"><tr><th>来源</th><th>Router → Worker</th><th>角色</th><th>模型</th><th>记录</th><th>任务</th></tr>{route_rows}</table></section>
<section data-view="models"><h2>模型与执行器 <b>MODEL / WORKER USAGE</b></h2>
<p class="dim">按来源分别统计，跨来源可能是同一次执行；已知 token 为部分合计，未知次数单列。缺少 attemptId 的历史记录无法去重。host-guard 是观测快照，不含后续消耗；模型为执行记录声明，不推断实际供应商账单。</p>
{notes_html}
<table data-paginate="models"><tr><th>来源</th><th>执行器</th><th>角色</th><th>模型</th><th>尝试/记录</th><th>已知 token</th><th>用量未知</th></tr>{model_rows}</table></section>
<section data-view="tasks"><h2>任务与执行 <b>TASK / ASSIGNMENT</b>（按来源顺序最多 200 条）</h2><p class="dim">交付结果来自执行记录或执行器报告，尚未独立验证分支、提交或 PR。</p><table data-paginate="tasks"><tr><th>来源</th><th>任务</th><th>尝试</th><th>执行器</th><th>角色</th><th>模型</th><th>状态</th><th>token</th><th>模型调用</th><th>交付结果</th></tr>{task_rows}</table></section>
<section data-view="models"><h2>已登记引擎与通道 <b>ENGINE / PROVIDER</b></h2><p class="dim">载体由当前注册表的启动命令识别；提供方是当前配置。历史模型以执行记录为准，未记录不回填。</p><table data-paginate="engines"><tr><th>执行器标签</th><th>配置的载体</th><th>配置的提供方</th><th>订阅 / 通道</th><th>台账记录数</th></tr>{engine_table}</table></section>
<section data-view="models"><h2>订阅使用量 <b>SUBSCRIPTION USAGE</b></h2><div class="subs">{subs_html}</div></section>
<section data-view="models"><h2>执行器池 <b>EXECUTOR POOL</b></h2>
<table data-paginate="pool"><tr><th>执行器</th><th>层</th><th>订阅</th><th>状态</th><th>今日记录</th><th>记录成功率</th><th>记录数</th><th>最近</th></tr>{pool_html}</table></section>
<section data-view="tasks"><h2>任务看板 <b>TASK BOARD</b>（{len(matrix)} 项）</h2><div class="board">{board_html}</div></section>
<section data-view="dispatch"><h2>派工流水 <b>RECENT DISPATCHES</b>（最近 20 条）</h2>
<table data-paginate="dispatch"><tr><th>时间</th><th>任务</th><th>执行器</th><th>角色</th><th>结果</th></tr>{flow_html}</table></section>
<footer>regenerate：nuwax-forge dashboard --ledger &lt;crew-usage.jsonl&gt; --registry &lt;executors.json&gt; --out &lt;this.html&gt;<br>
边界：{footer_note} 不含密钥；由工作台按进度汇总周期重新生成。</footer>
</div></div></body></html>"""


def write_dashboard(out_path, *, usage, registry, health, matrix, flow_rows: list, records=None, notes=None, approval_items=None, approvals_actionable=False) -> str:
    generated_at = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    page = build_html(usage, registry, health, matrix, flow_rows, generated_at=generated_at, records=records, notes=notes, approval_items=approval_items, approvals_actionable=approvals_actionable)
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(page, encoding="utf-8")
    return str(p)
