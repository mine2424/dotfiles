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
./setup.sh --pi --install # Pi + Ponytail 固定版の導入
./setup.sh --ssh         # SSH 設定（~/.ssh/config）
./setup.sh --macos       # macOS システム設定

./setup.sh --all --dry-run  # ドライラン（実際には実行しない）
./setup.sh --help
```

### Pi開発環境の診断

```bash
python3 scripts/check-pi.py --smoke
```

リポジトリルートから実行。Node・Piの版、Ponytailの登録とSHA、4つの開発Promptを確認する。
`--smoke` は一時設定で実際のPi RPCの読込を検証する。モデルへの質問は送らない。
結果はJSONで出力し、失敗時は終了コード1。詳細は [Piガイド](../pi/README.md) を参照。

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
./disk-cleanup.sh --check           # 空き50GiB未満で警告・終了コード2
./disk-cleanup.sh --report --save-report  # 計測を保存し、次回から増分比較
./disk-cleanup.sh --safe --dry-run  # 使用中でないキャッシュの整理候補
./disk-cleanup.sh --deep --only artifacts --dry-run  # build/.build/node_modules等
./disk-cleanup.sh --deep --only artifacts  # 候補ごとに確認して整理
./disk-cleanup.sh --deep --artifact ~/development/example/build --dry-run  # 個別指定
./disk-cleanup.sh --help
```

Python 3.10以上が必要。`scripts/disk-cleanup.json` と `--config` / `--keep` で保持対象を指定する。
使用中・最近更新・Git管理中の成果物は保持。シミュレータとworktreeの削除はID・パスの明示が必要。
Docker、miseのインストール実体、録音、調査出力は調査のみで、自動では削除しない。

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
