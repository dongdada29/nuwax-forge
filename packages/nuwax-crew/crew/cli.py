"""命令行入口：route / verify / ledger。"""

from __future__ import annotations

import argparse
import json
import sys

from . import contract, dashboard, dispatch, health, ledger, registry, router, runner, usage

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
    h = Path(args.health)
    health_data = json.loads(h.read_text(encoding="utf-8")) if args.health and h.exists() else {}
    m = Path(args.matrix)
    matrix = json.loads(m.read_text(encoding="utf-8")) if args.matrix and m.exists() else []
    flow_rows = usage.load_rows(args.ledger)[-20:][::-1]
    out = dashboard.write_dashboard(args.out, usage=data, registry=reg, health=health_data,
                                    matrix=matrix, flow_rows=flow_rows)
    print(out)
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
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_dashboard)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (contract.ContractError, registry.RegistryError, health.HealthError, runner.RunError, ValueError, FileNotFoundError) as err:
        print(f"停止：{err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
