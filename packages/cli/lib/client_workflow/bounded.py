#!/usr/bin/env python3
"""Observe a fresh codex exec --json child; enforce a process cap, not a provider quota.

Only the child process group is controlled. In-flight/unflushed usage is unknowable.
Cached tokens are a subset of input; reasoning tokens are a subset of output.
"""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import time


class MeasurementError(ValueError):
    pass


def integer(value):
    if type(value) is not int or value < 0:
        raise MeasurementError('usage must contain nonnegative integers')
    return value


class JsonLines:
    def __init__(self, path):
        self.path, self.offset, self.pending = Path(path), 0, b''

    def rows(self, final=False):
        if not self.path.exists():
            return []
        if self.path.stat().st_size < self.offset:
            raise MeasurementError('telemetry truncated')
        with self.path.open('rb') as f:
            f.seek(self.offset)
            data = self.pending + f.read()
            self.offset = f.tell()
        lines = data.split(b'\n')
        self.pending = lines.pop()
        if final and self.pending:
            lines.append(self.pending)
            self.pending = b''
        out = []
        for line in lines:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError) as e:
                raise MeasurementError('malformed JSONL: ' + str(self.path)) from e
            if not isinstance(row, dict):
                raise MeasurementError('JSONL row must be an object')
            out.append(row)
        return out


class SessionReader:
    """The same strict reader is used by synthetic subprocess tests and live Codex."""
    def __init__(self, path, thread):
        self.lines, self.thread = JsonLines(path), thread
        self.meta = False
        self.usage = None
        self.responses = set()
        self.tool_calls = 0

    def read(self, final=False):
        for row in self.lines.rows(final):
            p = row.get('payload') or {}
            if not isinstance(p, dict):
                raise MeasurementError('malformed session payload')
            if row.get('type') == 'session_meta':
                if p.get('id') != self.thread:
                    raise MeasurementError('session identity mismatch')
                self.meta = True
            if row.get('type') == 'response_item' and p.get('type') in ('function_call', 'custom_tool_call'):
                self.tool_calls += 1
            if row.get('type') != 'event_msg' or p.get('type') != 'token_count':
                continue
            info = p.get('info')
            if info is None:  # initial Codex event may have no snapshot yet
                continue
            if not isinstance(info, dict) or not isinstance(info.get('total_token_usage'), dict):
                raise MeasurementError('malformed token_count snapshot')
            u = info['total_token_usage']
            v = {k: integer(u.get(k)) for k in ('input_tokens', 'output_tokens', 'total_tokens')}
            for k in ('cached_input_tokens', 'reasoning_output_tokens'):
                v[k] = integer(u.get(k, 0))
            if not self.meta:
                raise MeasurementError('usage before session identity')
            if v['total_tokens'] != v['input_tokens'] + v['output_tokens']:
                raise MeasurementError('total must equal input + output')
            if v['cached_input_tokens'] > v['input_tokens'] or v['reasoning_output_tokens'] > v['output_tokens']:
                raise MeasurementError('cache/reasoning subset violation')
            if self.usage and any(v[k] < self.usage[k] for k in v):
                raise MeasurementError('cumulative usage decreased')
            self.usage = v
            self.responses.add((v['input_tokens'], v['output_tokens']))
        return self.usage


def live_members(proc, known):
    """Inspect group and known descendants, excluding zombies; never signal our group."""
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pgid=,stat='], text=True)
    table = {}
    for line in rows.splitlines():
        pid, parent, group, state = line.split()[:4]
        table[int(pid)] = (int(parent), int(group), state)
    known.add(proc.pid)
    changed = True
    while changed:
        children = {pid for pid, (parent, group, state) in table.items()
                    if parent in known or group == proc.pid}
        changed = not children <= known
        known.update(children)
    return {pid for pid in known if pid in table and 'Z' not in table[pid][2]}


def stop_group(proc, grace):
    # A successful TERM plus no live members is sufficient; an empty/inaccessible
    # stale process group must not receive an unconditional KILL.
    known = {proc.pid}
    alive = live_members(proc, known)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        proc.poll()
        if not alive:
            break
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        # Descendants that left the group still belong to this invocation.
        for pid in alive:
            try:
                if os.getpgid(pid) != proc.pid:
                    os.kill(pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            proc.poll()
            alive = live_members(proc, known)
            if not alive:
                break
            time.sleep(.01)
    proc.poll()
    alive = live_members(proc, known)
    if alive:
        raise PermissionError('live owned processes remain: ' + str(sorted(alive)))
    proc.wait(timeout=max(grace, .1))


def termination_probe(command, evidence, wall=3, term_grace=.15):
    """Zero-model, self-expiring child, with the same executable/sandbox as paid work."""
    evidence = Path(evidence)
    evidence.mkdir(parents=True, exist_ok=False)
    result = dict(passed=False, modelRequests=0, cleanupFailed=False, command=command)
    proc = None
    start = time.monotonic()
    try:
        with (evidence/'stdout.log').open('x') as out, (evidence/'stderr.log').open('x') as err:
            proc = subprocess.Popen(command, stdout=out, stderr=err, stdin=subprocess.DEVNULL, start_new_session=True)
            result['pid'] = proc.pid
            while time.monotonic()-start < wall:
                if 'probe-ready' in (evidence/'stdout.log').read_text():
                    result['ready'] = True
                    break
                if proc.poll() is not None:
                    raise MeasurementError('termination probe exited before readiness')
                time.sleep(.01)
            else:
                raise MeasurementError('termination probe readiness timeout')
            stop_group(proc, term_grace)
            result.update(passed=True, reason='TERM stopped probe and known descendants', returnCode=proc.returncode)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        result.update(reason='termination-probe-blocked: '+str(e), cleanupFailed=isinstance(e, PermissionError))
        if proc and proc.poll() is None and not result['cleanupFailed']:
            try:
                stop_group(proc, term_grace)
            except (OSError, subprocess.SubprocessError) as cleanup:
                result.update(cleanupFailed=True, cleanupError=str(cleanup))
        # On EPERM do not pretend to have stopped it. Probe code has its own deadline.
    result['wallSeconds'] = time.monotonic()-start
    (evidence/'result.json').write_text(json.dumps(result, indent=2)+'\n')
    return result


def supervise(command, *, evidence, sessions, budget, used=0, reserve=0,
              launch_tokens=1, wall=150, startup_grace=45, poll=.05, term_grace=.5, observer=None, probe_command=None):
    start = time.monotonic()
    evidence = Path(evidence)
    evidence.mkdir(parents=True, exist_ok=False)
    report = dict(passed=False, started=False, reason=None, thread=None, session=None,
                  usage=None, responses=0, toolCalls=0, budget=budget, usedTokens=used,
                  reserveTokens=reserve, launchTokens=launch_tokens,
                  warning='observed process cap; in-flight/unflushed usage unknown; not provider hard quota; cannot stop parent Codex')
    proc = reader = None
    events = JsonLines(evidence / 'events.jsonl')
    try:
        for v in (budget, used, reserve, launch_tokens):
            integer(v)
        if not all(math.isfinite(v) and v > 0 for v in (wall, startup_grace, poll, term_grace)):
            raise ValueError('timing limits must be finite and positive')
        if budget == 0 or used + reserve >= budget or used + reserve + launch_tokens > budget:
            report['reason'] = 'pre-spawn-budget-refused'
        else:
            if probe_command is not None:
                report['terminationProbe'] = termination_probe(probe_command, evidence/'termination-probe')
                if not report['terminationProbe']['passed']:
                    raise PermissionError('zero-model termination probe failed')
            with (evidence / 'events.jsonl').open('xb') as out, (evidence / 'stderr.log').open('xb') as err:
                proc = subprocess.Popen(command, stdout=out, stderr=err, stdin=subprocess.DEVNULL,
                                        start_new_session=True)
                report.update(started=True, pid=proc.pid)
                while True:
                    exited = proc.poll() is not None
                    for event in events.rows(final=exited):
                        if event.get('type') == 'thread.started':
                            tid = event.get('thread_id')
                            if not isinstance(tid, str) or not tid or any(c not in '0123456789abcdef-' for c in tid):
                                raise MeasurementError('invalid thread.started identity')
                            if report['thread'] not in (None, tid):
                                raise MeasurementError('thread identity changed')
                            report['thread'] = tid
                    if report['thread'] and reader is None:
                        paths = list(Path(sessions).rglob('*' + report['thread'] + '.jsonl'))
                        if len(paths) > 1:
                            raise MeasurementError('ambiguous session path')
                        if paths:
                            report['session'] = str(paths[0].resolve())
                            reader = SessionReader(paths[0], report['thread'])
                    if reader:
                        report['usage'] = reader.read(final=exited)
                        report['responses'] = len(reader.responses)
                        report['toolCalls'] = reader.tool_calls
                    if observer:
                        observer(report)
                    elapsed = time.monotonic() - start
                    if report['usage'] and used + report['usage']['total_tokens'] + reserve >= budget:
                        report['reason'] = 'observed-token-limit'
                    elif elapsed >= wall:
                        report['reason'] = 'wall-timeout'
                    elif report['usage'] is None and (elapsed >= startup_grace or exited):
                        report['reason'] = 'missing-usage'
                    elif exited:
                        report['reason'] = 'completed' if proc.returncode == 0 else 'child-failed'
                        report['passed'] = proc.returncode == 0
                    if report['reason']:
                        break
                    time.sleep(poll)
    except KeyboardInterrupt:
        report.update(passed=False, reason='supervisor-interrupted')
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        report['reason'] = 'measurement-error: ' + str(e)
    finally:
        if proc:
            # Also remove surviving descendants after an otherwise normal leader exit.
            try:
                stop_group(proc, term_grace)
            except (OSError, subprocess.SubprocessError) as e:
                report.update(passed=False, blocked=True, cleanupFailed=True, reason='cleanup-permission-denied: ' + str(e))
            report['returnCode'] = proc.returncode
            if reader:
                try:
                    report['usage'] = reader.read(final=True)
                    report['responses'] = len(reader.responses)
                    report['toolCalls'] = reader.tool_calls
                    if not report.get('cleanupFailed') and report['usage'] and used + report['usage']['total_tokens'] + reserve >= budget:
                        report.update(passed=False, reason='observed-token-limit')
                except (OSError, ValueError) as e:
                    if not report.get('cleanupFailed'):
                        report.update(passed=False, reason='measurement-error: ' + str(e))
        if report.get('terminationProbe') and not report['terminationProbe']['passed']:
            report.update(blocked=True, cleanupFailed=True, passed=False)
        report['wallSeconds'] = round(time.monotonic() - start, 3)
        (evidence / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def main():
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--evidence', required=True)
    p.add_argument('--sessions', required=True)
    p.add_argument('--budget', type=int, required=True)
    p.add_argument('--used-tokens', type=int, default=0)
    p.add_argument('--reserve-tokens', type=int, default=0)
    p.add_argument('--launch-tokens', type=int, default=1)
    p.add_argument('--wall', type=float, default=150)
    p.add_argument('--startup-grace', type=float, default=45)
    p.add_argument('command', nargs=argparse.REMAINDER)
    a = p.parse_args()
    command = a.command[1:] if a.command[:1] == ['--'] else a.command
    if not command:
        p.error('provide codex exec --json command after --')
    r = supervise(command, evidence=a.evidence, sessions=a.sessions, budget=a.budget,
                  used=a.used_tokens, reserve=a.reserve_tokens, launch_tokens=a.launch_tokens,
                  wall=a.wall, startup_grace=a.startup_grace)
    print(json.dumps(r))
    return 0 if r['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
