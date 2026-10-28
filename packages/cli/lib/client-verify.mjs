// 固定配方的新鲜运行与有界交接。verify 仍负责解释器、仓外状态、验证及导入门。
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, readFileSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateProjectBinding } from './recipe.mjs';
import { allDevkitRoots } from './resolve.mjs';
import { realpathNearestExisting, resolveStateReal, isInside } from './paths.mjs';
import { checkNode, checkPython } from './env.mjs';

const fixedRecipe = JSON.parse(readFileSync(new URL('./client-tooling-recipe.json', import.meta.url), 'utf8'));
const bin = fileURLToPath(new URL('../bin/nuwax-devkit.mjs', import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');

export async function runClientVerify({ project, state, node, python }) {
  const start = performance.now();
  let runDir = null;
  try {
    if (!project || !state) throw new Error('client-verify 需要 --project 和 --state');
    const root = realpathSync(resolve(project));
    // 避免在任何 mkdir 前写入项目、devkit 或其父目录。
    const base = resolve(state);
    const stateReal = resolveStateReal(base);
    const fullReal = realpathNearestExisting(base).real;
    if (isInside(root, stateReal) || isInside(root, fullReal)) throw new Error('--state 必须在项目仓外');
    for (const p of allDevkitRoots()) {
      const r = realpathNearestExisting(p).real;
      if ([stateReal, fullReal].some(s => isInside(r, s) || isInside(s, r))) throw new Error('--state 不得写入或覆盖 devkit');
    }
    const { problems, binding } = validateProjectBinding(root);
    if (problems) throw new Error('配方预检失败: ' + problems.join('; '));
    if (binding.recipe !== '.verification/client-tooling.json' || binding.runner !== 'scripts/sdlc-verify.mjs' ||
        !isDeepStrictEqual(JSON.parse(readFileSync(join(root, binding.recipe), 'utf8')), fixedRecipe)) {
      throw new Error('client 固定配方或绑定不匹配');
    }
    const nc = checkNode(node), pc = checkPython(python);
    if (nc.problems.length || pc.problems.length) throw new Error([...nc.problems, ...pc.problems].join('; '));
    const taskKey = 'client-tooling-' + randomUUID();
    runDir = join(fullReal, taskKey);
    mkdirSync(runDir, { recursive: true });
    const stdoutPath = join(runDir, 'verify.stdout.log'), stderrPath = join(runDir, 'verify.stderr.log');
    const out = createWriteStream(stdoutPath, { flags: 'wx' }), err = createWriteStream(stderrPath, { flags: 'wx' });
    const args = [bin, 'verify', '--project', root, '--state', runDir, '--task-key', taskKey, '--node', nc.bin, '--python', pc.resolvedBin];
    const code = await new Promise((resolveCode, reject) => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT; // 避免调用方 node:test 环境改变下游测试报告格式
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      child.stdout.pipe(out); child.stderr.pipe(err);
      child.on('error', reject);
      child.on('close', code => Promise.all([new Promise(r => out.end(r)), new Promise(r => err.end(r))]).then(() => resolveCode(code)));
    });
    const lines = readFileSync(stdoutPath, 'utf8').trim().split('\n');
    let verdict; try { verdict = JSON.parse(lines.at(-1)); } catch { throw new Error('verify 未返回可解析结论'); }
    if (code !== 0 || verdict.passed !== true || verdict.reused !== false || verdict.taskKey !== taskKey) throw new Error('verify 未通过或未执行新鲜验证');
    const manifestPath = realpathSync(verdict.manifest);
    if (!isInside(join(runDir, 'artifacts'), manifestPath)) throw new Error('manifest 不在本次工件目录');
    const manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes);
    if (!manifest.passed || manifest.recipe !== fixedRecipe.id || manifest.level !== fixedRecipe.level || manifest.source.root !== root) throw new Error('manifest 结论不匹配');
    for (const artifact of manifest.artifacts) {
      const f = join(dirname(manifestPath), artifact.path);
      if (lstatSync(f).isSymbolicLink() || !isInside(dirname(manifestPath), realpathSync(f)) || hash(readFileSync(f)) !== artifact.sha256) throw new Error('日志指纹不匹配');
    }
    const doctor = JSON.parse(readFileSync(join(dirname(manifestPath), 'doctor-schema.log'), 'utf8'));
    if (typeof doctor.ready !== 'boolean' || !Array.isArray(doctor.issues)) throw new Error('doctor 结构不匹配');
    let tests = 0, passed = 0, failed = 0, skipped = 0;
    for (const stage of ['cli', 'dev', 'prepare']) {
      const log = readFileSync(join(dirname(manifestPath), stage + '.log'), 'utf8');
      const count = name => { const m = log.match(new RegExp('(?:^|\\n)[ℹ#]\\s*' + name + '\\s+(\\d+)(?:\\r?\\n|$)')); if (!m) throw new Error(stage + ' 测试计数缺失: ' + name); return Number(m[1]); };
      tests += count('tests'); passed += count('pass'); failed += count('fail'); skipped += count('skipped');
    }
    if (!tests || passed !== tests || failed || skipped) throw new Error('测试计数不完整或未全部通过');
    // 用只读 SQLite 复核桥接已导入的任务及证据，绝不建立或修改任务。
    const py = `import json,sqlite3,sys,pathlib\nd=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True)\nr=d.execute('select payload,owner from tasks where id=?',(sys.argv[2],)).fetchone()\nif not r: raise ValueError('missing task')\np=json.loads(r[0]); print(json.dumps({'phase':p.get('phase'),'evidence':p.get('evidence'),'owner':r[1]}))`;
    const db = spawnSync(pc.resolvedBin, ['-B', '-c', py, join(runDir, 'tasks.sqlite'), taskKey], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (db.status !== 0) throw new Error('TaskStore 读取失败');
    const task = JSON.parse(db.stdout), digest = hash(manifestBytes);
    if (task.phase !== 'done' || task.owner !== null || task.evidence?.length !== fixedRecipe.stages.length || task.evidence.some(e => e.artifact !== manifestPath || e.sha256 !== digest || e.passed !== true)) throw new Error('TaskStore 状态或证据不匹配');
    const result = { schemaVersion: 1, passed: true, reused: false, scope: fixedRecipe.level, taskKey, tests: { total: tests, passed, failed, skipped }, doctor: { ready: doctor.ready, issueCount: doctor.issues.length }, taskStore: task.phase, modelRequests: 0, elapsedSeconds: Number(((performance.now() - start) / 1000).toFixed(3)), evidence: { manifest: manifestPath, manifestSha256: digest, state: runDir, stdout: stdoutPath, stderr: stderrPath } };
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, passed: false, error: String(e.message).slice(0, 500), state: runDir, elapsedSeconds: Number(((performance.now() - start) / 1000).toFixed(3)) }) + '\n');
    process.exitCode = 1;
  }
}
