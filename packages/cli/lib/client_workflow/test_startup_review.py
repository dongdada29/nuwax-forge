import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
from workflow import Workflow, MeasurementError
import bounded

class StartupReview(unittest.TestCase):
    def test_pending_snapshot_not_registered_as_known(self):
        with tempfile.TemporaryDirectory() as t:
            w=Workflow.__new__(Workflow); w.state=w.project=pathlib.Path(t)
            w.owned=w.state/'owned';w.owned.mkdir()
            w.s=dict(codexHome=t,codex=sys.executable,executorModel='fixture',baselineModel='fixture',sessions=t)
            w.b=dict(executorCapTokens=100,baselineCapTokens=100,launchReserveTokens=10,processWallSeconds=1,startupGraceSeconds=1)
            w.gate=lambda **kw: None;w.probe_command=lambda: [sys.executable,'-c','pass']
            def fixture(*args,**kwargs):
                r=dict(session=str(w.state/'session.jsonl'),thread='11111111-1111-1111-1111-111111111111',usage=None)
                kwargs['observer'](r);self.assertTrue((w.owned/'baseline.json').exists())
                r['usage']=dict(input_tokens=10,output_tokens=5,total_tokens=15)
                kwargs['observer'](r);self.assertTrue((w.owned/'baseline.json').exists())
                return dict(passed=False,reason='fixture stopped without model')
            with patch('workflow.supervise',side_effect=fixture):
                with self.assertRaisesRegex(MeasurementError,'fixture stopped'):w.model('baseline',[sys.executable,'-c','pass'])
    def test_probe_eperm_blocks_real_paid_process_and_persists(self):
        with tempfile.TemporaryDirectory() as t:
            root=pathlib.Path(t); paid=root/'paid-started'
            probe=[sys.executable,'-u','-c',"import time;print('probe-ready',flush=True);time.sleep(.3)"]
            command=[sys.executable,'-c',"from pathlib import Path;Path("+repr(str(paid))+").touch()"]
            with patch('bounded.os.killpg',side_effect=PermissionError('injected EPERM')):
                r=bounded.supervise(command,evidence=root/'evidence',sessions=root,budget=100,wall=2,startup_grace=1,probe_command=probe)
            self.assertFalse(r['started']);self.assertFalse(paid.exists());self.assertTrue(r['cleanupFailed'])
            self.assertTrue(json.loads((root/'evidence/result.json').read_text())['blocked'])
            self.assertTrue(json.loads((root/'evidence/termination-probe/result.json').read_text())['cleanupFailed'])
            import time;time.sleep(.35)
    def test_term_success_does_not_send_kill_to_empty_group(self):
        import subprocess,os,signal,time
        proc=subprocess.Popen([sys.executable,'-u','-c',"import time;print('ready',flush=True);time.sleep(2)"],stdout=subprocess.PIPE,start_new_session=True)
        proc.stdout.readline();real=os.killpg;calls=[]
        def send(pid,sig):calls.append(sig);return real(pid,sig)
        with patch('bounded.os.killpg',side_effect=send):bounded.stop_group(proc,.2)
        self.assertEqual(calls,[signal.SIGTERM]);proc.stdout.close()
