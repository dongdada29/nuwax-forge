#!/usr/bin/env python3
"""在明确配置的仓外目录追加去重的分析记录。"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import sys

FIELDS = {"record_id", "task_id", "conversation_id", "message_id", "repository", "head", "phase", "decision", "reason", "evidence", "next_action"}
PHASES = {"triaged", "analyzed", "awaiting-approval", "blocked", "handoff"}


def append_record(directory, repo_root, record):
    root = Path(repo_root).resolve(strict=True)
    target = Path(directory).resolve()
    if not root.is_dir() or target.is_relative_to(root):
        raise ValueError("日志目录必须在目标仓之外")
    if not isinstance(record, dict) or set(record) != FIELDS:
        raise ValueError("记录字段不完整或含未知字段")
    if any(not isinstance(record[key], str) or not record[key].strip() for key in FIELDS - {"evidence"}):
        raise ValueError("记录文本字段不能为空")
    if record["phase"] not in PHASES or Path(record["repository"]).resolve() != root:
        raise ValueError("阶段或目标仓不符")
    if not isinstance(record["evidence"], list) or any(not isinstance(item, str) for item in record["evidence"]):
        raise ValueError("evidence 必须是引用字符串数组")
    if len(json.dumps(record, ensure_ascii=False).encode("utf-8")) > 16 * 1024:
        raise ValueError("记录超出 16 KiB，请使用简短证据引用")
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = target / ".append.lock"
    lock_fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        path = target / "decisions.jsonl"
        if path.is_symlink():
            raise ValueError("日志文件不能是软链")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "r+", encoding="utf-8") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ValueError("日志必须是普通文件")
            for line in handle:
                if not line.endswith("\n"):
                    raise ValueError("已有日志尾行不完整，请先核对原记录")
                old = json.loads(line)
                if old["record_id"] == record["record_id"]:
                    previous = {key: old[key] for key in FIELDS}
                    if previous != record:
                        raise ValueError("record_id 已用于不同内容，请保留原事件并创建新轮次")
                    return "duplicate"
            stored = {**record, "recorded_at": datetime.now(timezone.utc).isoformat()}
            handle.write(json.dumps(stored, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        return "appended"
    finally:
        os.close(lock_fd)
        lock.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--repo-root", required=True, type=Path)
    args = parser.parse_args()
    raw = sys.stdin.read(16 * 1024 + 1)
    if len(raw) > 16 * 1024:
        raise ValueError("输入超出大小限制")
    record = json.loads(raw)
    status = append_record(args.directory, args.repo_root, record)
    print(json.dumps({"status": status, "record_id": record["record_id"]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(f"记录失败: {error}") from None
