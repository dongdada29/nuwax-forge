#!/usr/bin/env python3
"""来源只读、个人字段保留的本地合并与文档写目标检查。"""

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

PHASES = {"待分析", "分析中", "实施中", "验证中", "待决策", "受阻", "待验收", "已完成"}


def check_write_target(policy, base_url, page_id):
    expected = str(policy.get("baseUrl", "")).rstrip("/")
    parsed = urlsplit(expected)
    if parsed.scheme != "https" or parsed.path not in {"", "/"} or parsed.username or parsed.query or parsed.fragment:
        raise ValueError("台账必须配置明确的 HTTPS origin")
    owned = policy.get("ownedLedgerPageId")
    if owned is None or str(owned) in {"", "0"}:
        raise ValueError("未登记自有台账 ID")
    sources = {str(item) for item in policy.get("sourcePageIds", [])}
    if base_url.rstrip("/") != expected or str(page_id) != str(owned) or str(page_id) in sources:
        raise ValueError("拒绝写入来源文档、其他文档或其他环境")
    if policy.get("writeSourceDocuments") is not False or policy.get("syncDirection") != "source-to-owned-only":
        raise ValueError("只允许单向同步到自有台账")
    return str(owned)


def merge_sources(state, records, policy, observed_at=None):
    result = deepcopy(state)
    result.setdefault("tasks", {})
    result.setdefault("events", [])
    allowed = {str(item) for item in policy.get("sourcePageIds", [])}
    now = observed_at or datetime.now(timezone.utc).isoformat()
    for record in records:
        page_id, item_id = str(record["source_page_id"]), str(record["source_record_id"])
        if page_id not in allowed or not item_id or len(item_id) > 200:
            raise ValueError("来源未配置或条目 ID 无效")
        key = page_id + ":" + item_id
        source = {k: deepcopy(record.get(k)) for k in ["title", "source_status", "source_url", "source_version", "withdrawn", "source_owner", "identity_kind", "scope"]}
        source.update(source_page_id=page_id, source_record_id=item_id)
        previous = result["tasks"].get(key)
        if previous is None:
            previous = {"personal": {"phase": "待分析", "notes": "", "evidence": [], "next_action": "核对已有代码与验证证据"}}
            result["tasks"][key] = previous
        changed = previous.get("source") != source
        previous["source"] = source
        previous["observed_at"] = now
        if changed:
            result["events"].append({"task_id": key, "type": "source-observed", "at": now, "source": deepcopy(source)})
    return result


def update_progress(state, key, phase, notes=None, evidence=None, next_action=None):
    if phase not in PHASES:
        raise ValueError("未知个人阶段")
    if phase == "已完成" and not evidence:
        raise ValueError("完成必须带验证证据")
    result = deepcopy(state)
    personal = result["tasks"][key]["personal"]
    personal["phase"] = phase
    for field, value in [("notes", notes), ("evidence", evidence), ("next_action", next_action)]:
        if value is not None:
            personal[field] = value
    result["events"].append({"task_id": key, "type": "personal-progress", "at": datetime.now(timezone.utc).isoformat(), "personal": deepcopy(personal)})
    return result


def render_markdown(state):
    def cell(value):
        return str(value or "—").replace("|", "\\|").replace("\n", " ").replace("<", "&lt;").replace(">", "&gt;")

    lines = ["# 罗东研发工作台账", "", "团队原文档只读。本台账记录个人处理进度，用于与团队对接；个人完成不回写原问题状态。", "",
             "| 来源条目 | 问题 / 需求 | 源状态 | 我的阶段 | 读取时间 | 证据 / 下一步 |",
             "| --- | --- | --- | --- | --- | --- |"]
    for key, task in sorted(state.get("tasks", {}).items()):
        source, personal = task["source"], task["personal"]
        detail = "; ".join(personal.get("evidence", [])) or personal.get("next_action", "")
        url = str(source.get("source_url") or "")
        label = cell(key)
        link = f"[{label}]({url})" if url.startswith("https://agent.nuwax.com/repo/doc/") and not any(c in url for c in "()\\\n") else label
        title = str(source.get("title") or "")
        if len(title) > 180:
            title = title[:180] + "…（完整描述见来源）"
        lines.append("| " + " | ".join([link] + list(map(cell, [title, source.get("source_status"), personal["phase"], task.get("observed_at"), detail]))) + " |")
    lines += ["", "## 使用规则", "", "- 来源更新只刷新源字段；个人进度、证据和备注保留。", "- 源表显示已处理，不代表本机代码和验收已核对。", "- 已提交、测试通过、设备验收、上线分别记录，不混写。", "- 同步失败保留上次读取时间；源条目撤回只标记待核对，不删除个人记录。"]
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--records", type=Path)
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--check-write", type=str)
    parser.add_argument("--base-url")
    args = parser.parse_args()
    policy = json.loads(args.policy.read_text(encoding="utf-8"))
    if args.check_write is not None:
        check_write_target(policy, args.base_url or "", args.check_write)
        print("allowed-owned-ledger")
        return
    state = json.loads(args.state.read_text(encoding="utf-8")) if args.state.exists() else {"tasks": {}, "events": []}
    if args.records:
        state = merge_sources(state, json.loads(args.records.read_text(encoding="utf-8")), policy)
        args.state.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.state.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(args.state)
    if args.render:
        print(render_markdown(state), end="")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(f"台账失败: {error}") from None
