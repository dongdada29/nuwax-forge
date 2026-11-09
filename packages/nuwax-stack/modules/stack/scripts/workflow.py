#!/usr/bin/env python3
"""One-shot native-host bridge: backlog -> approval -> bounded Crew run -> verified checkpoint.

No inbox polling, model engine, approval decisions, automatic retry or platform writes.
"""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys

import runtime_guard as guard
from task_state import TaskStore

READY = {'queued', 'pending', 'todo', 'prepared'}


def definition_hash(task):
    return guard.fingerprint({key:task.get(key) for key in ('objective','title','predicates','repo_root','head')})


def rows(profile):
    path = Path(profile['runtimeGuard']['taskStore']).resolve(strict=True)
    if path != (Path(profile['workspace']['stateDirectory'])/'tasks/tasks.sqlite').resolve():
        raise ValueError('workflow-task-store-mismatch')
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True)) as db:
        return {key: {'revision': revision, **json.loads(raw)}
                for key, revision, raw in db.execute('SELECT id,revision,payload FROM tasks')}


def journal_path(profile):
    return guard.state_dir(profile)/'workflow/index.json'


def journal(profile):
    path = journal_path(profile)
    return guard.load(path, 4*1048576) if path.exists() else {}


def save(profile, entries):
    if len(entries) > 1000:
        raise ValueError('workflow-index-limit-explicit-archive-required')
    guard.atomic(journal_path(profile), guard.encoded(entries))


def identity(data):
    for key in ('taskKey', 'attemptId'):
        if not isinstance(data.get(key), str) or not 0 < len(data[key]) <= 128:
            raise ValueError('workflow-'+key+'-required')
    return guard.fingerprint({key: data[key] for key in ('taskKey', 'attemptId')})


def approvals(profile):
    sys.path.insert(0, profile['runtimeGuard']['devkitCrewRoot'])
    from crew import approvals as api
    return api


def approval_rows(profile):
    path = guard.state_dir(profile)/'approvals.sqlite'
    return {item['id']: item for item in approvals(profile).list_requests(path, limit=1000)}


def entry_request(entry):
    path = Path(entry['requestFile']).resolve(strict=True)
    if guard.sha_file(path) != entry['requestHash']:
        raise ValueError('workflow-request-changed')
    return guard.load(path, 16384)


def task_store(profile, task):
    repo = Path(task.get('repo_root', '')).resolve(strict=True)
    allowed = {Path(item['root']).resolve() for item in profile['repositories']}
    if repo not in allowed or not repo.is_dir():
        raise ValueError('task-repository-not-authorized')
    return TaskStore(Path(profile['runtimeGuard']['taskStore']).parent, repo)


def checkpoint(profile, task_key, patch, seconds=120):
    task = rows(profile)[task_key]
    store = task_store(profile, task)
    owner = 'forge-workflow:'+task_key
    try:
        store.claim(task_key, owner, seconds)
        current = store.read(task_key)
        return store.checkpoint(task_key, owner, current['revision'], patch)
    finally:
        with store.db:
            store.db.execute('UPDATE tasks SET owner=NULL,lease_until=NULL WHERE id=? AND owner=?', (task_key,owner))
        store.close()


def next_action(profile):
    tasks, entries, decisions = rows(profile), journal(profile), approval_rows(profile)
    by_task = {}
    for entry in sorted(entries.values(), key=lambda item: item['createdAt']):
        by_task[entry['taskKey']] = entry
    counts = {'queued': 0, 'approvalPending': 0, 'decisionOrBlocked': 0, 'running': 0}
    actions = []
    for task_key, task in tasks.items():
        entry = by_task.get(task_key)
        if entry and entry['status'] not in {'done', 'failed'}:
            item = decisions.get(entry['approvalId'], {})
            status = item.get('status', 'unknown')
            base = {'taskKey': task_key, 'attemptId': entry['attemptId'], 'requestFile': entry['requestFile'],
                    'approvalId': entry['approvalId']}
            if entry['status'] == 'running':
                counts['running'] += 1
                actions.append((0, {'action': 'inspect-running', **base, 'pid': entry.get('pid'), 'automaticRetry': False}))
            elif entry['status'] == 'verifying':
                actions.append((1, {'action': 'verify-delivery', **base, 'receipt': entry.get('receiptFile')}))
            elif status == 'approved':
                actions.append((2, {'action': 'run-approved', **base}))
            elif status == 'pending':
                counts['approvalPending'] += 1
            else:
                counts['decisionOrBlocked'] += 1
            continue
        if task.get('phase') in READY and not entry:
            counts['queued'] += 1
            actions.append((3, {'action': 'prepare-approval', 'taskKey': task_key,
                                'objective': str(task.get('objective') or task.get('title') or '')[:1200],
                                'repoRoot': task.get('repo_root'), 'acceptance': task.get('predicates', []),
                                'createdAt': task.get('created')}))
        elif task.get('phase') not in {'done'}:
            counts['decisionOrBlocked'] += 1
    actions.sort(key=lambda row: (row[0], row[1].get('createdAt') or '', row[1]['taskKey']))
    selected = actions[0][1] if actions else {'action': 'wait-approval' if counts['approvalPending'] else 'no-ready-task'}
    return {'schemaVersion': 1, 'status': 'ready', 'next': selected, 'counts': counts,
            'inspectionIsBusinessProgress': False}


def sync(profile):
    """Reflect real owner decisions once; never make a decision or unfreeze a task."""
    changed=[]
    with guard.locked(journal_path(profile).parent):
        entries=journal(profile);decisions=approval_rows(profile);tasks=rows(profile)
        for entry in entries.values():
            if entry['status']!='waiting':continue
            decision=decisions.get(entry['approvalId'],{}).get('status','unknown')
            if decision==entry.get('observedDecision','pending'):continue
            task=tasks.get(entry['taskKey'],{})
            if task.get('phase')!='waiting' or task.get('wake',{}).get('id')!=entry['approvalId']:
                continue  # A newer explicit task decision wins over this old attempt.
            if decision=='approved':
                patch={'last_action':'本人已在看板批准当前方案','next_action':'workflow run 执行已批准的固定方案'}
            elif decision in {'rejected','unknown'}:
                patch={'phase':'blocked','last_action':'审批被拒绝' if decision=='rejected' else '审批状态未知',
                       'blocker':'approval-'+decision,'next_action':'按本人决定核对范围；重新准备必须重新审批'}
                entry['status']='failed'
            else:continue
            checkpoint(profile,entry['taskKey'],patch)
            entry['observedDecision']=decision;changed.append({'taskKey':entry['taskKey'],'decision':decision})
        if changed:save(profile,entries)
    return {'status':'ready','changed':changed,'decisionsMade':0}


def submit(profile, request):
    if profile['runtimeGuard'].get('humanApprovalRequired') is not True:
        raise ValueError('workflow-requires-human-approval-policy')
    policy=guard.state_dir(profile)/'approval-policy.json'
    if Path(profile['runtimeGuard']['crewLedger']).resolve().parent/'runtime' != guard.state_dir(profile):
        raise ValueError('workflow-ledger-policy-path-mismatch')
    if policy.exists():
        if policy.is_symlink() or guard.load(policy).get('required') is not True:
            raise ValueError('approval-policy-invalid')
    else:guard.atomic(policy,guard.encoded({'required':True}))
    key = identity(request)
    timeout = request.get('timeoutSeconds',180)
    if type(timeout) is not int or not 1 <= timeout <= 3300:
        raise ValueError('workflow-timeout-must-fit-task-lease')
    task = rows(profile)[request['taskKey']]
    if not isinstance(task.get('predicates'),list) or not task['predicates']:
        raise ValueError('task-requires-explicit-acceptance-predicates')
    store = task_store(profile, task)
    store.close()
    request = {**request, 'taskRef': {'source':'stack','taskKey':request['taskKey']},
               'deliveryKind': request.get('deliveryKind', 'pull-request')}
    with guard.locked(journal_path(profile).parent):
        entries = journal(profile)
        previous = entries.get(key)
        replaced_id = request.get('supersedesApprovalId')
        replaced = next((e for e in entries.values() if e['approvalId'] == replaced_id), None) if replaced_id else None
        if replaced_id:
            status = approval_rows(profile).get(replaced_id, {}).get('status')
            if (not replaced or replaced['taskKey'] != request['taskKey'] or replaced['attemptId'] == request['attemptId']
                    or replaced['status'] not in {'waiting', 'superseded'} or status not in {'pending', 'superseded'}
                    or (not previous and task.get('wake', {}).get('id') != replaced_id)):
                raise ValueError('only-undecided-current-plan-can-be-replaced')
        if previous:
            if guard.fingerprint(entry_request(previous)) != guard.fingerprint(request):
                raise ValueError('attempt-input-changed-create-new-approval')
        elif task.get('phase') not in READY and not (replaced and task.get('phase') == 'waiting'):
            raise ValueError('task-not-ready-do-not-unfreeze-decisions')
        if not previous and any(e['taskKey']==request['taskKey'] and e is not replaced and e['status'] not in {'done','failed','superseded'} for e in entries.values()):
            raise ValueError('task-has-unfinished-attempt')
        result = guard.dispatch(profile, request, guard.state_dir(profile), reserve=False)
        if not previous:
            path = journal_path(profile).parent/'requests'/f'{key}.json'
            guard.atomic(path, guard.encoded(request))
            entries[key] = {'taskKey':request['taskKey'], 'attemptId':request['attemptId'], 'status':'waiting',
                            'requestFile':str(path), 'requestHash':guard.sha_file(path),
                            'approvalId':result['approvalId'], 'createdAt':guard.now_utc(),
                            'definitionHash':definition_hash(task),'observedDecision':'pending'}
            save(profile, entries)
        # Reconcile a crash between journal persistence and TaskStore checkpoint without
        # creating another approval or changing the approved plan.
        if task.get('wake',{}).get('id') != result['approvalId']:
            checkpoint(profile, request['taskKey'], {'phase':'waiting',
                'wake':{'kind':'human-approval','id':result['approvalId']},
                'next_action':'等待本人在看板审批；批准后由 workflow run 执行同一方案',
                'last_action':'已提交正式开工审批 '+result['approvalId']})
        if replaced:
            approvals(profile).supersede_pending(guard.state_dir(profile)/'approvals.sqlite', replaced_id, result['approvalId'])
            replaced['status'] = 'superseded'
            replaced['replacementId'] = result['approvalId']
            save(profile, entries)
        return {**result, 'taskKey':request['taskKey'], 'attemptId':request['attemptId'], 'taskRef':request['taskRef']}


def run(profile, data):
    if profile['runtimeGuard'].get('humanApprovalRequired') is not True:
        raise ValueError('workflow-requires-human-approval-policy')
    key = identity(data)
    with guard.locked(journal_path(profile).parent):
        entries = journal(profile)
        entry = entries[key]
        if entry['status'] != 'waiting':
            return {'status':entry['status'], 'duplicate':True, 'executeAllowed':False, 'automaticRetry':False}
        request = entry_request(entry)
        task = rows(profile)[entry['taskKey']]
        if task.get('phase') != 'waiting' or task.get('wake',{}).get('id') != entry['approvalId']:
            raise ValueError('task-state-changed-reconcile-before-execution')
        if definition_hash(task)!=entry['definitionHash']:
            raise ValueError('task-definition-changed-reapproval-required')
        decision=approval_rows(profile).get(entry['approvalId'],{}).get('status','unknown')
        if decision!='approved':
            return {'status':'approval-'+decision,'approvalId':entry['approvalId'],'executeAllowed':False}
        # Reusing a run is not a request to approve changed inputs. Refuse any
        # changed file before dispatch can create a different approval payload.
        approvals(profile).verify(guard.state_dir(profile)/'approvals.sqlite',entry['approvalId'],
            task=entry['taskKey'],attempt=entry['attemptId'],worktree=request['worktree'],
            plan=request['plan'],brief=request['briefFile'])
        timeout = request.get('timeoutSeconds',180)
        if type(timeout) is not int or not 1 <= timeout <= 3300:
            raise ValueError('workflow-timeout-must-fit-task-lease')
        store = task_store(profile,task)
        owner = 'forge-workflow:'+entry['taskKey']
        try:
            store.claim(entry['taskKey'],owner,timeout+90)
            prepared = guard.dispatch(profile, request, guard.state_dir(profile))
            if not prepared.get('executeAllowed'):
                return prepared
            directory = Path(profile['runtimeGuard']['taskStore']).parent/'workflow'/key
            directory.mkdir(parents=True,exist_ok=True,mode=0o700)
            entry.update(status='running',pid=os.getpid(),startedAt=guard.now_utc(),receiptFile=str(directory/'receipt.json'))
            save(profile,entries)
            store.checkpoint(entry['taskKey'],owner,store.read(entry['taskKey'])['revision'],
                {'phase':'implementing','last_action':'本人已批准，启动有限 Crew 执行',
                 'next_action':'执行后核对真实验证结果与 PR 交付'})
            return_code = None
            with (directory/'stdout.json').open('w') as stdout, (directory/'stderr.log').open('w') as stderr:
                os.chmod(stdout.name,0o600);os.chmod(stderr.name,0o600)
                try:
                    process = subprocess.Popen(prepared['argv'],cwd=prepared['cwd'],env={**os.environ,**prepared['env']},
                                               stdout=stdout,stderr=stderr,start_new_session=True)
                    try:
                        return_code = process.wait(timeout=timeout+60)
                    except (subprocess.TimeoutExpired, KeyboardInterrupt):
                        os.killpg(process.pid,signal.SIGTERM)
                        try:process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            os.killpg(process.pid,signal.SIGKILL);process.wait()
                except OSError as error:
                    stderr.write(str(error))
            try:result=guard.load(directory/'stdout.json',4*1048576)
            except (ValueError,OSError):result={}
            process_passed = return_code==0 and result.get('processPassed') is True and result.get('budgetPassed') is True
            delivery = {}
            from crew.delivery import delivery_fields
            for item in result.get('results',[]):delivery.update(delivery_fields(item.get('delivery',{})))
            receipt = {'taskKey':entry['taskKey'],'attemptId':entry['attemptId'],'exitCode':return_code,
                       'processPassed':process_passed,'acceptancePassed':None,'budgetPassed':result.get('budgetPassed'),
                       'budget':result.get('budget'),'delivery':delivery,'crewArtifacts':result.get('artifacts'),
                       'recordedAt':guard.now_utc()}
            guard.atomic(directory/'receipt.json',guard.encoded(receipt))
            guard.record(guard.state_dir(profile),{**receipt,'acceptancePassed':None})
            entry.update(status='verifying' if process_passed else 'failed',completedAt=guard.now_utc(),delivery=delivery)
            save(profile,entries)
            store.checkpoint(entry['taskKey'],owner,store.read(entry['taskKey'])['revision'],
                {'phase':'verifying' if process_passed else 'blocked',
                 'last_action':'执行已结束，产品验收尚未通过' if process_passed else '执行失败或预算未通过，禁止自动重试',
                 'next_action':'核验验收条件与 PR；通过后 workflow finish' if process_passed else '检查执行回执，变更方案后重新审批',
                 'delivery':delivery,'blocker':None if process_passed else 'execution-or-budget-failed'})
            return {'status':entry['status'],'receipt':str(directory/'receipt.json'),**receipt}
        finally:
            with store.db:
                store.db.execute('UPDATE tasks SET owner=NULL,lease_until=NULL WHERE id=? AND owner=?',(entry['taskKey'],owner))
            store.close()


def finish(profile,data):
    key=identity(data)
    with guard.locked(journal_path(profile).parent):
        entries=journal(profile);entry=entries[key]
        if entry['status']=='done':return {'status':'done','duplicate':True}
        if entry['status']!='verifying':raise ValueError('execution-not-ready-for-acceptance')
        request=entry_request(entry);receipt=guard.load(entry['receiptFile'])
        if receipt.get('processPassed') is not True:raise ValueError('process-not-passed')
        if request['deliveryKind']=='pull-request' and not receipt.get('delivery',{}).get('prUrl'):
            raise ValueError('pull-request-delivery-required')
        evidence=data.get('evidence')
        if not isinstance(evidence,list) or not evidence:raise ValueError('real-predicate-evidence-required')
        head=subprocess.check_output(['git','-C',request['worktree'],'rev-parse','HEAD'],text=True).strip()
        # TaskStore checks every predicate, artifact hash, command, HEAD and state boundary.
        task=checkpoint(profile,entry['taskKey'],{'phase':'done','head':head,'evidence':evidence,
                         'last_action':'真实验收条件已验证，交付记录已回写','next_action':'已完成，不重复执行'})
        entry.update(status='done',acceptedAt=guard.now_utc());save(profile,entries)
        return {'status':'done','taskKey':entry['taskKey'],'revision':task['revision'],'delivery':receipt['delivery']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['next','sync','submit','run','finish'])
    parser.add_argument('--profile',required=True);parser.add_argument('--input')
    args=parser.parse_args()
    try:
        profile=guard.load(args.profile)
        data=guard.load(args.input,16384) if args.input else {}
        result=next_action(profile) if args.command=='next' else sync(profile) if args.command=='sync' else {'submit':submit,'run':run,'finish':finish}[args.command](profile,data)
        blob=guard.encoded(result)
        if len(blob)>16384:raise ValueError('workflow-output-limit')
        sys.stdout.buffer.write(blob)
        return 3 if result.get('status','').startswith('approval-') or result.get('status') in {'failed','blocked'} else 0
    except (OSError,ValueError,KeyError,TypeError,sqlite3.Error) as error:
        print(json.dumps({'status':'blocked','reason':str(error)[:240],'automaticRetry':False},ensure_ascii=False));return 3


if __name__=='__main__':sys.exit(main())
