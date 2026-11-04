"""Local dashboard service and command-line adapter."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import socketserver
from http.server import ThreadingHTTPServer
from crew import registry, usage
from . import views
from .adapters import default_adapters


class LoopbackServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer performs reverse DNS even for 127.0.0.1; this local-only
        # server does not need a hostname to advertise its URL.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]



def cmd_dashboard(args) -> int:
    from pathlib import Path
    reg = registry.load(args.registry)
    data = usage.summary(args.ledger, reg, days=7)
    h = Path(args.health) if args.health else None
    health_data = json.loads(h.read_text(encoding="utf-8")) if h and h.exists() else {}
    m = Path(args.matrix) if args.matrix else None
    matrix = json.loads(m.read_text(encoding="utf-8")) if m and m.exists() else []
    inputs = [Path(x).resolve() for x in (args.ledger, args.registry, args.health, args.matrix, args.task_store, args.host_budget, args.approval_store) if x]
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
    adapters = default_adapters()
    records = adapters.read('crew', rows)
    notes = []
    if args.task_store:
        stack_records = adapters.read('stack', args.task_store)
        if stack_records is None:
            notes.append('Stack 任务库尚无 Assignment 表；该来源未接入')
        else:
            records.extend(stack_records)
    if args.host_budget:
        records.extend(adapters.read('host-guard', args.host_budget))
    for directory in sorted(agent_dirs):
        record = adapters.read('forge-agent', directory)
        if record is not None:
            records.append(record)
    from crew import approvals
    approval_items = approvals.list_requests(args.approval_store) if args.approval_store else None
    out = views.write_dashboard(args.out, usage=data, registry=reg, health=health_data,
                                    matrix=matrix, flow_rows=flow_rows, records=records, notes=notes,
                                    approval_items=approval_items, approvals_actionable=bool(args.serve and args.approval_store))
    print(out)
    return 0


def cmd_dashboard_server(args) -> int:
    """Explicit foreground server; regenerate only on local requests."""
    import contextlib
    import copy
    import hashlib
    import html
    import io
    import secrets
    import tempfile
    import threading
    from datetime import datetime
    from http.server import BaseHTTPRequestHandler
    from pathlib import Path

    if args.out:
        raise ValueError('--serve 不接受 --out')
    if not 0 <= args.port <= 65535 or not 5 <= args.refresh_seconds <= 3600:
        raise ValueError('port 必须为 0..65535，refresh-seconds 必须为 5..3600')
    if args.approval_store and not Path(args.approval_store).is_absolute():
        raise ValueError('approval-store 必须是绝对路径')
    csrf = secrets.token_urlsafe(32)
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
                        f'<span id="source-time">派工台账最后写入：{source_time}</span></div>'
                        '<nav class="view-nav" aria-label="看板视图">' +
                        ('<button type="button" data-target="approvals">任务审批</button>' if args.approval_store else '') +
                        '<button type="button" data-target="overview">运行总览</button>'
                        '<button type="button" data-target="routes">路由关系</button>'
                        '<button type="button" data-target="tasks">任务详情</button>'
                        '<button type="button" data-target="models">模型与执行器</button>'
                        '<button type="button" data-target="dispatch">派工流水</button></nav>')
            marker = '<div id="dashboard-content">'
            content_hash = hashlib.sha256(page[page.index(marker):].encode('utf-8')).hexdigest()
            page = page.replace(marker, controls + f'<div id="dashboard-content" data-content-hash="{content_hash}">', 1)
            page = page.replace('</head>', f'<meta name="forge-csrf" content="{csrf}"></head>', 1)
            return page.replace('</body>', '<script src="/live.js" defer></script></body>', 1).encode('utf-8')

        live_script = (Path(__file__).resolve().parent.parent / "web" / "live.js").read_bytes()

        render()  # Fail before listening if an explicit source is invalid.

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
                    self.send_error(403)
                    return
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

            def do_POST(self):
                origin = f'http://127.0.0.1:{self.server.server_port}'
                if (not args.approval_store or self.path != '/api/approvals/decision'
                    or self.headers.get('Host') != origin.removeprefix('http://')
                    or self.headers.get('Origin') != origin
                    or self.headers.get('X-Forge-CSRF') != csrf
                    or self.headers.get('Content-Type') != 'application/json'):
                    self.send_error(403)
                    return
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if length < 1 or length > 2048: raise ValueError('invalid-length')
                    data = json.loads(self.rfile.read(length))
                    if not isinstance(data, dict) or set(data) != {'id', 'decision'}: raise ValueError('invalid-body')
                    from crew import approvals
                    result = approvals.decide(args.approval_store, data['id'], data['decision'])
                    body = json.dumps(result).encode()
                except (ValueError, OSError, sqlite3.Error):
                    self.send_error(400, 'Approval decision rejected')
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        with LoopbackServer(('127.0.0.1', args.port), Handler) as server:
            print(json.dumps({'status':'listening', 'url':f'http://127.0.0.1:{server.server_port}/',
                              'refreshSeconds':args.refresh_seconds}), flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
    return 0


def add_arguments(p):
    p.add_argument("--ledger", required=True)
    p.add_argument("--registry", required=True)
    for name in ("health", "matrix", "task-store", "agent-state", "agent-state-root", "host-budget", "approval-store", "out"):
        p.add_argument("--" + name, default=None)
    p.add_argument("--serve", action="store_true")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--refresh-seconds", type=int, default=5)
    p.set_defaults(func=dispatch_dashboard)


def dispatch_dashboard(args):
    if not args.serve and not args.out:
        raise ValueError("dashboard 需要 --out 或 --serve")
    return cmd_dashboard_server(args) if args.serve else cmd_dashboard(args)


def main():
    p = argparse.ArgumentParser(prog="nuwax-forge dashboard")
    add_arguments(p)
    args = p.parse_args()
    try:
        return dispatch_dashboard(args)
    except (ValueError, OSError, sqlite3.Error) as err:
        print(f"停止：{err}", file=sys.stderr)
        return 1
