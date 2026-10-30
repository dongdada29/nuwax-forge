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
            w.gate=lambda **kw: None
            def fixture(*args,**kwargs):
                r=dict(session=str(w.state/'session.jsonl'),thread='11111111-1111-1111-1111-111111111111',usage=None)
                kwargs['observer'](r);self.assertFalse((w.owned/'baseline.json').exists())
                r['usage']=dict(input_tokens=10,output_tokens=5,total_tokens=15)
                kwargs['observer'](r);self.assertTrue((w.owned/'baseline.json').exists())
                return dict(passed=False,reason='fixture stopped without model')
            with patch('workflow.supervise',side_effect=fixture):
                with self.assertRaisesRegex(MeasurementError,'fixture stopped'):w.model('baseline',[sys.executable,'-c','pass'])
    def test_cleanup_denial_retains_failed_report(self):
        with tempfile.TemporaryDirectory() as t:
            tid='11111111-1111-1111-1111-111111111111'
            root=pathlib.Path(t);session=root/('rollout-'+tid+'.jsonl')
            session.write_text(json.dumps(dict(type='session_meta',payload=dict(id=tid)))+'\n'+json.dumps(dict(type='event_msg',payload=dict(type='token_count',info=dict(total_token_usage=dict(input_tokens=10,output_tokens=5,total_tokens=15)))))+'\n')
            command=[sys.executable,'-c','import json;print(json.dumps('+repr(dict(type='thread.started',thread_id=tid))+'))']
            with patch('bounded.os.killpg',side_effect=PermissionError('fixture permission denial')):
                r=bounded.supervise(command,evidence=root/'evidence',sessions=root,budget=100,wall=2,startup_grace=1)
            self.assertFalse(r['passed']);self.assertIn('cleanup-permission-denied',r['reason'])
            self.assertTrue((root/'evidence/result.json').is_file())
