"""Isolated contract tests; approval decisions below touch only TemporaryDirectory fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
SCRIPT=ROOT/'modules/stack/scripts/workflow.py'
CREW=ROOT.parent/'nuwax-crew'
sys.path.insert(0,str(CREW))
from crew import approvals

spec=importlib.util.spec_from_file_location('workflow_task_store',SCRIPT.parent/'task_state.py')
state=importlib.util.module_from_spec(spec);spec.loader.exec_module(state)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name);self.repo=self.base/'repo';self.repo.mkdir()
        subprocess.run(['git','init','-q',str(self.repo)],check=True)
        subprocess.run(['git','-C',str(self.repo),'-c','user.name=fixture','-c','user.email=fixture@example.invalid',
                        'commit','-q','--allow-empty','-m','isolated fixture'],check=True)
        self.workspace=self.base/'workspace';self.work=self.workspace/'worktrees/one'
        self.work.parent.mkdir(parents=True)
        subprocess.run(['git','clone','-q',str(self.repo),str(self.work)],check=True)
        self.tasks=self.workspace/'state/tasks';self.runtime=self.workspace/'state/runtime'
        store=state.TaskStore(self.tasks,self.repo)
        self.head=subprocess.check_output(['git','-C',str(self.work),'rev-parse','HEAD'],text=True).strip()
        store.create('t1','真实流程测试',['marker exists'],self.head);store.close()
        self.profile={'workspace':{'root':str(self.workspace),'stateDirectory':str(self.workspace/'state'),
            'taskWorktreesDirectory':str(self.workspace/'worktrees'),'artifactsDirectory':str(self.workspace/'artifacts')},
            'repositories':[{'root':str(self.repo)}],
            'runtimeGuard':{'taskStore':str(self.tasks/'tasks.sqlite'),'stateDirectory':str(self.runtime),
                'humanApprovalRequired':True,'devkitCrewRoot':str(CREW),'crewLedger':str(self.workspace/'state/crew-usage.jsonl'),
                'tools':{'python':{'path':sys.executable},'node':{'path':'node'}}}}
        self.profile_file=self.base/'profile.json';self.profile_file.write_text(json.dumps(self.profile))
        (self.work/'brief.txt').write_text('Only write marker in the isolated fixture. No model, network or real repository changes.')
        self.plan={'taskKey':'t1','attemptId':'a1','mode':'no-model','assignments':[{'executor':'fixture','role':'triage',
             'command':[sys.executable,'-c','from pathlib import Path; Path("marker").write_text("executed")']}]}
        (self.work/'plan.json').write_text(json.dumps(self.plan))
        self.request={'taskKey':'t1','attemptId':'a1','runtime':{'kind':'codex'},'plan':str(self.work/'plan.json'),
            'briefFile':str(self.work/'brief.txt'),'worktree':str(self.work),'deliveryKind':'analysis',
            'approval':{'summary':'isolated task','scope':'TemporaryDirectory only','acceptance':'marker exists'}}

    def command(self,command,data=None,expected=0):
        argv=[sys.executable,'-B',str(SCRIPT),command,'--profile',str(self.profile_file)]
        if data is not None:
            path=self.base/'input.json';path.write_text(json.dumps(data));argv+=['--input',str(path)]
        result=subprocess.run(argv,capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,expected,result.stdout+result.stderr)
        return json.loads(result.stdout)

    def task(self):
        with sqlite3.connect(self.tasks/'tasks.sqlite') as db:
            row=db.execute('SELECT revision,payload FROM tasks WHERE id="t1"').fetchone()
        return {'revision':row[0],**json.loads(row[1])}

    def submit(self):
        return self.command('submit',self.request,expected=3)

    def approve_fixture(self,item):
        self.assertTrue(str(self.runtime).startswith(self.tmp.name))
        approvals.decide(self.runtime/'approvals.sqlite',item['approvalId'],'approved')

    def test_real_cli_closed_loop_requires_approval_and_verified_evidence(self):
        self.assertEqual(self.command('next')['next']['action'],'prepare-approval')
        pending=self.submit();self.assertEqual(pending['status'],'approval-pending')
        self.assertFalse((self.work/'marker').exists())
        self.assertEqual(self.task()['phase'],'waiting')
        self.assertEqual(self.command('run',self.request,expected=3)['status'],'approval-pending')
        revision=self.task()['revision'];self.submit();self.assertEqual(self.task()['revision'],revision)
        self.assertEqual(len(approvals.list_requests(self.runtime/'approvals.sqlite')),1)
        self.approve_fixture(pending)
        self.assertEqual(self.command('next')['next']['action'],'run-approved')
        ran=self.command('run',self.request);self.assertEqual(ran['status'],'verifying')
        self.assertTrue((self.work/'marker').is_file());self.assertIsNone(ran['acceptancePassed'])
        self.assertEqual(self.task()['phase'],'verifying')
        ledger=(self.workspace/'state/crew-usage.jsonl').read_bytes()
        duplicate=self.command('run',self.request);self.assertTrue(duplicate['duplicate'])
        self.assertEqual((self.workspace/'state/crew-usage.jsonl').read_bytes(),ledger)
        self.command('finish',self.request,expected=3)
        artifact=self.tasks/'verification.txt';artifact.write_text('marker exists: passed')
        evidence={'predicate':'marker exists','head':self.head,'command':['test','-f','marker'],
                  'artifact':str(artifact),'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),'passed':True}
        done=self.command('finish',{**self.request,'evidence':[evidence]})
        self.assertEqual(done['status'],'done');self.assertEqual(self.task()['phase'],'done')
        with sqlite3.connect(self.tasks/'tasks.sqlite') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM events WHERE task_id="t1"').fetchone()[0],4)

    def test_changed_plan_rejected_before_worker_and_frozen_task_not_submitted(self):
        pending=self.submit();self.approve_fixture(pending)
        (self.work/'plan.json').write_text(json.dumps(self.plan)+' ')
        denied=self.command('run',self.request,expected=3)
        self.assertIn('approval-input-changed',denied['reason']);self.assertFalse((self.work/'marker').exists())
        with sqlite3.connect(self.tasks/'tasks.sqlite') as db:
            task=self.task();task.pop('revision');task['phase']='needs-decision'
            db.execute('UPDATE tasks SET payload=? WHERE id="t1"',(json.dumps(task),))
        self.request['attemptId']='a2';self.plan['attemptId']='a2'
        (self.work/'plan.json').write_text(json.dumps(self.plan))
        denied=self.command('submit',self.request,expected=3)
        self.assertIn('task-not-ready',denied['reason'])

    def test_rejected_approval_never_executes_and_does_not_hide_other_queued_task(self):
        pending=self.submit();approvals.decide(self.runtime/'approvals.sqlite',pending['approvalId'],'rejected')
        self.assertEqual(self.command('run',self.request,expected=3)['status'],'approval-rejected')
        self.assertFalse((self.work/'marker').exists())
        self.assertEqual(self.command('sync')['changed'][0]['decision'],'rejected')
        self.assertEqual(self.task()['phase'],'blocked')
        revision=self.task()['revision'];self.command('sync');self.assertEqual(self.task()['revision'],revision)
        store=state.TaskStore(self.tasks,self.repo);store.create('t2','another queued task',['test'],self.head);store.close()
        self.assertEqual(self.command('next')['next']['taskKey'],'t2')

    def test_changed_task_scope_requires_reapproval_even_when_plan_bytes_unchanged(self):
        pending=self.submit();self.approve_fixture(pending)
        with sqlite3.connect(self.tasks/'tasks.sqlite') as db:
            task=self.task();task.pop('revision');task['predicates']=['different objective']
            db.execute('UPDATE tasks SET payload=? WHERE id="t1"',(json.dumps(task),))
        result=self.command('run',self.request,expected=3)
        self.assertEqual(result['reason'],'task-definition-changed-reapproval-required')
        self.assertFalse((self.work/'marker').exists())

    def test_existing_task_lease_prevents_dispatch_reservation(self):
        pending=self.submit();self.approve_fixture(pending)
        store=state.TaskStore(self.tasks,self.repo);store.claim('t1','other-real-owner');store.close()
        self.command('run',self.request,expected=3)
        self.assertFalse((self.runtime/'dispatch-index.json').exists())
        self.assertFalse((self.work/'marker').exists())

    def test_process_success_without_pr_cannot_finish_code_delivery(self):
        self.request['deliveryKind']='pull-request';pending=self.submit();self.approve_fixture(pending)
        self.command('run',self.request)
        result=self.command('finish',self.request,expected=3)
        self.assertEqual(result['reason'],'pull-request-delivery-required')
        self.assertEqual(self.task()['phase'],'verifying')

    def test_nonzero_worker_is_blocked_and_never_automatically_retried(self):
        self.plan['assignments'][0]['command']=[sys.executable,'-c','raise SystemExit(2)']
        (self.work/'plan.json').write_text(json.dumps(self.plan));pending=self.submit();self.approve_fixture(pending)
        result=self.command('run',self.request,expected=3);self.assertEqual(result['status'],'failed')
        self.assertEqual(self.task()['phase'],'blocked')
        result=self.command('run',self.request,expected=3);self.assertTrue(result['duplicate'])

    def test_replace_undecided_plan_never_decides_or_executes_either_attempt(self):
        old=self.submit()
        old_request=dict(self.request)
        self.request={**self.request,'attemptId':'a2','supersedesApprovalId':old['approvalId'],
                      'plan':str(self.work/'plan2.json')}
        (self.work/'plan2.json').write_text(json.dumps({**self.plan,'attemptId':'a2'}))
        new=self.submit()
        items={i['id']:i for i in approvals.list_requests(self.runtime/'approvals.sqlite')}
        self.assertEqual(items[old['approvalId']]['status'],'superseded')
        self.assertIsNone(items[old['approvalId']]['decidedAt'])
        self.assertEqual(items[new['approvalId']]['status'],'pending')
        with self.assertRaises(ValueError):approvals.decide(self.runtime/'approvals.sqlite',old['approvalId'],'approved')
        self.assertEqual(self.task()['wake']['id'],new['approvalId'])
        self.assertEqual(self.command('next')['next']['action'],'wait-approval')
        self.assertFalse(self.command('run',old_request)['executeAllowed'])
        self.assertFalse((self.work/'marker').exists())
        self.approve_fixture(new)
        self.assertEqual(self.command('next')['next']['attemptId'],'a2')
        self.command('submit',self.request,expected=3)
        self.assertEqual(self.command('run',self.request)['status'],'verifying')

    def test_cannot_replace_an_approved_or_rejected_plan(self):
        old=self.submit();self.approve_fixture(old)
        self.request={**self.request,'attemptId':'a2','supersedesApprovalId':old['approvalId']}
        result=self.command('submit',self.request,expected=3)
        self.assertIn('only-undecided-current-plan',result['reason'])
        self.assertEqual(len(approvals.list_requests(self.runtime/'approvals.sqlite')),1)


    def test_failure_is_actionable_once_and_never_automatically_restarted(self):
        self.plan['assignments'][0]['command']=[sys.executable,'-c','raise SystemExit(2)']
        (self.work/'plan.json').write_text(json.dumps(self.plan));pending=self.submit();self.approve_fixture(pending)
        self.command('run',self.request,expected=3)
        action=self.command('next')['next'];self.assertEqual(action['action'],'review-failure')
        self.assertFalse(action['automaticRetry'])
        ledger=(self.workspace/'state/crew-usage.jsonl').read_bytes()
        review={**self.request,'summary':'实际命令退出2，未交付','nextAction':'先修复执行条件，准备新审批；不自动重跑'}
        self.command('review',review,expected=3)
        self.assertEqual(self.task()['phase'],'blocked')
        self.assertEqual(self.task()['blocker'],'process-failed')
        revision=self.task()['revision'];self.command('review',review,expected=3)
        self.assertEqual(self.task()['revision'],revision)
        self.assertEqual(self.command('next')['next']['action'],'wait-blocked')
        self.assertEqual((self.workspace/'state/crew-usage.jsonl').read_bytes(),ledger)

    def test_model_code_requires_real_workdir_source_and_runner_before_approval(self):
        self.plan.update(mode='model',budget={'maxTokens':20000,'maxAttempts':1},budgetSpec={'mode':'model'})
        (self.work/'plan.json').write_text(json.dumps(self.plan));self.request['deliveryKind']='pull-request'
        self.assertIn('preflight',self.command('submit',self.request,expected=3)['reason'])
        self.assertEqual(approvals.list_requests(self.runtime/'approvals.sqlite'),[])
        source=self.work/'source.txt';source.write_text('actual source')
        self.request['preflight']={'cwd':str(self.work),'requiredFiles':['source.txt'],'executables':['/missing/vitest']}
        self.assertIn('runner-unavailable',self.command('submit',self.request,expected=3)['reason'])
        self.assertEqual(approvals.list_requests(self.runtime/'approvals.sqlite'),[])
        self.request['preflight']['executables']=[sys.executable]
        pending=self.submit();self.approve_fixture(pending);source.unlink()
        self.command('run',self.request,expected=3)
        self.assertFalse((self.runtime/'dispatch-index.json').exists())

    def test_unchanged_baseline_is_not_a_code_delivery(self):
        code='import json,pathlib;pathlib.Path("{stepArtifacts}/delivery.json").write_text(json.dumps('+repr({'branch':'fixture','commit':self.head})+'))'
        self.plan['assignments'][0]['command']=[sys.executable,'-c',code]
        (self.work/'plan.json').write_text(json.dumps(self.plan));pending=self.submit();self.approve_fixture(pending)
        result=self.command('run',self.request)
        self.assertEqual(result['status'],'verifying');self.assertEqual(result['delivery'],{})


if __name__=='__main__':unittest.main()
