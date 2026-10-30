"""Offline fixtures only; no Codex/model calls."""
import argparse
import json
import tempfile
import unittest
from pathlib import Path
import sys
from workflow import host, Workflow, ZERO, save, MeasurementError
from bounded import SessionReader

def row(t,p,n=1): return dict(type=t,payload=p,timestamp=f'2026-10-30T00:00:{n:02d}+00:00')
def usage(n): return row('event_msg',dict(type='token_count',info=dict(total_token_usage=dict(ZERO,input_tokens=n,total_tokens=n))))
class Cases(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.r=Path(self.tmp.name);self.p=self.r/'host.jsonl'
        self.s=dict(hostSession=str(self.p),hostThread='host',hostTurn='turn',marker='MARK')
        self.rows=[row('session_meta',dict(id='host')),usage(0),row('response_item',dict(role='user',content=[dict(text='MARK')]),2),usage(5)]
    def write(self):self.p.write_text(''.join(json.dumps(x)+'\n' for x in self.rows))
    def completed(self):
        if not any(x.get('payload',{}).get('phase') in ('final','final_answer') for x in self.rows):
            self.rows.extend([row('response_item',dict(type='message',role='assistant',phase='final_answer',content=[dict(type='output_text',text='done')]),3),usage(5)])
        self.rows.append(row('event_msg',dict(type='task_complete',turn_id='turn'),4));self.write()
    def w(self):
        w=object.__new__(Workflow);w.s=self.s;w.state=self.r/'state';w.state.mkdir();w.owned=w.state/'owned';w.owned.mkdir()
        w.b=dict(totalTokens=100,dispatchStopTokens=80,hostReserveTokens=20,hostNextInputTokens=10,hostFinalReplyTokens=10,launchReserveTokens=10,wallSeconds=999999999,hostToolRoundtrips=4)
        return w
    def test_zero_is_known(self):
        self.rows[-1]=usage(0);self.write();self.assertEqual(host(self.s)['usage']['total_tokens'],0)
    def test_missing_unknown(self):
        self.rows.pop();self.write()
        with self.assertRaises(MeasurementError):host(self.s)
    def test_bad_usage(self):
        for v in (True,-1,1.2,None):
            self.rows[-1]=usage(v);self.write()
            with self.assertRaises(MeasurementError):host(self.s)
    def test_next_user_not_counted(self):
        self.completed();self.rows.extend([row('response_item',dict(role='user',content=[dict(text='NEXT')]),5),usage(999)]);self.write()
        self.assertEqual(host(self.s,True)['usage']['total_tokens'],5)
    def test_pending_without_completion(self):
        self.write();self.assertFalse(host(self.s,True)['complete'])
    def test_wrong_completion(self):
        self.rows.append(row('event_msg',dict(type='task_complete',turn_id='other'),4));self.write()
        with self.assertRaises(MeasurementError):host(self.s,True)
    def test_final_reply_metering(self):
        self.rows.append(row('response_item',dict(role='assistant',phase='final',content=[dict(text='done')]),3));self.completed()
        with self.assertRaises(MeasurementError):host(self.s,True)
        self.rows.insert(-1,usage(7));self.write();self.assertEqual(host(self.s,True)['usage']['total_tokens'],7)
    def test_duplicate_owned_session(self):
        self.completed();w=self.w();save(w.owned/'duplicate.json',dict(session=str(self.p),thread='host',capTokens=10))
        with self.assertRaises(MeasurementError):w.totals(True)
    def test_launch_reserve(self):
        self.completed();w=self.w();w.b['launchReserveTokens']=80
        with self.assertRaises(MeasurementError):w.gate(True)
    def test_seal_idempotent_and_pending(self):
        self.write();w=self.w();self.s['budget']=w.b
        a=self.r/'spec.json';save(a,self.s);save(w.state/'spec.json',self.s);w.a=argparse.Namespace(spec=str(a),roots='[]',cli=str(Path(__file__).parents[2]/'bin/nuwax-devkit.mjs'));w.project=self.r/'project';
        for k in ('node','python','codex'):self.s[k]=str(self.r/(k+'-input'))
        save(a.with_name('seal-spec.json'),self.s);(w.state/'spec.json').write_text(json.dumps(self.s));save(w.state/'run-result.json',dict(passed=True))
        self.assertFalse(w.seal()['final']);self.assertFalse((w.state/'TOTAL-FINAL.json').exists())
        self.completed();a=w.seal();self.assertTrue(a['final']);self.rows.append(usage(999));self.write();self.assertEqual(w.seal(),a)
    def test_complete_without_final_is_pending(self):
        self.rows.append(row('event_msg',dict(type='task_complete',turn_id='turn'),4));self.write()
        self.assertFalse(host(self.s,True)['complete'])
    def test_final_answer_requires_later_usage_before_completion(self):
        self.rows.extend([row('response_item',dict(type='message',role='assistant',phase='final_answer',content=[dict(type='output_text',text='done')]),3),row('event_msg',dict(type='task_complete',turn_id='turn'),4),row('response_item',dict(role='user',content=[dict(text='NEXT')]),5),usage(999)])
        self.write()
        with self.assertRaisesRegex(MeasurementError,'final reply usage unknown'):host(self.s,True)
    def test_planned_missing_and_external_caps_no_double_count(self):
        self.write();w=self.w();w.s['mode']='compare';w.b.update(executorCapTokens=10,baselineCapTokens=10)
        c=self.r/'actor.jsonl';w.s['ownedActors']=[dict(name='implementation',session=str(c),thread='impl',capTokens=20)]
        t=w.totals();self.assertEqual(t['reservedActorTokens'],40);self.assertEqual(t['committedTokens'],65)
        c.write_text(json.dumps(row('session_meta',dict(id='impl')))+'\n'+json.dumps(usage(7))+'\n')
        t=w.totals();self.assertEqual(t['reservedActorTokens'],33);self.assertEqual(t['committedTokens'],65)
        w.b['totalTokens']=70
        with self.assertRaisesRegex(MeasurementError,'reserve exhausted'):w.gate(True)
        for cap in (True,-1,'20',None):
            w.s['ownedActors'][0]['capTokens']=cap
            with self.assertRaises(MeasurementError):w.totals()
    def test_external_duplicate_id_or_path(self):
        self.write();w=self.w();c=self.r/'actor.jsonl'
        a=dict(name='one',session=str(c),thread='impl',capTokens=10)
        for b in (dict(a,name='two',session=str(self.r/'other')),dict(a,name='two',thread='other')):
            w.s['ownedActors']=[a,b]
            with self.assertRaisesRegex(MeasurementError,'duplicate'):w.totals()
    def test_tool_dispatch_boundary(self):
        self.write();w=self.w();w.b['hostToolRoundtrips']=0
        with self.assertRaisesRegex(MeasurementError,'dispatch-boundary'):w.gate()
    def test_owned_final_tail_stays_reserved_until_metered(self):
        self.completed();w=self.w();c=self.r/'child.jsonl'
        rows=[row('session_meta',dict(id='child')),usage(2),row('response_item',dict(role='assistant',phase='final_answer'),2),row('event_msg',dict(type='task_complete'),3),usage(99)]
        c.write_text(''.join(json.dumps(x)+'\n' for x in rows));save(w.owned/'child.json',dict(session=str(c),thread='child',capTokens=10))
        t=w.totals(True);self.assertFalse(t['final']);self.assertEqual(t['reservedActorTokens'],8)
        rows.insert(3,usage(3));c.write_text(''.join(json.dumps(x)+'\n' for x in rows))
        t=w.totals(True);self.assertTrue(t['final']);self.assertEqual(t['observedTotalTokens'],8)
    def test_path_aliases_and_missing_parents(self):
        w=self.w();w.project=self.r/'project';w.project.mkdir();alias=self.r/'alias';alias.symlink_to(w.project,target_is_directory=True)
        w.a=argparse.Namespace(roots='[]',cli=str(Path(__file__).parents[2]/'bin/nuwax-devkit.mjs'),spec=str(self.r/'spec.json'))
        for k in ('node','python','codex'):w.s[k]=str(self.r/(k+'-input'))
        for state in (alias/'missing/child',w.project/'missing',Path(__file__).parents[2]/'missing/child',self.r):
            w.state=state.resolve()
            with self.subTest(state=str(state)),self.assertRaises(MeasurementError):w.safe_paths()
        w.state=self.r/'external/missing/child';w.safe_paths();self.assertFalse(w.state.exists())
    def test_child_time_cutoff_and_next_turn(self):
        self.completed();w=self.w();c=self.r/'child.jsonl'
        rows=[row('session_meta',dict(id='child')),usage(2),row('event_msg',dict(type='task_complete'),3),usage(999)]
        c.write_text(''.join(json.dumps(x)+'\n' for x in rows));save(w.owned/'child.json',dict(session=str(c),thread='child',capTokens=10))
        self.assertEqual(w.totals(True)['observedTotalTokens'],7)

if __name__=='__main__':
    # Run the exact existing real subprocess tests against the shared reader/supervisor.
    root=Path(__file__).resolve().parents[4]
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(Cases)
    import test_startup_review
    suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(test_startup_review))
    old=root/'scripts/test_bounded_codex.py'
    if old.exists():
        import importlib.util
        spec=importlib.util.spec_from_file_location('supervisor_tests',old);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(m))
    result=unittest.TextTestRunner(verbosity=1).run(suite);sys.exit(not result.wasSuccessful())
