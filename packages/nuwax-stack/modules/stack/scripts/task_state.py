#!/usr/bin/env python3
"""有版本检查、执行租约和完成证据的本地任务状态。"""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import time

PHASES = {"queued", "analyzing", "implementing", "verifying", "waiting", "needs-decision", "blocked", "done"}


class TaskStore:
    def __init__(self, directory, repo_root):
        self.directory = Path(directory).resolve()
        self.repo_root = Path(repo_root).resolve(strict=True)
        if self.directory.is_relative_to(self.repo_root):
            raise ValueError("任务状态必须放在目标仓外")
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.directory / "tasks.sqlite")
        self.db.execute("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, owner TEXT, lease_until REAL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS events (task_id TEXT NOT NULL, revision INTEGER NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task_id,revision))")
        self.db.commit()

    def close(self):
        self.db.close()

    def create(self, task_id, objective, predicates, head):
        if not task_id or not objective or not predicates or any(not isinstance(p, str) or not p.strip() for p in predicates):
            raise ValueError("任务必须有目标和可检查完成条件")
        payload = {"objective": objective, "predicates": predicates, "head": head, "repo_root": str(self.repo_root), "phase": "queued", "next_action": "核对现场", "evidence": []}
        with self.db:
            self.db.execute("INSERT INTO tasks VALUES(?,0,?,NULL,NULL)", (task_id, json.dumps(payload, ensure_ascii=False)))
        return self.read(task_id)

    def read(self, task_id):
        row = self.db.execute("SELECT revision,payload,owner,lease_until FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise ValueError("任务不存在")
        return {"task_id": task_id, "revision": row[0], **json.loads(row[1]), "lease_owner": row[2], "lease_until": row[3]}

    def claim(self, task_id, owner, seconds=120):
        if not owner or seconds <= 0 or seconds > 3600:
            raise ValueError("租约参数无效")
        now = time.time()
        with self.db:
            changed = self.db.execute("UPDATE tasks SET owner=?,lease_until=? WHERE id=? AND (owner IS NULL OR owner=? OR lease_until<?)", (owner, now + seconds, task_id, owner, now)).rowcount
            if changed != 1:
                raise ValueError("已有有效执行者或任务不存在")

    def checkpoint(self, task_id, owner, expected_revision, patch):
        allowed = {"phase", "head", "next_action", "last_action", "evidence", "wake", "blocker"}
        if not isinstance(patch, dict) or set(patch) - allowed:
            raise ValueError("检查点含未知字段")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            current = self.read(task_id)
            if current["revision"] != expected_revision or current["lease_owner"] != owner or (current["lease_until"] or 0) < time.time():
                raise ValueError("检查点版本或执行租约已失效")
            payload = {k: v for k, v in current.items() if k not in {"task_id", "revision", "lease_owner", "lease_until"}}
            payload.update(patch)
            if payload["phase"] not in PHASES:
                raise ValueError("阶段无效")
            if payload["phase"] == "waiting" and not (payload.get("wake", {}).get("id") and payload.get("wake", {}).get("kind")):
                raise ValueError("等待需要实际唤醒句柄；未接入应标 blocked")
            if payload["phase"] == "done":
                verified = set()
                for evidence in payload.get("evidence", []):
                    path = Path(evidence.get("artifact", "")).resolve()
                    if not path.is_relative_to(self.directory) or not path.is_file():
                        raise ValueError("完成证据必须是状态工件区内的真实文件")
                    if evidence.get("passed") is not True or evidence.get("head") != payload["head"] or not evidence.get("command"):
                        raise ValueError("验证未通过、命令缺失或证据 HEAD 过期")
                    if hashlib.sha256(path.read_bytes()).hexdigest() != evidence.get("sha256"):
                        raise ValueError("验证工件已变化")
                    verified.add(evidence.get("predicate"))
                if not set(payload["predicates"]).issubset(verified):
                    raise ValueError("完成条件尚未全部验证")
            revision = expected_revision + 1
            encoded = json.dumps(payload, ensure_ascii=False)
            self.db.execute("UPDATE tasks SET revision=?,payload=? WHERE id=?", (revision, encoded, task_id))
            self.db.execute("INSERT INTO events VALUES(?,?,?,?)", (task_id, revision, datetime.now(timezone.utc).isoformat(), encoded))
        return self.read(task_id)
