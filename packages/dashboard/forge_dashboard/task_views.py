"""HTML presentation of the host-neutral task projection."""
import html
import json
from datetime import datetime

from .sources import delivery_fields, summarize
from .workbench import STATES, timestamp


def esc(value):
    return html.escape(str(value if value is not None else ''), quote=True)


def when(value):
    if timestamp(value) is None:
        return '时间未记录'
    return datetime.fromtimestamp(timestamp(value)).astimezone().strftime('%m-%d %H:%M')


def delivery_html(record):
    delivery = delivery_fields(record)
    rows = []
    if delivery.get('branch'): rows.append('分支：' + esc(delivery['branch']))
    if delivery.get('commit'): rows.append('提交：<code>' + esc(delivery['commit']) + '</code>')
    if delivery.get('prUrl'):
        rows.append('<a href="' + esc(delivery['prUrl']) + '" target="_blank" rel="noopener noreferrer">查看 PR ↗</a>')
    return ''.join('<div>' + row + '</div>' for row in rows) or '<span class="dim">未记录</span>'


def budget_observation_html(record):
    observation = record.get('observedBudget')
    if not isinstance(observation, dict):
        return ''
    lower = observation.get('reportedTokensLowerBound')
    maximum = observation.get('maxTokens')
    verdict = '已证实超限' if observation.get('verdict') == 'exceeds' else 'unknown（部分报告不能证明预算达标）'
    issue = '<p class="task-notice">' + esc(observation['issue']) + '</p>' if observation.get('issue') else ''
    return ('<div class="budget-observation"><b>本次运行的预算观察</b>'
            f'<p class="dim">运行状态目录：{esc(record.get("statePath") or "未记录")}</p>'
            f'<p>已报告 token 下界：{esc(lower if lower is not None else "unknown")} · '
            f'预算上限：{esc(maximum if maximum is not None else "unknown")} · 观测判定：{esc(verdict)}</p>'
            f'<p>完整结算 token：{esc(record.get("tokens") if record.get("tokens") is not None else "unknown")}</p>'
            + issue + '<p class="dim">下界仅代表已报告部分，单独展示，不计入已结算 token 汇总；未报告与在途消耗未知。</p></div>')


def render_source_health(sources):
    if not sources:
        return ''
    cards = []
    for source in sources:
        detail = ('最近事件 ' + when(source['lastAt'])) if source.get('lastAt') else ('文件更新 ' + when(source['updatedAt'])) if source.get('updatedAt') else '未提供可读数据'
        cards.append(f'<li class="source-item source-{esc(source["state"])}"><b>{esc(source["name"])}</b>'
                     f'<span>{esc(source["label"])}</span><small>{esc(detail)}</small></li>')
    return ('<section data-view="tasks" class="source-health"><details><summary>数据来源与新鲜度'
            '<span class="dim"> · 记录超过 15 分钟标记较旧，静态配置除外；不代表进程存活</span></summary>'
            '<ul class="source-grid">' + ''.join(cards) + '</ul></details></section>')


def _detail(task):
    acceptance = ''.join('<li>' + esc(value) + '</li>' for value in task['acceptance']) or '<li class="dim">未记录</li>'
    attempts = []
    for record in task['attempts'][::-1]:
        attempts.append(f'<li><div class="attempt-heading"><b>{esc(record.get("executor") or "未记录执行器")}</b>'
                        f'<span>{esc(record.get("status") or "unknown")}</span></div>'
                        f'<p class="dim">{esc(record.get("source"))} · 尝试 {esc(record.get("attemptId") or "ID 未记录")} · '
                        f'{esc(record.get("role") or "角色未记录")} · {esc(record.get("model") or "模型未记录")}</p>'
                        f'<p>会话：{esc(record.get("sessionId") or "未记录")}</p>'
                        f'<p>{esc(record.get("summary") or "")}</p>{delivery_html(record)}{budget_observation_html(record)}</li>')
    events = ''.join(
        f'<li><time datetime="{esc(event.get("at"))}">{esc(when(event.get("at")))}</time>'
        f'<div><b>{esc(event.get("status") or "unknown")}</b><small>{esc(event.get("source") or task["source"])}'
        f'{" · " + esc(event["executor"]) if event.get("executor") else ""}</small>'
        f'<p>{esc(event.get("summary") or "")}</p>{delivery_html(event) if delivery_fields(event) else ""}</div></li>'
        for event in task['events']) or '<li class="dim">没有记录事件时间线</li>'
    charges = ''.join(f'<li>{esc(group["source"])} / {esc(group["executor"])} / {esc(group["model"])}：'
                      f'{group["knownTokens"] if group["knownCount"] else "unknown"} 已知 token · '
                      f'{group["unknownTokens"]} 条用量未知</li>' for group in summarize(task['attempts'])) or '<li class="dim">尚无执行用量</li>'
    approvals = ''.join(f'<li>{esc(item.get("summary"))} · '
                        f'{esc({"pending":"待审批", "approved":"已通过", "rejected":"已拒绝"}.get(item.get("status"), "未知"))}'
                        f' · 尝试 {esc(item.get("attemptId"))}</li>' for item in task['approvals'])
    approval_block = ('<h4>任务审批</h4><ul class="task-facts">' + approvals + '</ul>'
                      '<button type="button" data-go-view="approvals">前往审批页</button>') if approvals else ''
    warning = (f'<p class="task-notice">有 {task["runningUnverified"]} 条来源记录仍为进行中，尚未核验进程。'
               '历史无尝试 ID 的记录无法可靠配对。</p>') if task['runningUnverified'] else ''
    source_status = (f'<p class="dim">任务来源状态：{esc(task["sourceStatus"])} · {esc(task["sourceStatusSource"])} · '
                     f'{esc(when(task["sourceStatusAt"]))}</p>') if task['sourceStatus'] else ''
    if task.get('deliveryStatus'):
        source_status += f'<p>来源交付状态：{esc(task["deliveryStatus"])}（与执行结果分别记录）</p>'
    latest = task['latestAttempt']
    attempt_status = (f'<p>最近尝试记录：{esc(latest.get("status") or "unknown")} · {esc(latest.get("source"))} · '
                      f'{esc(when(latest.get("at")))}'
                      f'{"；含时间未知记录，顺序待核实" if not task["attemptOrderKnown"] else ""}</p>') if latest else ''
    status_note = '<p class="task-notice">' + esc(task['statusNote']) + '</p>' if task['statusNote'] else ''
    return (f'<details id="task-{task["id"]}" class="task-detail" data-task-detail="{task["id"]}">'
            f'<summary>{esc(task["title"])} · 查看详情</summary><div class="task-detail-body">'
            f'<p class="eyebrow">{esc(task["source"])} · {esc(task["taskKey"])}</p>'
            f'<h3>{esc(task["title"])}</h3><p class="task-state state-{task["state"]}">{STATES[task["state"]]} · {esc(task["status"])}</p>'
            f'{source_status}{attempt_status}{status_note}{warning}<h4>目标与验收条件</h4><p>{esc(task["objective"] or "目标未记录")}</p><ul class="task-facts">{acceptance}</ul>'
            f'<p class="dim">工作区：{esc(task["workspace"] or "未记录")}</p>{approval_block}'
            f'<h4>执行与交付</h4><p class="dim">{task["attemptCount"]} 次可识别尝试 · {task["legacyCount"]} 条无尝试 ID 的观察。执行结束不等于产品验收通过；交付引用尚未独立验证。</p>'
            f'<ul class="attempt-list">{"".join(attempts) or "<li class=dim>尚未派工</li>"}</ul>'
            f'<h4>用量记录</h4><ul class="task-facts">{charges}</ul><p class="dim">按来源分别展示，未知不记为 0，不跨来源求和。</p>'
            f'<h4>事件时间线 <span class="dim">{len(task["events"])} 条</span></h4><ol class="task-timeline">{events}</ol>'
            '</div></details>')


def render_workbench(tasks, *, source_states=()):
    counts = {state: sum(1 for task in tasks if task['state'] == state) for state in STATES}
    executor_names = sorted({name for task in tasks for name in task['executors']})
    source_names = sorted({name for task in tasks for name in task['sources']})
    older = [s['name'] for s in source_states if s['state'] == 'stale']
    missing = [s['name'] for s in source_states if s['state'] == 'missing']
    freshness = ''
    if older or missing:
        messages = (['记录较旧：' + '、'.join(older)] if older else []) + (['文件缺失：' + '、'.join(missing)] if missing else [])
        freshness = '<p class="freshness-notice">' + esc('；'.join(messages)) + '。页面读取成功不代表执行仍在运行，来源时间见下方。</p>'
    options = lambda values: ''.join(f'<option value="{esc(value)}">{esc(label)}</option>' for value, label in values)
    quick = ''.join(f'<button type="button" data-task-state="{state}" aria-pressed="false">{STATES[state]} <b>{counts[state]}</b></button>'
                    for state in ('approval', 'review', 'blocked', 'running'))
    rows = []
    for task in tasks:
        search = ' '.join([task['taskKey'], task['title'], task['objective'], task['workspace'],
                           *task['executors'], *[str(r.get('attemptId') or '') for r in task['attempts']]])
        legacy = f'<small>{task["legacyCount"]} 条无 ID 观察</small>' if task['legacyCount'] else ''
        status_detail = f'<small>任务来源状态：{esc(task["sourceStatus"])}</small>' if task['sourceStatus'] else ''
        if task['latestAttempt']:
            status_detail += f'<small>最近尝试记录：{esc(task["latestAttempt"].get("status") or "unknown")}</small>'
        if task['statusNote']:
            status_detail += '<small class="status-difference">有尝试记录需核对</small>'
        rows.append(f'<tr data-task-row="{task["id"]}" data-search="{esc(search.lower())}" data-state="{task["state"]}" '
                    f'data-sources="{esc(json.dumps(task["sources"]))}" data-executors="{esc(json.dumps(task["executors"]))}" '
                    f'data-at="{timestamp(task["lastAt"]) or ""}"><td><a class="task-link" href="#task-{task["id"]}" '
                    f'data-task-open="{task["id"]}">{esc(task["title"])}</a><small>{esc(task["taskKey"])}</small></td>'
                    f'<td><span class="task-state state-{task["state"]}">{STATES[task["state"]]}</span>'
                    f'{status_detail}</td><td>{esc(task["source"])}<small>{esc("、".join(task["executors"]) or "尚未派工")}</small></td>'
                    f'<td>{task["attemptCount"]} 次尝试{legacy}</td>'
                    f'<td>{esc(when(task["lastAt"]))}</td></tr>')
    empty = '<p class="task-empty">当前没有可展示任务。可接入任务矩阵、Stack 任务库或派工台账；来源未接入与空任务库见下方。</p>' if not tasks else ''
    return (f'<section data-view="tasks" class="task-workbench"><div class="workbench-heading"><div>'
            f'<p class="eyebrow">TASK WORKSPACE</p><h2>任务工作台 <b>{len(tasks)}</b></h2>'
            '<p class="dim">按明确任务 ID 汇总；点击任务查看历次尝试、交付与时间线。</p></div></div>'
            f'{freshness}<div class="task-quick-filters">{quick}</div><div class="task-controls">'
            '<label class="task-search">搜索任务<input id="task-search" type="search" placeholder="任务、目标、执行器或尝试 ID" autocomplete="off"></label>'
            f'<label>状态<select id="task-state"><option value="">全部状态</option>{options(STATES.items())}</select></label>'
            f'<label>来源<select id="task-source"><option value="">全部来源</option>{options((s,s) for s in source_names)}</select></label>'
            f'<label>执行器<select id="task-executor"><option value="">全部执行器</option>{options((s,s) for s in executor_names)}</select></label>'
            '<label>最近事件<select id="task-period"><option value="">全部时间</option><option value="today">今天（本地时间）</option><option value="7d">近 7 天</option></select></label>'
            '<button type="button" id="task-reset">清除筛选</button></div>'
            f'<p id="task-results" role="status" aria-live="polite">共 {len(tasks)} 个任务</p>{empty}'
            '<div class="task-table-wrap"><table data-paginate="workbench"><thead><tr><th>任务</th><th>当前阶段</th><th>来源 / 执行器</th><th>执行记录</th><th>最近事件</th></tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table></div>'
            '<p id="task-no-match" class="task-empty" hidden>没有符合筛选条件的任务。</p>'
            f'{"".join(_detail(task) for task in tasks)}</section>{render_source_health(source_states)}')
