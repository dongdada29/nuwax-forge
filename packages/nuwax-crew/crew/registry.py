"""执行器注册表：加载与校验 executors.json。不含密钥。"""

from __future__ import annotations

import json
from pathlib import Path

VALID_TIERS = {"S", "A", "B", "C", "fixed"}
VALID_KINDS = {
    "implementation", "review", "triage", "batch", "docs",
    "research", "web-verification", "platform-query",
}


class RegistryError(ValueError):
    pass


def load(path) -> dict:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return validate(raw)


def validate(raw: dict) -> dict:
    if not isinstance(raw, dict) or "executors" not in raw:
        raise RegistryError("注册表必须包含 executors 列表")
    seen = set()
    executors = []
    for item in raw["executors"]:
        name = item.get("name")
        if not isinstance(name, str) or not name:
            raise RegistryError("执行器必须有 name")
        if name in seen:
            raise RegistryError(f"执行器重名：{name}")
        seen.add(name)
        tier = item.get("tier")
        if tier not in VALID_TIERS:
            raise RegistryError(f"{name}: tier 非法 {tier!r}")
        roles = item.get("roles") or []
        bad = [k for k in roles if k not in VALID_KINDS]
        if bad:
            raise RegistryError(f"{name}: 未知角色 {bad}")
        if not isinstance(item.get("verified", False), bool):
            raise RegistryError(f"{name}: verified 必须是布尔")
        if not isinstance(item.get("enabled", True), bool):
            raise RegistryError(f"{name}: enabled 必须是布尔")
        cost_class = item.get("costClass", "subscription")
        if cost_class not in {"local", "zhipu", "subscription", "api"}:
            raise RegistryError(f"{name}: costClass 只能是 local/zhipu/subscription/api")
        cap = item.get("dailyCap", 20)
        if not isinstance(cap, int) or cap <= 0:
            raise RegistryError(f"{name}: dailyCap 必须是正整数")
        executors.append({
            "name": name,
            "tier": tier,
            "roles": roles,
            "provider": item.get("provider", name),
            "verified": item.get("verified", False),
            "enabled": item.get("enabled", True),
            "subscription": item.get("subscription", ""),
            "costClass": cost_class,
            "costProfile": item.get("costProfile", ""),
            "dailyCap": cap,
            "invocation": item.get("invocation") or {},
            "evidence": item.get("evidence", ""),
        })
    return {"executors": executors, "routing": raw.get("routing", {})}


def by_tier(registry: dict, tier: str) -> list:
    return [e for e in registry["executors"] if e["tier"] == tier]


def find(registry: dict, name: str) -> dict:
    for e in registry["executors"]:
        if e["name"] == name:
            return e
    raise RegistryError(f"注册表中没有执行器 {name}")
