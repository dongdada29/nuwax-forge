"""Local, explicit approval ledger for a single configured workspace.

This is a cooperative gate, not an identity boundary against processes running
as the same OS user. Never infer approval from a message, plan or old task.
"""
import hashlib
import json
import os
import re
import sqlite3
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def request_id(payload):
    return hashlib.sha256(_canonical(payload).encode()).hexdigest()


def _connect(path, *, create=False):
    p = Path(path)
    if not p.is_absolute() or p.is_symlink():
        raise ValueError('approval-store-invalid')
    if create:
        p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not p.exists():
            try:
                fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
            except FileExistsError:
                pass
    else:
        p = p.resolve(strict=True)
    db = sqlite3.connect(p.as_uri() + '?mode=rw', uri=True, timeout=5)
    db.execute('PRAGMA busy_timeout=5000')
    if create:
        db.execute('CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT)')
        db.commit()
    return db


@contextmanager
def _transaction(path, *, create=False):
    with closing(_connect(path, create=create)) as db:
        with db:
            yield db


def submit(path, payload):
    if not isinstance(payload, dict): raise ValueError('approval-payload-invalid')
    for key, limit in [('taskKey', 128), ('attemptId', 128), ('summary', 1000), ('scope', 1000), ('acceptance', 1000), ('worktree', 2048), ('planHash', 64), ('briefHash', 64), ('brief', 8192)]:
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip() or len(value.encode()) > limit:
            raise ValueError('approval-' + key + '-required')
    if not all(re.fullmatch(r'[0-9a-f]{64}', payload[k]) for k in ('planHash', 'briefHash')):
        raise ValueError('approval-hash-invalid')
    identity = request_id(payload)
    with _transaction(path, create=True) as db:
        db.execute('INSERT OR IGNORE INTO approvals VALUES(?,?,?,?,NULL)',
                   (identity, _canonical(payload), 'pending', datetime.now(timezone.utc).isoformat()))
        row = db.execute('SELECT status,created_at,decided_at FROM approvals WHERE id=?', (identity,)).fetchone()
    return {'id': identity, 'status': row[0], 'createdAt': row[1], 'decidedAt': row[2], **payload}


def list_requests(path, limit=200):
    if not Path(path).exists(): return []
    with _transaction(path) as db:
        rows = db.execute("SELECT id,payload,status,created_at,decided_at FROM approvals ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,created_at DESC LIMIT ?", (limit,)).fetchall()
    return [{'id': i, 'status': s, 'createdAt': c, 'decidedAt': d, **json.loads(p)} for i, p, s, c, d in rows]


def decide(path, identity, decision):
    if not isinstance(identity, str) or not re.fullmatch(r'[0-9a-f]{64}', identity) or decision not in ('approved', 'rejected'):
        raise ValueError('approval-decision-invalid')
    with _transaction(path) as db:
        changed = db.execute("UPDATE approvals SET status=?,decided_at=? WHERE id=? AND status='pending'", (decision, datetime.now(timezone.utc).isoformat(), identity)).rowcount
        if changed != 1: raise ValueError('approval-not-pending')
    return {'id': identity, 'status': decision}


def supersede_pending(path, previous_id, replacement_id):
    """Retire an undecided plan in favour of a new pending plan; never approve it."""
    with _transaction(path) as db:
        old = db.execute('SELECT payload,status FROM approvals WHERE id=?', (previous_id,)).fetchone()
        new = db.execute('SELECT payload,status FROM approvals WHERE id=?', (replacement_id,)).fetchone()
        if not old or not new:
            raise ValueError('replacement-approval-missing')
        before, after = json.loads(old[0]), json.loads(new[0])
        if (previous_id == replacement_id or old[1] not in {'pending', 'superseded'}
                or (new[1] != 'pending' and not (old[1] == 'superseded' and new[1] in {'approved','rejected'}))
                or before.get('taskRef') != after.get('taskRef')
                or not before.get('taskRef') or before['taskKey'] != after['taskKey']
                or before['attemptId'] == after['attemptId']
                or after.get('supersedesApprovalId') != previous_id):
            raise ValueError('only-undecided-same-task-plan-can-be-replaced')
        db.execute("UPDATE approvals SET status='superseded' WHERE id=? AND status='pending'", (previous_id,))
    return {'id': previous_id, 'status': 'superseded', 'replacementId': replacement_id}


def verify(path, identity, *, task, attempt, worktree, plan, brief, plan_bytes=None, brief_bytes=None):
    if not re.fullmatch(r'[0-9a-f]{64}', identity or ''): raise ValueError('approval-id-invalid')
    with _transaction(path) as db:
        row = db.execute('SELECT payload,status FROM approvals WHERE id=?', (identity,)).fetchone()
    if not row or row[1] != 'approved': raise ValueError('approval-not-approved')
    payload = json.loads(row[0])
    if (request_id(payload) != identity or payload['taskKey'] != task or payload['attemptId'] != attempt
            or payload['worktree'] != str(Path(worktree).resolve())
            or payload['planHash'] != (hashlib.sha256(plan_bytes).hexdigest() if plan_bytes is not None else sha_file(plan))
            or payload['briefHash'] != (hashlib.sha256(brief_bytes).hexdigest() if brief_bytes is not None else sha_file(brief))):
        raise ValueError('approval-input-changed')
    return payload
