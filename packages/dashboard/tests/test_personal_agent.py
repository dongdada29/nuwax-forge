import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / 'nuwax-crew'))
from forge_dashboard.adapters import default_adapters
from forge_dashboard.personal_agent import read_snapshot, MAX_BYTES
from forge_dashboard.task_views import render_workbench
from forge_dashboard.workbench import build_workbench, source_health

FIXTURE = Path(__file__).parent / 'fixtures' / 'personal-agent-snapshot.json'


class PersonalAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'pa.json'
        self.data = json.loads(FIXTURE.read_text())

    def load(self):
        self.path.write_text(json.dumps(self.data))
        return default_adapters().read('personal-agent', self.path)

    def project(self):
        result = self.load()
        return build_workbench(result['records'], tasks=result['tasks'])

    def snapshot(self):
        return self.data['instances'][0]['snapshots'][0]

    def test_source_namespace_and_full_task_key_do_not_merge_by_name(self):
        second = copy.deepcopy(self.data['instances'][0])
        second['instanceId'] = 'other-pa'
        self.data['instances'].append(second)
        key = 'x' * 3000 + '/native-task-id'
        for instance in self.data['instances']:
            snapshot = instance['snapshots'][0]
            snapshot['task']['id'] = key
            for collection in ('events', 'runs', 'artifacts', 'verifications'):
                for row in snapshot[collection]: row['taskId'] = key
        tasks = self.project()
        self.assertEqual(len(tasks), 2)
        self.assertEqual(len({t['id'] for t in tasks}), 2)
        self.assertEqual({t['taskKey'] for t in tasks}, {key})
        self.assertEqual({t['source'] for t in tasks}, {'personal-agent:fixture-pa', 'personal-agent:other-pa'})

    def test_completed_pending_accepted_and_returned_remain_separate_facts(self):
        for delivery in ('pending', 'accepted', 'returned'):
            self.snapshot()['task']['deliveryStatus'] = delivery
            task = self.project()[0]
            self.assertEqual(task['sourceStatus'], 'completed')
            self.assertEqual(task['state'], 'review')
            self.assertEqual(task['deliveryStatus'], delivery)
            self.assertIn('来源交付状态：' + delivery, render_workbench([task]))
            self.assertTrue(any(e['status'] == 'delivery:' + delivery for e in task['events']))

    def test_no_run_does_not_fabricate_attempt_from_active_id_or_events(self):
        self.snapshot()['runs'] = []
        self.snapshot()['task']['activeAttemptId'] = 'active-but-no-run'
        task = self.project()[0]
        self.assertEqual(task['attemptCount'], 0)
        self.assertEqual(task['attempts'], [])
        self.assertIn('尚无执行用量', render_workbench([task]))

    def test_native_runs_keep_attempt_ids_unknown_models_tokens_and_relationships(self):
        self.snapshot()['runs'][0]['attemptId'] = None
        self.snapshot()['runs'][0]['model'] = 'uncontracted-model'
        result = self.load()
        record = result['records'][0]
        for key in ('model', 'tokens', 'modelCalls', 'attemptId'):
            self.assertIsNone(record[key])
        self.assertNotIn('taskRef', record)
        self.assertNotIn('prUrl', record)
        self.assertEqual(record['runId'], 'run-1')
        task = build_workbench(result['records'], tasks=result['tasks'])[0]
        self.assertIn('unknown 已知 token', render_workbench([task]))

    def test_event_seq_orders_equal_time_and_evidence_is_visible_escaped(self):
        for event in self.snapshot()['events']: event['createdAt'] = '2026-11-04T01:00:00Z'
        self.snapshot()['artifacts'][0]['content'] = '<script>bad()</script>'
        task = self.project()[0]
        native = [e for e in task['events'] if 'seq' in e]
        self.assertEqual([e['seq'] for e in native], [2, 1])
        page = render_workbench([task])
        self.assertIn('命令（仅显示，不执行）', page)
        self.assertIn('&lt;script&gt;', page)
        self.assertNotIn('<script>', page)
        self.assertIn('pa/fixture', page)

    def test_read_has_no_network_database_or_write_side_effects(self):
        self.path.write_bytes(FIXTURE.read_bytes())
        before = (hashlib.sha256(self.path.read_bytes()).hexdigest(), self.path.stat().st_mtime_ns)
        with patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')), patch.object(sqlite3, 'connect', side_effect=AssertionError('DB forbidden')):
            result = read_snapshot(self.path)
            self.assertEqual(len(result['tasks']), 1)
        self.assertEqual(before, (hashlib.sha256(self.path.read_bytes()).hexdigest(), self.path.stat().st_mtime_ns))
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_invalid_oversized_and_non_regular_files_fail_closed(self):
        for value in ([], {}, {'kind': 'personal-agent-snapshot', 'schemaVersion': True, 'instances': []}):
            self.path.write_text(json.dumps(value))
            with self.assertRaises(ValueError): read_snapshot(self.path)
        self.path.write_text('{bad')
        with self.assertRaises(ValueError): read_snapshot(self.path)
        self.path.write_bytes(b' ' * (MAX_BYTES + 1))
        with self.assertRaises(ValueError): read_snapshot(self.path)
        self.path.unlink()
        os.mkfifo(self.path)
        with self.assertRaises(ValueError): read_snapshot(self.path)

    def test_bad_relations_duplicate_ids_and_status_shapes_are_rejected(self):
        changes = [lambda s: s['runs'][0].update(taskId='other-task'),
                   lambda s: s['task'].update(status=[]),
                   lambda s: s['events'].append(copy.deepcopy(s['events'][0])),
                   lambda s: s['runs'].append(copy.deepcopy(s['runs'][0]))]
        for change in changes:
            self.data = json.loads(FIXTURE.read_text())
            change(self.snapshot())
            with self.assertRaises(ValueError): self.load()

    def test_export_time_not_new_file_mtime_drives_staleness(self):
        result = self.load()
        export = result['exports'][0]
        health = source_health(export['source'], self.path, last_at=export['exportedAt'],
                               now=datetime(2026, 11, 4, 4, tzinfo=timezone.utc))
        self.assertEqual(health['state'], 'stale')
        self.assertEqual(health['ageSeconds'], 3600)

    def test_pa_permission_is_only_an_observation_not_a_forge_approval(self):
        self.snapshot()['approvals'] = [{'id': 'approval-1', 'taskId': 'task/native/full-id',
                                        'attemptId': 'attempt-1', 'runId': 'run-1',
                                        'title': '允许工具操作', 'status': 'pending',
                                        'createdAt': '2026-11-04T02:00:00Z',
                                        'toolCall': {'rawInput': 'not-projected-secret'}}]
        task = self.project()[0]
        self.assertEqual(task['approvals'], [])
        page = render_workbench([task])
        self.assertIn('PA approval:pending', page)
        self.assertNotIn('not-projected-secret', page)
        self.assertNotIn('前往审批页', page)

    def test_python_cli_wiring_and_output_alias_protection(self):
        self.load()
        registry = self.path.parent / 'registry.json'
        registry.write_text('{"executors": []}')
        ledger = self.path.parent / 'ledger.jsonl'
        ledger.write_text('')
        output = self.path.parent / 'dashboard.html'
        env = {**os.environ, 'PYTHONPATH': os.pathsep.join((str(ROOT), str(ROOT.parent / 'nuwax-crew')))}
        argv = [sys.executable, '-B', '-m', 'forge_dashboard', '--registry', str(registry), '--ledger', str(ledger), '--personal-agent-snapshot', str(self.path), '--out']
        result = subprocess.run([*argv, str(output)], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('personal-agent:fixture-pa', output.read_text())
        self.assertIn('导出快照', output.read_text())
        self.assertIn('快照新鲜不证明进程存活', output.read_text())
        original = self.path.read_bytes()
        alias = self.path.parent / 'hardlink.json'
        os.link(self.path, alias)
        for target in (self.path, alias):
            result = subprocess.run([*argv, str(target)], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('不得覆盖输入', result.stderr)
        self.assertEqual(self.path.read_bytes(), original)


if __name__ == '__main__': unittest.main()
