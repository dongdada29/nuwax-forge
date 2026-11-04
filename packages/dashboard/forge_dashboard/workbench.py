"""Host-independent, read-only task projection for Web and DSH clients.

Identity is source-scoped. A taskRef is the only way an adapter can explicitly
attach an observation from another source; names and current Git state are not
evidence of identity. No totals are summed across sources here.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from .sources import delivery_fields


STATES = {
    'pending': '待处理', 'approval': '待审批', 'running': '运行待核实',
    'review': '待验收', 'blocked': '阻塞 / 失败', 'done': '来源标记已验证',
    'other': '其他',
}
RUNNING = {'dispatched', 'running', 'in_progress', 'claimed', 'analyzing', 'implementing', 'verifying'}
REVIEW = {'completed', 'success', 'succeeded', 'reported', 'in_review',
          'merged-needs-acceptance', 'released-await-verify',
          'test-verified-web-sample-pending', 'mac-verified-win-pending',
          'verified-live-partial', 'verified-web-partial'}
DONE = {'done', 'done-verified-web', 'verified-live', 'triaged-a-closed-verified'}
PENDING = {'queued', 'prepared', 'pending', 'pending-triage', 'plan-only', 'pending-decision', 'todo'}
BLOCKED = {'blocked', 'failed'}


def text(value, limit=2048):
    return value[:limit] if isinstance(value, str) else ''


def identifier(value):
    """Validate presence without trimming or truncating identity fields."""
    return value if isinstance(value, str) and value.strip() else ''


def timestamp(value):
    """Unknown and timezone-less dates must not silently become local time."""
    if not isinstance(value, str):
        return None
    try:
        at = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return at.timestamp() if at.tzinfo is not None else None
    except (ValueError, OverflowError):
        return None


def identity(source, key):
    return hashlib.sha256(json.dumps([source, key], ensure_ascii=False).encode()).hexdigest()[:24]


def reference(record):
    ref = record.get('taskRef')
    if isinstance(ref, dict) and all(identifier(ref.get(k)) for k in ('source', 'taskKey')):
        return ref['source'], ref['taskKey']
    return identifier(record.get('source')) or 'unknown', identifier(record.get('taskKey'))


def _source_status(task, item, origin):
    status = text(item.get('status'))
    dates = [event['at'] for event in item.get('events') or []
             if event.get('status') == status and timestamp(event.get('at')) is not None]
    at = item.get('updatedAt')
    task.update(status=status, sourceStatus=status, sourceStatusSource=origin,
                sourceStatusAt=at if timestamp(at) is not None else max(dates, key=timestamp) if dates else None)


def _status_note(task):
    if task['sourceStatus'] not in DONE:
        return ''
    source_at = timestamp(task['sourceStatusAt'])
    attention = [record for record in task['attempts'] if record.get('status') in BLOCKED | RUNNING]
    if source_at is not None and any(timestamp(record.get('at')) is not None and timestamp(record['at']) > source_at for record in attention):
        return '任务来源标记已验证，但存在时间戳晚于来源状态的失败、阻塞或进行中尝试记录，需核对；来源状态保持不变。'
    if source_at is not None and any(timestamp(record.get('at')) == source_at for record in attention):
        return '任务来源标记已验证，但异常尝试与来源状态的时间戳相同，先后顺序需核对；来源状态保持不变。'
    if attention and (source_at is None or any(timestamp(record.get('at')) is None for record in attention)):
        return '任务来源标记已验证，观察中包含失败、阻塞或进行中记录，且时间不完整，需核对；来源状态保持不变。'
    return ''


def state_for(status):
    if status in RUNNING: return 'running'
    if status in REVIEW: return 'review'
    if status in DONE: return 'done'
    if status in PENDING: return 'pending'
    if status in BLOCKED: return 'blocked'
    if status in {'partial', 'code-landed-unverified', 'unmerged-wip', 'unmerged-wip-im', 'pending-coordination'}:
        return 'review'
    return 'other'


def build_workbench(records, *, matrix=(), approvals=(), tasks=()):
    """Project explicit metadata, attempts and events without mutating a store."""
    groups = {}

    def get(source, key, *, observation=None):
        if not key:
            return None
        bucket = (source, key) if observation is None else (source, None, observation)
        return groups.setdefault(bucket, {
            'id': identity(source, key if observation is None else [None, observation]), 'source': source, 'taskKey': key,
            'title': key, 'objective': '', 'acceptance': [], 'workspace': '',
            'status': '', 'state': 'other', 'attempts': [], 'events': [],
            'approvals': [], 'sources': [], 'executors': [], 'lastAt': None,
            'sourceStatus': '', 'sourceStatusSource': '', 'sourceStatusAt': None,
        })

    for item in tasks:
        source, key = reference(item)
        task = get(source, key)
        if task is None: continue
        task.update(title=text(item.get('title')) or key, objective=text(item.get('objective'), 4096),
                    workspace=text(item.get('workspace')))
        _source_status(task, item, identifier(item.get('source')) or source)
        task['acceptance'] = [text(p, 1000) for p in item.get('acceptance', []) if isinstance(p, str)]
        task['events'].extend(item.get('events') or [])

    for item in matrix:
        source, key = reference({**item, 'source': item.get('source') or 'matrix', 'taskKey': item.get('key')})
        task = get(source, key)
        if task is None: continue
        task['title'] = text(item.get('title')).replace('**', '') or key
        _source_status(task, item, identifier(item.get('source')) or 'matrix')
        task['objective'] = text(item.get('objective'), 4096)
        evidence = text(item.get('evidence'), 4096)
        if evidence:
            task['events'].append({'status': task['status'], 'summary': evidence, 'source': 'matrix', 'at': item.get('updatedAt')})

    for index, record in enumerate(records):
        source, key = reference(record)
        # Missing task IDs stay separate observations rather than one "unknown" task.
        task = get(source, key or f'未关联记录 {index + 1}', observation=index if not key else None)
        task['attempts'].append(record)
        events = record.get('events')
        if not events:
            events = [{'status': record.get('status'), 'at': record.get('at'),
                       'summary': record.get('summary'), **delivery_fields(record)}]
        task['events'].extend({**event, 'source': record.get('source') or source,
                               'attemptId': record.get('attemptId'), 'executor': record.get('executor')}
                              for event in events)

    for item in approvals or ():
        # These approvals are produced by Crew and explicitly carry its taskKey.
        task = get('crew', identifier(item.get('taskKey')))
        if task is None: continue
        task['approvals'].append(item)
        if task['title'] == task['taskKey']:
            task['title'] = text(item.get('summary')) or task['title']
        task['workspace'] = task['workspace'] or text(item.get('worktree'))
        if not task['acceptance'] and item.get('acceptance'):
            task['acceptance'] = [text(item['acceptance'], 1000)]
        task['events'].append({'source': 'approvals', 'status': '提交审批', 'at': item.get('createdAt'),
                               'attemptId': item.get('attemptId'), 'summary': text(item.get('scope'))})
        if item.get('decidedAt'):
            task['events'].append({'source': 'approvals', 'status': {'approved': '审批通过', 'rejected': '审批拒绝'}.get(item.get('status'), '审批决定'),
                                   'at': item['decidedAt'], 'attemptId': item.get('attemptId'), 'summary': ''})

    for task in groups.values():
        attempts = task['attempts']
        task['executors'] = sorted({identifier(r.get('executor')) for r in attempts if identifier(r.get('executor'))})
        task['sources'] = sorted({identifier(r.get('source')) for r in attempts if identifier(r.get('source'))} | {task['source']})
        dated = [e for e in task['events'] if timestamp(e.get('at')) is not None]
        if dated:
            task['lastAt'] = max(dated, key=lambda e: timestamp(e['at']))['at']
        # Array/source order is a fallback only within one source, never a global clock.
        latest = max(enumerate(attempts), key=lambda pair: (timestamp(pair[1].get('at')) or 0, pair[0]))[1] if attempts else {}
        task['latestAttempt'] = {key: latest.get(key) for key in ('source', 'attemptId', 'executor', 'status', 'at')} if latest else None
        task['attemptOrderKnown'] = bool(attempts) and all(timestamp(record.get('at')) is not None for record in attempts)
        task['statusNote'] = _status_note(task)
        if not task['status'] or (task['status'] in PENDING and latest):
            task['status'] = text(latest.get('status')) or 'unknown'
        task['state'] = state_for(task['status'])
        if any(a.get('status') == 'pending' for a in task['approvals']):
            task['state'] = 'approval'
        task['attemptCount'] = len({(r.get('source'), r['attemptId']) for r in attempts if r.get('attemptId')})
        task['legacyCount'] = sum(1 for r in attempts if not r.get('attemptId'))
        task['runningUnverified'] = sum(1 for r in attempts if r.get('status') in RUNNING)
        task['events'] = sorted(task['events'], key=lambda e: timestamp(e.get('at')) or 0, reverse=True)
    return sorted(groups.values(), key=lambda t: (timestamp(t['lastAt']) or 0, t['source'], t['taskKey']), reverse=True)


def source_health(name, path, *, last_at=None, now=None, snapshot=False):
    """File freshness describes observations, never process liveness."""
    from pathlib import Path
    now = now or datetime.now(timezone.utc)
    if not path:
        return {'name': name, 'state': 'unconfigured', 'label': '未接入', 'updatedAt': None, 'lastAt': None}
    p = Path(path)
    if not p.exists():
        return {'name': name, 'state': 'missing', 'label': '文件不存在', 'updatedAt': None, 'lastAt': None}
    stamps = [f.stat().st_mtime for f in (p, Path(str(p) + '-wal')) if f.exists()]
    modified = max(stamps)
    age = max(0, now.timestamp() - (timestamp(last_at) if timestamp(last_at) is not None else modified))
    stale = not snapshot and age > 900
    return {'name': name, 'state': 'stale' if stale else 'read',
            'label': '记录较旧' if stale else ('配置快照' if snapshot else '已读取'),
            'updatedAt': datetime.fromtimestamp(modified, timezone.utc).isoformat(),
            'lastAt': last_at, 'ageSeconds': int(age)}
