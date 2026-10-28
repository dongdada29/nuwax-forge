"""调用台账：派工去重、每日配额计数。JSONL，只增不改。"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def _read(path) -> list:
    p = Path(path)
    if not p.exists():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def record(path, *, task_key: str, executor: str, role: str, status: str, ts: str | None = None,
           attempt_id: str | None = None, phase: str | None = None, elapsed_seconds: float | None = None,
           details: dict | None = None) -> dict:
    row = {
        "ts": ts or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "taskKey": task_key,
        "executor": executor,
        "role": role,
        "status": status,
    }
    row.update({k: v for k, v in {"attemptId": attempt_id, "phase": phase, "elapsedSeconds": elapsed_seconds}.items() if v is not None})
    if details is not None:
        row["details"] = details
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def dispatched_keys(path) -> set:
    return {r["taskKey"] for r in _read(path) if r.get("status") == "dispatched"}


def today_counts(path, today: str | None = None) -> Counter:
    day = today or datetime.now(timezone.utc).date().isoformat()
    counts: Counter = Counter()
    for row in _read(path):
        if str(row.get("ts", "")).startswith(day) and row.get("status") == "dispatched":
            counts[row.get("executor")] += 1
    return counts


def summary(path) -> dict:
    rows = _read(path)
    per_executor: Counter = Counter(r.get("executor") for r in rows if r.get("status") == "dispatched")
    return {"total": len(rows), "dispatched": sum(per_executor.values()), "perExecutor": dict(per_executor)}
