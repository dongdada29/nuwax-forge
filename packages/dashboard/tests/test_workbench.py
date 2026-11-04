import json
import os
import select
import signal
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from argparse import Namespace
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / 'nuwax-crew'))
from forge_dashboard import sources
from forge_dashboard.cli import dispatch_dashboard, embed_origin
from forge_dashboard.task_views import render_workbench
from forge_dashboard.workbench import build_workbench, source_health, timestamp


class TaskProjectionTests(unittest.TestCase):
    def test_explicit_task_identity_groups_attempts_but_never_guesses_across_sources(self):
        records = [
            {'source': 'crew', 'taskKey': 'NW-1', 'attemptId': 'a', 'status': 'failed', 'at': '2026-11-04T00:00:00Z'},
            {'source': 'crew', 'taskKey': 'NW-1', 'attemptId': 'b', 'status': 'completed', 'at': '2026-11-04T01:00:00Z'},
            {'source': 'stack', 'taskKey': 'NW-1', 'attemptId': 'c', 'status': 'running'},
            {'source': 'fixture', 'taskKey': 'plugin-native-id', 'attemptId': 'd', 'status': 'reported',
             'taskRef': {'source': 'crew', 'taskKey': 'NW-1'}},
        ]
        tasks = build_workbench(records)
        self.assertEqual(len(tasks), 2)
        crew = next(t for t in tasks if t['source'] == 'crew')
        self.assertEqual(crew['attemptCount'], 3)
        self.assertEqual(crew['state'], 'review')
        self.assertEqual(crew['sources'], ['crew', 'fixture'])
        self.assertEqual(len(crew['events']), 3)
        self.assertEqual(crew['lastAt'], '2026-11-04T01:00:00Z')

    def test_legacy_and_missing_task_ids_do_not_become_fake_attempts(self):
        records = sources.crew_records([
            {'taskKey': 'legacy', 'executor': 'codex', 'status': 'dispatched'},
            {'taskKey': 'legacy', 'executor': 'codex', 'status': 'completed'},
            {'executor': 'codex', 'status': 'completed'},
            {'executor': 'codex', 'status': 'completed'},
        ])
        tasks = build_workbench(records)
        self.assertEqual(len(tasks), 3)
        legacy = next(t for t in tasks if t['taskKey'] == 'legacy')
        self.assertEqual(legacy['attemptCount'], 0)
        self.assertEqual(legacy['legacyCount'], 2)
        self.assertEqual(legacy['runningUnverified'], 1)

    def test_long_and_synthetic_ids_never_collide_with_real_identity(self):
        records = [{'source': 'crew', 'taskKey': 'x' * 2048 + suffix, 'status': 'completed'} for suffix in ('a', 'b')]
        records += [{'source': 'crew'}, {'source': 'crew', 'taskKey': '未关联记录 3'}]
        tasks = build_workbench(records)
        self.assertEqual(len(tasks), 4)
        self.assertEqual(len({t['id'] for t in tasks}), 4)

    def test_approval_keeps_full_task_identity_with_a_matching_short_prefix(self):
        prefix = 'x' * 2048
        longer = prefix + 'suffix'
        records = [{'source': 'crew', 'taskKey': key, 'status': 'completed'} for key in (prefix, longer)]
        approval = {'taskKey': longer, 'attemptId': 'next', 'status': 'pending'}
        tasks = {t['taskKey']: t for t in build_workbench(records, approvals=[approval])}
        self.assertEqual(len(tasks), 2)
        self.assertEqual(tasks[prefix]['approvals'], [])
        self.assertEqual(tasks[prefix]['state'], 'review')
        self.assertEqual(tasks[longer]['approvals'], [approval])
        self.assertEqual(tasks[longer]['state'], 'approval')

    def test_filter_identity_values_keep_full_source_and_executor(self):
        source = 'source-' + 's' * 2048
        executor = 'executor-' + 'e' * 2048
        task = build_workbench([{'source': source, 'taskKey': 't', 'executor': executor, 'status': 'completed'}])[0]
        self.assertEqual(task['sources'], [source])
        self.assertEqual(task['executors'], [executor])

    def test_verified_source_and_later_failed_attempt_are_both_visible_without_rewriting_source(self):
        metadata = {'source': 'stack', 'taskKey': 't', 'status': 'done',
                    'events': [{'source': 'stack', 'status': 'done', 'at': '2026-11-04T01:00:00Z'}]}
        record = {'source': 'stack', 'taskKey': 't', 'attemptId': 'a', 'status': 'failed', 'at': '2026-11-04T02:00:00Z'}
        task = build_workbench([record], tasks=[metadata])[0]
        self.assertEqual(task['status'], 'done')
        self.assertEqual(task['state'], 'done')
        self.assertEqual(task['sourceStatus'], 'done')
        self.assertEqual(task['sourceStatusAt'], '2026-11-04T01:00:00Z')
        self.assertEqual(task['latestAttempt']['status'], 'failed')
        self.assertEqual(task['lastAt'], '2026-11-04T02:00:00Z')
        self.assertTrue(task['statusNote'])
        page = render_workbench([task])
        self.assertIn('任务来源状态：done', page)
        self.assertIn('最近尝试记录：failed', page)
        self.assertIn('需核对', page)

    def test_unknown_attempt_time_does_not_override_source_or_claim_a_later_failure(self):
        metadata = {'source': 'stack', 'taskKey': 't', 'status': 'done'}
        task = build_workbench([{'source': 'stack', 'taskKey': 't', 'status': 'failed'}], tasks=[metadata])[0]
        self.assertEqual(task['state'], 'done')
        self.assertEqual(task['sourceStatus'], 'done')
        self.assertIsNone(task['sourceStatusAt'])
        self.assertEqual(task['latestAttempt']['status'], 'failed')
        self.assertIn('时间不完整', task['statusNote'])
        self.assertNotIn('之后', task['statusNote'])

    def test_historical_failure_before_verified_source_is_not_reported_as_a_new_conflict(self):
        metadata = {'source': 'stack', 'taskKey': 't', 'status': 'done', 'updatedAt': '2026-11-04T02:00:00Z'}
        task = build_workbench([{'source': 'stack', 'taskKey': 't', 'status': 'failed', 'at': '2026-11-04T01:00:00Z'}], tasks=[metadata])[0]
        self.assertEqual(task['state'], 'done')
        self.assertEqual(task['latestAttempt']['status'], 'failed')
        self.assertEqual(task['statusNote'], '')

    def test_equal_snapshot_and_attempt_times_keep_source_status_and_require_order_review(self):
        at = '2026-11-04T02:00:00Z'
        task = build_workbench([{'source': 'stack', 'taskKey': 't', 'status': 'failed', 'at': at}],
                               tasks=[{'source': 'stack', 'taskKey': 't', 'status': 'done', 'updatedAt': at}])[0]
        self.assertEqual(task['state'], 'done')
        self.assertIn('时间戳相同', task['statusNote'])
        self.assertNotIn('晚于', task['statusNote'])

    def test_crew_event_history_preserves_reason_delivery_and_unknown_usage(self):
        base = {'taskKey': 'task', 'attemptId': 'a', 'executor': 'dsh', 'role': 'worker'}
        records = sources.crew_records([
            {**base, 'status': 'dispatched', 'ts': '2026-11-04T00:00:00Z', 'details': {'stepIndex': 1}},
            {**base, 'status': 'blocked', 'ts': '2026-11-04T00:01:00Z',
             'details': {'stepIndex': 1, 'reason': 'budget-unknown', 'commit': 'abc1234', 'credential': 'must-not-leak'}},
        ])
        task = build_workbench(records)[0]
        self.assertEqual(task['state'], 'blocked')
        self.assertEqual(task['attemptCount'], 1)
        self.assertEqual(len(task['events']), 2)
        self.assertEqual(task['events'][0]['summary'], 'budget-unknown')
        self.assertNotIn('must-not-leak', json.dumps(task))
        self.assertIsNone(records[0]['tokens'])

    def test_completion_is_review_and_pending_approval_remains_visible(self):
        task = build_workbench([{'source': 'crew', 'taskKey': 't', 'attemptId': 'a', 'status': 'completed'}])[0]
        self.assertEqual(task['state'], 'review')
        approval = {'taskKey': 't', 'attemptId': 'b', 'summary': '第二次方案', 'status': 'pending', 'acceptance': '运行验证'}
        task = build_workbench(task['attempts'], approvals=[approval])[0]
        self.assertEqual(task['state'], 'approval')
        self.assertEqual(task['acceptance'], ['运行验证'])
        self.assertEqual(len(task['approvals']), 1)
        self.assertEqual(build_workbench([], matrix=[{'key': 'partial', 'status': 'verified-live-partial'}])[0]['state'], 'review')

    def test_stack_queued_tasks_visible_before_assignments_and_store_stays_read_only(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'tasks.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE tasks (id TEXT PRIMARY KEY,payload TEXT)')
                db.execute('INSERT INTO tasks VALUES(?,?)', ('new', json.dumps({'objective': '尚未派工', 'phase': 'queued', 'predicates': ['验证']})))
            db.close()
            before = path.read_bytes()
            tasks = build_workbench([], tasks=sources.task_store_tasks(path))
            self.assertEqual(tasks[0]['title'], '尚未派工')
            self.assertEqual(tasks[0]['state'], 'pending')
            self.assertEqual(tasks[0]['attemptCount'], 0)
            self.assertIsNone(sources.task_store_records(path))
            self.assertEqual(path.read_bytes(), before)

    def test_native_stack_active_phases_remain_in_running_filter_with_or_without_assignments(self):
        phases = ('analyzing', 'implementing', 'verifying')
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'tasks.sqlite'
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE tasks (id TEXT PRIMARY KEY,payload TEXT)')
                for phase in (*phases, 'waiting', 'blocked', 'done'):
                    db.execute('INSERT INTO tasks VALUES(?,?)', (phase, json.dumps({'objective': phase, 'phase': phase})))
            db.close()
            metadata = sources.task_store_tasks(path)
        for with_assignments in (False, True):
            with self.subTest(with_assignments=with_assignments):
                records = [{'source': 'stack', 'taskKey': phase, 'attemptId': phase + '-a', 'status': 'reported'} for phase in phases] if with_assignments else []
                tasks = build_workbench(records, tasks=metadata)
                by_key = {task['taskKey']: task for task in tasks}
                for phase in phases:
                    self.assertEqual(by_key[phase]['state'], 'running', phase)
                    self.assertEqual(by_key[phase]['sourceStatus'], phase)
                    self.assertEqual(by_key[phase]['status'], phase)
                self.assertEqual(sum(task['state'] == 'running' for task in tasks), 3)
                self.assertEqual(render_workbench(tasks).count('data-state="running"'), 3)
                self.assertEqual(by_key['waiting']['state'], 'other')
                self.assertEqual(by_key['blocked']['state'], 'blocked')
                self.assertEqual(by_key['done']['state'], 'done')

    def test_static_html_details_escape_untrusted_text_and_unsafe_links(self):
        tasks = build_workbench([{'source': 'crew', 'taskKey': '<script>', 'attemptId': 'a',
                                 'status': 'completed', 'branch': '<img onerror=evil>', 'prUrl': 'javascript:evil()'}])
        page = render_workbench(tasks)
        self.assertIn('&lt;script&gt;', page)
        self.assertIn('&lt;img onerror=evil&gt;', page)
        self.assertNotIn('javascript:evil()', page)
        self.assertNotIn('<script>', page)
        self.assertIn('<details id="task-', page)

    def test_source_freshness_keeps_missing_unconfigured_and_quiet_snapshots_distinct(self):
        now = datetime(2026, 11, 4, 2, tzinfo=timezone.utc)
        self.assertEqual(source_health('matrix', None)['state'], 'unconfigured')
        self.assertEqual(source_health('matrix', '/path/not-present/fixture')['state'], 'missing')
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'source.json'
            path.write_text('{}')
            stale = source_health('ledger', path, now=now, last_at='2026-11-04T01:00:00Z')
            self.assertEqual(stale['state'], 'stale')
            self.assertEqual(stale['ageSeconds'], 3600)
            self.assertEqual(source_health('registry', path, now=now, snapshot=True)['label'], '配置快照')
        self.assertIsNone(timestamp('2026-11-04T02:00:00'))

    def test_embed_origin_accepts_only_one_exact_origin(self):
        for good in ['http://127.0.0.1:3000', 'https://dsh.example.test', 'http://[::1]:8080']:
            self.assertEqual(embed_origin(good), good)
        for bad in ['*', 'null', 'file://local', 'https://host/path', 'https://host/', 'https://user:pass@host',
                    "http://localhost:3000 'unsafe-inline'", 'https://*.example.test', 'http://host:bad', 'http://host\r\nX: bad']:
            with self.assertRaises(ValueError, msg=bad): embed_origin(bad)
        with self.assertRaisesRegex(ValueError, '只支持 --serve'):
            dispatch_dashboard(Namespace(serve=False, out='unused.html', embed_origin='http://localhost:3000'))

    def test_service_deep_link_and_dsh_ancestor_are_opt_in(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            registry = root / 'registry.json'
            registry.write_text(json.dumps({'executors': []}))
            ledger = root / 'ledger.jsonl'
            ledger.write_text(json.dumps({'taskKey': 'linked-task', 'attemptId': 'a', 'status': 'completed'}) + '\n')
            env = {**os.environ, 'PYTHONPATH': os.pathsep.join((str(ROOT), str(ROOT.parent / 'nuwax-crew')))}
            for origin in (None, 'http://127.0.0.1:33000'):
                argv = [sys.executable, '-B', '-m', 'forge_dashboard', '--ledger', str(ledger), '--registry', str(registry), '--serve']
                if origin: argv += ['--embed-origin', origin]
                process = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
                try:
                    ready, _, _ = select.select([process.stdout], [], [], 5)
                    self.assertTrue(ready, 'server failed to start')
                    line = process.stdout.readline()
                    self.assertTrue(line, process.stderr.read() if process.poll() is not None else 'no URL')
                    url = json.loads(line)['url']
                    with urllib.request.urlopen(url + '?q=linked&view=tasks', timeout=5) as response:
                        self.assertIn('linked-task', response.read().decode())
                        self.assertIn('frame-ancestors ' + (origin or "'none'"), response.headers['Content-Security-Policy'])
                        self.assertIsNone(response.headers.get('Access-Control-Allow-Origin'))
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(url + 'api/snapshot', timeout=5)
                    error.exception.close()
                finally:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
