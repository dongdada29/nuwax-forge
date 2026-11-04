#!/usr/bin/env python3
"""Host-neutral, one-shot JSON preflight/context/backoff/dispatch protocol. No model or shell."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

VERSION = '0.4.7'
KINDS = {'nuwax-platform', 'codex', 'deepseek-harness'}
DELAYS = (5, 15, 60, 360)


def encoded(x):
    return (json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode()


def fingerprint(x):
    return hashlib.sha256(encoded(x)).hexdigest()


def load(path, limit=1048576):
    p = Path(path)
    if p.stat().st_size > limit:
        raise ValueError('input-too-large')
    return json.loads(p.read_text())


def atomic(path, data):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + p.name, dir=p.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextmanager
def locked(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield directory
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def state_dir(profile):
    p = Path(profile['workspace']['stateDirectory']).resolve() / 'runtime'
    configured = Path(profile['runtimeGuard']['stateDirectory']).resolve()
    if configured != p:
        raise ValueError('runtime-state-must-be-state/runtime')
    return p


def now_utc():
    return datetime.now(timezone.utc).isoformat()


def check(profile, observed, dns=None):
    rt, config = profile['runtime'], profile['runtimeGuard']
    issues = []
    if rt.get('kind') not in KINDS:
        issues.append('runtime.kind:unknown')
    if rt.get('expectedHostname') != socket.gethostname():
        issues.append('hostname:mismatch')
    if observed.get('kind') != rt.get('kind'):
        issues.append('runtime.kind:mismatch')
    for key in ('sandboxId', 'agentId') if rt.get('kind') == 'nuwax-platform' else ():
        if str(observed.get(key)) != str(rt.get(key)):
            issues.append(key + ':mismatch-or-unknown')
    root = Path(profile['workspace']['root'])
    if not root.is_absolute() or not root.is_dir():
        issues.append('workspace:missing')
    for name, tool in sorted(config['tools'].items()):
        path = tool.get('path')
        valid = bool(path and Path(path).is_absolute() and Path(path).is_file())
        if valid and tool.get('executable'):
            valid = os.access(path, os.X_OK)
        if not valid and tool.get('required', True):
            issues.append('tool:' + name + ':missing-or-unknown')
    db = Path(config['taskStore'])
    if db != Path(profile['workspace']['stateDirectory']) / 'tasks' / 'tasks.sqlite' or not db.is_file():
        issues.append('task-store:missing-or-wrong-path')
    if dns:
        # A separate Python resolver process gives a hard wait bound; no global DNS mutation.
        if dns not in config.get('dnsAllowlist', []):
            raise ValueError('dns-host-not-allowed')
        try:
            proc = subprocess.run([config['tools']['python']['path'], '-c',
                'import socket,sys;socket.getaddrinfo(sys.argv[1],443)', dns],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=False)
            if proc.returncode:
                issues.append('dns:failed')
        except (OSError, subprocess.TimeoutExpired):
            issues.append('dns:failed')
    issues = sorted(issues)
    return {'schemaVersion': 1, 'runtime': {'kind': rt.get('kind', 'unknown')},
            'status': 'blocked' if issues else 'ready', 'issues': issues,
            'fingerprint': fingerprint({'issues': issues, 'profile': fingerprint(profile)}),
            'cursorChanged': False, 'fallbackAllowed': False}


def backoff(directory, observation, now=None):
    now = time.time() if now is None else now
    key = observation['key']
    if not isinstance(key, str) or not 0 < len(key) <= 160:
        raise ValueError('invalid-key')
    outcome = observation['outcome']
    if outcome not in {'blocked', '404', 'permission', 'unchanged', 'changed', 'ok'}:
        raise ValueError('invalid-outcome')
    identity = {k: observation.get(k) for k in ('issueFingerprint', 'sourceFingerprint', 'conditionFingerprint')}
    if not all(isinstance(v, str) and 0 < len(v) <= 128 for v in identity.values()):
        raise ValueError('explicit-fingerprints-required')
    fp = fingerprint(identity)
    with locked(directory) as d:
        p = d / 'backoff.json'
        state = load(p) if p.exists() else {}
        old = state.get(key, {})
        changed = old.get('fingerprint') != fp or outcome in {'changed', 'ok'}
        bypass = observation.get('newMessage') is True or observation.get('authorizedTaskReady') is True
        # A wake during cooldown is not another failed probe; it does not extend the timer.
        if changed or not old:
            count = 0 if outcome in {'changed', 'ok'} else 1
            due = now if count == 0 or old else now + 300
            item = {'fingerprint': fp, 'count': count, 'nextCheckAt': due, 'outcome': outcome}
        elif now >= old['nextCheckAt'] and observation.get('attempted') is True:
            count = min(old['count'] + 1, 4)
            item = {**old, 'count': count, 'nextCheckAt': now + DELAYS[count - 1] * 60, 'outcome': outcome}
        else:
            item = old
        state[key] = item
        if len(state) > 256:
            raise ValueError('backoff-key-limit-archive-explicitly')
        atomic(p, encoded(state))
        return {**item, 'status': 'ready' if bypass or changed and bool(old) or now >= item['nextCheckAt'] else 'deferred',
                'allowNewMessages': True, 'allowAuthorizedTasks': True, 'scope': key,
                'bypassed': bypass, 'reset': changed}


def sha_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            digest.update(chunk)
    return digest.hexdigest()


def compact_context(directory, cursor, recent, legacy_digest=None):
    original = load(cursor, 8 * 1048576)
    allowed = ('afterSeq', 'privateSeq', 'tech1Seq', 'group', 'groupSeq', 'lastRunId', 'updatedAt')
    view = {k: original[k] for k in allowed if k in original and isinstance(original[k], (int, str, type(None)))}
    for key in view:
        if isinstance(view[key], str) and len(view[key].encode()) > 256:
            raise ValueError('cursor-scalar-too-large')
    # Only explicitly selected recent data; never include note_run* or historical prose.
    pending = recent.get('pending', [])
    if not isinstance(pending, list):
        raise ValueError('pending-must-be-list')
    view['pending'] = [str(x)[:120] for x in pending[:3]]
    view['recentRun'] = str(recent.get('runId', 'unknown'))[:80]
    view['sourceHash'] = sha_file(cursor)
    if len(encoded(view)) > 4096:
        raise ValueError('cursor-view-limit')
    summary = recent.get('summary', '')
    if not isinstance(summary, str) or len(summary) > 600 or len(summary.encode()) > 2400:
        raise ValueError('digest-summary-limit')
    source_hash = sha_file(legacy_digest) if legacy_digest else fingerprint(recent)
    meta = {'sourceHash': source_hash, 'recentHash': fingerprint(recent), 'updatedAt': now_utc(), 'schemaVersion': 1}
    digest = ('<!-- ' + encoded(meta).decode().strip() + ' -->\n' + summary + '\n').encode()
    if len(digest) > 4096:
        raise ValueError('digest-byte-limit')
    with locked(directory) as d:
        # Immutable, content-addressed archive. Original remains byte-for-byte untouched.
        if legacy_digest:
            archive = d / 'archive' / ('progress-digest-' + source_hash + '.md')
            if not archive.exists():
                archive.parent.mkdir(exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=archive.parent)
                os.close(fd)
                try:
                    shutil.copyfile(legacy_digest, tmp)
                    if sha_file(tmp) != source_hash:
                        raise ValueError('source-changed-during-archive')
                    os.replace(tmp, archive)
                finally:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
        atomic(d / 'cursor-view.json', encoded(view))
        atomic(d / 'digest-current.md', digest)
    return {'status': 'ready', 'cursorView': view, 'digestBytes': len(digest), 'cursorChanged': False}


def lease(directory, owner, action, seconds=120, now=None):
    if not owner or len(owner) > 128 or not 1 <= seconds <= 3600:
        raise ValueError('invalid-lease')
    now = time.time() if now is None else now
    with locked(directory) as d:
        p = d / 'lease.json'
        old = load(p) if p.exists() else {}
        if old.get('expiresAt', 0) > now and old.get('owner') != owner:
            return {'status': 'busy'}
        if action == 'release':
            atomic(p, encoded({'owner': owner, 'expiresAt': 0}))
        else:
            atomic(p, encoded({'owner': owner, 'expiresAt': now + seconds}))
        return {'status': 'ready', 'owner': owner}


def usage(raw):
    unknown = {'status': 'unknown', 'inputTokens': None, 'outputTokens': None, 'totalTokens': None, 'cachedInputTokens': None}
    if not raw or raw.get('adapter') != 'structured-v1' or raw.get('usageScope') != 'run-segment' or raw.get('inputSemantics') != 'includes-cache':
        return unknown
    values = [raw.get(k) for k in ('inputTokens', 'outputTokens', 'cachedInputTokens')]
    if any(type(v) is not int or v < 0 for v in values) or values[2] > values[0]:
        return unknown
    total = values[0] + values[1]
    if raw.get('totalTokens', total) != total:
        return unknown
    return dict(zip(('inputTokens', 'outputTokens', 'cachedInputTokens'), values), status='known', totalTokens=total)


def dispatch(profile, request, directory):
    """Produce fixed argv for approved local plan; do not execute messages or model commands."""
    if request.get('runtime', {}).get('kind') not in KINDS:
        raise ValueError('explicit-runtime.kind-required')
    task, attempt = request['taskKey'], request['attemptId']
    if not all(isinstance(x, str) and 0 < len(x) <= 128 for x in (task, attempt)):
        raise ValueError('invalid-dispatch-key')
    config = profile['runtimeGuard']
    plan_path = Path(request['plan']).resolve(strict=True)
    brief = Path(request['briefFile']).resolve(strict=True)
    worktree = Path(request['worktree']).resolve(strict=True)
    if not worktree.is_relative_to(Path(profile['workspace']['taskWorktreesDirectory']).resolve()) or not brief.is_relative_to(worktree) or not plan_path.is_relative_to(worktree):
        raise ValueError('plan-brief-worktree-outside-authorized-worktrees')
    if brief.stat().st_size > 8192:
        raise ValueError('short-brief-limit')
    plan = load(plan_path)
    if plan.get('taskKey') != task or plan.get('mode') not in {'model', 'no-model'}:
        raise ValueError('explicit-mode-and-taskKey-required')
    if plan['mode'] == 'model' and (not plan.get('budgetSpec') or not plan.get('budget') or plan['budget'].get('maxAttempts', 1) != 1):
        raise ValueError('use-existing-devkit-budget-contract')
    if not plan.get('assignments') or any(not isinstance(a.get('command'), list) or not a['command'] or not all(isinstance(x, str) for x in a['command']) for a in plan['assignments']):
        raise ValueError('approved-local-argv-plan-required')
    timeout = request.get('timeoutSeconds', 180)
    if type(timeout) is not int or not 1 <= timeout <= 3600:
        raise ValueError('finite-timeout-required')
    # Bundled crew has existing devkit prediction + step admission; standalone crew is not silently substituted.
    result = {'schemaVersion': 1, 'taskKey': task, 'attemptId': attempt, 'runtime': request['runtime'],
              'status': 'prepared', 'processPassed': None, 'acceptancePassed': None, 'usage': usage(None),
              'cwd': config['devkitCrewRoot'], 'env': {'NUWAX_DEVKIT_NODE': config['tools']['node']['path'], 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': config['devkitCrewRoot']},
              'argv': [config['tools']['python']['path'], '-B', '-m', 'crew', 'run', '--plan', str(plan_path), '--worktree', str(worktree), '--brief', '@' + str(brief), '--ledger', config['crewLedger'], '--artifacts', str(Path(profile['workspace']['artifactsDirectory']) / 'dispatch'), '--timeout', str(timeout)],
              'planHash': sha_file(plan_path), 'briefHash': sha_file(brief), 'providerHardCap': False}
    if config.get('humanApprovalRequired') is True:
        if plan.get('attemptId') != attempt:
            raise ValueError('approval-requires-matching-plan-attemptId')
        info = request.get('approval')
        if not isinstance(info, dict) or set(info) != {'summary', 'scope', 'acceptance'}:
            raise ValueError('approval-summary-scope-acceptance-required')
        store = Path(directory).resolve() / 'approvals.sqlite'
        sys.path.insert(0, config['devkitCrewRoot'])
        from crew import approvals
        brief_bytes = brief.read_bytes()
        if hashlib.sha256(brief_bytes).hexdigest() != result['briefHash']:
            raise ValueError('approval-brief-changed-during-read')
        payload = {'taskKey': task, 'attemptId': attempt, 'summary': info['summary'], 'scope': info['scope'],
                   'acceptance': info['acceptance'], 'worktree': str(worktree), 'planHash': result['planHash'],
                   'briefHash': result['briefHash'], 'brief': brief_bytes.decode('utf-8'),
                   'planPath': str(plan_path), 'briefPath': str(brief),
                   'workers': [{'executor': str(a.get('executor', 'unknown'))[:128], 'role': str(a.get('role', 'unknown'))[:128],
                                'model': str(a.get('model') or plan.get('model') or '未声明')[:150]} for a in plan['assignments'][:20]]}
        item = approvals.submit(store, payload)
        if item['status'] != 'approved':
            return {'schemaVersion': 1, 'taskKey': task, 'attemptId': attempt, 'status': 'approval-' + item['status'],
                    'approvalId': item['id'], 'executeAllowed': False}
        approvals.verify(store, item['id'], task=task, attempt=attempt, worktree=worktree, plan=plan_path, brief=brief)
        result['approvalId'] = item['id']
        result['argv'].extend(['--approval-db', str(store), '--approval-id', item['id']])
    with locked(directory) as d:
        p = d / 'dispatch-index.json'
        index = load(p) if p.exists() else {}
        key = fingerprint({'taskKey': task, 'attemptId': attempt})
        if key in index:
            if index[key]['planHash'] != result['planHash'] or index[key]['briefHash'] != result['briefHash']:
                raise ValueError('attempt-input-changed')
            return {**index[key], 'duplicate': True, 'executeAllowed': False}
        if any(v['taskKey'] == task for v in index.values()):
            raise ValueError('task-already-prepared-reconcile-no-auto-retry')
        if len(index) >= 256:
            raise ValueError('dispatch-index-limit-reconcile-before-archive')
        index[key] = result
        atomic(p, encoded(index))
        return {**result, 'duplicate': False, 'executeAllowed': True}


def record(directory, data):
    # Sidecar reconciliation only; original crew ledger stays append-only under crew.run.
    key = fingerprint({'taskKey': data['taskKey'], 'attemptId': data['attemptId']})
    with locked(directory) as d:
        index = load(d / 'dispatch-index.json')
        if key not in index:
            raise ValueError('unprepared-attempt')
        item = index[key]
        if item.get('status') == 'reconciled':
            return {**item, 'duplicate': True}
        if type(data.get('processPassed')) is not bool:
            raise ValueError('processPassed-required')
        acceptance = data.get('acceptancePassed')
        if acceptance is not None and type(acceptance) is not bool:
            raise ValueError('invalid-acceptance')
        if acceptance is True and (not data['processPassed'] or not data.get('acceptanceEvidence')):
            raise ValueError('acceptance-requires-process-and-evidence')
        item.update(status='reconciled', processPassed=data['processPassed'], acceptancePassed=acceptance,
                    acceptanceEvidence=str(data.get('acceptanceEvidence', ''))[:512], usage=usage(data.get('usage')))
        atomic(d / 'dispatch-index.json', encoded(index))
        # One immutable event per task/attempt; atomic rewrite makes repeated reconciliation idempotent.
        atomic(d / 'dispatch-events' / (key + '.json'), encoded(item))
        return item


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['check', 'backoff', 'context', 'lease', 'dispatch', 'record'])
    p.add_argument('--profile', required=True)
    p.add_argument('--input', help='Explicit local JSON observation/recent/approved dispatch request; never an external command')
    p.add_argument('--dns')
    p.add_argument('--owner')
    p.add_argument('--action', choices=['acquire', 'release'], default='acquire')
    p.add_argument('--seconds', type=int, default=120)
    args = p.parse_args()
    try:
        profile = load(args.profile)
        directory = state_dir(profile)
        data = load(args.input, 16384) if args.input else {}
        if args.command == 'check':
            result = check(profile, data, args.dns)
        elif args.command == 'backoff':
            result = backoff(directory, data)
        elif args.command == 'context':
            result = compact_context(directory, Path(profile['workspace']['stateDirectory']) / 'im-cursor.json', data, data.get('legacyDigest'))
        elif args.command == 'lease':
            result = lease(directory, args.owner, args.action, args.seconds)
        elif args.command == 'dispatch':
            result = dispatch(profile, data, directory)
        else:
            result = record(directory, data)
        blob = encoded(result)
        if len(blob) > 16384:
            raise ValueError('output-limit')
        sys.stdout.buffer.write(blob)
        return 3 if result.get('status') in {'blocked', 'busy', 'deferred'} else 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'status': 'blocked', 'reason': type(error).__name__, 'detail': str(error)[:240], 'cursorChanged': False}))
        return 3


if __name__ == '__main__':
    sys.exit(main())
