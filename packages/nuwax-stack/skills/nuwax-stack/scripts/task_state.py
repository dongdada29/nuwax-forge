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
import argparse
import sys

MAX_JSON_BYTES = 65536
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
        # Additive local ledger tables; existing tasks/events rows are never rewritten.
        self.db.execute("CREATE TABLE IF NOT EXISTS triggers (trigger_key TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, identity_hash TEXT NOT NULL, payload TEXT NOT NULL, task_id TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS assignments (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS assignment_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, operation TEXT NOT NULL, operation_hash TEXT NOT NULL, revision INTEGER NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(attempt_id,operation))")
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


    def _json(self, value, label):
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if len(encoded.encode()) > MAX_JSON_BYTES:
            raise ValueError(label + "超出大小限制")
        return encoded

    def record_trigger(self, data):
        source, source_id = data.get("source"), data.get("sourceId")
        classification, thread_id = data.get("classification"), data.get("threadId")
        identity = data.get("identity", {})
        if not isinstance(source, str) or not source.strip() or len(source) > 128 or not isinstance(source_id, str) or not source_id.strip() or len(source_id) > 256:
            raise ValueError("Trigger source/sourceId 无效")
        if classification not in {"candidate", "context-only"} or (thread_id is not None and (not isinstance(thread_id, str) or not thread_id or len(thread_id) > 256)):
            raise ValueError("Trigger 分类或 threadId 无效")
        if not isinstance(identity, dict) or set(identity) - {"senderId", "accountId", "tenantId", "eventType"} or any(not isinstance(v, str) or not v or len(v) > 256 for v in identity.values()) or len(self._json(identity, "identity")) > 2048:
            raise ValueError("Trigger identity 无效")
        # Only bounded metadata is accepted; callers must pass pointers/summaries, never message bodies.
        allowed = {"source", "sourceId", "classification", "threadId", "identity", "summary", "resourceRefs"}
        if set(data) - allowed:
            raise ValueError("Trigger 含未知字段")
        summary = data.get("summary", "")
        refs = data.get("resourceRefs", [])
        if not isinstance(summary, str) or len(summary) > 512 or not isinstance(refs, list) or len(refs) > 32 or any(not isinstance(x, str) or not x or len(x) > 512 for x in refs):
            raise ValueError("Trigger 元数据超限")
        core = {"source": source, "sourceId": source_id, "classification": classification, "threadId": thread_id, "identity": identity, "summary": summary, "resourceRefs": refs}
        identity_hash = hashlib.sha256(self._json(core, "Trigger").encode()).hexdigest()
        key = hashlib.sha256((source + "\0" + source_id).encode()).hexdigest()
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            old = self.db.execute("SELECT identity_hash,payload,task_id FROM triggers WHERE trigger_key=?", (key,)).fetchone()
            if old:
                if old[0] != identity_hash:
                    raise ValueError("Trigger 键已绑定不同身份或内容")
                return {"triggerKey": key, "duplicate": True, "trigger": json.loads(old[1]), "taskId": old[2]}
            encoded = self._json(core, "Trigger")
            self.db.execute("INSERT INTO triggers(trigger_key,source,source_id,identity_hash,payload) VALUES(?,?,?,?,?)", (key, source, source_id, identity_hash, encoded))
        return {"triggerKey": key, "duplicate": False, "trigger": core, "taskId": None}

    def read_trigger(self, key):
        if not isinstance(key, str) or len(key) != 64:
            raise ValueError("Trigger key 无效")
        row = self.db.execute("SELECT identity_hash,payload,task_id FROM triggers WHERE trigger_key=?", (key,)).fetchone()
        if not row: raise ValueError("Trigger 不存在")
        return {"triggerKey": key, "trigger": json.loads(row[1]), "taskId": row[2]}

    def admit(self, data):
        trigger_key, task_id = data.get("triggerKey"), data.get("taskId")
        admission, mandate = data.get("admission"), data.get("mandate")
        allowed = {"triggerKey", "taskId", "admission", "mandate", "objective", "predicates", "head"}
        if set(data) - allowed:
            raise ValueError("Ticket 输入含未知字段")
        if not isinstance(trigger_key, str) or len(trigger_key) != 64:
            raise ValueError("Trigger key 无效")
        if not isinstance(admission, dict) or set(admission) != {"kind", "actor", "evidenceRef"} or admission.get("kind") != "explicit" or not all(isinstance(admission.get(k), str) and admission[k].strip() and len(admission[k]) <= 512 for k in ("actor", "evidenceRef")):
            raise ValueError("admission 必须为 explicit 且包含 actor/evidenceRef")
        if not isinstance(mandate, dict) or set(mandate) - {"writePaths", "argvCommands", "maxModelCalls"}:
            raise ValueError("Mandate 字段无效")
        paths, commands = mandate.get("writePaths"), mandate.get("argvCommands")
        if not isinstance(paths, list) or len(paths) > 64 or any(not isinstance(p, str) or not p.strip() or len(p) > 512 or Path(p).is_absolute() or ".." in Path(p).parts for p in paths) or len(set(paths)) != len(paths):
            raise ValueError("Mandate writePaths 必须是仓库相对路径")
        if not isinstance(commands, list) or len(commands) > 32 or any(not isinstance(c, list) or not c or len(c) > 32 or any(not isinstance(x, str) or not x or len(x) > 512 for x in c) for c in commands):
            raise ValueError("Mandate argvCommands 无效")
        if "maxModelCalls" in mandate and (not isinstance(mandate["maxModelCalls"], int) or isinstance(mandate["maxModelCalls"], bool) or not 0 <= mandate["maxModelCalls"] <= 10000):
            raise ValueError("Mandate maxModelCalls 无效")
        task_id, objective, predicates, head = data.get("taskId"), data.get("objective"), data.get("predicates"), data.get("head")
        if not isinstance(task_id, str) or not 1 <= len(task_id) <= 256 or not isinstance(objective, str) or not objective.strip() or len(objective) > 4096 or not isinstance(predicates, list) or not predicates or len(predicates) > 64 or any(not isinstance(p, str) or not p.strip() or len(p) > 512 for p in predicates) or not isinstance(head, str) or not head.strip() or len(head) > 256:
            raise ValueError("Ticket 必须有 taskId、目标、head 和有界完成条件")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            row = self.db.execute("SELECT payload,task_id FROM triggers WHERE trigger_key=?", (trigger_key,)).fetchone()
            if not row: raise ValueError("Trigger 不存在")
            trigger = json.loads(row[0])
            if trigger["classification"] != "candidate": raise ValueError("context-only Trigger 不能创建 Ticket")
            if row[1]:
                existing = self.read(row[1])
                ticket = existing.get("ticket", {})
                requested = {"triggerKey": trigger_key, "threadId": trigger.get("threadId"), "admission": admission, "mandate": mandate}
                if task_id != row[1] or (existing["objective"], existing["predicates"], existing["head"], ticket) != (objective, predicates, head, requested):
                    raise ValueError("Trigger 已绑定不同 Ticket 内容")
                return existing
            payload = {"objective": objective, "predicates": predicates, "head": head, "repo_root": str(self.repo_root), "phase": "queued", "next_action": "核对现场", "evidence": []}
            payload["ticket"] = {"triggerKey": trigger_key, "threadId": trigger.get("threadId"), "admission": admission, "mandate": mandate}
            self.db.execute("INSERT INTO tasks VALUES(?,0,?,NULL,NULL)", (task_id, self._json(payload, "Ticket")))
            self.db.execute("UPDATE triggers SET task_id=? WHERE trigger_key=?", (task_id, trigger_key))
        return self.read(task_id)

    def assignment(self, data, operation):
        task_id, attempt_id, owner = data.get("taskId"), data.get("attemptId"), data.get("owner")
        expected = data.get("expectedRevision")
        if not all(isinstance(x, str) and 1 <= len(x) <= 256 for x in (task_id, attempt_id, owner)) or not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            raise ValueError("Assignment 身份或 revision 无效")
        extra = {k: v for k, v in data.items() if k not in {"taskId", "attemptId", "owner", "expectedRevision"}}
        operation_fields = {
            "assignment-prepare": {"executor", "role", "model", "sessionId", "contextRefs"},
            "assignment-start": {"sessionId"},
            "assignment-report": {"reportSummary", "usage"},
            "assignment-finish": {"status"},
        }
        if operation not in operation_fields or set(extra) - operation_fields[operation]: raise ValueError("Assignment 操作含未知字段")
        encoded_extra = self._json(extra, "Assignment")
        digest = hashlib.sha256((operation + "\0" + task_id + "\0" + owner + "\0" + encoded_extra).encode()).hexdigest()
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            prior = self.db.execute("SELECT operation_hash,payload FROM assignment_events WHERE attempt_id=? AND operation=?", (attempt_id, operation)).fetchone()
            if prior:
                if prior[0] != digest: raise ValueError("同一 Assignment 操作 ID 内容冲突")
                return json.loads(prior[1])
            task = self.read(task_id)
            if task["revision"] != expected or task["lease_owner"] != owner or (task["lease_until"] or 0) <= time.time():
                raise ValueError("Assignment revision 或有效租约不匹配")
            old = self.db.execute("SELECT task_id,state,payload FROM assignments WHERE attempt_id=?", (attempt_id,)).fetchone()
            if operation == "assignment-prepare":
                if old: raise ValueError("attemptId 已存在")
                state = "prepared"
                payload = {"executor": data.get("executor"), "role": data.get("role"), "model": data.get("model"), "sessionId": data.get("sessionId"), "contextRefs": data.get("contextRefs", []), "reportSummary": None, "usage": {"tokens": None, "modelCalls": None}}
                if not isinstance(payload["executor"], str) or not payload["executor"].strip(): raise ValueError("Assignment executor 必填")
                for key in ("executor", "role", "model", "sessionId"):
                    if payload[key] is not None and (not isinstance(payload[key], str) or not payload[key].strip() or len(payload[key]) > 512): raise ValueError("Assignment 字符串无效")
                if not isinstance(payload["contextRefs"], list) or len(payload["contextRefs"]) > 64 or any(not isinstance(x, str) or not x or len(x) > 1024 for x in payload["contextRefs"]): raise ValueError("contextRefs 无效")
            else:
                if not old or old[0] != task_id: raise ValueError("Assignment attempt 不存在")
                state, payload = old[1], json.loads(old[2])
                if operation == "assignment-start" and state == "prepared":
                    session_id = data.get("sessionId", payload.get("sessionId"))
                    if session_id is not None and (not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 512): raise ValueError("sessionId 无效")
                    payload["sessionId"] = session_id
                    state = "running"
                elif operation == "assignment-report" and state == "running":
                    summary, usage = data.get("reportSummary"), data.get("usage", {})
                    if not isinstance(summary, str) or not summary.strip() or len(summary) > 2048 or not isinstance(usage, dict) or set(usage) - {"tokens", "modelCalls"}: raise ValueError("报告/usage 无效")
                    for k in ("tokens", "modelCalls"):
                        if usage.get(k) is not None and (not isinstance(usage[k], int) or isinstance(usage[k], bool) or usage[k] < 0): raise ValueError("usage 无效")
                    payload["reportSummary"], payload["usage"] = summary, {k: usage.get(k) for k in ("tokens", "modelCalls")}
                    state = "reported"
                elif operation == "assignment-finish" and state == "reported" and data.get("status") in {"succeeded", "failed", "blocked", "cancelled"}: state = data["status"]
                else: raise ValueError("Assignment 状态转换无效")
            revision = expected + 1
            result = {"taskId": task_id, "attemptId": attempt_id, "state": state, "revision": revision, **payload}
            encoded = self._json(result, "Assignment")
            encoded_payload = self._json(payload, "Assignment")
            if old:
                self.db.execute("UPDATE assignments SET state=?,payload=?,revision=? WHERE attempt_id=?", (state, encoded_payload, revision, attempt_id))
            else:
                self.db.execute("INSERT INTO assignments(attempt_id,task_id,state,payload,revision) VALUES(?,?,?,?,?)", (attempt_id, task_id, state, encoded_payload, revision))
            task_payload = {k: v for k, v in task.items() if k not in {"task_id", "revision", "lease_owner", "lease_until"}}
            task_payload["last_assignment"] = {"attempt_id": attempt_id, "state": state}
            encoded_task = self._json(task_payload, "任务状态")
            self.db.execute("UPDATE tasks SET revision=?,payload=? WHERE id=?", (revision, encoded_task, task_id))
            at = datetime.now(timezone.utc).isoformat()
            self.db.execute("INSERT INTO events VALUES(?,?,?,?)", (task_id, revision, at, encoded_task))
            self.db.execute("INSERT INTO assignment_events(task_id,attempt_id,operation,operation_hash,revision,at,payload) VALUES(?,?,?,?,?,?,?)", (task_id, attempt_id, operation, digest, revision, at, encoded))
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["trigger-record", "trigger-read", "ticket-admit", "ticket-read", "assignment-prepare", "assignment-start", "assignment-report", "assignment-finish"])
    parser.add_argument("--input", required=True)
    args = parser.parse_args()
    with Path(args.input).open("rb") as input_file:
        raw = input_file.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES: raise ValueError("输入文件超过 64 KiB")
    data = json.loads(raw)
    if not isinstance(data, dict): raise ValueError("输入必须是 JSON object")
    repo, directory = data.get("repoRoot"), data.get("stateDirectory")
    if not isinstance(repo, str) or not Path(repo).is_absolute() or not isinstance(directory, str) or not Path(directory).is_absolute(): raise ValueError("repoRoot 与 stateDirectory 必须是绝对路径")
    store = TaskStore(directory, repo)
    try:
        operation_data = {k: v for k, v in data.items() if k not in {"repoRoot", "stateDirectory"}}
        if args.command == "trigger-record": out = store.record_trigger(operation_data)
        elif args.command in {"trigger-read", "ticket-read"}:
            if args.command == "trigger-read": out = store.read_trigger(data.get("triggerKey"))
            else:
                out = store.read(data.get("taskId"))
                out["assignments"] = [{"attemptId": r[0], "state": r[1], **json.loads(r[2]), "revision": r[3]} for r in store.db.execute("SELECT attempt_id,state,payload,revision FROM assignments WHERE task_id=? ORDER BY revision DESC LIMIT 100", (data.get("taskId"),))]
        elif args.command == "ticket-admit": out = store.admit(operation_data)
        else: out = store.assignment(operation_data, args.command)
        output = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
        if len(output.encode()) > MAX_JSON_BYTES: raise ValueError("输出超出大小限制")
        print(output)
    finally: store.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
