import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('bounded', ROOT / 'bounded-codex.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

# Each test launches the supervisor as one OS process and a telemetry writer as
# another; no mocked Popen or mocked signals. The descendant ignores SIGTERM.
CHILD = '''import json,os,signal,subprocess,sys,time
from pathlib import Path
r=Path(sys.argv[1]); mode=sys.argv[2]; tid="11111111-1111-1111-1111-111111111111"
(r/"started").write_text(str(os.getpid()))
desc=subprocess.Popen([sys.executable,"-c","import signal,time,pathlib,sys; signal.signal(signal.SIGTERM,signal.SIG_IGN); p=pathlib.Path(sys.argv[1]); i=0\\nwhile True: p.write_text(str(i)); i+=1; time.sleep(.01)",str(r/"heartbeat")])
(r/"descendant").write_text(str(desc.pid))
while not (r/"heartbeat").exists():time.sleep(.005)
signal.signal(signal.SIGTERM,signal.SIG_IGN)
print(json.dumps({"type":"thread.started","thread_id":tid}),flush=True)
p=r/("rollout-"+tid+".jsonl")
def write(x):
 with p.open("a") as f:f.write(json.dumps(x)+"\\n");f.flush()
write({"type":"session_meta","payload":{"id":tid}})
if mode=="malformed":
 with p.open("a") as f:f.write("{bad}\\n")
elif mode!="missing":
 u={"input_tokens":10,"output_tokens":5,"total_tokens":15,"cached_input_tokens":3,"reasoning_output_tokens":2}
 if mode=="over":u.update(input_tokens=100,total_tokens=105)
 if mode=="fraction":u.update(input_tokens=1.5,total_tokens=6.5)
 if mode=="negative":u.update(input_tokens=-1,total_tokens=4)
 if mode=="boolean":u.update(input_tokens=True,total_tokens=6)
 if mode=="final-over":u.update(input_tokens=100,total_tokens=105)
 write({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":u}}})
if mode in ("normal","final-over"):sys.exit(0)
time.sleep(30)
'''


class SubprocessTests(unittest.TestCase):
    def run_case(self, mode, extra=()):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            command = [sys.executable, str(ROOT / 'bounded-codex.py'), '--evidence', str(root / 'proof'),
                       '--sessions', t, '--budget', '100', '--startup-grace', '.3', '--wall', '2',
                       *extra, '--', sys.executable, '-c', CHILD, t, mode]
            proc = subprocess.run(command, capture_output=True, text=True, timeout=6)
            result = json.loads((root / 'proof/result.json').read_text())
            if result['started']:
                self.assertTrue((root / 'started').exists())
                self.assertNotEqual(result['pid'], os.getpgrp())
                if mode not in ('normal', 'final-over'):
                    self.assertLess(result['wallSeconds'], 3)
                    self.assertNotEqual(result['returnCode'], 0)
                # The SIGTERM-ignoring grandchild writes every 10ms. Verify it
                # actually stopped, including after a normal leader exit.
                before = (root / 'heartbeat').read_text()
                time.sleep(.1)
                self.assertEqual((root / 'heartbeat').read_text(), before)
            else:
                self.assertFalse((root / 'started').exists())
            self.assertEqual(proc.returncode == 0, result['passed'])
            return result

    def test_pre_spent_and_reserved_refuse_before_spawn(self):
        self.assertEqual(self.run_case('normal', ['--used-tokens', '80', '--reserve-tokens', '20'])['reason'], 'pre-spawn-budget-refused')

    def test_launch_reservation_refuses_before_spawn(self):
        self.assertFalse(self.run_case('normal', ['--launch-tokens', '101'])['started'])

    def test_running_limit_kills_entire_group(self):
        self.assertEqual(self.run_case('over')['reason'], 'observed-token-limit')

    def test_missing_fails_closed(self):
        self.assertEqual(self.run_case('missing')['reason'], 'missing-usage')

    def test_malformed_fails_closed(self):
        self.assertIn('measurement-error', self.run_case('malformed')['reason'])

    def test_invalid_numeric_usage(self):
        for mode in ('fraction', 'negative', 'boolean'):
            with self.subTest(mode=mode):
                self.assertIn('measurement-error', self.run_case(mode)['reason'])

    def test_wall_timeout(self):
        self.assertEqual(self.run_case('wall', ['--wall', '.3'])['reason'], 'wall-timeout')

    def test_final_exit_usage_is_checked(self):
        self.assertEqual(self.run_case('final-over')['reason'], 'observed-token-limit')

    def test_normal_cache_and_reasoning_not_added(self):
        r = self.run_case('normal')
        self.assertTrue(r['passed'])
        self.assertEqual(r['usage']['total_tokens'], 15)
        self.assertEqual(r['responses'], 1)


if __name__ == '__main__':
    unittest.main()
