# Dotfiles

Neovim + Ghostty + Zellij を中心にした開発環境用 dotfiles です。

## 主な構成

- Editor: Neovim
- Terminal: Ghostty / WezTerm
- Multiplexer: Zellij
- Shell: Zsh + Starship
- File manager: Yazi
- AI tooling: Codex / Claude Code / OpenCode / Pi

## クイックスタート

```bash
git clone https://github.com/mine2424/dotfiles.git ~/development/dotfiles
cd ~/development/dotfiles

# セットアップ
./scripts/setup.sh --all --install

# 反映確認
./scripts/verify-setup.sh --all --verbose

# シェル再起動
exec $SHELL
```

## スクリプト

- `scripts/setup.sh`: 設定適用と依存導入
- `scripts/sync.sh`: dotfiles とローカル設定の双方向同期
- `scripts/clean.sh`: 設定クリーニング
- `scripts/verify-setup.sh`: セットアップ検証
- `scripts/backup.sh`: ローカル環境のバックアップ
- `scripts/disk-cleanup.sh`: キャッシュ・不要ファイル削除によるディスク容量回復

## ディレクトリ

- `nvim/`: Neovim 設定
- `zellij/`: Zellij 設定
- `ghostty/`: Ghostty 設定
- `wezterm/`: WezTerm 設定
- `zsh/`: Zsh 設定
- `starship/.config/starship.toml`: Starship 設定
- `yazi/.config/yazi/yazi.toml`: Yazi 設定
- `git/`, `gh/`, `tmux/`: Git・GitHub CLI・tmux設定
- `cursor/`, `zed/`: エディタ設定
- `macos/`: 実機から確認した表示設定
- `docs/`: ガイド類

## 設定の棚卸し

[ローカルPC棚卸し](docs/local-pc-audit.md)に、今回の追加対象・同期しない情報・検証範囲を記録しています。明示した11ファイルは `python3 scripts/config-files.py audit` でローカルとの差分を確認できます。適用は `python3 scripts/config-files.py apply`。変更前の設定はホーム配下へ退避します。

## ドキュメント

- [キーバインディング](docs/keybindings.md)
- [Zellij ガイド](docs/zellij-guide.md)
- [Ghostty ガイド](docs/ghostty-guide.md)
- [OpenCode セットアップ](docs/opencode-setup.md)
- [カラースキーム統合](docs/colorscheme-integration.md)
- [Mac 移行手順](docs/guides/migration.md)
- [ディスクメンテナンス](docs/disk-maintenance.md)

### アーカイブ（履歴資料）

- [要件定義 1](docs/requirements/first-requirement.md)
- [要件定義 2](docs/requirements/neovim-tmux-claude-parallel-dev.md)

## メモ

`docs/requirements/*` は履歴資料として保持しています。現行運用は `scripts/` と上記ガイドを参照してください。
