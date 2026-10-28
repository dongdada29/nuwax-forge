#!/usr/bin/env python3
"""有版本检查、执行租约和完成证据的本地任务状态。"""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import os
import platform
import shutil
import subprocess

PHASES = {"queued", "analyzing", "implementing", "verifying", "waiting", "needs-decision", "blocked", "done"}


def verification_files(repo_root, inputs):
    root = Path(repo_root).resolve(strict=True)
    found = {}

    def visit(relative):
        raw = root / relative
        if raw.is_symlink():
            raise ValueError("验证输入不允许软链")
        target = raw.resolve(strict=True)
        if not target.is_relative_to(root):
            raise ValueError("验证输入超出目标仓")
        if target.is_dir():
            for child in sorted(target.iterdir()):
                if child.name not in {".git", "node_modules"}:
                    visit(child.relative_to(root))
        elif target.is_file():
            found[target.relative_to(root).as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()

    if not isinstance(inputs, list) or not inputs or any(not isinstance(x, str) or not x for x in inputs):
        raise ValueError("验证输入缺失")
    for value in inputs:
        visit(value)
    return [{"path": key, "sha256": found[key]} for key in sorted(found)]


def validate_verification(manifest_path, repo_root, required_predicates=(), expected_level=None, node_executable=None):
    manifest_path = Path(manifest_path).resolve(strict=True)
    root = Path(repo_root).resolve(strict=True)
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1 or data.get("kind") != "nuwax-verification" or data.get("passed") is not True:
        raise ValueError("验证未通过或契约版本不支持")
    source = data.get("source", {})
    head = subprocess.check_output(["git", "--no-optional-locks", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    if source.get("root") != str(root) or source.get("head") != head:
        raise ValueError("验证工作区或 HEAD 过期")
    recipe_path = root / data.get("recipePath", "")
    if recipe_path.is_symlink() or not recipe_path.resolve().is_relative_to(root) or not recipe_path.is_file():
        raise ValueError("验证配方路径无效")
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    expected_inputs = list(dict.fromkeys(recipe.get("inputs", []) + [recipe_path.relative_to(root).as_posix()]))
    if source.get("inputs") != expected_inputs or data.get("recipe") != recipe.get("id") or data.get("level") != recipe.get("level"):
        raise ValueError("验证配方不匹配")
    files = verification_files(root, expected_inputs)
    digest = hashlib.sha256("".join(f["path"] + "\0" + f["sha256"] + "\n" for f in files).encode()).hexdigest()
    if source.get("files") != files or source.get("inputDigest") != digest:
        raise ValueError("验证输入已变化")
    env = data.get("environment", {})
    # Node 版本只来自显式可信运行配置或本机 PATH；绝不执行 manifest 里的 environment.nodeExecutable。
    node = str(Path(node_executable).resolve(strict=True)) if node_executable else shutil.which("node")
    version = subprocess.check_output([node, "--version"], text=True).strip() if node else None
    if env.get("hostname") != platform.node() or env.get("platform") != {"Darwin": "darwin", "Windows": "win32"}.get(platform.system(), platform.system().lower()) or env.get("arch") != {"aarch64": "arm64", "x86_64": "x64", "AMD64": "x64"}.get(platform.machine(), platform.machine()) or env.get("node") != version:
        raise ValueError("验证运行环境已变化")
    if expected_level and data.get("level") != expected_level:
        raise ValueError("验证层级不匹配")
    predicates = data.get("predicates", [])
    expected = [stage["predicate"] for stage in recipe.get("stages", [])]
    if not expected or [p.get("id") for p in predicates] != expected or any(p.get("passed") is not True for p in predicates):
        raise ValueError("验证条件缺失或未通过")
    if not set(required_predicates).issubset(expected):
        raise ValueError("完成条件尚未全部验证")
    stages = data.get("stages", [])
    if len(stages) != len(expected) or any(stage.get("passed") is not True or stage.get("exitCode") != 0 for stage in stages):
        raise ValueError("验证阶段未全部执行成功")
    artifacts = data.get("artifacts", [])
    if len(artifacts) != len(stages):
        raise ValueError("验证日志缺失")
    for artifact in artifacts:
        raw = manifest_path.parent / artifact.get("path", "")
        target = raw.resolve(strict=True)
        if raw.is_symlink() or not target.is_relative_to(manifest_path.parent) or not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != artifact.get("sha256"):
            raise ValueError("验证工件已变化或超出证据目录")
    if not data.get("command"):
        raise ValueError("验证缺少重跑命令")
    return data


class TaskStore:
    def __init__(self, directory, repo_root, node_executable=None):
        self.directory = Path(directory).resolve()
        self.repo_root = Path(repo_root).resolve(strict=True)
        self.node_executable = str(Path(node_executable).resolve(strict=True)) if node_executable else None
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

    def release(self, task_id, owner):
        with self.db:
            changed = self.db.execute("UPDATE tasks SET owner=NULL,lease_until=NULL WHERE id=? AND owner=?",
                                      (task_id, owner)).rowcount
            if changed != 1:
                raise ValueError("不能释放其他执行者的租约")

    def accept_verification(self, task_id, owner, expected_revision, manifest_path, expected_level=None):
        path = Path(manifest_path).resolve(strict=True)
        if not path.is_relative_to(self.directory):
            raise ValueError("验证 manifest 必须位于任务状态工件区")
        current = self.read(task_id)
        data = validate_verification(path, self.repo_root, current["predicates"], expected_level, self.node_executable)
        if data["source"]["head"] != current["head"]:
            raise ValueError("任务 HEAD 与验证 HEAD 不匹配")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        evidence = [{"predicate": p, "artifact": str(path), "sha256": digest, "passed": True,
                     "head": current["head"], "command": data["command"], "verification_manifest": True}
                    for p in current["predicates"]]
        return self.checkpoint(task_id, owner, expected_revision, {
            "phase": "done", "evidence": evidence, "last_action": "导入已验证配方结果", "next_action": "交付"})

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
                    if evidence.get("verification_manifest") is True:
                        validate_verification(path, self.repo_root, payload["predicates"], node_executable=self.node_executable)
                    verified.add(evidence.get("predicate"))
                if not set(payload["predicates"]).issubset(verified):
                    raise ValueError("完成条件尚未全部验证")
            revision = expected_revision + 1
            encoded = json.dumps(payload, ensure_ascii=False)
            self.db.execute("UPDATE tasks SET revision=?,payload=? WHERE id=?", (revision, encoded, task_id))
            self.db.execute("INSERT INTO events VALUES(?,?,?,?)", (task_id, revision, datetime.now(timezone.utc).isoformat(), encoded))
        return self.read(task_id)
