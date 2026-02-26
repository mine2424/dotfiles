# Zellij Guide

このリポジトリのマルチプレクサは Zellij を前提とします。

## インストール

```bash
brew install zellij
```

## 設定ファイル

- `~/.config/zellij/config.kdl`
- `~/.config/zellij/layouts/`
- dotfiles 側: `zellij/config.kdl`, `zellij/layouts/default.kdl`

## 基本操作

- `Ctrl+p`: Pane mode
- `Ctrl+n`: Resize mode
- `Ctrl+t`: Tab mode
- `Ctrl+o`: Session mode
- `Ctrl+s`: Scroll mode

Pane mode:
- `h/j/k/l`: 移動
- `r`: 右分割
- `d`: 下分割
- `x`: 閉じる

Tab mode:
- `n`: 新規タブ
- `h/l`: 前後タブ
- `1-9`: 指定タブへ移動

## セッション

```bash
zellij
zellij attach
zellij list-sessions
zellij kill-session <session-name>
```

## Ghostty 連携

Ghostty 側で `Cmd+Alt+矢印` を送る設定を入れると、移動操作を統一しやすくなります。
