"""Explicit PA TaskSnapshot exports projected into the existing read-only workbench.

No service discovery, DB imports, HTTP, credentials, control actions or model calls.
The envelope supplies instance identity; native task/run IDs are never shortened.
"""
from __future__ import annotations

import json
import stat
from pathlib import Path

from .workbench import timestamp

MAX_BYTES = 4 * 1024 * 1024
TASK_STATUSES = {'queued', 'running', 'waiting_human', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'}
RUN_STATUSES = {'running', 'completed', 'failed', 'cancelled', 'waiting_human'}


def _id(value):
    if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 for c in value):
        raise ValueError('personal-agent ID 无效')
    return value


def _text(value, limit=2048):
    return value[:limit] if isinstance(value, str) else ''


def _rows(value, label):
    if not isinstance(value, list) or len(value) > 10000 or any(not isinstance(row, dict) for row in value):
        raise ValueError('personal-agent ' + label + ' 必须是至多 10000 个对象的数组')
    return value


def _owned(rows, task_id, label):
    rows = _rows(rows, label)
    if any(row.get('taskId') != task_id for row in rows):
        raise ValueError('personal-agent ' + label + ' 的 taskId 不匹配')
    return rows


def read_snapshot(path):
    """Read one bounded explicit export, returning task and execution projections."""
    p = Path(path).resolve(strict=True)
    info = p.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
        raise ValueError('personal-agent 快照必须是至多 4 MiB 的普通文件')
    with p.open('rb') as stream:
        encoded = stream.read(MAX_BYTES + 1)
    if len(encoded) > MAX_BYTES:
        raise ValueError('personal-agent 快照超过 4 MiB')
    try:
        data = json.loads(encoded)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError('personal-agent 快照 JSON 无效') from None
    if not isinstance(data, dict) or data.get('kind') != 'personal-agent-snapshot' or type(data.get('schemaVersion')) is not int or data.get('schemaVersion') != 1:
        raise ValueError('不支持的 personal-agent 快照格式')
    instances = _rows(data.get('instances'), 'instances')
    tasks, records, exports = [], [], []
    seen_instances = set()
    for instance in instances:
        instance_id = _id(instance.get('instanceId'))
        if instance_id in seen_instances:
            raise ValueError('personal-agent instanceId 重复')
        seen_instances.add(instance_id)
        exported_at = instance.get('exportedAt')
        if timestamp(exported_at) is None:
            raise ValueError('personal-agent exportedAt 必须含时区')
        source = 'personal-agent:' + instance_id
        exports.append({'source': source, 'exportedAt': exported_at})
        seen_tasks = set()
        for snapshot in _rows(instance.get('snapshots'), 'snapshots'):
            task = snapshot.get('task')
            if not isinstance(task, dict):
                raise ValueError('personal-agent snapshot.task 无效')
            task_id = _id(task.get('id'))
            if task_id in seen_tasks:
                raise ValueError('personal-agent task.id 重复')
            seen_tasks.add(task_id)
            if not isinstance(task.get('status'), str) or task['status'] not in TASK_STATUSES or not isinstance(task.get('deliveryStatus'), str) or task['deliveryStatus'] not in {'pending', 'accepted', 'returned'}:
                raise ValueError('personal-agent 任务状态无效')
            events = _owned(snapshot.get('events'), task_id, 'events')
            sequences = [e.get('seq') for e in events]
            if any(not isinstance(seq, int) or isinstance(seq, bool) or seq < 1 for seq in sequences) or len(set(sequences)) != len(sequences):
                raise ValueError('personal-agent event.seq 无效或重复')
            projected_events = []
            # Native seq, rather than export array order, breaks equal-time ties.
            for event in sorted(events, key=lambda e: e['seq'], reverse=True):
                details = event.get('data') if isinstance(event.get('data'), dict) else {}
                summary = next((_text(details.get(key)) for key in ('reason', 'message', 'summary', 'requirements') if isinstance(details.get(key), str)), '')
                projected_events.append({'source': source, 'status': _text(event.get('type')),
                                         'at': event.get('createdAt'), 'attemptId': event.get('attemptId'),
                                         'summary': f'事件 #{event["seq"]} ' + summary, 'seq': event['seq']})
            # Delivery is a task-level human fact, never inferred from run completion.
            projected_events.append({'source': source, 'status': 'delivery:' + task['deliveryStatus'],
                                     'at': task.get('updatedAt'), 'summary': 'PA 来源交付状态；执行结束与人工接收分别记录。',
                                     'branch': task.get('branchName')})
            for result in _owned(snapshot.get('verifications', []), task_id, 'verifications'):
                command = result.get('command') if isinstance(result.get('command'), dict) else {}
                projected_events.append({'source': source, 'status': 'verification', 'at': result.get('endedAt'),
                                         'attemptId': result.get('attemptId'),
                                         'summary': _text(json.dumps({key: result.get(key) for key in ('id', 'exitCode', 'timedOut', 'cancelled')}, ensure_ascii=False)
                                                          + '\n命令（仅显示，不执行）：' + json.dumps(command, ensure_ascii=False)
                                                          + '\nstdout: ' + _text(result.get('stdout'), 1000)
                                                          + '\nstderr: ' + _text(result.get('stderr'), 1000))})
            for artifact in _owned(snapshot.get('artifacts'), task_id, 'artifacts'):
                projected_events.append({'source': source, 'status': 'artifact:' + _text(artifact.get('kind'), 30),
                                         'at': artifact.get('createdAt'), 'attemptId': artifact.get('attemptId'),
                                         'summary': _text(artifact.get('name'), 256) + '\n' + _text(artifact.get('content'))})
            for approval in _owned(snapshot.get('approvals', []), task_id, 'approvals'):
                projected_events.append({'source': source, 'status': 'PA approval:' + _text(approval.get('status'), 30),
                                         'at': approval.get('resolvedAt') or approval.get('createdAt'),
                                         'attemptId': approval.get('attemptId'),
                                         'summary': _text(approval.get('title')) + '（仅供查看，请在 PA 工作台处理）'})
            tasks.append({'source': source, 'taskKey': task_id, 'title': _text(task.get('goal')),
                          'objective': _text(task.get('goal'), 4096), 'status': task['status'],
                          'deliveryStatus': task['deliveryStatus'], 'updatedAt': task.get('updatedAt'),
                          'workspace': _text(task.get('worktreePath')), 'events': projected_events})
            seen_runs = set()
            for run in _owned(snapshot.get('runs', []), task_id, 'runs'):
                run_id = _id(run.get('id'))
                if run_id in seen_runs or not isinstance(run.get('status'), str) or run['status'] not in RUN_STATUSES:
                    raise ValueError('personal-agent run ID 重复或状态无效')
                seen_runs.add(run_id)
                attempt_id = run.get('attemptId')
                if attempt_id is not None:
                    _id(attempt_id)
                # PA currently has no measured token/model/session fields in AgentRunRecord.
                records.append({'source': source, 'taskKey': task_id, 'runId': run_id,
                                'attemptId': attempt_id, 'status': run['status'],
                                'executor': task.get('engine') if isinstance(task.get('engine'), str) and task['engine'] in {'fake', 'claude'} else None,
                                'role': _text(run.get('role')) or None, 'model': None, 'tokens': None,
                                'modelCalls': None, 'at': run.get('endedAt') or run.get('startedAt'),
                                'summary': 'PA run ' + run_id + ' · stage ' + _text(run.get('stageId'))})
    return {'tasks': tasks, 'records': records, 'exports': exports}
