"""Watchdog V0：离线巡查派工台账，规则抓行为异常（原地打转/连败/耗时零产出）。

纯函数，零模型零执行；只读台账，产出告警 JSONL。规则与阈值见 docs/CREW-WATCHDOG.md。
token 级「烧穿下界零产出」与 PR 循环重跑需要 Forge 观测 / GitHub 轮询数据源，留 V1。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .usage import OK_STATUSES, FAILED_STATUSES, load_rows

DEFAULTS = {
    "window_days": 7,        # 只看最近 N 天的台账行
    "spin_dispatched": 3,    # 同任务 dispatched 次数达到阈值且无成功 → 打转
    "fail_streak": 2,        # 同任务失败次数达到阈值且无成功 → 连败
    "executor_fail_streak": 3,  # 同执行器窗口内全败且失败数达阈值 → 疑似配额/挂死
    "burn_seconds": 3600.0,  # 同任务累计耗时达到阈值且无成功 → 耗时零产出
    "suppress_hours": 6,     # 同 key 告警抑制窗口
}


def _parse_ts(value: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(value)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _alert(rule: str, subject: str, ts: str, evidence: dict) -> dict:
    return {"schemaVersion": 1, "kind": "crew-watchdog-alert", "rule": rule, "subject": subject,
            "severity": "warn", "ts": ts, "evidence": evidence, "key": f"{rule}:{subject}"}


def evaluate(rows: list, *, now: datetime | None = None, **thresholds) -> list:
    """台账行 → 告警列表。无副作用；不修改 rows。"""
    t = {**DEFAULTS, **{k: v for k, v in thresholds.items() if v is not None}}
    now = now or datetime.now(timezone.utc)
    window_start = now.timestamp() - t["window_days"] * 86400

    recent = []
    for row in rows:
        ts = _parse_ts(row.get("ts", ""))
        if ts and ts.timestamp() >= window_start:
            recent.append(row)

    by_task: dict[str, list] = {}
    by_executor: dict[str, list] = {}
    for row in recent:
        key = row.get("taskKey")
        if key:
            by_task.setdefault(key, []).append(row)
        name = row.get("executor")
        if name:
            by_executor.setdefault(name, []).append(row)

    alerts: list = []
    now_iso = now.isoformat(timespec="seconds")
    for key, task_rows in sorted(by_task.items()):
        ok = [r for r in task_rows if r.get("status") in OK_STATUSES]
        if ok:
            continue
        dispatched = sum(1 for r in task_rows if r.get("status") == "dispatched")
        failed = [r for r in task_rows if r.get("status") in FAILED_STATUSES]
        elapsed = sum(r.get("elapsedSeconds") or 0 for r in task_rows)
        last_ts = max((r.get("ts", "") for r in task_rows), default="")
        if dispatched >= t["spin_dispatched"]:
            alerts.append(_alert("task-spin", key, now_iso,
                                 {"dispatched": dispatched, "failed": len(failed), "lastTs": last_ts}))
        elif len(failed) >= t["fail_streak"]:
            alerts.append(_alert("attempt-fail-streak", key, now_iso,
                                 {"failed": len(failed), "dispatched": dispatched, "lastTs": last_ts}))
        if elapsed >= t["burn_seconds"]:
            alerts.append(_alert("time-burn-no-output", key, now_iso,
                                 {"elapsedSeconds": elapsed, "failed": len(failed), "dispatched": dispatched}))
    for name, rows_of in sorted(by_executor.items()):
        ok = sum(1 for r in rows_of if r.get("status") in OK_STATUSES)
        failed = sum(1 for r in rows_of if r.get("status") in FAILED_STATUSES)
        if ok == 0 and failed >= t["executor_fail_streak"]:
            alerts.append(_alert("executor-fail-streak", name, now_iso,
                                 {"failed": failed, "ok": ok, "windowDays": t["window_days"]}))
    return alerts


def _existing_alerts(path) -> list:
    p = Path(path)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def patrol(ledger_path, alerts_path, *, now: datetime | None = None, **thresholds) -> dict:
    """巡查一次：读台账 → evaluate → 抑制窗口内重复告警 → 追加写 alerts JSONL。

    只增不改（与台账同纪律）；已有告警文件只追加。返回摘要 dict。
    """
    now = now or datetime.now(timezone.utc)
    t = {**DEFAULTS, **{k: v for k, v in thresholds.items() if v is not None}}
    alerts = evaluate(load_rows(ledger_path), now=now, **t)

    seen: dict[str, datetime] = {}
    for row in _existing_alerts(alerts_path):
        ts = _parse_ts(row.get("ts", ""))
        if ts and row.get("key"):
            seen[row["key"]] = max(seen.get(row["key"], ts), ts)
    cutoff = now - timedelta(hours=t["suppress_hours"])

    fresh = [a for a in alerts if seen.get(a["key"], datetime.min.replace(tzinfo=timezone.utc)) < cutoff]
    suppressed = len(alerts) - len(fresh)
    if fresh:
        p = Path(alerts_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as fh:
            for a in fresh:
                fh.write(json.dumps(a, ensure_ascii=False) + "\n")
    return {"evaluated": True, "alerts": len(alerts), "newAlerts": len(fresh),
            "suppressed": suppressed, "rules": sorted({a["rule"] for a in alerts})}
