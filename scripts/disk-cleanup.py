#!/usr/bin/env python3
"""Read-only inventory by default; guarded cleanup of generated files on macOS."""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

GIB = 1024 ** 3
ARTIFACTS = {"node_modules", ".next", ".turbo", ".venv", ".dart_tool", "Pods", "build", ".build"}
CATEGORIES = {"caches", "artifacts", "simulators", "worktrees"}
CONFIG = Path(__file__).with_suffix(".json")


def run(args, timeout=30):
    return subprocess.run([str(a) for a in args], capture_output=True, text=True,
                          timeout=timeout, env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"))


def query(args, timeout=30):
    result = run(args, timeout)
    if result.returncode:
        raise RuntimeError(f"{args[0]}: {result.stderr.strip() or '取得に失敗'}")
    return result.stdout


def inside(path, root):
    return path == root or root in path.parents


def expand(value):
    return Path(value).expanduser().absolute()


def linked(path):
    return any(p.is_symlink() for p in (path, *path.parents))


def allocated(path):
    """Allocated size, never a sparse file's logical maximum. Failures are not zero."""
    try:
        result = run(["du", "-skx", path], timeout=180)
        if result.returncode:
            return None
        return int(result.stdout.split()[0]) * 1024
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return None


def size_label(size):
    return "不明（権限/取得失敗）" if size is None else f"{size / GIB:.2f} GiB"


def load_config(path):
    config = json.loads(CONFIG.read_text())
    if path:
        override = json.loads(path.read_text())
        if not isinstance(override, dict):
            raise ValueError("設定ファイルはJSONオブジェクトで指定してください")
        unknown = set(override) - set(config)
        if unknown:
            raise ValueError(f"不明な設定: {', '.join(sorted(unknown))}")
        config.update(override)
    for key in ("development_roots", "keep_paths", "keep_runtimes", "keep_devices"):
        if not isinstance(config[key], list) or any(not isinstance(v, str) or not v for v in config[key]):
            raise ValueError(f"{key} は空でない文字列の配列で指定してください")
    threshold = config["minimum_free_gib"]
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0 < threshold < 100000:
        raise ValueError("minimum_free_gib は正の数で指定してください")
    return config


@dataclass
class Item:
    category: str
    label: str
    path: Path | None = None
    size: int | None = None
    blocked: str = ""
    identifier: str = ""


class Activity:
    """Best-effort activity detection; query failures prohibit cleanup."""

    def __init__(self):
        self.paths = []
        self.commands = ""
        self.names = []
        self.error = ""
        try:
            output = query(["lsof", "-nP", "-w", "-a", "-u", str(os.getuid()), "-F", "pcn"])
            self.paths = [Path(line[1:]).resolve() for line in output.splitlines() if line.startswith("n/")]
            processes = {}
            for line in query(["ps", "-axo", "pid=,ppid=,comm="]).splitlines():
                pid, parent, name = line.strip().split(None, 2)
                processes[int(pid)] = (int(parent), name.lower())
            # Our own argv (and the launching shell) contains the explicitly selected
            # path. It must not masquerade as another process using that project.
            ancestors = set()
            pid = os.getpid()
            while pid and pid not in ancestors:
                ancestors.add(pid)
                pid = processes.get(pid, (0, ""))[0]
            self.names = [name for pid, (_, name) in processes.items() if pid not in ancestors]
            commands = []
            for line in query(["ps", "-axo", "pid=,command="]).splitlines():
                pid, command = line.strip().split(None, 1)
                if int(pid) not in ancestors:
                    commands.append(command)
            self.commands = "\n".join(commands)
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
            self.error = f"実行中チェックに失敗: {exc}"

    def reason(self, scope):
        if self.error:
            return self.error
        scope = scope.resolve()
        if any(inside(path, scope) for path in self.paths) or str(scope) in self.commands:
            return "実行中プロセスが参照"
        return ""

    def has_tools(self, tools):
        return any(re.search(rf"\b{re.escape(tool)}\b", name, re.IGNORECASE)
                   for tool in tools for name in self.names)


def kept(path, config):
    if linked(path):
        return "シンボリックリンクを含むパス"
    resolved = path.resolve()
    for value in config["keep_paths"]:
        protected = expand(value).resolve()
        if inside(resolved, protected) or inside(protected, resolved):
            return "keep_paths で保持"
    return ""


def old_tree(path, days, exclude_artifacts=False):
    """Inspect source descendants, not just a parent's directory mtime."""
    cutoff = time.time() - days * 86400
    def fail(exc):
        raise exc
    try:
        if not path.exists():
            return False
        if not path.is_dir():
            return path.lstat().st_mtime < cutoff
        for parent, dirs, files in os.walk(path, onerror=fail):
            if exclude_artifacts:
                dirs[:] = [d for d in dirs if d not in ARTIFACTS | {".git"}]
            if Path(parent).stat().st_mtime >= cutoff:
                return False
            for name in files:
                if name in {".git", ".DS_Store"}:
                    continue
                if (Path(parent) / name).lstat().st_mtime >= cutoff:
                    return False
        return True
    except OSError:
        return False


def discover(roots):
    artifacts, worktrees, errors = [], [], []
    seen = set()
    for root in roots:
        if not root.is_dir() or linked(root):
            continue
        for parent, dirs, files in os.walk(root, onerror=lambda exc: errors.append(str(exc))):
            path = Path(parent)
            if path in seen:
                dirs[:] = []
                continue
            seen.add(path)
            if ".git" in files:
                worktrees.append(path)
            dirs[:] = [d for d in dirs if d != ".git" and not (path / d).is_symlink()]
            for name in dirs[:]:
                if name in ARTIFACTS:
                    artifacts.append(path / name)
                    dirs.remove(name)
    return artifacts, worktrees, errors


def artifact_reason(path, config, activity, days, selected=False):
    reason = kept(path, config)
    if reason:
        return reason
    try:
        repo = Path(query(["git", "-C", path.parent, "rev-parse", "--show-toplevel"]).strip())
        relative = path.relative_to(repo).as_posix()
        # build can also contain source. Only ignored, untracked directories qualify.
        if query(["git", "-C", repo, "ls-files", "--", relative]).strip():
            return "Git管理ファイルを含む"
        if run(["git", "-C", repo, "check-ignore", "-q", "--", relative]).returncode != 0:
            return "Gitの除外対象ではないため手動確認"
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        return "Git情報を確認できないため手動確認"
    reason = activity.reason(repo)
    if reason:
        return reason
    # Recent builds are evidence of use even if source files have not changed.
    if not selected and (not old_tree(path.parent, days, exclude_artifacts=True) or not old_tree(path, days)):
        return f"{days}日以内の更新あり／更新日時を取得できない"
    return ""


def cache_paths(home):
    base = home / "Library/Caches"
    paths = [home / ".npm/_cacache", home / ".cache/uv", home / ".cache/pnpm",
             home / ".cache/puppeteer", base / "pip", base / "go-build",
             base / "org.swift.swiftpm", base / "CocoaPods", base / "com.openai.codex",
             base / "ms-playwright", home / ".gradle/caches"]
    paths.extend(sorted(base.glob("*.ShipIt")))
    paths.extend(sorted(base.glob("*-updater")))
    for root in (home / ".npm/_npx", home / "Library/Developer/Xcode/DerivedData"):
        if root.is_dir() and not linked(root):
            paths.extend(sorted(p for p in root.iterdir() if p.is_dir()))
    return list(dict.fromkeys(p for p in paths if p.exists()))


def cache_reason(path, config, activity, days, selected=False):
    reason = kept(path, config) or activity.reason(path)
    if reason:
        return reason
    guards = {
        "uv": ("uv", "uvx"), "_cacache": ("npm", "npx", "pnpm"), "_npx": ("node", "npx"),
        "go-build": ("go", "compile", "link"), "ms-playwright": ("node", "chrome", "chromium"),
        "puppeteer": ("node", "chrome", "chromium"), "pnpm": ("pnpm", "node"),
        "pip": ("pip", "uv"), "caches": ("gradle", "java"),
        "org.swift.swiftpm": ("swift", "xcodebuild"), "CocoaPods": ("pod", "xcodebuild"),
    }
    name = "_npx" if path.parent.name == "_npx" else path.name
    if "DerivedData" in path.parts:
        name = "org.swift.swiftpm"
    if activity.has_tools(guards.get(name, ())):
        return "関連ツールが実行中"
    # Cache trees are continually updated. Requiring every file to be old would
    # keep the entire cache indefinitely. Activity guards protect ordinary caches;
    # npx additionally retains recent executable environments used by MCP servers.
    if name == "_npx" and not selected and not old_tree(path, days):
        return f"{days}日以内の更新あり／更新日時を取得できない"
    return ""


def simulator_items(args, config, home, activity=None):
    runtimes = json.loads(query(["xcrun", "simctl", "runtime", "list", "-j"]))
    devices = json.loads(query(["xcrun", "simctl", "list", "devices", "-j"]))["devices"]
    items, known_runtimes, known_devices = [], set(), set()
    for key, runtime in runtimes.items():
        identifier = runtime.get("identifier", key)
        known_runtimes.add(identifier)
        runtime_id = runtime["runtimeIdentifier"]
        group = devices.get(runtime_id, [])
        reason = "" if identifier in args.runtime else "--runtime で削除IDを明示してください"
        if identifier in config["keep_runtimes"] or runtime_id in config["keep_runtimes"]:
            reason = "keep_runtimes で保持"
        if any(d["state"] == "Booted" for d in group):
            reason = "対応する端末が起動中"
        elif any(d["udid"] in config["keep_devices"] for d in group):
            reason = "保持対象の端末が使用"
        if not runtime.get("deletable", False):
            reason = "ランタイムが削除不可"
        last_used = runtime.get("lastUsedAt")
        if last_used:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(last_used.replace("Z", "+00:00"))
            if age.total_seconds() < args.days * 86400:
                reason = f"{args.days}日以内に利用"
        for device in group:
            reason = kept(home / "Library/Developer/CoreSimulator/Devices" / device["udid"], config) or reason
        for field in ("path", "runtimeBundlePath"):
            if runtime.get(field):
                reason = kept(Path(runtime[field]), config) or reason
                if activity:
                    reason = activity.reason(Path(runtime[field])) or reason
        platform = runtime_id.rsplit(".", 1)[-1].split("-")[0]
        items.append(Item("simulators", f"{platform} {runtime['version']} ({runtime.get('build', '')}) {identifier}",
                          size=runtime.get("sizeBytes"), blocked=reason, identifier=identifier))
    for runtime_id, group in devices.items():
        for device in group:
            identifier = device["udid"]
            known_devices.add(identifier)
            path = home / "Library/Developer/CoreSimulator/Devices" / identifier
            reason = "" if identifier in args.device else "--device で削除IDを明示してください"
            if identifier in config["keep_devices"]:
                reason = "keep_devices で保持"
            if device["state"] != "Shutdown":
                reason = "端末が停止状態ではない"
            reason = kept(path, config) or reason
            if activity:
                reason = activity.reason(path) or reason
            items.append(Item("simulators", f"端末 {device['name']} / {runtime_id} / {identifier}",
                              path, allocated(path) if path.exists() else 0, reason, identifier))
    unknown = (set(args.runtime) - known_runtimes) | (set(args.device) - known_devices)
    if unknown:
        raise ValueError(f"存在しないシミュレータID: {', '.join(sorted(unknown))}")
    return items


def worktree_reason(path, args, config, activity):
    reason = kept(path, config) or activity.reason(path)
    if reason:
        return reason
    if path.resolve() not in {expand(p).resolve() for p in args.worktree}:
        return "--worktree で削除パスを明示してください"
    if not old_tree(path, args.days):
        return f"{args.days}日以内の更新あり／更新日時を取得できない"
    try:
        git_dir = Path(query(["git", "-C", path, "rev-parse", "--absolute-git-dir"]).strip())
        common = Path(query(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]).strip())
        if inside(common.resolve(), path.resolve()):
            return "Git共通ディレクトリを含むため保持"
        listing = query(["git", "-C", path, "worktree", "list", "--porcelain"])
        if f"worktree {path.resolve()}" not in listing.splitlines():
            return "登録済みworktreeではない"
        if (git_dir / "locked").exists():
            return "worktreeがロック中"
        if query(["git", "-C", path, "status", "--porcelain", "--untracked-files=all", "--ignored"]).strip():
            return "変更・未追跡・ignoredファイルあり（成果物も先に整理してください）"
        base = query(["git", "-C", path, "symbolic-ref", "refs/remotes/origin/HEAD"]).strip()
        if run(["git", "-C", path, "merge-base", "--is-ancestor", "HEAD", base]).returncode:
            return "originの既定ブランチへの取り込みを確認できない"
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        return "Git情報を確認できない"
    return ""


def make_plan(args, config, activity, home):
    items = []
    if "caches" in args.categories:
        for path in select_paths(cache_paths(home), args.cache, "キャッシュ"):
            items.append(Item("caches", str(path), path, allocated(path),
                              cache_reason(path, config, activity, args.days, selected=bool(args.cache))))
    if args.categories & {"artifacts", "worktrees"}:
        artifacts, worktrees, errors = discover([expand(v) for v in config["development_roots"]])
        for error in errors:
            print(f"調査範囲の一部を読み取れません: {error}", file=sys.stderr)
        if "artifacts" in args.categories:
            for path in select_paths(artifacts, args.artifact, "成果物"):
                items.append(Item("artifacts", str(path), path, allocated(path),
                                  artifact_reason(path, config, activity, args.days, selected=bool(args.artifact))))
        if "worktrees" in args.categories:
            for path in worktrees:
                items.append(Item("worktrees", str(path), path, allocated(path),
                                  worktree_reason(path, args, config, activity)))
            unknown = {expand(p).resolve() for p in args.worktree} - {p.resolve() for p in worktrees}
            if unknown:
                raise ValueError(f"探索ルート内にworktreeが見つかりません: {unknown}")
    if "simulators" in args.categories:
        try:
            items.extend(simulator_items(args, config, home, activity))
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            if args.runtime or args.device:
                raise
            print(f"シミュレータ調査をスキップ（取得失敗）: {exc}", file=sys.stderr)
    for item in items:
        if activity.error:
            item.blocked = activity.error
        if not item.blocked and item.path:
            if any(other is not item and not other.blocked and other.path and
                   inside(item.path, other.path) for other in items):
                item.blocked = "親ディレクトリが同じ実行の候補"
        if item.size is None:
            item.blocked = "容量を取得できないため手動確認"
    return items


def select_paths(paths, selected, label):
    if not selected:
        return paths
    wanted = {expand(value) for value in selected}
    if any(linked(path) for path in wanted):
        raise ValueError(f"{label}にシンボリックリンクは指定できません")
    wanted = {path.resolve() for path in wanted}
    unknown = wanted - {path.resolve() for path in paths}
    if unknown:
        raise ValueError(f"探索対象の{label}ではありません: {unknown}")
    return [path for path in paths if path.resolve() in wanted]


def print_plan(items, limit=30):
    print("\n容量順の整理候補（候補量は実際の回復量を保証しません）")
    ordered = sorted(items, key=lambda i: i.size or 0, reverse=True)
    for item in ordered[:limit] if limit else ordered:
        status = f"保持: {item.blocked}" if item.blocked else "整理候補"
        print(f"{size_label(item.size):>12}  [{item.category}] {item.label}\n              {status}")
    if limit and len(items) > limit:
        print(f"ほか {len(items) - limit} 件（全件表示は --limit 0）")
    total = sum(i.size or 0 for i in items if not i.blocked)
    print(f"整理候補の合計: {size_label(total)}（共有ブロック等により回復量と異なる場合があります）")


def inventory(home):
    paths = [Path("/Applications/Unity"), Path("/Applications/Ableton Live 12 Trial.app"),
             Path("/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime"),
             Path("/System/Library/AssetsV2/com_apple_MobileAsset_watchOSSimulatorRuntime"),
             Path("/Library/Developer/CoreSimulator/Caches"),
             home / "Library/Developer/CoreSimulator/Devices", home / "Library/Caches",
             home / "Library/Application Support/AllMyRecords", home / "Library/Application Support/Notion",
             home / "Library/Application Support/Claude", home / "Library/Android/sdk", home / ".android/avd",
             home / ".local/share/mise", home / ".codex/.chatgpt-projects", home / ".codex/sessions",
             home / ".claude/projects", home / "Library/pnpm", home / ".local/share/pnpm",
             home / ".cache", home / ".gradle", home / "Music", home / "Downloads", home / ".Trash",
             home / "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"]
    rows = {str(p): allocated(p) for p in paths if p.exists()}
    print("\n大容量領域（調査専用・親子が重複するため合算不可）")
    for path, size in sorted(rows.items(), key=lambda pair: pair[1] or 0, reverse=True):
        print(f"{size_label(size):>12}  {path}")
    return rows


def save_or_compare(rows, state, save, limit=30):
    if state.exists():
        previous = json.loads(state.read_text())
        print(f"\n前回計測との差分: {previous['measured_at']}")
        changes = []
        for path, size in rows.items():
            before = previous["sizes"].get(path)
            if size is not None and before is not None and size != before:
                changes.append((size - before, path))
        changes.sort(key=lambda pair: abs(pair[0]), reverse=True)
        for difference, path in changes[:limit] if limit else changes:
            print(f"{difference / GIB:+.2f} GiB  {path}")
        if limit and len(changes) > limit:
            print(f"ほか {len(changes) - limit} 件（全件表示は --limit 0）")
        if not changes:
            print("比較できる対象の容量変化はありません。")
    if save:
        state.parent.mkdir(parents=True, exist_ok=True)
        temporary = state.with_suffix(".tmp")
        temporary.write_text(json.dumps({"measured_at": datetime.now(timezone.utc).isoformat(),
                                         "sizes": rows}, ensure_ascii=False, indent=2))
        temporary.replace(state)
        print(f"計測結果を保存: {state}")


def execute(item, args, config, home):
    # Refresh activity and policy after confirmation, immediately before removal.
    activity = Activity()
    if activity.error:
        raise RuntimeError(activity.error)
    if item.category == "caches":
        reason = cache_reason(item.path, config, activity, args.days, selected=bool(args.cache))
    elif item.category == "artifacts":
        reason = artifact_reason(item.path, config, activity, args.days, selected=bool(args.artifact))
    elif item.category == "worktrees":
        reason = worktree_reason(item.path, args, config, activity)
    else:
        current = simulator_items(args, config, home, activity)
        match = next((i for i in current if i.identifier == item.identifier and i.path == item.path), None)
        reason = match.blocked if match else "シミュレータの状態が変化"
        if item.path:
            reason = activity.reason(item.path) or reason
    if reason:
        print(f"スキップ: {item.label}: {reason}")
        return False
    if item.category == "worktrees":
        common = Path(query(["git", "-C", item.path, "rev-parse", "--path-format=absolute", "--git-common-dir"]).strip())
        archive = common / "cleanup-archives"
        archive.mkdir(exist_ok=True)
        bundle = archive / f"{time.time_ns()}.bundle"
        query(["git", "-C", item.path, "bundle", "create", bundle, "HEAD"], timeout=180)
        query(["git", "-C", item.path, "bundle", "verify", bundle], timeout=180)
        print(f"復元用bundle: {bundle}")
        reason = worktree_reason(item.path, args, config, Activity())
        if reason:
            print(f"スキップ: {reason}")
            return False
        query(["git", "--git-dir", common, "worktree", "remove", item.path], timeout=180)
    elif item.category == "simulators":
        command = ["xcrun", "simctl", "delete", item.identifier] if item.path else [
            "xcrun", "simctl", "runtime", "delete", item.identifier]
        query(command, timeout=180)
    elif item.path.is_dir():
        shutil.rmtree(item.path)
    else:
        item.path.unlink()
    return True


def parse_args(argv=None):
    parser = argparse.ArgumentParser(prog="disk-cleanup.sh", description="macOSの容量調査と、保持設定・使用状況を確認した整理")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--report", action="store_const", const="report", dest="mode", help="調査のみ（既定）")
    modes.add_argument("--safe", action="store_const", const="safe", dest="mode", help="使用中でないキャッシュの整理")
    modes.add_argument("--deep", action="store_const", const="deep", dest="mode", help="キャッシュと古い開発成果物の整理")
    modes.add_argument("--check", action="store_const", const="check", dest="mode", help="空き容量のみ確認。閾値未満で終了コード2")
    parser.set_defaults(mode="report")
    parser.add_argument("--dry-run", action="store_true", help="削除せず候補を表示")
    parser.add_argument("-y", "--yes", action="store_true", help="確認を省略（保持条件は省略しない）")
    parser.add_argument("--days", type=int, default=30, help="未更新とみなす日数（既定30、1以上）")
    parser.add_argument("--limit", type=int, default=30, help="一覧の最大表示件数（既定30、0で全件。処理対象は制限しない）")
    parser.add_argument("--only", help="対象種別をカンマ区切り: caches,artifacts,simulators,worktrees")
    parser.add_argument("--config", type=Path, help="JSONの設定上書きファイル")
    parser.add_argument("--keep", action="append", default=[], help="保持するパス。繰り返し指定可")
    parser.add_argument("--artifact", action="append", default=[], help="成果物パスを限定。更新日時のみ問わず候補にする（--deepのみ）")
    parser.add_argument("--cache", action="append", default=[], help="既知のキャッシュパスを限定。更新日時のみ問わず候補にする")
    parser.add_argument("--runtime", action="append", default=[], help="削除するランタイムのUUID（--deepのみ）")
    parser.add_argument("--device", action="append", default=[], help="削除する端末のUUID（--deepのみ）")
    parser.add_argument("--worktree", action="append", default=[], help="削除するworktreeのパス（--deepのみ）")
    parser.add_argument("--save-report", action="store_true", help="計測結果をローカル保存し次回の増分比較に使用")
    args = parser.parse_args(argv)
    if args.days < 1:
        parser.error("--days は1以上にしてください")
    if args.limit < 0:
        parser.error("--limit は0以上にしてください")
    explicit = set()
    for values, category in ((args.artifact, "artifacts"), (args.cache, "caches"),
                             (args.runtime or args.device, "simulators"), (args.worktree, "worktrees")):
        if values:
            explicit.add(category)
    defaults = CATEGORIES.copy() if args.mode == "report" else {"caches", "artifacts"} if args.mode == "deep" else {"caches"}
    args.categories = set(args.only.split(",")) if args.only else explicit or defaults
    if args.categories - CATEGORIES:
        parser.error("--only の対象種別が不正です")
    if args.mode == "safe" and args.categories != {"caches"}:
        parser.error("--safe はcachesのみです。その他は--deepを指定してください")
    if (args.runtime or args.device or args.worktree or args.artifact) and args.mode != "deep":
        parser.error("削除ID・パスの指定には--deepが必要です")
    if explicit - args.categories:
        parser.error("--only に指定したパス・IDの対象種別を含めてください")
    if args.save_report and (args.mode != "report" or args.dry_run):
        parser.error("--save-report は--reportでのみ使用できます。--dry-runとは併用不可")
    return args


def main(argv=None):
    args = parse_args(argv)
    home = Path.home()
    try:
        config = load_config(args.config)
        config["keep_paths"].extend(args.keep)
        volume = Path("/System/Volumes/Data") if Path("/System/Volumes/Data").exists() else home
        before = shutil.disk_usage(volume).free
        print(f"空き容量: {size_label(before)} / 警告閾値: {config['minimum_free_gib']} GiB", flush=True)
        if before < config["minimum_free_gib"] * GIB:
            print("空き容量が閾値を下回っています。整理候補を確認してください。")
        if args.mode == "check":
            return 2 if before < config["minimum_free_gib"] * GIB else 0
        if sys.platform != "darwin":
            raise ValueError("このスクリプトはmacOS専用です")
        items = make_plan(args, config, Activity(), home)
        print_plan(items, args.limit)
        if args.mode == "report":
            rows = inventory(home)
            rows.update({f"{i.category}:{i.label}": i.size for i in items})
            save_or_compare(rows, home / ".local/state/dotfiles/disk-report.json", args.save_report, args.limit)
            print("\nDocker・mise・SDK・録音・調査出力は手動整理。docs/disk-maintenance.md を参照。")
            return 0
        if args.dry_run:
            print("DRY RUN: 削除・計測結果の保存はしていません。")
            return 0
        failed = False
        for item in items:
            if item.blocked:
                continue
            if not args.yes:
                if not sys.stdin.isatty():
                    raise ValueError("非対話実行では--dry-runまたは--yesを明示してください")
                if input(f"削除しますか: {item.label} ({size_label(item.size)}) [y/N]: ").lower() not in {"y", "yes"}:
                    continue
            try:
                if execute(item, args, config, home):
                    print(f"削除完了: {item.label}")
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                failed = True
                print(f"削除失敗: {item.label}: {exc}", file=sys.stderr)
        after = shutil.disk_usage(volume).free
        print(f"空き容量: {size_label(before)} → {size_label(after)} / 差分: {(after - before) / GIB:+.2f} GiB")
        return 1 if failed else 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
