#!/usr/bin/env python3
"""从只读试点仓一次性导入三个源码包到本仓 packages/，并记录 provenance。

用法：
  python3 -I scripts/import_from_pilot.py            # 一次性导入：目标包目录非空即拒绝
  python3 -I scripts/import_from_pilot.py --check    # 只读校验：对照 provenance.json 复核 sha256

规则（与 docs/MIGRATION.md 一致）：
- 一次性导入（不是可重跑覆盖）：目标非空立即失败，防止覆盖导入后的整合改动。
- 复制包含未跟踪实现与 dot 配置；**跳过并记录源 symlink**（不把外链搬进新仓）。
- 排除：.git、node_modules、dist、__pycache__、*.pyc、.DS_Store、debug-shots、midscene_run、
  真实 registry（registries/ 下非 example 文件）、所有 .env 与 .env.*（明确放行合成 .env.example）、
  运行证据目录。
- 只读源：不调用 git 写命令，不改源仓；仅读取 HEAD 与 status。
- --check 模式全程只读：重算目标文件 sha256 与 provenance.json 比对，报告漂移，退出码 0/1。
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PILOT = Path("/Users/apple/Documents/Codex/2026-10-27/client-efficiency-pilot")
TARGETS = {
    "nuwax-stack": PILOT / "worktrees/nuwax-stack",
    "nuwax-crew": PILOT / "worktrees/nuwax-crew",
    "nuwa-sdlc-kit": PILOT / "worktrees/nuwa-sdlc-kit",
}
REPO_ROOT = Path(__file__).resolve().parents[1]
PROVENANCE = REPO_ROOT / "provenance" / "provenance.json"
EXCLUDED_DIR_NAMES = {".git", "node_modules", "dist", "__pycache__", "debug-shots", "midscene_run", "evidence", ".vercel"}
EXCLUDED_FILE_SUFFIXES = (".pyc", ".pyo", ".DS_Store")
# 凭据类 env：.env、.env.local、.env.* 一律排除；仅明确放行合成 .env.example
ENV_ALLOWED = {".env.example"}


def excluded(rel_path: Path) -> str | None:
    for part in rel_path.parts:
        if part in EXCLUDED_DIR_NAMES:
            return f"目录黑名单:{part}"
    name = rel_path.name
    if name.startswith(".env"):
        if name not in ENV_ALLOWED:
            return "凭据类 env 文件"
    if name.endswith(EXCLUDED_FILE_SUFFIXES):
        return f"后缀黑名单:{name}"
    # 真实 registry：registries/ 下全部排除（合成 registry.example.json 只在根目录，不在此列）
    if len(rel_path.parts) >= 2 and rel_path.parts[0] == "registries":
        return "真实 registry 目录"
    return None


def git_output(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "--no-optional-locks", *args], cwd=cwd, text=True,
                          capture_output=True, check=True).stdout.strip()


def copy_tree(src: Path, dst: Path) -> tuple[dict[str, str], list[str], list[str], list[str]]:
    """复制并返回 (rel->sha256, 排除项, 复制项, 跳过的 symlink)。"""
    hashes: dict[str, str] = {}
    excluded_log: list[str] = []
    copied_log: list[str] = []
    symlink_log: list[str] = []
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src)
        reason = excluded(rel)
        if reason is not None:
            excluded_log.append(f"{rel.as_posix()} ({reason})")
            continue
        if path.is_symlink():
            symlink_log.append(f"{rel.as_posix()} -> {path.readlink()}")
            continue  # 拒绝搬入 symlink（绝对外链/相对链均不复制，只记录）
        if not path.is_file():
            continue
        data = path.read_bytes()
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        hashes[rel.as_posix()] = hashlib.sha256(data).hexdigest()
        copied_log.append(rel.as_posix())
    return hashes, excluded_log, copied_log, symlink_log


def run_import() -> int:
    for name, src in TARGETS.items():
        dst = REPO_ROOT / "packages" / name
        if not src.is_dir():
            print(f"missing source {src}", file=sys.stderr)
            return 1
        if dst.exists() and any(dst.iterdir()):
            print(f"拒绝导入：目标目录非空（一次性导入，不覆盖整合改动）：{dst}", file=sys.stderr)
            print("如需复核来源与当前文件是否漂移，请用只读模式：python3 -I scripts/import_from_pilot.py --check", file=sys.stderr)
            return 1
    provenance: dict = {
        "importedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tool": "scripts/import_from_pilot.py（一次性导入；--check 为只读复核）",
        "sourcePilotRoot": str(PILOT),
        "policy": [
            "只读源，未修改源仓/客户端/个人配置/凭据/服务",
            "一次性导入：目标非空即拒绝，不重跑覆盖整合改动",
            "包含未跟踪实现与 dot 配置；跳过并记录源 symlink",
            "排除 .git/node_modules/dist/__pycache__/debug-shots/midscene_run/真实 registry/运行证据/.env*（放行 .env.example）",
        ],
        "packages": {},
    }
    for name, src in TARGETS.items():
        dst = REPO_ROOT / "packages" / name
        head = git_output(src, "rev-parse", "HEAD")
        branch = git_output(src, "rev-parse", "--abbrev-ref", "HEAD")
        status = git_output(src, "status", "--porcelain")
        hashes, excluded_log, copied_log, symlink_log = copy_tree(src, dst)
        provenance["packages"][name] = {
            "source": str(src),
            "branch": branch,
            "head": head,
            "dirtyStatus": [line for line in status.splitlines() if line.strip()],
            "copiedFileCount": len(hashes),
            "fileSha256": hashes,
            "excluded": excluded_log,
            "skippedSymlinks": symlink_log,
        }
        print(f"{name}: HEAD={head[:12]} dirty={len(status.splitlines())} copied={len(hashes)} "
              f"excluded={len(excluded_log)} skippedSymlinks={len(symlink_log)}")
    PROVENANCE.parent.mkdir(parents=True, exist_ok=True)
    PROVENANCE.write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n")
    print(f"provenance -> {PROVENANCE.relative_to(REPO_ROOT)}")
    return 0


def run_check() -> int:
    if not PROVENANCE.is_file():
        print("provenance.json 不存在：先完成一次性导入", file=sys.stderr)
        return 1
    data = json.loads(PROVENANCE.read_text())
    drift = 0
    for name, record in data["packages"].items():
        dst = REPO_ROOT / "packages" / name
        recorded = record["fileSha256"]
        for rel, expected in sorted(recorded.items()):
            target = dst / rel
            try:
                actual = hashlib.sha256(target.read_bytes()).hexdigest()
            except OSError:
                print(f"DRIFT {name}/{rel}: 文件缺失")
                drift += 1
                continue
            if actual != expected:
                print(f"DRIFT {name}/{rel}: sha256 变化（导入后已被修改或需重新核对）")
                drift += 1
        for extra in sorted(p.relative_to(dst).as_posix() for p in dst.rglob("*") if p.is_file()):
            if extra not in recorded:
                print(f"NEW   {name}/{extra}: 导入后新增文件")
        print(f"{name}: recorded={len(recorded)} drift={drift}")
    if drift:
        print(f"共 {drift} 处漂移（整合改动属预期；源侧核对请比对源仓当前状态）")
        return 1
    print("OK 目标文件与导入 provenance 逐字节一致")
    return 0


if __name__ == "__main__":
    sys.exit(run_check() if "--check" in sys.argv else run_import())
