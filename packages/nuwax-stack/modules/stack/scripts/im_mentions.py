#!/usr/bin/env python3
"""筛选平台 IM 原始消息页；无网络、凭据读取或文件写入。"""

import argparse
import hashlib
import json
from pathlib import Path


def identifier(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError("ID 必须为整数字符串或 Python 整数，不接受浮点数")
    raw = str(value)
    if not raw.isdecimal() or int(raw) <= 0:
        raise ValueError("ID 必须为正整数")
    return str(int(raw))


def select(profile, envelope, after_seq):
    runtime, handoff = profile["runtime"], profile["handoff"]
    origin = runtime["baseUrl"]
    if not isinstance(origin, str) or not origin.startswith("https://") or origin.endswith("/"):
        raise ValueError("需要明确的 HTTPS origin")
    from urllib.parse import urlsplit
    url = urlsplit(origin)
    if not url.netloc or url.path or url.query or url.fragment or url.username or url.password:
        raise ValueError("平台配置必须为 origin，不能含路径或凭据")
    group = identifier(handoff["sourceGroupId"])
    owner = identifier(handoff["structuredMentionUserId"])
    extra_targets = handoff.get("structuredMentionUserIds") or []
    if not isinstance(extra_targets, list):
        raise ValueError("structuredMentionUserIds 必须是列表")
    accepted = {owner} | {identifier(x) for x in extra_targets}
    agent = identifier(runtime["agentId"])
    subject = identifier(handoff["agentSubjectId"])
    if isinstance(after_seq, bool) or not isinstance(after_seq, int) or after_seq < 0:
        raise ValueError("afterSeq 无效")
    if envelope.get("code") != "0000":
        raise ValueError("IM 业务请求未成功，不能推进游标")
    page = envelope["data"]
    rows, more = page["list"], page["hasMore"]
    if not isinstance(rows, list) or not isinstance(more, bool):
        raise ValueError("消息分页结构不完整")
    selected, seen, previous, cursor = [], set(), 0, after_seq
    for msg in rows:
        seq = msg["seq"]
        if isinstance(seq, bool) or not isinstance(seq, int) or seq <= previous:
            raise ValueError("消息必须按 seq 严格递增；不能跳页或猜游标")
        previous = seq
        if identifier(msg["convId"]) != group:
            raise ValueError("响应混入未授权会话")
        msg_id = identifier(msg["msgId"])
        if msg_id in seen:
            raise ValueError("一页含重复消息 ID")
        seen.add(msg_id)
        cursor = max(cursor, seq)
        if seq <= after_seq or msg["msgStatus"] != 1 or msg["senderType"] != 1:
            continue
        sender = identifier(msg["senderId"])
        if sender == subject:
            continue
        mentions = msg["mentionUserIds"]
        if not isinstance(mentions, list):
            raise ValueError("缺少结构化提及，不按正文推断")
        if accepted.isdisjoint({identifier(x) for x in mentions}):
            continue
        key = f"{origin}|{group}|{msg_id}|{agent}"
        selected.append({"taskId": "im-" + hashlib.sha256(key.encode()).hexdigest()[:24],
                         "sourceKey": key, "convId": group, "msgId": msg_id,
                         "seq": seq, "senderId": sender, "message": msg})
    if more and (not rows or page.get("nextSeq") != previous or previous <= after_seq):
        raise ValueError("后续页游标无效；不能跳过未知消息")
    return {"candidates": selected, "afterSeq": cursor,
            "hasMore": more, "nextSeq": page.get("nextSeq") if more else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--page", type=Path, required=True)
    parser.add_argument("--after-seq", type=int, required=True)
    args = parser.parse_args()
    try:
        result = select(json.loads(args.profile.read_text()), json.loads(args.page.read_text()), args.after_seq)
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, KeyError, TypeError) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
