"""订阅与执行器用量聚合：从派工台账 + 注册表统计，支持时间窗。纯函数。"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

OK_STATUSES = {"completed", "success"}
FAILED_STATUSES = {"failed"}


def load_rows(ledger_path) -> list:
    p = Path(ledger_path)
    if not p.exists():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def _sub_label(executor: dict) -> str:
    return executor.get("subscription") or executor.get("costProfile") or executor.get("costClass") or executor.get("name", "?")


def aggregate(rows: list, registry: dict, *, today: str | None = None, days: int = 7,
              now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    today = today or now.date().isoformat()
    window_start = (now.timestamp() - days * 86400)

    executors = {e["name"]: e for e in registry.get("executors", [])}
    per_executor = defaultdict(lambda: {"total": 0, "ok": 0, "failed": 0, "window": 0, "today": 0, "lastTs": ""})
    per_subscription = defaultdict(lambda: {"executors": set(), "total": 0, "ok": 0, "failed": 0, "window": 0})
    per_day = defaultdict(lambda: defaultdict(int))

    for r in rows:
        name = r.get("executor", "?")
        status = r.get("status", "")
        ts = str(r.get("ts", ""))
        e = per_executor[name]
        e["total"] += 1
        if status in OK_STATUSES:
            e["ok"] += 1
        if status in FAILED_STATUSES:
            e["failed"] += 1
        e["lastTs"] = max(e["lastTs"], ts)
        day = ts[:10]
        per_day[day][name] += 1
        try:
            in_window = datetime.fromisoformat(ts).timestamp() >= window_start
        except ValueError:
            in_window = False
        if in_window:
            e["window"] += 1
        if day == today:
            e["today"] += 1

    for name, stats in per_executor.items():
        meta = executors.get(name, {})
        label = _sub_label(meta) if meta else "未注册执行器"
        sub = per_subscription[label]
        sub["executors"].add(name)
        for k in ("total", "ok", "failed", "window"):
            sub[k] += stats[k]

    subs_out = {}
    for label, s in per_subscription.items():
        subs_out[label] = {
            "executors": sorted(s["executors"]), "total": s["total"], "ok": s["ok"],
            "failed": s["failed"], "window": s["window"],
            "okRate": round(s["ok"] / s["total"], 3) if s["total"] else None,
        }

    exec_out = {}
    for name, meta in executors.items():
        stats = per_executor.get(name, {"total": 0, "ok": 0, "failed": 0, "window": 0, "today": 0, "lastTs": ""})
        exec_out[name] = {
            **stats, "tier": meta.get("tier"), "costClass": meta.get("costClass"),
            "subscription": _sub_label(meta), "verified": meta.get("verified", False),
            "enabled": meta.get("enabled", True), "dailyCap": meta.get("dailyCap"),
            "okRate": round(stats["ok"] / stats["total"], 3) if stats["total"] else None,
        }

    return {"today": today, "days": days, "perExecutor": exec_out,
            "perSubscription": subs_out,
            "perDay": {d: dict(v) for d, v in sorted(per_day.items())}}


def summary(ledger_path, registry: dict, **kw) -> dict:
    return aggregate(load_rows(ledger_path), registry, **kw)
