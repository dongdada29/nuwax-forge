#!/usr/bin/env python3
"""离线打包；显式 --apply 写草稿，额外 --publish 才发布。"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "/api/v1/4sandbox"
IGNORED = {".DS_Store", "__pycache__"}


def collect_skill(directory):
    directory = Path(directory)
    if directory.is_symlink():
        raise ValueError("技能目录不能是软链")
    files = {}
    for path in sorted(directory.rglob("*")):
        rel = path.relative_to(directory)
        if any(part in IGNORED for part in rel.parts):
            continue
        if path.is_symlink() or any(part.startswith(".") for part in rel.parts):
            raise ValueError(f"拒绝分发软链或隐藏文件: {rel}")
        if path.is_file():
            blob = path.read_bytes()
            blob.decode("utf-8", errors="strict")
            files[rel.as_posix()] = blob
    text = files.get("SKILL.md", b"").decode("utf-8")
    front = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not front:
        raise ValueError(f"{directory.name}: 缺少 frontmatter")
    fields = {}
    for key in ("name", "description"):
        match = re.search(rf"^{key}: (.+)$", front[1], re.M)
        if not match:
            raise ValueError(f"缺少 {key}")
        fields[key] = match[1].strip()
    if fields["name"] != directory.name or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", fields["name"]):
        raise ValueError("技能 name 必须与目录名一致且使用小写连字符")
    version = re.search(r'^  version: "(\d+\.\d+\.\d+)"$', front[1], re.M)
    if not version:
        raise ValueError("缺少 metadata.version")
    for rel, blob in files.items():
        if not rel.endswith(".md"):
            continue
        for target in re.findall(r"\]\(([^)]+)\)", blob.decode("utf-8")):
            if ":" in target or target.startswith("#"):
                continue
            path = (directory / rel).parent / target.split("#", 1)[0]
            if not path.resolve().is_relative_to(directory.resolve()) or not path.is_file():
                raise ValueError(f"技能引用不在包内或不存在: {rel} -> {target}")
    return {**fields, "version": version[1], "files": files}


def skill_zip(skill):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for rel, blob in sorted(skill["files"].items()):
            info = zipfile.ZipInfo(f"{skill['name']}/{rel}", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, blob)
    return stream.getvalue()


def export_files(blob, name):
    files = {}
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        total = 0
        for info in archive.infolist():
            path = PurePosixPath(info.filename)
            if not path.parts or path.is_absolute() or ".." in path.parts or "\\" in info.filename or path.parts[0] != name:
                raise ValueError("导出包包含非预期路径")
            if info.is_dir():
                continue
            rel = PurePosixPath(*path.parts[1:]).as_posix()
            if rel == "." or rel in files:
                raise ValueError("导出包路径重复或无效")
            total += info.file_size
            if total > 20 * 1024 * 1024:
                raise ValueError("导出包超出核验大小限制")
            files[rel] = archive.read(info)
    return files


def request_body(skill, space_id, remote=None, skill_id=None):
    remote = remote or {}
    files = [{"name": rel, "contents": blob.decode("utf-8"), "operation": "modify" if rel in remote else "create", "isDir": False}
             for rel, blob in sorted(skill["files"].items())]
    files += [{"name": rel, "contents": "", "operation": "delete", "isDir": False}
              for rel in sorted(set(remote) - set(skill["files"]))]
    body = {"name": skill["name"], "description": skill["description"], "spaceId": space_id,
            "usageScenarios": ["TaskAgent", "ChatBot"], "files": files}
    if skill_id is not None:
        body["id"] = skill_id
    return body


def build_preview(skills, output, space_id=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    manifest, requests = [], []
    for skill in skills:
        blob = skill_zip(skill)
        (output / f"{skill['name']}.zip").write_bytes(blob)
        manifest.append({"name": skill["name"], "version": skill["version"],
                         "zipSha256": hashlib.sha256(blob).hexdigest(),
                         "files": {rel: hashlib.sha256(data).hexdigest() for rel, data in sorted(skill["files"].items())}})
        requests.append({"method": "POST", "path": PREFIX + "/skill/add", "body": request_body(skill, space_id)})
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "platform-preview.json").write_text(json.dumps(requests, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base, token):
        parsed = urllib.parse.urlsplit(base)
        local = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if (parsed.scheme != "https" and not (parsed.scheme == "http" and local)) or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("平台地址必须是 HTTPS origin；仅本机假服务可用 HTTP")
        if not token or "\n" in token or "\r" in token:
            raise ValueError("缺少或无效 SANDBOX_ACCESS_KEY")
        self.base = base.rstrip("/")
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None, binary=False):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
        req = urllib.request.Request(self.base + PREFIX + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(req, timeout=20) as response:
                blob = response.read(10 * 1024 * 1024 + 1)
        except urllib.error.HTTPError as error:
            raise ValueError(f"平台 HTTP {error.code}，请求停止") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ValueError("平台连接失败或结果不明，未自动重试") from None
        if len(blob) > 10 * 1024 * 1024:
            raise ValueError("平台响应超出大小限制")
        if binary:
            return blob
        try:
            result = json.loads(blob)
        except (ValueError, UnicodeDecodeError):
            raise ValueError("平台返回非 JSON 结果") from None
        if not isinstance(result, dict) or result.get("code") != "0000":
            raise ValueError("平台业务失败（code 非 0000），未自动重试")
        return result.get("data")


def save_state(path, state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".platform-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sync_one(client, skill, space_id, state, state_path, publish=False, category=None):
    if publish and (not isinstance(category, str) or not category.strip()):
        raise ValueError("发布需要目标平台的分类代码 category")
    entry = state["skills"].get(skill["name"], {})
    if entry.get("pending_create"):
        raise ValueError("上次创建结果不明；先核对平台草稿和本机状态，禁止重复 add")
    skill_id = entry.get("id")
    remote = {}
    if skill_id is not None:
        if type(skill_id) is not int or skill_id <= 0:
            raise ValueError("状态中的 skill ID 无效")
        detail = client.request("GET", f"/skill/{skill_id}")
        if not isinstance(detail, dict) or detail.get("name") != skill["name"] or detail.get("spaceId", space_id) != space_id:
            raise ValueError("平台草稿名称或空间与状态不符")
        remote = export_files(client.request("GET", f"/skill/export/{skill_id}", binary=True), skill["name"])
        client.request("POST", "/skill/update", request_body(skill, space_id, remote, skill_id))
    else:
        state["skills"][skill["name"]] = {"pending_create": True}
        save_state(state_path, state)
        skill_id = client.request("POST", "/skill/add", request_body(skill, space_id))
        if isinstance(skill_id, str) and re.fullmatch(r"[1-9][0-9]*", skill_id):
            skill_id = int(skill_id)
        if type(skill_id) is not int or skill_id <= 0:
            raise ValueError("创建返回的 ID 无效；请核对平台草稿")
        state["skills"][skill["name"]] = {"id": skill_id}
        save_state(state_path, state)
    exported = export_files(client.request("GET", f"/skill/export/{skill_id}", binary=True), skill["name"])
    if exported != skill["files"]:
        raise ValueError("导出内容与本地不一致，停止发布")
    if publish:
        client.request("POST", "/publish/apply", {"targetType": "Skill", "targetId": skill_id,
                       "remark": f"{skill['name']} v{skill['version']}",
                       "category": category,
                       "items": [{"scope": "Space", "spaceId": space_id, "allowCopy": 1, "onlyTemplate": 0}]})
        detail = client.request("GET", f"/skill/{skill_id}")
        if not isinstance(detail, dict) or detail.get("publishStatus") != "Published":
            raise ValueError("发布状态尚未确认，保留 ID 后停止")
    return {"name": skill["name"], "id": skill_id, "verified": True, "published": publish}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skills", nargs="*")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true")
    modes.add_argument("--apply", action="store_true")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--category", help="目标平台技能分类代码；发布必填，例如开发部署 dev")
    parser.add_argument("--space-id", type=int)
    parser.add_argument("--base-url")
    parser.add_argument("--state", type=Path, default=ROOT / ".local/platform-state.json")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args(argv)
    if args.publish and not args.apply:
        parser.error("--publish 需要 --apply")
    if args.publish and (not args.category or not args.category.strip()):
        parser.error("--publish 需要 --category 分类代码")
    available = {p.name: p for p in (ROOT / "skills").iterdir() if p.is_dir()}
    if any(name not in available for name in args.skills):
        parser.error("技能名称不在仓库中")
    skills = [collect_skill(available[name]) for name in sorted(set(args.skills or available))]
    if not args.apply:
        result = build_preview(skills, args.output, args.space_id)
        print(json.dumps({"mode": "offline", "skills": len(result), "output": str(args.output)}, ensure_ascii=False))
        return
    if args.space_id is None or args.space_id <= 0:
        parser.error("--apply 需要已确认的正整数 --space-id")
    client = Client(args.base_url or os.environ.get("PLATFORM_BASE_URL", ""), os.environ.get("SANDBOX_ACCESS_KEY", ""))
    args.state.parent.mkdir(parents=True, exist_ok=True)
    lock = args.state.with_suffix(".lock")
    lock_fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        state = json.loads(args.state.read_text(encoding="utf-8")) if args.state.exists() else {"base_url": client.base, "space_id": args.space_id, "skills": {}}
        if state.get("base_url") != client.base or state.get("space_id") != args.space_id or not isinstance(state.get("skills"), dict):
            raise ValueError("状态与目标环境不符，请为不同环境使用独立 --state")
        for skill in skills:
            print(json.dumps(sync_one(client, skill, args.space_id, state, args.state, args.publish, args.category), ensure_ascii=False))
    finally:
        os.close(lock_fd)
        lock.unlink()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        raise SystemExit(f"失败: {error}") from None
