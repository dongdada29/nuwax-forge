import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "skills/nuwax-stack/scripts/commit_attribution.py"
spec = importlib.util.spec_from_file_location("commit_attribution", SCRIPT)
ca = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ca)


def run(*args):
    return subprocess.run([sys.executable, "-B", str(SCRIPT), *args], capture_output=True, text=True)


class CommitAttributionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "-C", str(self.repo), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.name", "罗东"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.email", "luodong@example.com"], check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, message: str, *, agent_identity: bool = False):
        if agent_identity:
            subprocess.run(["git", "-C", str(self.repo), "config", "user.name", ca.DEFAULT_NAME], check=True)
            subprocess.run(["git", "-C", str(self.repo), "config", "user.email", ca.DEFAULT_EMAIL], check=True)
        (self.repo / "f.txt").write_text(f"x{subprocess.run(['git','-C',str(self.repo),'rev-parse','--short','HEAD'],capture_output=True,text=True).stdout.strip()}", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-q", "-m", message], check=True)

    def test_plain_commit_fails_check(self):
        self.commit("普通提交")
        r = run("--repo", str(self.repo))
        self.assertEqual(r.returncode, 1)
        self.assertIn("缺少 trailer", r.stderr)

    def test_commit_with_trailer_passes(self):
        self.commit(f"修复登录倒计时\n\n{ca.TRAILER}\nAgent-Executor: pa-mbp128-agent / deepseek-v4.1-flash (implement)")
        r = run("--repo", str(self.repo))
        self.assertEqual(r.returncode, 0)

    def test_trailer_without_executor_line_fails(self):
        self.commit(f"缺执行器行\n\n{ca.TRAILER}")
        r = run("--repo", str(self.repo))
        self.assertEqual(r.returncode, 1)
        self.assertIn("Agent-Executor", r.stderr)

    def test_expect_executor_match_and_mismatch(self):
        self.commit(f"带执行器\n\n{ca.TRAILER}\nAgent-Executor: codex / gpt-6.1-sol (implement)")
        ok = run("--repo", str(self.repo), "--expect-executor", "Agent-Executor: codex / gpt-6.1-sol (implement)")
        self.assertEqual(ok.returncode, 0)
        bad = run("--repo", str(self.repo), "--expect-executor", "Agent-Executor: cursor / x (implement)")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("不匹配", bad.stderr)

    def test_author_check_requires_agent_identity(self):
        self.commit(f"带 trailer\n\n{ca.TRAILER}\nAgent-Executor: pa-mbp128-agent / deepseek-v4.1-flash (implement)", agent_identity=True)
        r = run("--repo", str(self.repo), "--require-author")
        self.assertEqual(r.returncode, 0)
        self.commit("换身份再提交")  # 回到罗东身份且无 trailer
        r2 = run("--repo", str(self.repo), "--require-author")
        self.assertEqual(r2.returncode, 1)

    def test_print_setup_outputs_local_config(self):
        r = run("--repo", str(self.repo), "--print-setup")
        self.assertEqual(r.returncode, 0)
        self.assertIn(ca.DEFAULT_EMAIL, r.stdout)
        self.assertNotIn("--global", r.stdout)

    def test_check_function_is_read_only(self):
        self.commit(f"校验只读\n\n{ca.TRAILER}")
        before = subprocess.run(["git", "-C", str(self.repo), "status", "--porcelain"], capture_output=True, text=True).stdout
        ca.check(str(self.repo), "HEAD", want_author=False)
        after = subprocess.run(["git", "-C", str(self.repo), "status", "--porcelain"], capture_output=True, text=True).stdout
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
