# ディスクメンテナンスガイド

開発用 Mac のディスク容量を定期的に回復するための手順書です。
自動化できる部分は `scripts/disk-cleanup.sh` にまとめています。

## クイックリファレンス

```bash
cd ~/development/dotfiles

./scripts/disk-cleanup.sh                     # レポートのみ（何も消さない）
./scripts/disk-cleanup.sh --safe --dry-run    # safe で消える内容を確認
./scripts/disk-cleanup.sh --safe              # キャッシュを削除
./scripts/disk-cleanup.sh --deep              # + 古いシミュレータ / worktree / 放置 node_modules 等（項目ごとに確認）
./scripts/disk-cleanup.sh --deep --days 60    # 「古い」の基準を 60 日に
./scripts/disk-cleanup.sh --deep -y           # 確認なしで実行
```

## 推奨スケジュール

| タイミング | 実行内容 |
|---|---|
| 月 1 回 | `--report` で状況確認 → `--safe` |
| 空き容量 30GB 未満 | `--deep --dry-run` で対象を確認 → `--deep` |
| Xcode メジャーアップデート後 | `--deep`（旧シミュレータランタイムの整理） |
| 四半期に 1 回 | 下記「手動メンテナンス」を見直す |

## 削除対象と再生成方法

### `--safe`（再生成可能なキャッシュ）

| 対象 | パス / コマンド | 削除後の影響・再生成 |
|---|---|---|
| Docker ビルドキャッシュ | `docker builder prune -af` / `docker image prune -f` | 次回ビルドが遅くなるだけ。コンテナ・ボリュームは消さない（Docker 起動時のみ実行） |
| npm キャッシュ | `npm cache clean --force` | 次回 install 時に再ダウンロード |
| npx キャッシュ | `~/.npm/_npx` の `--days` 日より古いもの | 次回 `npx` 実行時に再取得。実行中の MCP サーバーを壊さないため新しいものは残す |
| pnpm store | `pnpm store prune` | どのプロジェクトからも参照されていないパッケージのみ削除 |
| pnpm メタデータ / puppeteer | `~/.cache/pnpm`, `~/.cache/puppeteer` | 自動再生成 / `npx puppeteer browsers install chrome` |
| uv / pip | `uv cache clean`, `~/Library/Caches/pip` | 次回 `uv sync` で再ダウンロード。**uv プロセス実行中（uvx 起動の serena MCP など）はロック待ちで止まるため自動スキップ**。Codex / Claude Code を終了してから再実行する |
| Go | `go clean -cache -modcache` | 次回 `go build` で再ダウンロード |
| Xcode | `DerivedData/*`, SwiftPM / CocoaPods キャッシュ, `simctl delete unavailable` | 次回ビルドがフルビルドになる |
| mise | `mise cache clear` | インストール済みツールには影響なし |
| アプリ更新残骸 | `~/Library/Caches/*.ShipIt`, `*-updater`, `com.openai.codex` | アプリが必要に応じて再作成 |
| Homebrew | `brew cleanup --prune=all` | 古いバージョンとダウンロードキャッシュを削除 |
| ログ | `~/Library/Logs` の 14 日より古いファイル | なし |

### `--deep`（判断を伴うもの。確認プロンプトあり）

| 対象 | 判定ルール | 復元方法 |
|---|---|---|
| シミュレータランタイム | プラットフォーム（iOS / watchOS 等）ごとに新しい 2 つを残す | Xcode > Settings > Components、または `xcodebuild -downloadPlatform iOS` |
| Xcode DeviceSupport | `--days` 日より古いもの | 実機を接続すると再生成される |
| git worktree | `~/.codex/worktrees/*/*`, `<repo>/.claude/worktrees/*` で `--days` 日以上未更新のもの | ブランチは残るため `git worktree add <path> <branch>` で復元できる |
| 放置プロジェクトの成果物 | `~/development`, `~/orca` 配下の `node_modules` / `.next` / `.turbo` / `.venv` / `.dart_tool` / `Pods` のうち、親ディレクトリが `--days` 日以上未更新のもの | `pnpm install` / `npm ci` / `uv sync` / `flutter pub get` / `pod install` |
| mise の未参照バージョン | `mise ls --prunable` のうち、プロジェクトの設定（`.tool-versions`, `mise.toml`, `.fvmrc`, `.nvmrc` 等）に記載のないバージョン | `mise install <tool>@<version>` |

**worktree の安全装置:** 未コミットの変更（untracked を含む）がある worktree と、どのブランチにも含まれないコミット（detached HEAD 上の作業）がある worktree、`git worktree lock` されている worktree は削除せずにスキップします。Claude Code の agent worktree はロックが残ることがあるため、不要なら `git -C <repo> worktree unlock <path>` してから再実行してください。

**mise の注意点:** `mise prune` は「mise が認識した設定ファイル（tracked-configs）」しか見ないため、まだ mise で開いていないプロジェクトが使う node や flutter のバージョンまで消してしまいます。そのためスクリプトでは `mise prune` を使わず、設定ファイルを grep して参照がないバージョンだけを `mise uninstall` します。

## 手動メンテナンス（スクリプトでは消さないもの）

| 対象 | 目安サイズ | 対応 |
|---|---|---|
| Docker 仮想ディスク（`Docker.raw`） | 35GB | Docker Desktop > Settings > Resources > Disk usage limit で上限を設定。未使用のイメージは `docker image prune -a`（再 pull が必要） |
| 停止中の Docker コンテナ | 0.5GB | コンテナ内にデータを持つ場合があるため `docker ps -a` で確認してから `docker rm` |
| Notion `Application Support/Notion/Partitions` | 9GB | Notion アプリ > 設定 > 「キャッシュをクリア」 |
| Claude Desktop `vm_bundles` | 9GB | Claude Desktop のローカル実行環境。使わない場合はアプリの設定から無効化 |
| `~/.cache/huggingface` | 1.2GB | 不要なモデルを `huggingface-cli delete-cache` で選択削除 |
| `~/.pub-cache` | 0.9GB | `flutter pub cache clean`（全プロジェクトで `pub get` し直しになる） |
| Android SDK / AVD | 4GB | Android Studio > SDK Manager で使っていない system-image を削除 |
| watchOS ランタイム | 8GB | watchOS 開発で使うため自動では消さない（新しい 2 つだけを残すルール） |
| `~/Downloads` | 数 GB | 重複した zip（`xxx (1).zip`）や録音ファイルを整理 |
| ゴミ箱 | - | Finder でゴミ箱を空にする |

### 容量調査のコマンド

```bash
df -h /System/Volumes/Data
du -sh -x ~/.[!.]* ~/* 2>/dev/null | sort -hr | head -30
du -sh ~/Library/* 2>/dev/null | sort -hr | head -20
docker system df
xcrun simctl runtime list
mise ls --prunable
```

## 実施記録

| 日付 | モード | 実行前の空き容量 | 実行後の空き容量 | 備考 |
|---|---|---|---|---|
| 2026-10-02 | `--deep` + iOS DeviceSupport 手動削除 + `pnpm store prune` | 12.9GB | 119GB | Docker build cache 21GB, iOS 26.2/26.4 ランタイム 17GB, Codex worktree 16件 約10GB, Claude agent worktree 9件（ロック中の autest-sandbox 15件 約1GB は保留）, 放置 node_modules/.next/.venv 約15GB 等。uv キャッシュ 7.6GB は serena MCP 実行中のため未削除 |
