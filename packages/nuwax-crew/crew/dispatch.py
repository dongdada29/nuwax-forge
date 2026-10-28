"""派工闭环：把 route 产出的计划落台账（dispatched / failed / completed）。"""

from __future__ import annotations

import json
from pathlib import Path

from . import ledger


def load_plan(path) -> dict:
    plan = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(plan, dict) or "taskKey" not in plan or "assignments" not in plan:
        raise ValueError("派工计划缺少 taskKey/assignments")
    return plan


def mark(plan: dict, ledger_path, status: str, *, roles: set | None = None) -> list:
    if status not in {"dispatched", "failed", "completed"}:
        raise ValueError("status 只能是 dispatched / failed / completed")
    rows = []
    for a in plan.get("assignments", []):
        if roles and a.get("role") not in roles:
            continue
        rows.append(ledger.record(ledger_path, task_key=plan["taskKey"], executor=a["executor"],
                                  role=a.get("role", "unknown"), status=status))
    return rows
