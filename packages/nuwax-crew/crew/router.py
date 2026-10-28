"""路由策略：任务 brief + 注册表 + 台账状态 → 派工计划。纯函数，不执行任何命令。"""

from __future__ import annotations

from . import contract, registry

FIXED_ROUTES = {"web-verification": "ego-browser", "platform-query": "nuwax-a2a"}

# 各类任务的候选层级顺序（从先到后）
KIND_TIER_ORDER = {
    "implementation": {"high": ["S", "A"], "normal": ["S", "A"], "low": ["B", "A", "S"]},
    "review": {"high": ["S"], "normal": ["S"], "low": ["S", "A"]},
    "triage": {"high": ["B", "A"], "normal": ["B", "A"], "low": ["B", "A", "S"]},
    "batch": {"high": ["B", "A"], "normal": ["B", "A"], "low": ["B", "A", "S"]},
    "docs": {"high": ["B", "A"], "normal": ["B", "A"], "low": ["B", "A", "S"]},
    "research": {"high": ["C", "S"], "normal": ["C", "S"], "low": ["C", "S"]},
}


def _command(executor: dict, brief: dict) -> tuple:
    inv = executor.get("invocation") or {}
    if "argv" in inv:
        argv = inv["argv"]
        if not isinstance(argv, list) or not argv or any(not isinstance(a, str) or not a for a in argv):
            raise contract.ContractError("invocation.argv 必须是非空字符串数组")
        return ([a.replace("{objective}", brief["objective"]) for a in argv], bool(inv.get("proposed", True)))
    template = inv.get("command")
    if not template:
        return (None, True)
    cmd = template.format(worktree="{worktree}", brief="{brief}", objective=brief["objective"])
    return (cmd, bool(inv.get("proposed", True)))


def _eligible(reg: dict, kind: str, counts: dict, used_names: set, allow_unverified: bool,
              blocked: dict | None = None) -> list:
    out = []
    blocked = blocked or {}
    for e in reg["executors"]:
        if e["name"] in used_names:
            continue
        if not e.get("enabled", True):
            continue
        if e["name"] in blocked:
            continue
        if not allow_unverified and not e["verified"]:
            continue
        if e["roles"] and kind not in e["roles"]:
            continue
        if counts.get(e["name"], 0) >= e["dailyCap"]:
            continue
        out.append(e)
    # 消耗策略（用户 2026-10-22 确认 local->subscription->api；2026-10-23 追加：
    # 智谱个人 Coding Plan 与 Token Plan Max 用量最大，排在其它订阅之前）
    rank = {"local": 0, "zhipu": 1, "subscription": 2, "api": 3}
    out.sort(key=lambda e: rank.get(e.get("costClass", "subscription"), 2))
    return out


def route(task: dict, reg: dict, *, dispatched: set | None = None, counts: dict | None = None,
          force: bool = False, allow_unverified: bool = False, blocked: dict | None = None) -> dict:
    brief = contract.validate(task)
    counts = counts or {}
    dispatched = dispatched or set()
    warnings = []
    metadata = {key: brief[key] for key in ("schemaVersion", "attemptId", "runtime", "verification", "budget", "mode", "modelTask", "model", "budgetSpec", "context", "budgetHistory") if key in brief}

    if brief["taskKey"] in dispatched and not force:
        return {"taskKey": brief["taskKey"], "status": "already-dispatched", "assignments": [],
                "fallbacks": [], "warnings": ["同 taskKey 已派工；确认重复实施无风险后用 --force"], "acceptance": brief["acceptance"]}

    assignments, fallbacks, used = [], [], set()

    if brief["kind"] in FIXED_ROUTES:
        name = FIXED_ROUTES[brief["kind"]]
        try:
            e = registry.find(reg, name)
        except registry.RegistryError as err:
            return {"taskKey": brief["taskKey"], "status": "unroutable", "assignments": [],
                    "fallbacks": [], "warnings": [str(err)], "acceptance": brief["acceptance"]}
        if not e["verified"] and not allow_unverified:
            warnings.append(f"固定执行器 {name} 未核验")
        cmd, proposed = _command(e, brief)
        assignments.append({"role": "fixed", "executor": e["name"], "provider": e["provider"],
                            "command": cmd, "proposedInvocation": proposed,
                            "reason": f"{brief['kind']} 由固定执行器承接"})
        return {**metadata, "taskKey": brief["taskKey"], "status": "planned", "assignments": assignments,
                "fallbacks": fallbacks, "warnings": warnings, "acceptance": brief["acceptance"]}

    tiers = KIND_TIER_ORDER[brief["kind"]][brief["risk"]]
    max_exec = brief["budget"]["maxExecutors"] or (2 if brief["risk"] == "high" and brief["kind"] == "implementation" else 1)

    # 主执行器：按层级顺序取第一个合格者
    primary = None
    for tier in tiers:
        cands = _eligible(reg, brief["kind"], counts, used, allow_unverified, blocked)
        cands = [e for e in cands if e["tier"] == tier]
        if cands:
            primary = cands[0]
            break
    if primary is None:
        return {"taskKey": brief["taskKey"], "status": "unroutable", "assignments": [],
                "fallbacks": [], "warnings": ["没有合格执行器（核验/配额/角色均不满足）"], "acceptance": brief["acceptance"]}

    cmd, proposed = _command(primary, brief)
    role = "implement" if brief["kind"] == "implementation" else brief["kind"]
    assignments.append({"role": role, "executor": primary["name"], "provider": primary["provider"],
                        "command": cmd, "proposedInvocation": proposed,
                        "reason": f"{brief['risk']} 风险 {brief['kind']} 的首选（tier {primary['tier']}）"})
    used.add(primary["name"])

    # 高风险实施：交叉复核，必须不同提供商
    if brief["kind"] == "implementation" and brief["risk"] == "high" and len(assignments) < max_exec:
        reviewer = None
        for tier in tiers:
            cands = [e for e in _eligible(reg, "review", counts, used, allow_unverified, blocked)
                     if e["tier"] == tier and e["provider"] != primary["provider"]]
            if cands:
                reviewer = cands[0]
                break
        if reviewer:
            cmd, proposed = _command(reviewer, brief)
            assignments.append({"role": "review", "executor": reviewer["name"], "provider": reviewer["provider"],
                                "command": cmd, "proposedInvocation": proposed,
                                "reason": "高风险实施的交叉复核（不同提供商）"})
            used.add(reviewer["name"])
        else:
            warnings.append("无第二个已核验的不同提供商执行器可交叉复核，本次降为单跑+真实验收")

    # 降级链
    for tier in tiers:
        for e in _eligible(reg, brief["kind"], counts, used, allow_unverified, blocked):
            if e["tier"] == tier:
                cmd, proposed = _command(e, brief)
                fallbacks.append({"executor": e["name"], "provider": e["provider"], "command": cmd,
                                  "proposedInvocation": proposed, "reason": f"tier {tier} 降级备选"})
                used.add(e["name"])
                break
        if len(fallbacks) >= 2:
            break

    if blocked:
        warnings.append("冷却中已切换：" + "、".join(f"{k}({v[1]})" for k, v in sorted(blocked.items())))

    if any(a["proposedInvocation"] for a in assignments):
        warnings.append("调用命令仍为 proposed 模板，需在执行器核验中固化真实命令")

    return {**metadata, "taskKey": brief["taskKey"], "status": "planned", "assignments": assignments,
            "fallbacks": fallbacks, "warnings": warnings, "acceptance": brief["acceptance"]}
