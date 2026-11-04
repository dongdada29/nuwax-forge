"""Explicit local sources for the Forge dashboard. No network or state mutation."""
import json
import sqlite3
from pathlib import Path


def _tokens(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _text(value):
    return value if isinstance(value, str) and value.strip() else None


from crew.delivery import delivery_fields


def _event(row, details=None):
    details = details or {}
    summary = next((value[:2048] for value in (details.get('reason'), details.get('reportSummary'),
                    row.get('reason'), row.get('reportSummary')) if isinstance(value, str)), '')
    return {'status': _text(row.get('status')), 'at': row.get('ts') or row.get('atUtc') or row.get('at'),
            'summary': summary, **delivery_fields(row, details)}


def crew_records(rows):
    # A dispatch and its terminal event describe one attempt. Legacy rows without
    # attemptId cannot be correlated safely and remain separate observations.
    grouped, pending = {}, {}
    for index, row in enumerate(rows):
        if row.get('status') not in {'dispatched', 'completed', 'success', 'failed', 'blocked'}:
            continue
        details = row.get('details') if isinstance(row.get('details'), dict) else {}
        attempt = _text(row.get('attemptId'))
        base = (_text(row.get('taskKey')), attempt, _text(row.get('executor')), _text(row.get('role')))
        step = details.get('stepIndex')
        if attempt and isinstance(step, int) and not isinstance(step, bool) and step > 0:
            key = (*base, step)
        elif attempt and row.get('status') != 'dispatched' and pending.get(base):
            key = pending[base].pop(0)
        else:
            key = ('event', index)
            if attempt and row.get('status') == 'dispatched':
                pending.setdefault(base, []).append(key)
        old = grouped.get(key, {})
        model = _text(details.get('model')) or _text(row.get('model')) or old.get('model')
        charge = _tokens(details.get('chargedTokens'))
        grouped[key] = {'source': 'crew', 'taskKey': row.get('taskKey'), 'attemptId': attempt,
                        'executor': _text(row.get('executor')), 'role': _text(row.get('role')), 'model': model,
                        'status': row.get('status'), 'tokens': charge if 'chargedTokens' in details else old.get('tokens'),
                        'at': row.get('ts') or row.get('atUtc') or old.get('at'),
                        'legacyUncorrelated': not bool(attempt),
                        'events': [*old.get('events', []), _event(row, details)],
                        **delivery_fields(old, row, details)}
    # Attempt lifecycle events enrich an already identified step, not usage counts.
    for row in rows:
        if row.get('status') in {'attempt-started', 'attempt-blocked', 'attempt-failed', 'attempt-completed'} and _text(row.get('attemptId')):
            matching = [r for r in grouped.values() if r.get('taskKey') == row.get('taskKey') and r.get('attemptId') == row['attemptId']]
            if matching:
                details = row.get('details') if isinstance(row.get('details'), dict) else {}
                matching[0]['events'].append(_event(row, details))
    return list(grouped.values())


def task_store_records(path):
    p = Path(path).resolve(strict=True)
    with sqlite3.connect(p.as_uri() + '?mode=ro', uri=True) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assignments'").fetchone():
            return None
        rows = db.execute('SELECT attempt_id,task_id,state,payload FROM assignments').fetchall()
        events = {}
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assignment_events'").fetchone():
            for attempt, operation, at, encoded in db.execute('SELECT attempt_id,operation,at,payload FROM assignment_events ORDER BY event_id'):
                data = json.loads(encoded)
                events.setdefault(attempt, []).append({'status': data.get('state') or operation, 'at': at,
                                                       'summary': _text(data.get('reportSummary')), **delivery_fields(data)})
    out = []
    for attempt, task, state, encoded in rows:
        payload = json.loads(encoded)
        usage = payload.get('usage') if isinstance(payload.get('usage'), dict) else {}
        out.append({'source': 'stack', 'taskKey': task, 'attemptId': attempt,
                    'executor': _text(payload.get('executor')), 'role': _text(payload.get('role')),
                    'model': _text(payload.get('model')), 'status': state, 'tokens': _tokens(usage.get('tokens')),
                    'modelCalls': _tokens(usage.get('modelCalls')),
                    'at': events.get(attempt, [{}])[-1].get('at'), 'events': events.get(attempt, []),
                    'summary': _text(payload.get('reportSummary')), 'sessionId': _text(payload.get('sessionId')),
                    **delivery_fields(payload)})
    return out


def task_store_tasks(path):
    """Read task metadata independently of whether an Assignment exists yet."""
    p = Path(path).resolve(strict=True)
    with sqlite3.connect(p.as_uri() + '?mode=ro', uri=True) as db:
        columns = {r[1] for r in db.execute('PRAGMA table_info(tasks)')}
        if not {'id', 'payload'}.issubset(columns):
            return []
        rows = db.execute('SELECT id,payload FROM tasks').fetchall()
        events = {}
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").fetchone():
            for task, at, encoded in db.execute('SELECT task_id,at,payload FROM events ORDER BY revision'):
                data = json.loads(encoded)
                events.setdefault(task, []).append({'source': 'stack', 'status': data.get('phase'), 'at': at,
                                                   'summary': data.get('blocker') or data.get('last_action') or data.get('next_action')})
    out = []
    for task, encoded in rows:
        data = json.loads(encoded)
        out.append({'source': 'stack', 'taskKey': task, 'title': data.get('objective'),
                    'objective': data.get('objective'), 'acceptance': data.get('predicates') or [],
                    'workspace': data.get('repo_root'), 'status': data.get('phase'),
                    'events': events.get(task, [])})
    return out


def agent_state_record(path):
    p = Path(path).resolve(strict=True)
    manifest = json.loads((p / 'manifest.json').read_text(encoding='utf-8'))
    request = json.loads((p / 'request.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or not isinstance(request, dict) or manifest.get('kind') != 'client-agent-run-v1' or manifest.get('taskKey') != request.get('taskKey'):
        raise ValueError('agent state manifest/request 不匹配')
    if manifest.get('modelDispatched') is not True:
        return None
    runtime = request.get('runtime') if isinstance(request.get('runtime'), dict) else {}
    events = [{'status': 'started', 'at': manifest.get('startedAt'), 'summary': ''}]
    events.append({'status': manifest.get('status'), 'at': manifest.get('finishedAt'),
                   'summary': _text(manifest.get('reason')), **delivery_fields(manifest)})
    return {'source': 'forge-agent', 'taskKey': manifest.get('taskKey'), 'attemptId': None,
            'executor': _text(runtime.get('kind')), 'role': 'worker', 'model': _text(runtime.get('model')),
            'status': manifest.get('status'), 'tokens': _tokens(manifest.get('chargedTokens')) if manifest.get('usageKnown') is True else None,
            'modelCalls': None, 'at': manifest.get('finishedAt') or manifest.get('startedAt'),
            'events': events, **delivery_fields(manifest)}


def host_guard_records(path):
    p = Path(path).resolve(strict=True)
    if p.stat().st_size > 1048576:
        raise ValueError('budget guard 文件超过 1 MiB')
    data = json.loads(p.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or data.get('kind') != 'codex-budget-guard' or data.get('schemaVersion') != 1:
        raise ValueError('不支持的 budget guard 格式')
    host = data.get('host') if isinstance(data.get('host'), dict) else {}
    task = _text(host.get('threadId')) or 'unknown'
    own = host.get('ownTokens') if isinstance(host.get('ownTokens'), dict) else {}
    records = [{'source':'host-guard', 'taskKey':task, 'attemptId':task, 'executor':'codex',
                'role':'router', 'model':None, 'status':data.get('verdict'),
                'tokens':_tokens(own.get('totalTokens')), 'modelCalls':None, 'at':host.get('start')}]
    workers = data.get('workers', [])
    if not isinstance(workers, list) or any(not isinstance(worker, dict) for worker in workers):
        raise ValueError('budget guard workers 格式无效')
    for worker in workers:
        tokens = worker.get('tokens') if isinstance(worker.get('tokens'), dict) else {}
        records.append({'source':'host-guard', 'taskKey':task, 'attemptId':_text(worker.get('threadId')),
                        'executor':_text(worker.get('agentPath')) or 'codex', 'role':'worker', 'model':None,
                        'status':data.get('verdict'), 'tokens':_tokens(tokens.get('totalTokens')),
                        'modelCalls':None, 'at':worker.get('startedAt')})
    return records


def summarize(records):
    # No cross-source summation: independent logs can represent the same run.
    groups = {}
    for r in records:
        key = (r.get('source') or 'unknown', r.get('executor') or 'unknown', r.get('role') or 'unknown', r.get('model') or 'unknown')
        item = groups.setdefault(key, {'source': key[0], 'executor': key[1], 'role': key[2], 'model': key[3],
                                       'attempts': 0, 'knownTokens': 0, 'knownCount': 0, 'unknownTokens': 0})
        item['attempts'] += 1
        if r.get('tokens') is None:
            item['unknownTokens'] += 1
        else:
            item['knownCount'] += 1
            item['knownTokens'] += r['tokens']
    return sorted(groups.values(), key=lambda x: (x['source'], x['executor'], x['role'], x['model']))


def route_edges(records):
    """Only host-guard explicitly links its workers to the host thread.

    Other sources record an assignment but not the identity of its router.
    Never infer a parent from a shared task name across independent sources.
    """
    routers = {r.get('taskKey'): r for r in records
               if r.get('source') == 'host-guard' and r.get('role') == 'router' and r.get('taskKey')}
    edges = {}
    for r in records:
        if r.get('role') == 'router':
            continue
        router = routers.get(r.get('taskKey')) if r.get('source') == 'host-guard' else None
        parent = (router.get('attemptId') or router.get('executor') or 'unknown') if router else '未记录'
        key = (r.get('source') or 'unknown', parent, r.get('executor') or 'unknown',
               r.get('role') or 'unknown', r.get('model') or 'unknown')
        edge = edges.setdefault(key, {'source': key[0], 'router': key[1], 'worker': key[2],
                                      'role': key[3], 'model': key[4], 'count': 0, 'tasks': set()})
        edge['count'] += 1
        if r.get('taskKey'):
            edge['tasks'].add(str(r['taskKey']))
    return sorted(edges.values(), key=lambda e: (e['source'], e['router'], e['worker'], e['role'], e['model']))
