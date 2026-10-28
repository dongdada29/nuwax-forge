"""执行器健康与冷却：订阅/配额问题导致暂时不可用时及时切换。

health 文件形如 {"codex": {"until": "2026-10-27T14:00:00+00:00", "reason": "quota"}}，
`until` 之前路由一律跳过该执行器；过期自动恢复，无需手工清除。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_COOLDOWN_MINUTES = 60
_RESET_IN = re.compile(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?")


class HealthError(ValueError):
    pass


def load(path) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def save(path, state: dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_until(*, iso: str | None = None, reset_in: str | None = None,
                cooldown_minutes: int | None = None, now: datetime | None = None) -> str:
    """把三种输入统一成 ISO 截止时间：ISO 串 / 「125h35m8s」重置倒计时 / 冷却分钟数。"""
    now = now or datetime.now(timezone.utc)
    if iso:
        until = datetime.fromisoformat(iso)
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return until.astimezone(timezone.utc).isoformat(timespec="seconds")
    if reset_in:
        m = _RESET_IN.fullmatch(reset_in.strip())
        if not m or not any(m.groups()):
            raise HealthError(f"无法解析重置倒计时：{reset_in!r}，期望形如 125h35m8s")
        h, mi, s = (int(x or 0) for x in m.groups())
        return (now + timedelta(hours=h, minutes=mi, seconds=s)).isoformat(timespec="seconds")
    return (now + timedelta(minutes=cooldown_minutes or DEFAULT_COOLDOWN_MINUTES)).isoformat(timespec="seconds")


def mark(path, executor: str, reason: str, **kwargs) -> dict:
    if not executor or not reason:
        raise HealthError("executor 与 reason 必填")
    state = load(path)
    state[executor] = {"until": parse_until(**kwargs), "reason": reason}
    save(path, state)
    return state[executor]


def clear(path, executor: str) -> None:
    state = load(path)
    state.pop(executor, None)
    save(path, state)


def blocked(path, now: datetime | None = None) -> dict:
    """返回当前仍在冷却期内的执行器 {name: (until, reason)}；过期项顺带清理。"""
    now = now or datetime.now(timezone.utc)
    state = load(path)
    active, stale = {}, []
    for name, item in state.items():
        until = datetime.fromisoformat(item["until"])
        if until > now:
            active[name] = (item["until"], item["reason"])
        else:
            stale.append(name)
    if stale:
        for name in stale:
            state.pop(name)
        save(path, state)
    return active
