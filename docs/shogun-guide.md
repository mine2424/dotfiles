# Multi-Agent Shogun Guide

Ghostty + Zellij で最大10体の AI エージェントを並列稼働させるオーケストレーションシステム。
[multi-agent-shogun](https://github.com/yohey-w/multi-agent-shogun) を dotfiles で管理する。

## 概要

### アーキテクチャ

```
┌──────────────────────────────────────────────────────┐
│ Ghostty (ターミナル)                                   │
│ ┌──────────────────────────────────────────────────┐ │
│ │ Zellij (セッション管理)                            │ │
│ │                                                    │ │
│ │  Tab 1: shogun    Tab 2: multiagent               │ │
│ │  ┌──────────┐    ┌─────┬─────┬─────┐             │ │
│ │  │          │    │Karo │Ashi1│Ashi2│              │ │
│ │  │ Shogun   │    ├─────┼─────┼─────┤             │ │
│ │  │ (あなた) │    │Ashi3│Ashi4│Ashi5│              │ │
│ │  │          │    ├─────┼─────┼─────┤             │ │
│ │  └──────────┘    │Ashi6│Ashi7│Gun  │              │ │
│ │                   └─────┴─────┴─────┘             │ │
│ └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### tmux 版との違い

| 項目 | 本構成 | オリジナル |
|------|--------|-----------|
| セッション管理 | Zellij | tmux |
| ターミナル | Ghostty | 任意 |
| 設定管理 | dotfiles 一元管理 | リポジトリ直接利用 |
| レイアウト定義 | KDL ファイル | シェルスクリプト |
| upstream 更新 | `shogun-sync` | `git pull` |

## セットアップ

### 前提条件

- Ghostty
- Zellij
- Claude Code (`claude`)
- Python 3
- fswatch（ファイル監視、任意）

すべて Brewfile で管理済み。

### 初回インストール

```bash
cd ~/development/dotfiles
./scripts/setup.sh --shogun --install
```

実行される処理:

1. upstream リポジトリを `~/.local/share/shogun/upstream/` に clone
2. `lib/`, `scripts/`, `instructions/`, `skills/` を展開
3. dotfiles の設定をオーバーレイ（dotfiles 側が優先）
4. Python venv を作成し PyYAML をインストール
5. `shogun`, `shogun-init`, `shogun-sync` を `~/.local/bin/` にリンク
6. Zellij レイアウト `shogun.kdl` を配置

### 設定ファイルの場所

| ファイル | 用途 |
|---------|------|
| `dotfiles/shogun/config/settings.yaml` | CLI 設定、言語、エージェント数 |
| `dotfiles/shogun/config/projects.yaml` | プロジェクト登録簿 |
| `dotfiles/shogun/instructions/` | カスタム指示のオーバーライド |
| `dotfiles/shogun/skills/` | ユーザー独自スキル |
| `dotfiles/zellij/layouts/shogun.kdl` | Zellij レイアウト定義 |

### インストール先

```
~/.local/share/shogun/
  upstream/          # git clone キャッシュ
  lib/               # upstream ライブラリ
  scripts/           # upstream スクリプト
  config/            # マージ済み設定
  instructions/      # マージ済み指示
  skills/            # マージ済みスキル
  .venv/             # Python 仮想環境
  .upstream-ref      # ピン留めコミットハッシュ
```

## 基本操作

### プロジェクト初期化

```bash
cd ~/development/my-project
shogun-init
```

生成される構成:

```
.shogun/
  queue/             # エージェント間 YAML 通信
  queue/inbox/       # エージェント別メールボックス
  reports/           # 作業レポート
  context/           # プロジェクトコンテキスト
  dashboard.md       # エージェント状態ボード
```

`.gitignore` に `.shogun/` が自動追加される。

### エージェント起動

```bash
# 通常起動
shogun

# 決戦モード（全エージェント Opus）
shogun --kessen

# キュー初期化 + 起動
shogun --clean

# 起動メッセージ抑制
shogun --silent

# エージェント状態確認
shogun --status

# セッション終了
shogun --stop
```

### Zellij 画面操作

| 操作 | キーバインド |
|------|-------------|
| ペインモード | `Ctrl+p` |
| ペイン間移動 | `Ctrl+p` → `h/j/k/l` |
| タブ切替 | `Ctrl+t` → `h/l` |
| タブ番号で移動 | `Ctrl+t` → `1-9` |
| ペインリサイズ | `Ctrl+n` → `h/j/k/l` |
| ペイン最大化 | `Ctrl+p` → `f` |
| セッション操作 | `Ctrl+o` |

## エージェント階層と役割

```
あなた（主君）
  └── Shogun（将軍）    ← Tab 1: 戦略的指示を出す
        ├── Karo（家老）    ← 指示をタスクに分解、Ashigaru に割り当て
        ├── Ashigaru 1-7（足軽） ← 実際のコード作業を実行
        └── Gunshi（軍師）  ← 品質チェック、アーキテクチャ分析
```

### コミュニケーションフロー

```
Shogun → queue/shogun_to_karo.yaml → Karo
Karo   → queue/inbox/ashigaru-N.yaml → Ashigaru N
Ashigaru N → queue/inbox/gunshi.yaml → Gunshi（品質チェック）
Gunshi → queue/inbox/karo.yaml → Karo（結果報告）
Karo   → dashboard.md 更新
```

### 役割の詳細

| エージェント | モデル（通常） | モデル（決戦） | 責務 |
|-------------|-------------|-------------|------|
| Shogun | - | - | 最高指揮、戦略指示 |
| Karo | Sonnet | Opus | タスク分解、割り当て、進捗管理 |
| Ashigaru 1-7 | Sonnet | Opus | コード実装、テスト、ドキュメント |
| Gunshi | Opus | Opus | 品質チェック、アーキテクチャ分析 |

## タスク管理

### YAML キューの仕組み

タスクは `.shogun/queue/` ディレクトリの YAML ファイルで管理される。

```yaml
# queue/shogun_to_karo.yaml
command_id: feat-auth-001
north_star: ユーザー認証機能を実装する
purpose: ログイン/ログアウトが動作すること
acceptance_criteria:
  - JWT トークンの発行と検証
  - パスワードのハッシュ化
  - ログインエンドポイントのテスト
status: assigned
timestamp: 2026-04-25T10:00:00+09:00
```

### タスク状態

```
idle → assigned → in-progress → done/failed
```

### dashboard.md の読み方

```markdown
| エージェント | 状態   | 現在のタスク |
|-------------|--------|-------------|
| Karo        | 稼働中 | タスク分解中 |
| Ashigaru-1  | 稼働中 | 認証ミドルウェア実装 |
| Ashigaru-2  | 待機中 | - |
| Gunshi      | 稼働中 | コードレビュー |
```

### Claude Code からのタスク投入

```
/shogun ユーザー認証機能を実装して
```

`/shogun` コマンドが `queue/shogun_to_karo.yaml` に YAML を書き込む。

## 設定カスタマイズ

### settings.yaml

```yaml
language: ja              # 表示言語
cli:
  default: claude-code    # デフォルト CLI
  kessen_model: opus      # 決戦モード時のモデル
max_agents: 7             # Ashigaru の最大数
session_manager: zellij   # セッションマネージャ
```

### カスタム instructions の追加

`dotfiles/shogun/instructions/` にマークダウンファイルを配置すると、upstream の同名ファイルを上書きする。

```bash
# 例: Karo のカスタム指示を追加
vim ~/development/dotfiles/shogun/instructions/karo.md
./scripts/setup.sh --shogun  # 再デプロイ
```

### スキルの追加

`dotfiles/shogun/skills/` にスキルディレクトリを作成する。upstream のスキルに追加される。

### CLI ルーティング

upstream の `lib/cli_adapter.sh` が settings.yaml の設定に基づいてエージェントを適切な CLI（Claude Code, Codex, Copilot, Kimi）にルーティングする。

## upstream 管理

```bash
# 最新を取得
shogun-sync pull

# バージョン確認
shogun-sync status

# キャッシュから再インストール（設定マージ含む）
shogun-sync install

# 設定をバックアップ（dotfiles に書き戻し）
./scripts/backup.sh --shogun
```

## トラブルシューティング

### Zellij セッションが残っている

```bash
zellij kill-session shogun
```

### venv が壊れた

```bash
rm -rf ~/.local/share/shogun/.venv
./scripts/setup.sh --shogun
```

### upstream との設定マージで問題が起きた

dotfiles 側の設定が常に優先される。upstream のデフォルト設定に戻したい場合:

```bash
shogun-sync pull
shogun-sync install
```

### エージェントが応答しない

1. `shogun --status` でダッシュボードを確認
2. Zellij の該当ペインに切り替えてエラーを確認
3. `shogun --clean` でキューを初期化して再起動

### shogun コマンドが見つからない

`~/.local/bin` が `$PATH` に含まれていることを確認:

```bash
echo $PATH | tr ':' '\n' | grep local/bin
```

含まれていない場合、`.zshrc` に追加:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 完全リセット

```bash
./scripts/clean.sh --shogun
./scripts/setup.sh --shogun --install
```

## 関連ドキュメント

- [Zellij Guide](zellij-guide.md) — Zellij の基本操作
- [Ghostty Guide](ghostty-guide.md) — Ghostty の設定
- [Claude Code Guide](claude-code-guide.md) — Claude Code のエージェント・コマンド
