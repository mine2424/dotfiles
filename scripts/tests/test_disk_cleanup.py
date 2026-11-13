"""Destructive paths are exercised only inside temporary fixture directories."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("disk_cleanup", SCRIPTS / "disk-cleanup.py")
cleanup = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cleanup
spec.loader.exec_module(cleanup)


class Idle:
    error = ""
    commands = ""
    def reason(self, path):
        return ""
    def has_tools(self, tools):
        return False


class Busy(Idle):
    def reason(self, path):
        return "実行中プロセスが参照"


def age_tree(root):
    old = time.time() - 90 * 86400
    for parent, dirs, files in os.walk(root, topdown=False):
        for name in files:
            if not (Path(parent) / name).is_symlink():
                os.utime(Path(parent) / name, (old, old))
        os.utime(parent, (old, old))


class DiskCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.repo = self.home / "development/project"
        self.repo.mkdir(parents=True)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        (self.repo / ".gitignore").write_text("build/\n.build/\nnode_modules/\n")
        (self.repo / "source.txt").write_text("source")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.build = self.repo / "build"
        self.build.mkdir()
        (self.build / "artifact").write_text("regenerable")
        age_tree(self.repo)
        self.config = cleanup.load_config(None)
        self.config.update(development_roots=[str(self.repo.parent)], keep_paths=[], keep_runtimes=[])
        self.args = cleanup.parse_args(["--deep", "--only", "artifacts", "--yes"])

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def reason(self):
        return cleanup.artifact_reason(self.build, self.config, Idle(), 30)

    def test_ignored_old_artifact_is_deleted_but_source_is_preserved(self):
        items = cleanup.make_plan(self.args, self.config, Idle(), self.home)
        self.assertEqual(len(items), 1)
        self.assertFalse(items[0].blocked)
        with patch.object(cleanup, "Activity", Idle):
            self.assertTrue(cleanup.execute(items[0], self.args, self.config, self.home))
        self.assertFalse(self.build.exists())
        self.assertEqual((self.repo / "source.txt").read_text(), "source")

    def test_nonignored_and_tracked_build_are_preserved(self):
        (self.repo / ".gitignore").write_text("")
        age_tree(self.repo)
        self.assertIn("除外対象ではない", self.reason())
        self.git("add", "-f", "build/artifact")
        (self.repo / ".gitignore").write_text("build/\n")
        age_tree(self.repo)
        self.assertIn("Git管理", self.reason())

    def test_recent_generated_file_and_deep_source_file_are_preserved(self):
        (self.build / "artifact").touch()
        self.assertIn("更新", self.reason())
        deep = self.repo / "src/a/b/c/d"
        deep.mkdir(parents=True)
        (deep / "source.py").write_text("recent")
        age_tree(self.repo)
        (deep / "source.py").touch()
        self.assertIn("更新", self.reason())

    def test_recent_nested_build_in_cache_is_not_pruned_from_age_scan(self):
        nested = self.build / "node_modules/build"
        nested.mkdir(parents=True)
        (nested / "recent").write_text("recent")
        age_tree(self.repo)
        (nested / "recent").touch()
        self.assertFalse(cleanup.old_tree(self.build, 30))

    def test_protection_covers_ancestors_descendants_and_symlink_parents(self):
        self.config["keep_paths"] = [str(self.build / "artifact")]
        self.assertIn("keep_paths", self.reason())
        self.config["keep_paths"] = [str(self.repo)]
        self.assertIn("keep_paths", self.reason())
        link = self.home / "linked"
        link.symlink_to(self.repo, target_is_directory=True)
        self.assertIn("シンボリック", cleanup.kept(link / "build", self.config))
        artifacts, _, _ = cleanup.discover([link])
        self.assertEqual(artifacts, [])

    def test_busy_and_failed_activity_queries_preserve_data(self):
        self.assertIn("実行中", cleanup.artifact_reason(self.build, self.config, Busy(), 30))
        with patch.object(cleanup, "query", side_effect=RuntimeError("fixture failure")):
            activity = cleanup.Activity()
        self.assertIn("失敗", activity.reason(self.repo))
        item = cleanup.Item("artifacts", str(self.build), self.build, 1)
        with patch.object(cleanup, "Activity", Busy):
            self.assertFalse(cleanup.execute(item, self.args, self.config, self.home))
        self.assertTrue(self.build.exists())

    def test_process_guard_does_not_confuse_google_with_go(self):
        activity = cleanup.Activity.__new__(cleanup.Activity)
        activity.names = ["/Applications/Google Chrome", "/usr/bin/python3"]
        self.assertFalse(activity.has_tools(("go",)))
        self.assertTrue(activity.has_tools(("chrome",)))
        activity.names.append("/tools/go")
        self.assertTrue(activity.has_tools(("go",)))

    def test_safe_clears_idle_fresh_cache_but_keeps_busy_and_recent_npx(self):
        cache = self.home / ".gradle/caches"
        cache.mkdir(parents=True)
        (cache / "recent").write_text("regenerable")
        self.assertFalse(cleanup.cache_reason(cache, self.config, Idle(), 30))
        self.assertIn("実行中", cleanup.cache_reason(cache, self.config, Busy(), 30))
        npx = self.home / ".npm/_npx/recent"
        npx.mkdir(parents=True)
        (npx / "package.json").write_text("{}")
        self.assertIn("更新", cleanup.cache_reason(npx, self.config, Idle(), 30))

    def test_own_selected_path_is_not_misidentified_as_another_active_process(self):
        output = ["p100\ncfixture\nn/unrelated\n",
                  "100 50 python3\n50 1 zsh\n1 0 launchd\n200 1 node\n",
                  f"100 python3 disk-cleanup.py --artifact {self.build}\n50 zsh {self.build}\n200 node /another/project\n"]
        with patch.object(cleanup.os, "getpid", return_value=100), patch.object(cleanup, "query", side_effect=output):
            activity = cleanup.Activity()
        self.assertFalse(activity.error)
        self.assertFalse(activity.reason(self.repo))
        self.assertTrue(activity.has_tools(("node",)))

    def test_explicit_artifact_only_relaxes_age_and_limits_selection(self):
        (self.build / "artifact").touch()
        args = cleanup.parse_args(["--deep", "--artifact", str(self.build), "--dry-run"])
        self.assertEqual(args.categories, {"artifacts"})
        items = cleanup.make_plan(args, self.config, Idle(), self.home)
        self.assertEqual([i.path for i in items], [self.build])
        self.assertFalse(items[0].blocked)
        self.assertIn("実行中", cleanup.artifact_reason(self.build, self.config, Busy(), 30, selected=True))
        self.config["keep_paths"] = [str(self.repo)]
        self.assertIn("keep_paths", cleanup.artifact_reason(self.build, self.config, Idle(), 30, selected=True))
        with self.assertRaisesRegex(ValueError, "探索対象"):
            cleanup.select_paths([self.build], [str(self.repo / "source.txt")], "成果物")

    def test_explicit_runtime_does_not_select_other_categories(self):
        self.assertEqual(cleanup.parse_args(["--deep", "--runtime", "old"]).categories, {"simulators"})

    def test_discovery_finds_orca_and_swift_builds_without_following_dependencies(self):
        swift = self.repo / "client/.build"
        swift.mkdir(parents=True)
        deps = self.repo / "node_modules/dependency/build"
        deps.mkdir(parents=True)
        wt = self.home / "orca/workspaces/repo/task"
        wt.mkdir(parents=True)
        (wt / ".git").write_text("gitdir: /example")
        artifacts, worktrees, errors = cleanup.discover([self.home, self.repo])
        self.assertIn(swift, artifacts)
        self.assertNotIn(deps, artifacts)
        self.assertEqual(artifacts.count(self.build), 1)
        self.assertEqual(worktrees, [wt])
        self.assertEqual(errors, [])

    def simulator_fixture(self):
        runtimes = {
            "old": {"identifier": "old", "runtimeIdentifier": "ios-26", "version": "26.5",
                    "deletable": True, "sizeBytes": 1024},
            "new": {"identifier": "new", "runtimeIdentifier": "ios-27", "version": "27.2",
                    "deletable": True, "sizeBytes": 2048},
        }
        devices = {"devices": {"ios-26": [{"udid": "device", "name": "iPad", "state": "Shutdown"}]}}
        return runtimes, devices

    def sim_items(self, args, runtimes, devices):
        with patch.object(cleanup, "query", side_effect=[json.dumps(runtimes), json.dumps(devices)]):
            return cleanup.simulator_items(args, self.config, self.home)

    def test_simulators_require_explicit_ids_even_with_yes(self):
        args = cleanup.parse_args(["--deep", "--only", "simulators", "-y"])
        self.assertTrue(all(i.blocked for i in self.sim_items(args, *self.simulator_fixture())))
        args.runtime = ["old"]
        items = self.sim_items(args, *self.simulator_fixture())
        self.assertFalse(items[0].blocked)
        self.assertTrue(items[1].blocked)

    def test_kept_booted_and_recent_runtime_are_preserved(self):
        args = cleanup.parse_args(["--deep", "--runtime", "old", "-y"])
        runtimes, devices = self.simulator_fixture()
        self.config["keep_runtimes"] = ["ios-26"]
        self.assertIn("keep_runtimes", self.sim_items(args, runtimes, devices)[0].blocked)
        self.config["keep_runtimes"] = []
        devices["devices"]["ios-26"][0]["state"] = "Booted"
        self.assertIn("起動中", self.sim_items(args, runtimes, devices)[0].blocked)
        devices["devices"]["ios-26"][0]["state"] = "Shutdown"
        runtimes["old"]["lastUsedAt"] = cleanup.datetime.now(cleanup.timezone.utc).isoformat()
        self.assertIn("利用", self.sim_items(args, runtimes, devices)[0].blocked)

    def test_kept_device_path_also_protects_its_runtime(self):
        args = cleanup.parse_args(["--deep", "--runtime", "old", "--device", "device"])
        self.config["keep_paths"] = [str(self.home / "Library/Developer/CoreSimulator/Devices/device")]
        items = self.sim_items(args, *self.simulator_fixture())
        self.assertIn("keep_paths", items[0].blocked)
        self.assertIn("keep_paths", items[-1].blocked)

    def test_unknown_simulator_id_is_an_error(self):
        args = cleanup.parse_args(["--deep", "--device", "typo"])
        with self.assertRaisesRegex(ValueError, "存在しない"):
            self.sim_items(args, *self.simulator_fixture())

    def test_kept_runtime_storage_path_is_preserved(self):
        args = cleanup.parse_args(["--deep", "--runtime", "old"])
        runtimes, devices = self.simulator_fixture()
        runtimes["old"]["path"] = str(self.home / "runtime/image.dmg")
        self.config["keep_paths"] = [str(self.home / "runtime")]
        self.assertIn("keep_paths", self.sim_items(args, runtimes, devices)[0].blocked)

    def test_unknown_capacity_blocks_candidate(self):
        with patch.object(cleanup, "allocated", return_value=None):
            items = cleanup.make_plan(self.args, self.config, Idle(), self.home)
        self.assertIn("容量を取得できない", items[0].blocked)

    def test_explicit_cache_cannot_select_arbitrary_home_directory(self):
        args = cleanup.parse_args(["--safe", "--cache", str(self.repo)])
        with self.assertRaisesRegex(ValueError, "探索対象"):
            cleanup.make_plan(args, self.config, Idle(), self.home)

    def test_worktree_requires_explicit_path_and_bundle_is_recoverable(self):
        (self.build / "artifact").unlink()
        self.build.rmdir()
        wt = self.home / "orca/task"
        self.git("worktree", "add", "-qb", "done", str(wt))
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
        age_tree(wt)
        args = cleanup.parse_args(["--deep", "--only", "worktrees", "-y"])
        self.assertIn("明示", cleanup.worktree_reason(wt, args, self.config, Idle()))
        args.worktree = [str(wt)]
        (wt / "build").mkdir()
        (wt / "build/data").write_text("ignored data")
        age_tree(wt)
        self.assertIn("ignored", cleanup.worktree_reason(wt, args, self.config, Idle()))
        (wt / "build/data").unlink()
        (wt / "build").rmdir()
        age_tree(wt)
        self.assertFalse(cleanup.worktree_reason(wt, args, self.config, Idle()))
        actual_query = cleanup.query
        def fail_verification(command, timeout=30):
            if "bundle" in command and "verify" in command:
                raise RuntimeError("bundle verify fixture failure")
            return actual_query(command, timeout)
        item = cleanup.Item("worktrees", str(wt), wt, 1)
        with patch.object(cleanup, "Activity", Idle), patch.object(cleanup, "query", side_effect=fail_verification):
            with self.assertRaisesRegex(RuntimeError, "bundle verify"):
                cleanup.execute(item, args, self.config, self.home)
        self.assertTrue(wt.exists())
        with patch.object(cleanup, "Activity", Idle):
            cleanup.execute(cleanup.Item("worktrees", str(wt), wt, 1), args, self.config, self.home)
        self.assertFalse(wt.exists())
        bundles = list((self.repo / ".git/cleanup-archives").glob("*.bundle"))
        self.assertEqual(len(bundles), 2)
        recovered = self.home / "recovered"
        subprocess.run(["git", "clone", str(bundles[0]), str(recovered)], check=True, capture_output=True)
        self.assertEqual((recovered / "source.txt").read_text(), "source")

    def test_dry_run_is_read_only_and_never_executes_deletion(self):
        item = cleanup.Item("artifacts", str(self.build), self.build, 1024)
        with patch.object(cleanup.Path, "home", return_value=self.home), \
                patch.object(cleanup.sys, "platform", "darwin"), \
                patch.object(cleanup, "Activity", Idle), \
                patch.object(cleanup, "make_plan", return_value=[item]), \
                patch.object(cleanup, "execute") as execute, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cleanup.main(["--deep", "--only", "artifacts", "--dry-run", "-y"]), 0)
        execute.assert_not_called()
        self.assertTrue(self.build.exists())
        self.assertFalse((self.home / ".local/state").exists())

    def test_snapshot_is_opt_in_and_growth_comparison_handles_unknown_sizes(self):
        state = self.home / "state/report.json"
        with contextlib.redirect_stdout(io.StringIO()):
            cleanup.save_or_compare({"path": 1024}, state, False)
        self.assertFalse(state.exists())
        with contextlib.redirect_stdout(io.StringIO()):
            cleanup.save_or_compare({"path": 1024, "unknown": None}, state, True)
        original = state.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            cleanup.save_or_compare({"path": 1024 + cleanup.GIB, "unknown": 1}, state, False)
        self.assertIn("+1.00 GiB", output.getvalue())
        self.assertEqual(state.read_bytes(), original)

    def test_default_report_never_deletes_or_creates_snapshot(self):
        with patch.object(cleanup.Path, "home", return_value=self.home), \
                patch.object(cleanup.sys, "platform", "darwin"), \
                patch.object(cleanup, "Activity", Idle), \
                patch.object(cleanup, "make_plan", return_value=[]), \
                patch.object(cleanup, "inventory", return_value={"path": 1}), \
                patch.object(cleanup, "execute") as execute, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cleanup.main([]), 0)
        execute.assert_not_called()
        self.assertFalse((self.home / ".local/state").exists())

    def test_invalid_cli_cannot_trigger_broad_cleanup(self):
        for argv in (["--days", "0"], ["--only", "typo"], ["--safe", "--deep"],
                     ["--safe", "--only", "artifacts"], ["--runtime", "id"],
                     ["--deep", "--only", "caches", "--device", "id"],
                     ["--save-report", "--dry-run"]):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                cleanup.parse_args(argv)

    def test_check_returns_low_space_status_without_scanning(self):
        usage = type("Usage", (), {"free": cleanup.GIB})()
        with patch.object(cleanup.shutil, "disk_usage", return_value=usage), \
                patch.object(cleanup, "Activity") as activity, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cleanup.main(["--check"]), 2)
        activity.assert_not_called()


if __name__ == "__main__":
    unittest.main()
