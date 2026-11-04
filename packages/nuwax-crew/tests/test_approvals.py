import importlib.util
import json
import os
import re
import select
import signal
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from crew import approvals

spec = importlib.util.spec_from_file_location('approval_runtime_guard', ROOT.parent / 'nuwax-stack/modules/stack/scripts/runtime_guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ApprovalTests(unittest.TestCase):
    def test_dispatch_waits_and_rechecks_exact_plan_and_brief(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worktree = base / 'worktrees' / 'one'
            worktree.mkdir(parents=True)
            (base / 'artifacts').mkdir()
            state = base / 'runtime'
            plan = worktree / 'plan.json'
            brief = worktree / 'brief.txt'
            marker = worktree / 'started'
            brief.write_text('任务目标和范围')
            plan.write_text(json.dumps({'taskKey':'t1', 'attemptId':'a1', 'mode':'no-model',
                'assignments':[{'executor':'fixture','role':'triage','command':[sys.executable, '-c',
                    'from pathlib import Path; Path("started").write_text("yes")']}]}))
            profile = {'workspace': {'taskWorktreesDirectory': str(base / 'worktrees'), 'artifactsDirectory': str(base / 'artifacts')},
                'runtimeGuard': {'humanApprovalRequired': True, 'devkitCrewRoot':str(ROOT), 'crewLedger':str(base/'ledger.jsonl'),
                                 'tools':{'python':{'path':sys.executable},'node':{'path':'node'}}}}
            request = {'taskKey':'t1','attemptId':'a1','runtime':{'kind':'nuwax-platform'}, 'plan':str(plan),
                       'briefFile':str(brief),'worktree':str(worktree), 'approval':{'summary':'修复问题','scope':'测试仓','acceptance':'测试通过'}}
            first = guard.dispatch(profile, request, state)
            self.assertFalse(first['executeAllowed'])
            self.assertEqual(first['status'], 'approval-pending')
            self.assertFalse(marker.exists())
            store = state / 'approvals.sqlite'
            approvals.decide(store, first['approvalId'], 'approved')
            ready = guard.dispatch(profile, request, state)
            self.assertTrue(ready['executeAllowed'])
            self.assertIn('--approval-id', ready['argv'])
            policy_dir = base / 'runtime'
            (policy_dir / 'approval-policy.json').write_text('{"required":true}')
            bypass = ready['argv'][:-4]
            env = {**os.environ, **ready['env']}
            denied = subprocess.run(bypass, cwd=ready['cwd'], env=env, capture_output=True, text=True)
            self.assertNotEqual(denied.returncode, 0)
            self.assertFalse(marker.exists())
            # A changed file after approval is rejected by the real crew entrypoint.
            original = plan.read_text()
            plan.write_text(original + ' ')
            denied = subprocess.run(ready['argv'], cwd=ready['cwd'], env=env, capture_output=True, text=True)
            self.assertNotEqual(denied.returncode, 0)
            self.assertFalse(marker.exists())
            plan.write_text(original)
            allowed = subprocess.run(ready['argv'], cwd=ready['cwd'], env=env, capture_output=True, text=True)
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            self.assertTrue(marker.exists())
            self.assertFalse(guard.dispatch(profile, request, state)['executeAllowed'])

    def test_dashboard_decision_requires_same_origin_and_csrf(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            store = base/'approvals.sqlite'
            payload = {'taskKey':'t1','attemptId':'a1','summary':'任务','scope':'仓库','acceptance':'通过测试',
                       'worktree':'/tmp/work','planHash':'a'*64,'briefHash':'b'*64,'brief':'目标'}
            item = approvals.submit(store, payload)
            registry = base/'registry.json'
            registry.write_text(json.dumps({'executors':[]}))
            ledger = base/'usage.jsonl'
            ledger.write_text('')
            env = {**os.environ, 'PYTHONPATH':str(ROOT)}
            proc = subprocess.Popen([sys.executable, '-B','-m','crew','dashboard','--ledger',str(ledger),
                        '--registry',str(registry),'--approval-store',str(store),'--serve','--port','0'],
                        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
            try:
                ready, _, _ = select.select([proc.stdout], [], [], 10)
                self.assertTrue(ready)
                url = json.loads(proc.stdout.readline())['url']
                with urllib.request.urlopen(url, timeout=5) as response:
                    html = response.read().decode()
                token = re.search(r'<meta name="forge-csrf" content="([^"]+)">', html).group(1)
                data = json.dumps({'id':item['id'],'decision':'approved'}).encode()
                def post(origin, csrf):
                    req = urllib.request.Request(url+'api/approvals/decision', data=data, method='POST',
                        headers={'Origin':origin,'X-Forge-CSRF':csrf,'Content-Type':'application/json'})
                    return urllib.request.urlopen(req, timeout=5)
                with self.assertRaises(urllib.error.HTTPError) as failure: post('https://evil.example', token)
                failure.exception.close()
                with self.assertRaises(urllib.error.HTTPError) as failure: post(url.rstrip('/'), 'wrong')
                failure.exception.close()
                self.assertEqual(approvals.list_requests(store)[0]['status'], 'pending')
                with post(url.rstrip('/'), token) as response:
                    self.assertEqual(response.status, 200)
                self.assertEqual(approvals.list_requests(store)[0]['status'], 'approved')
                with self.assertRaises(urllib.error.HTTPError) as failure: post(url.rstrip('/'), token)
                failure.exception.close()
            finally:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.communicate(timeout=5)


if __name__ == '__main__': unittest.main()
