"""运行看板生成器：本地 JSON 状态 -> 自包含 HTML。纯函数，不联网、无常驻。"""

from __future__ import annotations

import html
from datetime import datetime, timezone
from pathlib import Path
from . import unified_dashboard

BOARD_COLUMNS = [
    ("待分诊/待决策", ["pending-triage", "pending", "plan-only", "pending-decision"], "wait"),
    ("进行中", ["partial", "code-landed-unverified", "unmerged-wip", "unmerged-wip-im", "pending-coordination"], "run"),
    ("待复验/验收", ["merged-needs-acceptance", "released-await-verify", "test-verified-web-sample-pending", "mac-verified-win-pending"], "verify"),
    ("已验证完成", ["done-verified-web", "verified-live", "verified-live-partial", "verified-web-partial", "triaged-a-closed-verified"], "done"),
    ("挂起/其它", ["excluded-im-pending"], "hold"),
    ("非本人未接", ["other-owner-not-taken"], "other"),
]
MAX_CARDS = 12

CSS = """
:root{--bg:#0b0e14;--panel:#11151f;--line:#1e2431;--ink:#d7dde8;--dim:#79839a;--amber:#f0b429;--green:#3dd68c;--red:#ff6b6b;--blue:#5aa9e6;--violet:#b48ef0}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:28px;
background-image:repeating-linear-gradient(0deg,transparent 0 2px,rgba(255,255,255,.012) 2px 4px)}
.wrap{max-width:1480px;margin:0 auto}
header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:20px}
h1{font-size:20px;letter-spacing:.14em;color:var(--amber);font-weight:700}
h1 .tag{color:var(--dim);font-weight:400;letter-spacing:.05em;font-size:12px}
.meta{color:var(--dim);font-size:12px;text-align:right}
section{margin-bottom:26px}
h2{font-size:13px;letter-spacing:.22em;color:var(--dim);margin-bottom:10px;text-transform:uppercase}
h2 b{color:var(--ink)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.kpi{background:var(--panel);border:1px solid var(--line);padding:12px 14px}
.kpi .n{font-size:26px;font-weight:700;color:var(--ink)}
.kpi .l{color:var(--dim);font-size:11px;letter-spacing:.1em;margin-top:2px}
.kpi.hot .n{color:var(--amber)}.kpi.good .n{color:var(--green)}.kpi.bad .n{color:var(--red)}
.subs{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
.sub{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--amber);padding:12px 14px}
.sub.api{border-left-color:var(--violet)}.sub.local{border-left-color:var(--green)}.sub.fixed{border-left-color:var(--blue)}
.sub h3{font-size:14px;margin-bottom:6px}
.sub .row{display:flex;gap:14px;color:var(--dim);font-size:12px;flex-wrap:wrap}
.sub .row b{color:var(--ink)}
.chips{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.chip{border:1px solid var(--line);padding:1px 7px;font-size:11px;color:var(--dim)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);font-size:12.5px}
th{color:var(--dim);text-align:left;font-weight:400;letter-spacing:.08em;padding:8px 10px;border-bottom:1px solid var(--line);font-size:11px}
td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.ok{color:var(--green)}.warn{color:var(--amber)}.err{color:var(--red)}.dim{color:var(--dim)}
.board{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;align-items:start}
.col{background:var(--panel);border:1px solid var(--line);min-height:120px}
.col header{border-bottom:1px solid var(--line);margin:0;padding:8px 10px;display:flex;justify-content:space-between;font-size:11.5px;letter-spacing:.06em;color:var(--dim)}
.col header b{color:var(--ink)}
.col.wait header b{color:var(--amber)}.col.run header b{color:var(--blue)}.col.verify header b{color:var(--violet)}.col.done header b{color:var(--green)}
.card{padding:8px 10px;border-bottom:1px solid var(--line);font-size:12px}
.card:last-child{border-bottom:none}
.card .k{color:var(--amber);font-size:11px;margin-bottom:2px}
.card .t{color:var(--ink);opacity:.85}
.more{padding:8px 10px;color:var(--dim);font-size:11px}
footer{color:var(--dim);font-size:11px;border-top:1px solid var(--line);padding-top:12px;line-height:1.8}
.badge{display:inline-block;padding:0 6px;border:1px solid var(--line);font-size:11px}
.badge.S{color:var(--amber);border-color:var(--amber)}.badge.A{color:var(--blue);border-color:var(--blue)}
.badge.B{color:var(--green);border-color:var(--green)}.badge.C{color:var(--violet);border-color:var(--violet)}
.badge.fixed{color:var(--dim)}
.live-controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:-8px 0 20px;color:var(--dim);font-size:12px}
.live-controls button{background:var(--panel);border:1px solid var(--blue);color:var(--ink);padding:6px 12px;cursor:pointer}
.live-controls button:disabled{opacity:.5;cursor:wait}
.route-arrow{color:var(--amber);padding:0 8px}
.view-nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:22px;border-bottom:1px solid var(--line);padding-bottom:10px}
.view-nav button,.pager button{background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:7px 12px;cursor:pointer}
.view-nav button[aria-pressed=true]{border-color:var(--amber);color:var(--amber)}
.pager{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:8px;color:var(--dim);font-size:12px}
.pager button:disabled{opacity:.4;cursor:default}
.chart{background:var(--panel);border:1px solid var(--line);padding:14px}
.bar-row{display:grid;grid-template-columns:minmax(120px,220px) 1fr 45px;gap:10px;align-items:center;margin:8px 0;font-size:12px}
.bar-track{background:var(--line);height:10px}.bar-fill{height:100%;background:var(--blue)}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.summary-card{background:var(--panel);border:1px solid var(--line);padding:14px;min-width:0}
.summary-card h3{font-size:13px;margin-bottom:10px}.summary-card p{color:var(--dim);font-size:12px;margin-bottom:8px}
.summary-list{list-style:none}.summary-list li{border-top:1px solid var(--line);padding:7px 0;overflow-wrap:anywhere}
@media(max-width:700px){body{padding:14px}.board{display:block}.col{margin-bottom:8px}table{display:block;overflow-x:auto}.bar-row{grid-template-columns:120px 1fr 35px}}
"""


def esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)


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


def build_html(usage: dict, registry: dict, health: dict, matrix: list, flow_rows: list, *, generated_at: str, records=None, notes=None) -> str:
    ex = usage["perExecutor"]
    subs = usage["perSubscription"]
    total = sum(v["total"] for v in ex.values())
    ok = sum(v["ok"] for v in ex.values())
    failed = sum(v["failed"] for v in ex.values())
    active = [n for n, v in ex.items() if v.get("enabled", True) and n not in health]
    ok_rate = f"{ok / total:.0%}" if total else "—"

    kpis = f"""
    <div class="kpis">
      <div class="kpi"><div class="n">{total}</div><div class="l">台账记录</div></div>
      <div class="kpi good"><div class="n">{ok_rate}</div><div class="l">记录成功率</div></div>
      <div class="kpi hot"><div class="n">{len(active)}</div><div class="l">可用执行器</div></div>
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
        f"<td>{esc(r.get('modelCalls') if r.get('modelCalls') is not None else 'unknown')}</td></tr>"
        for r in records[-200:][::-1]) or '<tr><td colspan="9">暂无记录</td></tr>'
    route_rows = ''.join(
        f"<tr><td>{esc(e['source'])}</td><td>{esc(e['router'])}<span class='route-arrow'>→</span>{esc(e['worker'])}</td>"
        f"<td>{esc(e['role'])}</td><td>{esc(e['model'])}</td><td>{e['count']}</td>"
        f"<td>{esc('、'.join(sorted(e['tasks'])[:8]))}{'…' if len(e['tasks']) > 8 else ''}</td></tr>"
        for e in unified_dashboard.route_edges(records)) or '<tr><td colspan="6">暂无路由记录</td></tr>'
    chart_groups = {}
    for r in records:
        key = (r.get('source') or 'unknown', r.get('executor') or 'unknown')
        chart_groups[key] = chart_groups.get(key, 0) + 1
    chart_items = sorted(chart_groups.items(), key=lambda item: (-item[1], item[0]))[:8]
    chart_max = max((count for _, count in chart_items), default=1)
    chart_html = ''.join(
        f'<div class="bar-row"><span>{esc(source)} / {esc(executor)}</span>'
        f'<div class="bar-track"><div class="bar-fill" style="width:{count / chart_max * 100:.1f}%"></div></div><b>{count}</b></div>'
        for (source, executor), count in chart_items) or '<p class="dim">暂无执行记录</p>'
    ongoing = [r for r in records if r.get('status') in ('dispatched', 'running', 'in_progress', 'claimed')]
    ongoing_html = ''.join(
        f'<li>{esc(r.get("taskKey") or "unknown")} · {esc(r.get("executor") or "unknown")} · {esc(r.get("status"))}</li>'
        for r in ongoing[-5:][::-1]) or '<li class="dim">当前数据中没有进行中记录</li>'
    recent_html = ''.join(
        f'<li>{esc((r.get("ts") or r.get("atUtc") or "")[:19])} · {esc(r.get("taskKey") or "unknown")} · {esc(r.get("status") or "unknown")}</li>'
        for r in flow_rows[:5]) or '<li class="dim">暂无派工流水</li>'

    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>nuwax-crew 运行看板</title><style>{CSS}</style></head>
<body><div class="wrap">
<header><h1>nuwax-crew <span class="tag">// 运行看板</span></h1>
<div class="meta">生成于 {esc(generated_at)}<br>数据：executors.json · crew-usage.jsonl · crew-health.json · matrix.json</div></header>
<div id="dashboard-content">
<section data-view="overview"><h2>总览 <b>OVERVIEW</b></h2>{kpis}</section>
<section data-view="overview"><div class="summary-grid">
<div class="summary-card"><h3>执行器记录分布</h3><p>各来源分别统计，条形长度按本图最大值缩放。</p>{chart_html}</div>
<div class="summary-card"><h3>进行中记录 · {len(ongoing)}</h3><p>依据台账状态，未核验进程是否仍在运行。</p><ul class="summary-list">{ongoing_html}</ul></div>
<div class="summary-card"><h3>最近派工</h3><ul class="summary-list">{recent_html}</ul></div>
</div></section>
<section data-view="routes"><h2>路由关系 <b>ROUTER → WORKER</b></h2>
<p class="dim">仅 host-guard 记录明确的宿主到 Worker 关联；其他来源的 Router 身份未记录，不能据此推断具体路由者。记录数按来源分开，不跨来源合并。</p>
<table data-paginate="routes"><tr><th>来源</th><th>Router → Worker</th><th>角色</th><th>模型</th><th>记录</th><th>任务</th></tr>{route_rows}</table></section>
<section data-view="models"><h2>模型与执行器 <b>MODEL / WORKER USAGE</b></h2>
<p class="dim">按来源分别统计，跨来源可能是同一次执行；已知 token 为部分合计，未知次数单列。缺少 attemptId 的历史记录无法去重。host-guard 是观测快照，不含后续消耗；模型为执行记录声明，不推断实际供应商账单。</p>
{notes_html}
<table data-paginate="models"><tr><th>来源</th><th>执行器</th><th>角色</th><th>模型</th><th>尝试/记录</th><th>已知 token</th><th>用量未知</th></tr>{model_rows}</table></section>
<section data-view="tasks"><h2>任务与执行 <b>TASK / ASSIGNMENT</b>（按来源顺序最多 200 条）</h2><table data-paginate="tasks"><tr><th>来源</th><th>任务</th><th>尝试</th><th>执行器</th><th>角色</th><th>模型</th><th>状态</th><th>token</th><th>模型调用</th></tr>{task_rows}</table></section>
<section data-view="models"><h2>订阅使用量 <b>SUBSCRIPTION USAGE</b></h2><div class="subs">{subs_html}</div></section>
<section data-view="models"><h2>执行器池 <b>EXECUTOR POOL</b></h2>
<table data-paginate="pool"><tr><th>执行器</th><th>层</th><th>订阅</th><th>状态</th><th>今日记录</th><th>记录成功率</th><th>记录数</th><th>最近</th></tr>{pool_html}</table></section>
<section data-view="tasks"><h2>任务看板 <b>TASK BOARD</b>（{len(matrix)} 项）</h2><div class="board">{board_html}</div></section>
<section data-view="dispatch"><h2>派工流水 <b>RECENT DISPATCHES</b>（最近 20 条）</h2>
<table data-paginate="dispatch"><tr><th>时间</th><th>任务</th><th>执行器</th><th>角色</th><th>结果</th></tr>{flow_html}</table></section>
<footer>regenerate：nuwax-forge dashboard --ledger &lt;crew-usage.jsonl&gt; --registry &lt;executors.json&gt; --out &lt;this.html&gt;<br>
边界：本页只读聚合本地状态；不含密钥；由工作台按进度汇总周期重新生成。</footer>
</div></div></body></html>"""


def write_dashboard(out_path, *, usage, registry, health, matrix, flow_rows: list, records=None, notes=None) -> str:
    generated_at = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    page = build_html(usage, registry, health, matrix, flow_rows, generated_at=generated_at, records=records, notes=notes)
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(page, encoding="utf-8")
    return str(p)
