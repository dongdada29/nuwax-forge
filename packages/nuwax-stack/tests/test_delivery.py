import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import sync_platform as sync

spec = importlib.util.spec_from_file_location("append_record", ROOT / "skills/nuwax-stack/scripts/append_record.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class FakePlatform:
    def __init__(self):
        self.calls = []
        self.skills = {}
        self.corrupt_export = False
        self.reject_add = False
        self.numeric_string_id = False
        self.defer_publish = False

    def __enter__(self):
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, body, binary=False):
                blob = body if binary else json.dumps(body).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Length", str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                fixture.calls.append(("POST", self.path, body))
                if self.headers.get("Authorization") != "Bearer test-only":
                    return self.respond({"code": "4030"})
                if self.path.endswith("/skill/add"):
                    if fixture.reject_add:
                        return self.respond({"code": "4000", "message": "not accepted"})
                    skill_id = len(fixture.skills) + 1
                    fixture.skills[skill_id] = {**body, "contents": {}, "publishStatus": "Developing"}
                    result = str(skill_id) if fixture.numeric_string_id else skill_id
                elif self.path.endswith("/skill/update"):
                    skill_id = body["id"]
                    result = None
                elif self.path.endswith("/publish/apply"):
                    target = fixture.skills[body["targetId"]]
                    if not body.get("category"):
                        return self.respond({"code": "4000", "message": "Please select a category"})
                    if any(item.get("scope") == "Space" and item.get("spaceId") != target["spaceId"] for item in body["items"]):
                        return self.respond({"code": "4000", "message": "spaceId required for Space publication"})
                    if not fixture.defer_publish:
                        fixture.skills[body["targetId"]]["publishStatus"] = "Published"
                    return self.respond({"code": "0000", "data": None})
                else:
                    return self.respond({"code": "4040"})
                for file in body["files"]:
                    if file["operation"] == "delete":
                        fixture.skills[skill_id]["contents"].pop(file["name"], None)
                    else:
                        fixture.skills[skill_id]["contents"][file["name"]] = file["contents"].encode("utf-8")
                self.respond({"code": "0000", "data": result})

            def do_GET(self):
                fixture.calls.append(("GET", self.path, None))
                skill_id = int(self.path.rsplit("/", 1)[1])
                skill = fixture.skills[skill_id]
                if "/skill/export/" in self.path:
                    files = dict(skill["contents"])
                    if fixture.corrupt_export:
                        files["SKILL.md"] = b"wrong bytes"
                    blob = sync.skill_zip({"name": skill["name"], "files": files})
                    return self.respond(blob, binary=True)
                self.respond({"code": "0000", "data": {"name": skill["name"], "spaceId": skill["spaceId"], "publishStatus": skill["publishStatus"]}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class PackageTests(unittest.TestCase):
    def test_dry_run_never_reads_credentials_or_network(self):
        class ForbiddenEnvironment(dict):
            def get(self, key, default=None):
                if key in {"SANDBOX_ACCESS_KEY", "PLATFORM_BASE_URL", "HOME"}:
                    raise AssertionError("dry-run accessed credentials or home")
                return super().get(key, default)

        with tempfile.TemporaryDirectory() as td, mock.patch.object(sync.os, "environ", ForbiddenEnvironment()), mock.patch.object(sync.urllib.request, "build_opener", side_effect=AssertionError("network")), contextlib.redirect_stdout(io.StringIO()):
            sync.main(["--dry-run", "--output", td])
            manifest = json.loads((Path(td) / "manifest.json").read_text())
            self.assertEqual([item["name"] for item in manifest], ["nuwax-stack"])
            preview = json.loads((Path(td) / "platform-preview.json").read_text())
            self.assertTrue(all(item["body"]["spaceId"] is None for item in preview))
            for item in manifest:
                with zipfile.ZipFile(Path(td) / f"{item['name']}.zip") as archive:
                    self.assertIn(f"{item['name']}/SKILL.md", archive.namelist())

    def test_archives_are_reproducible_and_contain_real_resources(self):
        skill = sync.collect_skill(ROOT / "skills/nuwax-stack")
        self.assertEqual(sync.skill_zip(skill), sync.skill_zip(skill))
        files = sync.export_files(sync.skill_zip(skill), skill["name"])
        for helper in ["append_record.py", "task_state.py", "ledger.py"]:
            self.assertIn("scripts/" + helper, files)
        self.assertEqual([name for name in files if name.endswith("SKILL.md")], ["SKILL.md"])

    def test_package_rejects_symlinks_and_missing_references(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "example-skill"
            root.mkdir()
            skill_md = '---\nname: example-skill\ndescription: example\nmetadata:\n  version: "0.1.0"\n---\n'
            (root / "SKILL.md").write_text(skill_md + "[ref](references/missing.md)\n")
            with self.assertRaisesRegex(ValueError, "引用"):
                sync.collect_skill(root)
            (root / "SKILL.md").write_text(skill_md)
            (root / "leaked.md").symlink_to(root / "SKILL.md")
            with self.assertRaisesRegex(ValueError, "软链"):
                sync.collect_skill(root)

    def test_publish_requires_explicit_apply(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            sync.main(["--publish"])


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state_path = Path(self.temp.name) / "state.json"
        self.skill = sync.collect_skill(ROOT / "skills/nuwax-stack")

    def run_sync(self, platform, state, publish=False):
        return sync.sync_one(sync.Client(platform.base, "test-only"), self.skill, 123, state, self.state_path, publish, category="dev")

    def test_publish_without_category_stops_before_creating_draft(self):
        with FakePlatform() as platform:
            with self.assertRaisesRegex(ValueError, "分类代码"):
                sync.sync_one(sync.Client(platform.base, "test-only"), self.skill, 123, {"skills": {}}, self.state_path, publish=True)
            self.assertEqual(platform.calls, [])

    def test_create_then_update_and_publish_without_duplicate_skill(self):
        with FakePlatform() as platform:
            state = {"skills": {}}
            first = self.run_sync(platform, state)
            self.assertFalse(first["published"])
            self.assertFalse(any(path.endswith("/publish/apply") for _, path, _ in platform.calls))
            platform.skills[1]["contents"]["old.md"] = b"obsolete"
            state = json.loads(self.state_path.read_text())
            second = self.run_sync(platform, state, publish=True)
            self.assertTrue(second["published"])
            self.assertEqual(len(platform.skills), 1)
            self.assertNotIn("old.md", platform.skills[1]["contents"])
            update = next(body for _, path, body in platform.calls if path.endswith("/skill/update"))
            self.assertIn({"name": "old.md", "contents": "", "operation": "delete", "isDir": False}, update["files"])

    def test_export_mismatch_blocks_publish(self):
        with FakePlatform() as platform:
            platform.corrupt_export = True
            with self.assertRaisesRegex(ValueError, "不一致"):
                self.run_sync(platform, {"skills": {}}, publish=True)
            self.assertFalse(any(path.endswith("/publish/apply") for _, path, _ in platform.calls))
            self.assertEqual(json.loads(self.state_path.read_text())["skills"][self.skill["name"]]["id"], 1)

    def test_numeric_string_id_is_saved_as_integer(self):
        with FakePlatform() as platform:
            platform.numeric_string_id = True
            result = self.run_sync(platform, {"skills": {}})
            self.assertEqual(result["id"], 1)
            self.assertIs(type(result["id"]), int)

    def test_business_error_is_failure_and_add_is_not_retried(self):
        with FakePlatform() as platform:
            platform.reject_add = True
            with self.assertRaisesRegex(ValueError, "业务失败"):
                self.run_sync(platform, {"skills": {}})
            state = json.loads(self.state_path.read_text())
            with self.assertRaisesRegex(ValueError, "禁止重复 add"):
                self.run_sync(platform, state)
            self.assertEqual(len(platform.calls), 1)

    def test_unconfirmed_publish_is_not_reported_successful(self):
        with FakePlatform() as platform:
            platform.defer_publish = True
            with self.assertRaisesRegex(ValueError, "尚未确认"):
                self.run_sync(platform, {"skills": {}}, publish=True)

    def test_wrong_environment_stops_before_http(self):
        state = {"base_url": "https://wrong.example", "space_id": 123, "skills": {}}
        self.state_path.write_text(json.dumps(state))
        with FakePlatform() as platform, mock.patch.dict(os.environ, {"SANDBOX_ACCESS_KEY": "test-only"}):
            with self.assertRaisesRegex(ValueError, "目标环境不符"):
                sync.main(["--apply", "--base-url", platform.base, "--space-id", "123", "--state", str(self.state_path)])
            self.assertEqual(platform.calls, [])


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.directory = Path(self.temp.name) / "audit"
        self.record = {"record_id": "conv1:msg1:analyzed:1", "task_id": "conv1:msg1", "conversation_id": "conv1", "message_id": "msg1", "repository": str(self.root), "head": "abc1234", "phase": "analyzed", "decision": "建议修复重复发送", "reason": "静态证据", "evidence": ["src/send.ts:42"], "next_action": "隔离复现"}

    def test_replay_is_deduplicated_and_repository_stays_untouched(self):
        self.assertEqual(audit.append_record(self.directory, self.root, self.record), "appended")
        self.assertEqual(audit.append_record(self.directory, self.root, self.record), "duplicate")
        lines = (self.directory / "decisions.jsonl").read_text().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["decision"], self.record["decision"])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_log_inside_repository_and_symlink_escape_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "目标仓之外"):
            audit.append_record(self.root / "logs", self.root, self.record)
        link = Path(self.temp.name) / "link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "目标仓之外"):
            audit.append_record(link / "logs", self.root, self.record)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_conflicting_replay_preserves_original(self):
        audit.append_record(self.directory, self.root, self.record)
        path = self.directory / "decisions.jsonl"
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, "不同内容"):
            audit.append_record(self.directory, self.root, {**self.record, "decision": "改变结论"})
        self.assertEqual(path.read_bytes(), before)

    def test_existing_lock_is_not_removed(self):
        self.directory.mkdir()
        lock = self.directory / ".append.lock"
        lock.write_text("another writer")
        with self.assertRaises(FileExistsError):
            audit.append_record(self.directory, self.root, self.record)
        self.assertEqual(lock.read_text(), "another writer")

    def test_unterminated_log_is_preserved_without_appending(self):
        self.directory.mkdir()
        path = self.directory / "decisions.jsonl"
        path.write_text(json.dumps({**self.record, "record_id": "old-record"}))
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, "不完整"):
            audit.append_record(self.directory, self.root, self.record)
        self.assertEqual(path.read_bytes(), before)

    def test_cli_stdin_can_be_used_from_extracted_unified_package(self):
        package = sync.skill_zip(sync.collect_skill(ROOT / "skills/nuwax-stack"))
        installed = Path(self.temp.name) / "installed"
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            archive.extractall(installed)
        path = installed / "nuwax-stack/scripts/append_record.py"
        proc = subprocess.run([sys.executable, "-B", str(path), "--directory", str(self.directory), "--repo-root", str(self.root)], input=json.dumps(self.record), text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(proc.stdout)["status"], "appended")


if __name__ == "__main__":
    unittest.main()
