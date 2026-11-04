"""命令行入口：route / verify / ledger。"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys

from . import contract, dispatch, health, ledger, registry, router, runner, usage

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
    from pathlib import Path
    plan_bytes = Path(args.plan).read_bytes()
    plan = _j.loads(plan_bytes)
    brief = args.brief
    input_files = [args.plan]
    if brief.startswith("@"):
        if Path(brief[1:]).stat().st_size > 1048576:
            raise ValueError("brief 文件超过 1MiB 输入上限")
        input_files.append(brief[1:])
        brief_bytes = Path(brief[1:]).read_bytes()
        brief = brief_bytes.decode('utf-8')
    # The configured workbench's canonical ledger carries a local policy marker.
    # An ordinary crew run against that ledger must not silently omit the gate.
    policy_file = Path(args.ledger).resolve().parent / 'runtime' / 'approval-policy.json'
    if policy_file.exists() or policy_file.is_symlink():
        if policy_file.is_symlink() or not policy_file.is_file() or policy_file.stat().st_size > 4096:
            raise ValueError('approval-policy-invalid')
        policy = _j.loads(policy_file.read_text(encoding='utf-8'))
        if not isinstance(policy, dict) or policy.get('required') is not True:
            raise ValueError('approval-policy-invalid')
        expected_store = policy_file.parent / 'approvals.sqlite'
        if not args.approval_db or not args.approval_id or Path(args.approval_db).resolve() != expected_store.resolve():
            raise ValueError('human-approval-required-for-workbench-ledger')
    if bool(args.approval_db) != bool(args.approval_id):
        raise ValueError('approval-db 与 approval-id 必须一起指定')
    if args.approval_db:
        if not args.brief.startswith('@'):
            raise ValueError('审批任务必须使用文件形式的 brief')
        from . import approvals
        approvals.verify(args.approval_db, args.approval_id, task=plan.get('taskKey'), attempt=plan.get('attemptId'),
                         worktree=args.worktree, plan=args.plan, brief=args.brief[1:], plan_bytes=plan_bytes, brief_bytes=brief_bytes)
    out = runner.run_plan(plan, worktree=args.worktree, brief=brief, ledger_path=args.ledger,
                          artifacts_dir=args.artifacts, timeout=args.timeout,
                          only_roles=set(args.role.split(",")) if args.role else None, input_files=input_files)
    print(_j.dumps(out, ensure_ascii=False, indent=2))
    failed = [r for r in out["results"] if r["status"] == "failed"]
    return 2 if failed or not out["processPassed"] or not out["budgetPassed"] or (plan.get("verification") and not out["acceptancePassed"]) else 0


def _dashboard_module():
    """Resolve the optional dashboard next to Crew, in a workspace or installed bundle."""
    from pathlib import Path
    for root in (Path(__file__).resolve().parents[2] / 'dashboard', Path(__file__).resolve().parents[2] / 'devkit-dashboard'):
        if (root / 'forge_dashboard' / '__init__.py').is_file():
            sys.path.insert(0, str(root))
            break
    try:
        from forge_dashboard import cli as dashboard_cli
    except ModuleNotFoundError as err:
        if err.name != 'forge_dashboard':
            raise
        raise ValueError('缺少 @nuwax-ai/devkit-dashboard，看板不可用') from err
    return dashboard_cli


def cmd_dashboard_compat(args):
    return _dashboard_module().dispatch_dashboard(args)


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
    p.add_argument("--approval-db", default=None, help="已授权工作台的审批账本")
    p.add_argument("--approval-id", default=None, help="批准的方案标识")
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
    p.add_argument("--approval-store", default=None, help="显式审批账本，--serve 时允许本机审批")
    p.add_argument("--out")
    p.add_argument("--serve", action="store_true", help="前台监听本机并按访问刷新")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--refresh-seconds", type=int, default=5)
    p.set_defaults(func=cmd_dashboard_compat)

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
