import json
import importlib.util
import os
import select
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from crew import unified_dashboard as u


class UnifiedDashboardTests(unittest.TestCase):
    def test_deduplicates_attempt_events_and_keeps_zero_and_unknown(self):
        base = {'taskKey': 'task', 'attemptId': 'a', 'executor': 'codex', 'role': 'worker'}
        records = u.crew_records([
            {**base, 'status': 'dispatched', 'details': {'model': 'm'}},
            {**base, 'status': 'completed', 'details': {'chargedTokens': 0}},
            {'taskKey': 'old', 'executor': 'codex', 'status': 'completed'},
        ])
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]['model'], 'm')
        self.assertEqual(records[0]['tokens'], 0)
        self.assertIsNone(records[1]['tokens'])
        groups = u.summarize(records)
        self.assertEqual(sum(x['unknownTokens'] for x in groups), 1)
        self.assertEqual(sum(x['knownCount'] for x in groups), 1)

    def test_legacy_database_is_read_without_migration(self):
        with tempfile.TemporaryDirectory() as td:
            dbfile = Path(td) / 'tasks.sqlite'
            with sqlite3.connect(dbfile) as db:
                db.execute('CREATE TABLE tasks (id TEXT)')
            self.assertIsNone(u.task_store_records(dbfile))
            with sqlite3.connect(dbfile) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE name='assignments'").fetchone()[0], 0)

    def test_multiple_steps_of_same_attempt_stay_distinct(self):
        base = {'taskKey':'task', 'attemptId':'same', 'executor':'codex', 'role':'worker'}
        rows = []
        for step in (1, 2):
            rows.extend([{**base, 'status':'dispatched', 'details':{'stepIndex':step}},
                         {**base, 'status':'completed', 'details':{'stepIndex':step, 'chargedTokens':step}}])
        records = u.crew_records(rows)
        self.assertEqual(len(records), 2)
        self.assertEqual([r['tokens'] for r in records], [1, 2])

    def test_route_edges_only_link_explicit_host_workers(self):
        rows = [
            {'source': 'host-guard', 'taskKey': 't', 'attemptId': 'host-1', 'role': 'router', 'executor': 'codex'},
            {'source': 'host-guard', 'taskKey': 't', 'role': 'worker', 'executor': 'agent-a', 'model': 'm'},
            {'source': 'crew', 'taskKey': 't', 'role': 'review', 'executor': 'agent-b'},
        ]
        edges = u.route_edges(rows)
        self.assertEqual([(x['source'], x['router'], x['worker']) for x in edges],
                         [('crew', '未记录', 'agent-b'), ('host-guard', 'host-1', 'agent-a')])
        self.assertEqual(edges[1]['tasks'], {'t'})

    @unittest.skipUnless(shutil.which('node'), 'Node required')
    def test_forge_dashboard_reads_three_sources_and_protects_inputs(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            module = root / 'node_modules' / '@nuwax-ai' / 'devkit-crew'
            module.parent.mkdir(parents=True)
            module.symlink_to(ROOT, target_is_directory=True)
            (module.parent / 'devkit-contracts').symlink_to(ROOT.parent / 'contracts', target_is_directory=True)
            shutil.copytree(ROOT.parent / 'cli', root / 'cli')
            registry = root / 'registry.json'
            registry.write_text(json.dumps({'executors': [{'name':'codex', 'tier':'S', 'roles':[], 'verified':True, 'dailyCap':10}]}))
            ledger = root / 'ledger.jsonl'
            ledger.write_text(json.dumps({'taskKey':'crew-task', 'attemptId':'a', 'executor':'codex', 'role':'worker', 'status':'completed', 'ts':'2026-11-03T00:00:00+00:00', 'details':{'model':'model-a', 'chargedTokens':0}}) + '\n')
            repo = root / 'repo'
            repo.mkdir()
            state_dir = root / 'stack-state'
            source = ROOT.parent / 'nuwax-stack' / 'modules' / 'stack' / 'scripts' / 'task_state.py'
            spec = importlib.util.spec_from_file_location('dashboard_task_state', source)
            module_spec = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module_spec)
            store = module_spec.TaskStore(state_dir, repo)
            trigger = store.record_trigger({'source':'im','sourceId':'1','classification':'candidate'})
            store.admit({'triggerKey':trigger['triggerKey'], 'taskId':'stack-task', 'objective':'work', 'predicates':['done'], 'head':'abc', 'admission':{'kind':'explicit','actor':'human','evidenceRef':'event'}, 'mandate':{'writePaths':[], 'argvCommands':[]}})
            store.claim('stack-task', 'owner')
            base = {'taskId':'stack-task','attemptId':'b','owner':'owner'}
            store.assignment({**base,'expectedRevision':0,'executor':'nuwax','role':'worker','model':'model-b'}, 'assignment-prepare')
            store.assignment({**base,'expectedRevision':1}, 'assignment-start')
            store.assignment({**base,'expectedRevision':2,'reportSummary':'done','usage':{'tokens':17}}, 'assignment-report')
            store.close()
            dbfile = state_dir / 'tasks.sqlite'
            state = root / 'agent-state'
            state.mkdir()
            (state / 'request.json').write_text(json.dumps({'taskKey':'agent-task','runtime':{'kind':'deepseek-harness','model':'model-c'}}))
            (state / 'manifest.json').write_text(json.dumps({'kind':'client-agent-run-v1','taskKey':'agent-task','status':'failed','modelDispatched':True,'usageKnown':False,'chargedTokens':None}))
            guard = root / 'guard.json'
            guard.write_text(json.dumps({'kind':'codex-budget-guard','schemaVersion':1,'verdict':'unknown','host':{'threadId':'host-thread','ownTokens':{'totalTokens':0}},'workers':[{'threadId':'child','agentPath':'reviewer','tokens':None}]}))
            out = root / 'board.html'
            cli = root / 'cli' / 'bin' / 'nuwax-forge.mjs'
            cmd = ['node', str(cli), 'dashboard', '--ledger', str(ledger), '--registry', str(registry), '--task-store', str(dbfile), '--agent-state', str(state), '--host-budget', str(guard), '--out', str(out)]
            env = {**os.environ, 'NUWAX_DEVKIT_RESOLVE_ROOT':str(root)}
            result = subprocess.run(cmd, capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            html = out.read_text()
            for value in ('crew-task', 'stack-task', 'agent-task', 'model-a', 'model-b', 'model-c', 'host-thread', 'router', 'reviewer', 'unknown', '17'):
                self.assertIn(value, html)
            before = ledger.read_bytes()
            cmd[-1] = str(ledger)
            result = subprocess.run(cmd, capture_output=True, text=True, env=env)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(ledger.read_bytes(), before)
            serve = cmd[:-2] + ['--serve', '--refresh-seconds', '5']
            process = subprocess.Popen(serve, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
            try:
                ready, _, _ = select.select([process.stdout], [], [], 10)
                self.assertTrue(ready, 'dashboard server did not start')
                url = json.loads(process.stdout.readline())['url']
                self.assertIn('127.0.0.1', url)
                with urllib.request.urlopen(url, timeout=5) as response:
                    page = response.read().decode()
                    self.assertIn('crew-task', page)
                    self.assertIn('立即刷新', page)
                    self.assertIn('路由关系', page)
                    self.assertIn('运行总览', page)
                    self.assertIn('data-paginate="tasks"', page)
                    self.assertIn('host-thread', page)
                    self.assertIn('派工台账最后写入', page)
                    self.assertIn("script-src 'self'", response.headers['Content-Security-Policy'])
                with urllib.request.urlopen(url + 'live.js', timeout=5) as response:
                    script = response.read().decode()
                    self.assertIn('setInterval', script)
                    self.assertIn('renderView', script)
                with ledger.open('a') as stream:
                    stream.write(json.dumps({'taskKey':'new-task', 'attemptId':'next', 'executor':'codex', 'role':'worker', 'status':'dispatched'})+'\n')
                with urllib.request.urlopen(url, timeout=5) as response:
                    self.assertIn('new-task', response.read().decode())
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                process.communicate(timeout=5)

if __name__ == '__main__':
    unittest.main()
