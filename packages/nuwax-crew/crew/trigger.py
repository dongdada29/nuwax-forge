"""Trigger V0：外部事件（GitHub PR 状态）→ 规则筛选 → crew 任务草稿。

纯函数筛事件（screen），任务草稿形状即 router.route 的 task 输入；
GitHub 拉取（collect_github）仅一次性 `gh` 子进程调用，凭据由 gh 自管，本模块不读密钥。
不常驻、不轮询：由调度入口（cron / Bot / 手动）驱动单次执行。
规则与边界见 docs/CREW-TRIGGER.md。
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULTS = {
    "limit": 50,            # gh pr list 拉取上限
    "timeout": 30,          # gh 子进程超时秒
    "suppress_hours": 24,   # 同 key 触发抑制窗口
    "state_retention_days": 30,  # 状态文件保留天数（更早的键剪枝）
}

FAILURE_CONCLUSIONS = {"FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"}
PENDING_STATUSES = {"PENDING", "QUEUED", "IN_PROGRESS", "WAITING"}
GH_FIELDS = "number,title,isDraft,state,updatedAt,headRefName,statusCheckRollup"


class TriggerError(ValueError):
    pass


def load_rules(path) -> list:
    rules = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(rules, list) or not rules:
        raise TriggerError("规则文件必须是非空数组")
    for rule in rules:
        for field in ("id", "match", "objective"):
            if field not in rule:
                raise TriggerError(f"规则缺少 {field}：{json.dumps(rule, ensure_ascii=False)[:120]}")
    return rules


def collect_github(repo: str, *, gh_path: str = "gh", limit: int | None = None,
                   timeout: int | None = None) -> list:
    """一次性 `gh pr list` 拉取并归一化为事件行。凭据由 gh 自管，此处不读不传任何 token。"""
    cfg = {**DEFAULTS, **{k: v for k, v in {"limit": limit, "timeout": timeout}.items() if v is not None}}
    if not repo or "/" not in repo:
        raise TriggerError("--github 需要 owner/repo 形式")
    argv = [gh_path, "pr", "list", "--repo", repo, "--limit", str(cfg["limit"]), "--state", "open",
            "--json", GH_FIELDS]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=cfg["timeout"])
    except FileNotFoundError as err:
        raise TriggerError(f"找不到 gh 命令（{gh_path}）：{err}") from err
    except subprocess.TimeoutExpired as err:
        raise TriggerError(f"gh 拉取超时（{cfg['timeout']}s）") from err
    if proc.returncode != 0:
        raise TriggerError(f"gh 拉取失败：{proc.stderr.strip()[:200]}")
    try:
        raw = json.loads(proc.stdout or "[]")
    except ValueError as err:
        raise TriggerError(f"gh 输出不是合法 JSON：{err}") from err
    return [{"source": "github-pr", "repo": repo, "number": p.get("number"),
             "title": p.get("title", ""), "isDraft": bool(p.get("isDraft")),
             "state": p.get("state", ""), "updatedAt": p.get("updatedAt", ""),
             "headRefName": p.get("headRefName", ""),
             "rollup": p.get("statusCheckRollup") or []} for p in raw]


def _parse_ts(value: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def checks_state(rollup: list) -> str:
    """rollup → 'failure' | 'pending' | 'success' | 'none'（无检查即 none）。"""
    if not rollup:
        return "none"
    for check in rollup:
        if str(check.get("conclusion", "")).upper() in FAILURE_CONCLUSIONS:
            return "failure"
    for check in rollup:
        if str(check.get("status", "")).upper() in PENDING_STATUSES or not check.get("conclusion"):
            return "pending"
    return "success"


def _match(event: dict, match: dict, *, now: datetime) -> bool:
    if match.get("source") and event.get("source") != match["source"]:
        return False
    if match.get("state") and event.get("state") != match["state"]:
        return False
    if match.get("draft") is not None and bool(event.get("isDraft")) != bool(match["draft"]):
        return False
    if match.get("checks"):
        want = match["checks"]
        if want == "open" and event.get("state") != "OPEN":
            return False
        if want != "open" and checks_state(event.get("rollup") or []) != want:
            return False
    if match.get("staleDays") is not None:
        ts = _parse_ts(event.get("updatedAt", ""))
        if ts is None or ts >= now - timedelta(days=float(match["staleDays"])):
            return False
    return True


def _task_key(event: dict, rule: dict) -> str:
    return f"ghpr:{event.get('repo')}#{event.get('number')}:{rule['id']}"


def screen(events: list, rules: list, *, now: datetime | None = None) -> list:
    """事件 × 规则 → 任务草稿（router.route 的 task 形状，附 sourceEvent/key）。纯函数。"""
    now = now or datetime.now(timezone.utc)
    tasks = []
    for rule in rules:
        for event in events:
            if not _match(event, rule.get("match") or {}, now=now):
                continue
            ctx = {"number": event.get("number"), "title": event.get("title"),
                   "headRefName": event.get("headRefName"), "repo": event.get("repo"),
                   "staleDays": (rule.get("match") or {}).get("staleDays", "")}
            objective = rule["objective"].format(**{k: str(v) for k, v in ctx.items()})
            tasks.append({"taskKey": _task_key(event, rule), "kind": rule.get("kind", "triage"),
                          "risk": rule.get("risk", "low"), "objective": objective,
                          "acceptance": rule.get("acceptance", ["输出结论，不改任何文件"]),
                          "sourceEvent": {"source": event.get("source"), "repo": event.get("repo"),
                                          "number": event.get("number"), "title": event.get("title")},
                          "key": _task_key(event, rule)})
    return tasks


def load_state(path) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (ValueError, OSError):
        return {}


def save_state(path, state: dict, *, now: datetime | None = None, retention_days: int | None = None) -> None:
    now = now or datetime.now(timezone.utc)
    days = retention_days if retention_days is not None else DEFAULTS["state_retention_days"]
    cutoff = now - timedelta(days=days)
    fresh = {k: v for k, v in state.items()
             if (_parse_ts(v) or now) >= cutoff}
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(fresh, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def dedup(tasks: list, state: dict, *, now: datetime | None = None, suppress_hours: float | None = None) -> tuple:
    """按 key 抑制窗口去重，返回 (新任务列表, 新状态 dict)。纯函数。"""
    now = now or datetime.now(timezone.utc)
    hours = suppress_hours if suppress_hours is not None else DEFAULTS["suppress_hours"]
    cutoff = now - timedelta(hours=hours)
    fresh, new_state = [], dict(state)
    for task in tasks:
        key = task["key"]
        last = _parse_ts(state.get(key, ""))
        if last is not None and last >= cutoff:
            continue
        fresh.append(task)
        new_state[key] = now.isoformat(timespec="seconds")
    return fresh, new_state


def run(events: list, rules: list, state_path, *, now: datetime | None = None,
        suppress_hours: float | None = None) -> dict:
    """一次触发的完整闭环：筛选 → 状态去重 → 落状态文件。返回摘要（含任务草稿）。"""
    now = now or datetime.now(timezone.utc)
    tasks = screen(events, rules, now=now)
    fresh, new_state = dedup(tasks, load_state(state_path), now=now, suppress_hours=suppress_hours)
    if fresh:
        save_state(state_path, new_state, now=now)
    return {"events": len(events), "matched": len(tasks), "tasks": fresh,
            "suppressed": len(tasks) - len(fresh)}
