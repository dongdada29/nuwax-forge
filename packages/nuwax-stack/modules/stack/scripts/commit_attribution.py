#!/usr/bin/env python3
"""提交归属自检：校验提交携带 Agent 的 Co-Authored-By trailer 与 worktree 身份。只读，不改仓。"""

from __future__ import annotations

import argparse
import subprocess
import sys

DEFAULT_NAME = "PA-MBP128"
DEFAULT_EMAIL = "noreply@pa-mbp128.local"
TRAILER = f"Co-Authored-By: {DEFAULT_NAME} <{DEFAULT_EMAIL}>"


def git(repo: str, *args: str) -> str:
    out = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} 失败：{out.stderr.strip()}")
    return out.stdout


def check(repo: str, revision: str, *, want_author: bool, expect_executor: str | None = None) -> list:
    problems = []
    body = git(repo, "log", "-1", "--format=%B", revision)
    if TRAILER not in body:
        problems.append(f"提交说明缺少 trailer：{TRAILER}")
    executor_lines = [ln.strip() for ln in body.splitlines() if ln.strip().startswith("Agent-Executor:")]
    if not executor_lines:
        problems.append("缺少 Agent-Executor 行（格式：Agent-Executor: <执行器> / <模型> (<角色>)）")
    if expect_executor and expect_executor not in executor_lines:
        problems.append(f"Agent-Executor 不匹配：期望含 “{expect_executor}”，实际 {executor_lines}")
    if want_author:
        author = git(repo, "log", "-1", "--format=%an %ae", revision).strip()
        if DEFAULT_EMAIL not in author:
            problems.append(f"作者身份不是 {DEFAULT_NAME} <{DEFAULT_EMAIL}>，实际：{author}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--require-author", action="store_true", help="同时校验作者身份为本 Agent")
    parser.add_argument("--expect-executor", default=None, help="校验实际的 Agent-Executor 行，如 “codex / gpt-6.1-sol (implement)”")
    parser.add_argument("--print-setup", action="store_true", help="打印 worktree 本地身份设置命令后退出")
    args = parser.parse_args()

    if args.print_setup:
        print(f'git -C <worktree> config user.name "{DEFAULT_NAME}"')
        print(f'git -C <worktree> config user.email "{DEFAULT_EMAIL}"')
        return 0

    problems = check(args.repo, args.revision, want_author=args.require_author, expect_executor=args.expect_executor)
    if problems:
        for p in problems:
            print(f"不合格：{p}", file=sys.stderr)
        print("补救：git commit --amend 在说明末尾补 trailer（身份用 --print-setup 的命令设置）", file=sys.stderr)
        return 1
    print(f"通过：{args.revision} 已带归属（{TRAILER}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
