"""Explicit, fresh source-tooling orchestration. No implicit session discovery."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import signal
import sqlite3
import subprocess
import sys
import time
from bounded import SessionReader, JsonLines, MeasurementError, integer, supervise, stop_group

ZERO = dict(input_tokens=0, output_tokens=0, total_tokens=0, cached_input_tokens=0, reasoning_output_tokens=0)
def require(ok, message):
    if not ok: raise MeasurementError(message)
def load(p): return json.loads(Path(p).read_text())
def save(p, v):
    p = Path(p)
    with p.open('x') as f: json.dump(v, f, ensure_ascii=False, indent=2); f.write('\n')
def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def stamp(s):
    v = dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    require(v.tzinfo is not None, 'timestamp requires timezone')
    return v
def inside(a, b): return a == b or a in b.parents

def host(spec, final=False):
    """Stop at the selected completion; never read subsequent user-turn usage."""
    reader = SessionReader(spec['hostSession'], spec['hostThread'])
    base = start = end = last = None
    active = complete = False
    tools = 0
    after_marker_usage = False
    reply_seen = False
    reply_metered = False
    for row in JsonLines(spec['hostSession']).rows(final=True):
        p = row.get('payload') or {}
        is_user = row.get('type') == 'response_item' and p.get('role') == 'user'
        text = ''.join(c.get('text', '') for c in p.get('content', []) if isinstance(c, dict))
        if is_user:
            if active: break
            if spec['marker'] in text:
                require(base is None, 'ambiguous marker')
                base = last
                start = row.get('timestamp')
                active = True
        if row.get('type') == 'session_meta':
            require(p.get('id') == spec['hostThread'], 'host identity mismatch')
            reader.meta = True
        if row.get('type') == 'event_msg' and p.get('type') == 'token_count':
            info = p.get('info')
            if info is not None:
                # Reuse the exact strict SessionReader normalization/monotonicity checks.
                reader.lines.rows = lambda final=False, row=row: [row]
                last = reader.read(final=True)
                if active:
                    after_marker_usage = True
                    if reply_seen: reply_metered = True
        if active and row.get('type')=='response_item' and p.get('role')=='assistant' and p.get('phase') in ('final','final_answer'):
            reply_seen=True; reply_metered=False
        if active and row.get('type') == 'response_item' and p.get('type') in ('function_call', 'custom_tool_call'):
            tools += 1
        if active and row.get('type') == 'event_msg' and p.get('type') == 'task_complete':
            require(p.get('turn_id') == spec['hostTurn'], 'host completion turn mismatch')
            end = row.get('timestamp'); complete = True; break
    require(not complete or not reply_seen or reply_metered, 'final reply usage unknown')
    require(active and base is not None and last is not None and after_marker_usage, 'host usage unknown')
    usage = {k: integer(last[k] - base[k]) for k in ZERO}
    require(usage['total_tokens'] == usage['input_tokens'] + usage['output_tokens'], 'host delta invalid')
    return dict(usage=usage, start=start, end=end, complete=complete, tools=tools)

class Workflow:
    def __init__(self, args):
        self.a = args; self.s = load(args.spec); self.state = Path(args.state).resolve()
        self.project = Path(self.s['project']).resolve(strict=True)
        self.b = self.s['budget']; self.owned = self.state / 'owned'
        self.env = dict(os.environ, CODEX_HOME=self.s['codexHome'])
        self.env['PATH'] = str(Path(self.s['node']).parent) + os.pathsep + self.env.get('PATH', '')
        self.env.pop('NODE_TEST_CONTEXT', None)
    def safe_paths(self):
        roots=[self.project.resolve(),*[Path(p).resolve() for p in json.loads(self.a.roots)]]
        cli=Path(self.a.cli).resolve()
        if (cli.parents[3]/'packages/cli').is_dir(): roots.append(cli.parents[3])
        for root in roots:
            require(not inside(root,self.state) and not inside(self.state,root),'state must be outside project/devkit')
        for key in ('hostSession','node','python','codex'):
            require(not inside(self.state,Path(self.s[key]).resolve()),'state covers input')
        require(not inside(self.state,Path(self.a.spec).resolve()) or Path(self.a.spec).resolve()==self.state/'spec.json','state covers input spec')
    def preflight(self, fresh=True):
        self.safe_paths()
        s = self.s
        allowed = {'project','node','python','codex','codexHome','sessions','hostSession','hostThread','hostTurn','marker','budget','mode','executorModel','baselineModel','reasoning'}
        require(not set(s) - allowed, 'unknown spec fields')
        require(s.get('mode', 'direct') in ('direct','compare'), 'invalid mode')
        for k in ('project','node','python','codex','codexHome','sessions','hostSession'):
            require(isinstance(s[k], str) and Path(s[k]).is_absolute(), k + ' requires absolute path')
        for k in ('node','python','codex'): require(Path(s[k]).is_file() and os.access(s[k], os.X_OK), k + ' executable missing')
        require(Path(s['sessions']).is_dir() and Path(s['codexHome']).is_dir(), 'explicit telemetry/config roots missing')
        require(Path(s['sessions']).resolve() == (Path(s['codexHome']) / 'sessions').resolve(), 'sessions must match explicit CODEX_HOME/sessions')
        for k in ('hostThread','hostTurn','marker'): require(isinstance(s[k], str) and s[k], 'missing ' + k)
        roots = [self.project, *[Path(p).resolve() for p in json.loads(self.a.roots)]]
        # A source checkout's root is also forbidden, not only its package folders.
        cli = Path(self.a.cli).resolve()
        if (cli.parents[3] / 'packages/cli').is_dir(): roots.append(cli.parents[3])
        for r in roots: require(not inside(r, self.state) and not inside(self.state, r), 'state must be outside project/devkit')
        for p in (self.a.spec, s['hostSession'], s['node'], s['python'], s['codex']):
            require(not inside(self.state, Path(p).resolve()), 'state would cover an input')
        if fresh: require(not self.state.exists() and not Path(self.a.state).is_symlink(), 'fresh state required; evidence exists')
        keys = {'totalTokens','dispatchStopTokens','hostReserveTokens','executorCapTokens','baselineCapTokens','launchReserveTokens','wallSeconds','processWallSeconds','startupGraceSeconds','hostToolRoundtrips'}
        require(set(self.b) == keys, 'budget requires exact explicit fields')
        for k, v in self.b.items():
            if k.endswith('Seconds'): require(type(v) in (int,float) and math.isfinite(v) and v > 0, 'bad timing budget')
            else: integer(v)
        require(0 < self.b['dispatchStopTokens'] <= self.b['totalTokens'] - self.b['hostReserveTokens'], 'invalid dispatch/reserve')
        require(self.b['launchReserveTokens'] > 0 and self.b['executorCapTokens'] > 0 and self.b['baselineCapTokens'] > 0, 'positive process caps required')
        require(self.b['launchReserveTokens'] <= min(self.b['executorCapTokens'],self.b['baselineCapTokens']), 'launch reserve exceeds process cap')
        require(self.b['processWallSeconds'] <= self.b['wallSeconds'], 'process wall exceeds total wall')
        for k in ('executorModel','baselineModel'):
            if s.get('mode') == 'compare': require(isinstance(s.get(k), str) and re.fullmatch(r'[A-Za-z0-9_.-]+', s[k]), 'explicit safe model name required')
        require(s.get('reasoning', 'medium') in ('low','medium','high'), 'invalid reasoning')
        # Fixed recipe/binding and clean source checked before any tested spawn.
        recipe = load(Path(self.a.cli).parents[1] / 'lib/client-tooling-recipe.json')
        require(load(self.project / '.verification/client-tooling.json') == recipe, 'fixed recipe mismatch')
        binding = load(self.project / '.sdlc.json')['verification']
        require(binding['recipe'] == '.verification/client-tooling.json' and binding['runner'] == 'scripts/sdlc-verify.mjs', 'fixed binding mismatch')
        require((self.project / binding['runner']).is_file(), 'runner missing')
        self.gate(launch=True)
    def totals(self, final=False):
        h = host(self.s, final)
        parts = {'host': h['usage'], 'direct': ZERO}
        ids = {self.s['hostThread']}; paths = {str(Path(self.s['hostSession']).resolve())}
        if self.owned.exists():
            for p in sorted(self.owned.glob('*.json')):
                x = load(p); path = str(Path(x['session']).resolve())
                require(x['thread'] not in ids and path not in paths, 'duplicate owned session')
                ids.add(x['thread']); paths.add(path)
                # Filter child telemetry at host completion, including its final reply.
                reader = SessionReader(path, x['thread'])
                rows = JsonLines(path).rows(final=True)
                if h['complete']:
                    require(all(r.get('timestamp') for r in rows),'owned timestamps unknown')
                    rows = [r for r in rows if stamp(r['timestamp']) <= stamp(h['end'])]
                bounded_rows=[]
                for row in rows:
                    bounded_rows.append(row)
                    if row.get('type')=='event_msg' and row.get('payload',{}).get('type')=='task_complete': break
                rows=bounded_rows
                reader.lines.rows = lambda final=False, rows=rows: rows
                u = reader.read(final=True); require(u is not None, 'owned usage unknown')
                parts[p.stem] = u
        end = h['end'] if h['complete'] else dt.datetime.now(dt.timezone.utc).isoformat()
        wall = (stamp(end) - stamp(h['start'])).total_seconds()
        require(wall >= 0, 'negative wall')
        total = sum(u['total_tokens'] for u in parts.values())
        return dict(final=bool(final and h['complete']), status='complete' if h['complete'] else 'pending', observedTotalTokens=total,
                    withinBudget=total <= self.b['totalTokens'] and wall <= self.b['wallSeconds'], parts=parts, wallSeconds=wall,
                    hostComplete=h['end'], hostToolRoundtrips=h['tools'], budget=self.b,
                    limits='Observed input+output only; cache/reasoning subsets counted once. Unflushed/provider usage unknown. Cannot interrupt host; tool roundtrips are phase gates.')
    def gate(self, launch=False):
        t = self.totals()
        reserve = self.b['launchReserveTokens'] if launch else 0
        require(t['observedTotalTokens'] + reserve < self.b['dispatchStopTokens'], 'aggregate dispatch stop')
        require(t['wallSeconds'] < self.b['wallSeconds'], 'aggregate wall stop')
        require(t['hostToolRoundtrips'] <= self.b['hostToolRoundtrips'], 'host tool phase stop')
        return t
    def command(self, arm):
        state = self.state / (arm + '-client-state')
        profile = 'client-workflow'
        cfg = ['-c', 'permissions.'+profile+'.extends=":workspace"', '-c', 'permissions.'+profile+'.workspace_roots={'+json.dumps(str(self.state))+'=true}', '-c', 'permissions.'+profile+'.network.enabled=true']
        return [self.s['codex'],'sandbox',*cfg,'-P',profile,'-C',str(self.project),self.s['node'],self.a.cli,'client-verify','--project',str(self.project),'--state',str(state),'--node',self.s['node'],'--python',self.s['python']]
    def checked(self, arm):
        fs = list((self.state / (arm+'-client-state')).rglob('verification.json'))
        require(len(fs) == 1, 'exactly one fresh manifest required')
        f = fs[0]; m = load(f)
        require(m['passed'] is True and m['level'] == 'source-tooling', 'manifest failed')
        for a in m['artifacts']:
            p = (f.parent / a['path']).resolve(); require(inside(f.parent.resolve(),p) and digest(p) == a['sha256'], 'artifact hash mismatch')
        dbs = list((self.state / (arm+'-client-state')).rglob('tasks.sqlite')); require(len(dbs)==1, 'task db missing')
        with sqlite3.connect(dbs[0].as_uri()+'?mode=ro',uri=True) as db: rows=db.execute('select payload,owner from tasks').fetchall()
        require(len(rows)==1, 'task count mismatch'); task=json.loads(rows[0][0])
        require(task['phase']=='done' and rows[0][1] is None and len(task['evidence'])==4, 'task not done')
        require(all(e['passed'] is True and e['sha256']==digest(f) for e in task['evidence']), 'task evidence mismatch')
        counts={k:0 for k in ('tests','pass','fail','skipped')}
        for n in ('cli','dev','prepare'):
            log=(f.parent/(n+'.log')).read_text()
            for k in counts:
                vals=re.findall(r'^(?:#|ℹ)\s+'+k+r'\s+(\d+)',log,re.M); require(len(vals)==1,'test count missing'); counts[k]+=int(vals[0])
        require(counts=={'tests':22,'pass':22,'fail':0,'skipped':0},'expected 22 passing tests')
        self.gate()
        v=subprocess.run([self.s['python'],'-B',self.a.validator,'--manifest',str(f),'--repo',str(self.project),'--level','source-tooling','--node',self.s['node']],capture_output=True,text=True,timeout=min(20,self.b['processWallSeconds']),env=self.env)
        require(v.returncode==0, 'independent validator failed: '+v.stderr[-200:])
        return dict(passed=True,manifest=str(f),sha256=digest(f),counts=counts,sqlitePhase='done',owner=None,evidenceCount=4,validator=json.loads(v.stdout))
    def direct(self):
        self.gate(launch=True); start=time.monotonic()
        with (self.state/'direct.stdout').open('x') as out,(self.state/'direct.stderr').open('x') as err:
            p=subprocess.Popen(self.command('direct'),stdout=out,stderr=err,env=self.env,start_new_session=True)
            try:
                while p.poll() is None:
                    self.gate()
                    require(time.monotonic()-start < self.b['processWallSeconds'],'direct wall timeout'); time.sleep(.05)
            finally: stop_group(p,.1)
        require(p.returncode==0,'direct failed')
        native=json.loads((self.state/'direct.stdout').read_text().strip().splitlines()[-1]); require(native['passed'] is True and native['reused'] is False,'direct verdict failed')
        checks=self.checked('direct')
        return dict(checks=checks,usage=ZERO,modelRequests=0,doctor=native['doctor'],wallSeconds=time.monotonic()-start)
    def model(self, arm, command):
        self.gate(launch=True)
        prompt='执行一次固定验证命令；只调用一次 shell 工具，不读历史、不改文件、不增加命令或模型。依据实际结果简短回复。命令：\n'+shlex.join(command)
        cap=self.b['executorCapTokens' if arm=='executor' else 'baselineCapTokens']
        def observe(r):
            if r['session'] and r['usage'] is not None:
                p=self.owned/(arm+'.json')
                if not p.exists(): save(p,dict(session=r['session'],thread=r['thread']))
            self.gate()
        cmd=[self.s['codex'],'-a','never','exec','--json','--sandbox','danger-full-access','-m',self.s['executorModel' if arm=='executor' else 'baselineModel'],'-c','model_reasoning_effort='+json.dumps(self.s.get('reasoning','medium')),'-C',str(self.project),prompt]
        old=os.environ.get('CODEX_HOME'); os.environ['CODEX_HOME']=self.s['codexHome']
        try: r=supervise(cmd,evidence=self.state/(arm+'-supervision'),sessions=self.s['sessions'],budget=cap,launch_tokens=self.b['launchReserveTokens'],wall=self.b['processWallSeconds'],startup_grace=self.b['startupGraceSeconds'],observer=observe)
        finally:
            if old is None: os.environ.pop('CODEX_HOME',None)
            else: os.environ['CODEX_HOME']=old
        require(r['passed'],arm+' supervisor failed: '+str(r['reason']))
        events=JsonLines(self.state/(arm+'-supervision/events.jsonl')).rows(final=True)
        commands=[e['item'] for e in events if e.get('type')=='item.completed' and e.get('item',{}).get('type')=='command_execution']
        require(len(commands)==1 and commands[0].get('exit_code')==0,'model must execute exactly one command')
        actual=shlex.split(commands[0]['command'])
        if len(actual)>=3 and Path(actual[0]).name in ('sh','bash','zsh'): actual=shlex.split(actual[-1])
        require(actual==command,'model command mismatch')
        return r
    def pair(self):
        baseline=self.model('baseline',self.command('baseline')); a=self.checked('baseline'); direct=self.direct()
        require(a['validator']['inputDigest']==direct['checks']['validator']['inputDigest'],'source input digest mismatch')
        save(self.state/'pair.json',dict(passed=True,baseline=baseline,baselineChecks=a,direct=direct))
    def run(self):
        self.preflight()
        clean=subprocess.run(['git','status','--porcelain'],cwd=self.project,capture_output=True,text=True,timeout=10)
        require(clean.returncode==0 and not clean.stdout.strip(),'client source must be clean')
        before=subprocess.check_output(['git','rev-parse','HEAD'],cwd=self.project,text=True).strip()
        self.state.mkdir(parents=True); self.owned.mkdir()
        save(self.state/'spec.json',self.s)
        save(self.state/'configuration.json',dict(maxAttempts=1,mode=self.s.get('mode','direct'),command=self.command('direct'),scope='source-tooling only; doctor.ready=false allowed; no builds/GUI/package acceptance',network='network.enabled=true authorizes broad network; not loopback only'))
        if self.s.get('mode','direct')=='compare':
            command=[self.s['python'],'-B',str(Path(__file__).resolve()),'pair','--spec',str(self.state/'spec.json'),'--state',str(self.state),'--cli',self.a.cli,'--validator',self.a.validator,'--roots',self.a.roots]
            self.model('executor',command); result=load(self.state/'pair.json')
        else: result=dict(passed=True,direct=self.direct())
        self.gate()
        require(subprocess.check_output(['git','rev-parse','HEAD'],cwd=self.project,text=True).strip()==before and not subprocess.check_output(['git','status','--porcelain'],cwd=self.project,text=True).strip(),'source changed')
        save(self.state/'run-result.json',result)
        save(self.state/'TOTAL-SNAPSHOT.json',self.totals())
        return dict(passed=True,final=False,state=str(self.state),mode=self.s.get('mode','direct'),modelRequests=0 if self.s.get('mode','direct')=='direct' else 'see owned sessions')
    def seal(self):
        self.safe_paths()
        require(self.state.is_dir() and load(self.state/'spec.json')==self.s,'seal spec/state mismatch')
        target=self.state/'TOTAL-FINAL.json'
        if target.exists(): return load(target)
        try: t=self.totals(final=True)
        except (ValueError,OSError) as e: return dict(final=False,status='unknown',error=str(e))
        if not t['final']: return t
        require((self.state/'run-result.json').exists(),'no successful run to seal')
        t['passed']=load(self.state/'run-result.json').get('passed') is True and t['withinBudget']
        save(target,t); return t

def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['run','seal','pair'])
    for k in ('spec','state','cli','validator','roots'):p.add_argument('--'+k,required=True)
    a=p.parse_args()
    try:
        w=Workflow(a); r=getattr(w,a.action)(); print(json.dumps(r or {'passed':True})); return 0 if r is None or r.get('passed',r.get('final',False)) else 1
    except (ValueError,OSError,KeyError,TypeError,subprocess.SubprocessError) as e:
        print(json.dumps(dict(passed=False,final=False,error=str(e))));return 1
if __name__=='__main__':raise SystemExit(main())
