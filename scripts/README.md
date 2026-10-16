# Scripts Directory

このディレクトリには開発環境のセットアップと管理用のユーティリティスクリプトが含まれています。

## メインスクリプト

### setup.sh
開発環境のメインセットアップスクリプト。dotfiles の設定を適用し、依存パッケージをインストールする。

```bash
# 設定ファイルのみ適用
./setup.sh --all

# 依存関係もインストール（Homebrew + npm）
./setup.sh --all --install

# 個別コンポーネント
./setup.sh --nvim        # Neovim 設定
./setup.sh --shell       # Zsh + Starship
./setup.sh --terminal    # Ghostty + WezTerm
./setup.sh --cli         # Git, Zellij, Yazi 等
./setup.sh --desktop     # Cursor + Zed
./setup.sh --claude      # Claude 設定
./setup.sh --ssh         # SSH 設定（~/.ssh/config）
./setup.sh --macos       # macOS システム設定

./setup.sh --all --dry-run  # ドライラン（実際には実行しない）
./setup.sh --help
```

### backup.sh
現在の Mac 環境を dotfiles にスナップショットする。新しい Mac への移行前に実行する。

```bash
# 全コンポーネントをバックアップ
./backup.sh --all

# 個別コンポーネント
./backup.sh --brew    # Brewfile 更新（mas エントリも自動取得）
./backup.sh --gcloud  # gcloud CLI 設定
./backup.sh --ssh     # SSH 設定（~/.ssh/config のみ、秘密鍵は除外）
./backup.sh --npm     # npm グローバルパッケージ一覧
./backup.sh --macos   # macOS システム設定（リストアスクリプト生成）
./backup.sh --mise    # mise インストール済みバージョン

./backup.sh --all --dry-run  # ドライラン
./backup.sh --help
```

### verify-setup.sh
開発環境のセットアップを検証するスクリプト。
```bash
./verify-setup.sh    # すべての検証テストを実行
```

### disk-cleanup.sh
キャッシュや再生成可能なファイルを削除してディスク容量を回復する。詳細は [docs/disk-maintenance.md](../docs/disk-maintenance.md) を参照。

```bash
./disk-cleanup.sh                   # 容量レポートのみ（デフォルト）
./disk-cleanup.sh --safe            # 再生成可能なキャッシュを削除
./disk-cleanup.sh --deep            # + 古いシミュレータ / worktree / 放置 node_modules 等
./disk-cleanup.sh --deep --dry-run  # ドライラン
./disk-cleanup.sh --help
```

## 移行手順

新しい Mac への移行は [docs/guides/migration.md](../docs/guides/migration.md) を参照。

## スクリプトの整理

スクリプトは機能別に整理されています：
- **バックアップ**: backup.sh
- **環境セットアップ**: setup.sh
- **検証**: verify-setup.sh
- **同期**: sync.sh
- **ディスクメンテナンス**: disk-cleanup.sh

## ファイル単位の設定適用

`config-files.json` に明示した11ファイルだけを `config-files.py` で比較・適用します。

```bash
python3 scripts/config-files.py audit
python3 scripts/config-files.py apply --dry-run
python3 scripts/config-files.py apply --group desktop
python3 -m unittest discover -s scripts/tests -v
```

詳細は [ローカルPC棚卸し](../docs/local-pc-audit.md) を参照。Codex/Claudeのホーム全体は同期しません。Codexのconfig.tomlとClaudeのsettingsは手動レビュー対象です。検証コマンドは20秒でタイムアウトし、失敗・警告を最後に集計します。
