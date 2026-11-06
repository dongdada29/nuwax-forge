"""执行器注册表：加载与校验 executors.json。不含密钥。"""

from __future__ import annotations

import json
from pathlib import Path

VALID_TIERS = {"S", "A", "B", "C", "fixed"}
VALID_KINDS = {
    "implementation", "review", "triage", "batch", "docs",
    "research", "web-verification", "platform-query",
}
# 模型分层（轻量模型分类路由的地基；V0 只声明不路由，分类路由等真实模型验收后再启用）
VALID_MODEL_CLASSES = {"light", "standard", "heavy"}


class RegistryError(ValueError):
    pass


def _normalize_models(executor_name: str, raw_models) -> list:
    """models 声明（可选）：[{id, class?(light/standard/heavy), contextK?, verified?, evidence?}]。

    纯字符串条目视为 id 简写（class 记空=未分层，兼容旧自由格式）。
    V0 只做声明与校验，不改路由行为；台账行执行器实际所用模型仍按 AGENTS.md 单独记录。
    """
    if raw_models is None:
        return []
    if not isinstance(raw_models, list):
        raise RegistryError(f"{executor_name}: models 必须是数组")
    seen = set()
    models = []
    for item in raw_models:
        if isinstance(item, str):
            item = {"id": item}
        if not isinstance(item, dict):
            raise RegistryError(f"{executor_name}: models 条目必须是对象或字符串")
        model_id = item.get("id")
        if not isinstance(model_id, str) or not model_id.strip():
            raise RegistryError(f"{executor_name}: models[].id 必填且非空")
        if model_id in seen:
            raise RegistryError(f"{executor_name}: models 重名 {model_id}")
        seen.add(model_id)
        model_class = item.get("class", "")
        if model_class and model_class not in VALID_MODEL_CLASSES:
            raise RegistryError(f"{executor_name}: models[{model_id}] class 只能是 "
                                f"{'/'.join(sorted(VALID_MODEL_CLASSES))}（省略=未分层）")
        context_k = item.get("contextK")
        if context_k is not None and (isinstance(context_k, bool) or not isinstance(context_k, int)
                                      or context_k <= 0):
            raise RegistryError(f"{executor_name}: models[{model_id}] contextK 必须是正整数")
        if not isinstance(item.get("verified", False), bool):
            raise RegistryError(f"{executor_name}: models[{model_id}] verified 必须是布尔")
        models.append({"id": model_id, "class": model_class,
                       "contextK": context_k,
                       "verified": item.get("verified", False),
                       "evidence": item.get("evidence", "")})
    return models


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
            "models": _normalize_models(name, item.get("models")),
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
