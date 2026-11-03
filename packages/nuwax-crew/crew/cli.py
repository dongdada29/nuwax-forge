"""命令行入口：route / verify / ledger。"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys

from . import contract, dashboard, dispatch, health, ledger, registry, router, runner, usage, unified_dashboard

VERIFY_BRIEF = {
    "taskKey": "executor-verify-mini",
    "kind": "triage",
    "risk": "low",
    "objective": "只读读取 tests/test_im_mentions.py，用 3 句话说明 im_mentions.py 的认领规则，不改任何文件",
    "acceptance": ["输出三句话", "无文件修改"],
}


def cmd_route(args) -> int:
    task = json.loads(open(args.task, encoding="utf-8").read())
    reg = registry.load(args.registry)
    plan = router.route(task, reg,
                        dispatched=ledger.dispatched_keys(args.ledger) if args.ledger else set(),
                        counts=ledger.today_counts(args.ledger) if args.ledger else {},
                        force=args.force, allow_unverified=args.allow_unverified,
                        blocked={k: v for k, v in health.blocked(args.health).items()} if args.health else {})
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    return 0 if plan["status"] in {"planned", "already-dispatched"} else 2


def cmd_verify(args) -> int:
    reg = registry.load(args.registry)
    out = {"brief": VERIFY_BRIEF, "executors": []}
    for e in reg["executors"]:
        if e["verified"] and not args.all:
            continue
        cmd, proposed = router._command(e, VERIFY_BRIEF)
        out["executors"].append({"name": e["name"], "tier": e["tier"], "provider": e["provider"],
                                 "command": cmd, "proposedInvocation": proposed,
                                 "note": "核验通过后把真实命令固化到 invocation 并置 verified=true"})
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_health(args) -> int:
    if args.clear:
        health.clear(args.file, args.clear)
        print(json.dumps({"cleared": args.clear}, ensure_ascii=False))
    elif args.mark:
        if not args.reason:
            print("停止：--mark 需要 --reason（如 quota-exhausted / auth-failed / subscription-expired）", file=sys.stderr)
            return 1
        row = health.mark(args.file, args.mark, args.reason, iso=args.until,
                          reset_in=args.reset_in, cooldown_minutes=args.cooldown_minutes)
        print(json.dumps({"executor": args.mark, **row}, ensure_ascii=False, indent=2))
    else:
        print(json.dumps({k: {"until": v[0], "reason": v[1]}
                          for k, v in health.blocked(args.file).items()}, ensure_ascii=False, indent=2))
    return 0


def cmd_ledger(args) -> int:
    if args.today:
        print(json.dumps(dict(ledger.today_counts(args.ledger)), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(ledger.summary(args.ledger), ensure_ascii=False, indent=2))
    return 0


def cmd_dispatch(args) -> int:
    plan = dispatch.load_plan(args.plan)
    rows = dispatch.mark(plan, args.ledger, args.status)
    print(json.dumps({"taskKey": plan["taskKey"], "status": args.status, "records": rows}, ensure_ascii=False, indent=2))
    return 0


def cmd_usage(args) -> int:
    reg = registry.load(args.registry)
    data = usage.summary(args.ledger, reg, days=args.days)
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


def cmd_run(args) -> int:
    import json as _j
    plan = _j.loads(open(args.plan, encoding="utf-8").read())
    brief = args.brief
    input_files = [args.plan]
    if brief.startswith("@"):
        from pathlib import Path
        if Path(brief[1:]).stat().st_size > 1048576:
            raise ValueError("brief 文件超过 1MiB 输入上限")
        input_files.append(brief[1:])
        brief = open(brief[1:], encoding="utf-8").read()
    out = runner.run_plan(plan, worktree=args.worktree, brief=brief, ledger_path=args.ledger,
                          artifacts_dir=args.artifacts, timeout=args.timeout,
                          only_roles=set(args.role.split(",")) if args.role else None, input_files=input_files)
    print(_j.dumps(out, ensure_ascii=False, indent=2))
    failed = [r for r in out["results"] if r["status"] == "failed"]
    return 2 if failed or not out["processPassed"] or not out["budgetPassed"] or (plan.get("verification") and not out["acceptancePassed"]) else 0


def cmd_dashboard(args) -> int:
    from pathlib import Path
    reg = registry.load(args.registry)
    data = usage.summary(args.ledger, reg, days=7)
    h = Path(args.health) if args.health else None
    health_data = json.loads(h.read_text(encoding="utf-8")) if h and h.exists() else {}
    m = Path(args.matrix) if args.matrix else None
    matrix = json.loads(m.read_text(encoding="utf-8")) if m and m.exists() else []
    inputs = [Path(x).resolve() for x in (args.ledger, args.registry, args.health, args.matrix, args.task_store, args.host_budget) if x]
    agent_dirs = {Path(args.agent_state).resolve(strict=True)} if args.agent_state else set()
    if args.agent_state_root:
        root = Path(args.agent_state_root).resolve(strict=True)
        if not root.is_dir():
            raise ValueError('agent-state-root 必须是目录')
        entries = list(root.iterdir())
        if len(entries) > 1000:
            raise ValueError('agent-state-root 超过 1000 个条目')
        agent_dirs.update(p.resolve() for p in entries if not p.is_symlink() and p.is_dir() and (p / 'manifest.json').is_file() and (p / 'request.json').is_file())
    for directory in agent_dirs:
        inputs.extend((directory / name for name in ('request.json', 'manifest.json')))
    output = Path(args.out).resolve()
    if any(output == p or (output.exists() and p.exists() and output.samefile(p)) for p in inputs):
        raise ValueError('看板输出不得覆盖输入')
    rows = usage.load_rows(args.ledger)
    flow_rows = rows[-20:][::-1]
    records = unified_dashboard.crew_records(rows)
    notes = []
    if args.task_store:
        stack_records = unified_dashboard.task_store_records(args.task_store)
        if stack_records is None:
            notes.append('Stack 任务库尚无 Assignment 表；该来源未接入')
        else:
            records.extend(stack_records)
    if args.host_budget:
        records.extend(unified_dashboard.host_guard_records(args.host_budget))
    for directory in sorted(agent_dirs):
        record = unified_dashboard.agent_state_record(directory)
        if record is not None:
            records.append(record)
    out = dashboard.write_dashboard(args.out, usage=data, registry=reg, health=health_data,
                                    matrix=matrix, flow_rows=flow_rows, records=records, notes=notes)
    print(out)
    return 0


def cmd_dashboard_server(args) -> int:
    """Explicit foreground server; regenerate only on local requests."""
    import contextlib
    import copy
    import html
    import io
    import tempfile
    import threading
    from datetime import datetime
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from pathlib import Path

    if args.out:
        raise ValueError('--serve 不接受 --out')
    if not 0 <= args.port <= 65535 or not 5 <= args.refresh_seconds <= 3600:
        raise ValueError('port 必须为 0..65535，refresh-seconds 必须为 5..3600')
    with tempfile.TemporaryDirectory(prefix='nuwax-dashboard-') as temp:
        snapshot = copy.copy(args)
        snapshot.out = str(Path(temp) / 'dashboard.html')
        lock = threading.Lock()

        def render():
            with lock, contextlib.redirect_stdout(io.StringIO()):
                cmd_dashboard(snapshot)
                page = Path(snapshot.out).read_text(encoding='utf-8')
            def modified(path):
                p = Path(path)
                stamps = [f.stat().st_mtime for f in (p, Path(str(p) + '-wal')) if f.exists()]
                return datetime.fromtimestamp(max(stamps)).astimezone().strftime('%Y-%m-%d %H:%M:%S') if stamps else '文件不存在'
            source_time = html.escape(modified(args.ledger))
            controls = (f'<div class="live-controls" data-interval="{args.refresh_seconds}">'
                        f'<button type="button" id="refresh-now">立即刷新</button>'
                        f'<span id="refresh-status" role="status">自动刷新：每 {args.refresh_seconds} 秒</span>'
                        f'<span id="source-time">派工台账最后写入：{source_time}</span></div>')
            page = page.replace('<div id="dashboard-content">', controls + '<div id="dashboard-content">', 1)
            return page.replace('</body>', '<script src="/live.js" defer></script></body>', 1).encode('utf-8')

        live_script = '''(() => {
  const controls = document.querySelector('.live-controls');
  const button = document.querySelector('#refresh-now');
  const status = document.querySelector('#refresh-status');
  const interval = Number(controls.dataset.interval);
  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true; button.disabled = true; status.textContent = '正在刷新…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/', {cache:'no-store', signal:controller.signal});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const next = new DOMParser().parseFromString(await response.text(), 'text/html');
      const content = next.querySelector('#dashboard-content');
      const meta = next.querySelector('.meta');
      const source = next.querySelector('#source-time');
      if (!content || !meta || !source) throw new Error('invalid response');
      document.querySelector('#dashboard-content').innerHTML = content.innerHTML;
      document.querySelector('.meta').innerHTML = meta.innerHTML;
      document.querySelector('#source-time').textContent = source.textContent;
      status.textContent = '已更新 ' + new Date().toLocaleTimeString() + ' · 每 ' + interval + ' 秒自动刷新';
    } catch (_) {
      status.textContent = '刷新失败，保留上次数据；将自动重试';
    } finally { clearTimeout(timeout); busy = false; button.disabled = false; }
  }
  button.addEventListener('click', refresh);
  setInterval(refresh, interval * 1000);
})();'''.encode('utf-8')

        render()  # Fail before listening if an explicit source is invalid.

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path not in ('/', '/index.html', '/live.js'):
                    self.send_error(404)
                    return
                try:
                    content = live_script if self.path == '/live.js' else render()
                except (OSError, ValueError, sqlite3.Error):
                    self.send_error(503, 'Dashboard source unavailable')
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript; charset=utf-8' if self.path == '/live.js' else 'text/html; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)

            def log_message(self, *_args):
                pass

        with ThreadingHTTPServer(('127.0.0.1', args.port), Handler) as server:
            print(json.dumps({'status':'listening', 'url':f'http://127.0.0.1:{server.server_port}/',
                              'refreshSeconds':args.refresh_seconds}), flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="crew", description="执行器路由与调度")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("route", help="任务 → 派工计划")
    p.add_argument("--task", required=True)
    p.add_argument("--registry", required=True)
    p.add_argument("--ledger", default=None)
    p.add_argument("--force", action="store_true")
    p.add_argument("--allow-unverified", action="store_true")
    p.add_argument("--health", default=None, help="健康冷却文件，冷却中的执行器自动切换")
    p.set_defaults(func=cmd_route)

    p = sub.add_parser("verify", help="打印统一核验任务与各执行器命令")
    p.add_argument("--registry", required=True)
    p.add_argument("--all", action="store_true", help="包含已核验执行器")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("dispatch", help="把派工计划落台账")
    p.add_argument("--plan", required=True)
    p.add_argument("--ledger", required=True)
    p.add_argument("--status", default="dispatched", choices=["dispatched", "failed", "completed"])
    p.set_defaults(func=cmd_dispatch)

    p = sub.add_parser("health", help="执行器健康冷却")
    p.add_argument("--file", required=True)
    p.add_argument("--mark")
    p.add_argument("--reason")
    p.add_argument("--until", help="ISO 截止时间")
    p.add_argument("--reset-in", help="重置倒计时，如 125h35m8s")
    p.add_argument("--cooldown-minutes", type=int)
    p.add_argument("--clear")
    p.set_defaults(func=cmd_health)

    p = sub.add_parser("ledger", help="调用台账")
    p.add_argument("--ledger", required=True)
    p.add_argument("--today", action="store_true")
    p.set_defaults(func=cmd_ledger)

    p = sub.add_parser("usage", help="订阅与执行器用量统计")
    p.add_argument("--ledger", required=True)
    p.add_argument("--registry", required=True)
    p.add_argument("--days", type=int, default=7)
    p.set_defaults(func=cmd_usage)

    p = sub.add_parser("run", help="按计划真实执行派工命令并记账")
    p.add_argument("--plan", required=True)
    p.add_argument("--worktree", required=True)
    p.add_argument("--brief", required=True, help="任务正文，或 @文件 路径")
    p.add_argument("--ledger", required=True)
    p.add_argument("--artifacts", required=True, help="输出日志目录")
    p.add_argument("--timeout", type=int, default=900)
    p.add_argument("--role", default=None, help="只执行指定角色，逗号分隔")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("dashboard", help="生成自包含运行看板 HTML")
    p.add_argument("--ledger", required=True)
    p.add_argument("--registry", required=True)
    p.add_argument("--health", default=None)
    p.add_argument("--matrix", default=None)
    p.add_argument("--task-store", default=None, help="Stack tasks.sqlite，只读")
    p.add_argument("--agent-state", default=None, help="Forge agent 单次运行 state 目录，只读")
    p.add_argument("--agent-state-root", default=None, help="包含多次 agent state 的目录，只读一层")
    p.add_argument("--host-budget", default=None, help="Codex budget guard JSON 快照，只读")
    p.add_argument("--out")
    p.add_argument("--serve", action="store_true", help="前台监听本机并按访问刷新")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--refresh-seconds", type=int, default=5)
    p.set_defaults(func=lambda args: cmd_dashboard_server(args) if args.serve else cmd_dashboard(args))

    args = parser.parse_args(argv)
    try:
        if args.cmd == 'dashboard' and not args.serve and not args.out:
            raise ValueError('dashboard 需要 --out 或 --serve')
        return args.func(args)
    except (contract.ContractError, registry.RegistryError, health.HealthError, runner.RunError, ValueError, OSError, sqlite3.Error) as err:
        print(f"停止：{err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
