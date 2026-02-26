# キーバインディングガイド

現行運用で使う主要キーバインドの抜粋です。

## 統合ナビゲーション

- `Ctrl+h/j/k/l`: ペイン/ウィンドウ移動（Neovim / WezTerm / Zellij の共通運用キー）

## Ghostty

- `Cmd+d`: 右に分割
- `Cmd+Shift+d`: 下に分割
- `Cmd+Alt+←/→/↑/↓`: ペイン移動
- `Cmd+Shift+Alt+←/→/↑/↓`: ペインリサイズ
- `Cmd+w`: ペインを閉じる
- `Cmd+Shift+,`: 設定リロード

## WezTerm

- `Cmd+t` / `Ctrl+t`: 新規タブ
- `Cmd+w` / `Ctrl+w`: タブを閉じる
- `Cmd+[1-9]` / `Ctrl+[1-9]`: タブ切り替え

## Zellij

- `Ctrl+p`: Pane mode
- `Ctrl+n`: Resize mode
- `Ctrl+t`: Tab mode
- `Ctrl+o`: Session mode
- `Ctrl+s`: Scroll mode

Pane mode (`Ctrl+p`) でよく使う操作:
- `h/j/k/l`: ペイン移動
- `r`: 右分割
- `d`: 下分割
- `x`: ペインを閉じる
- `f`: フルスクリーントグル

## Neovim

- `Space` (leader)
- `<leader>ff`: ファイル検索
- `<leader>fg`: テキスト検索
- `<leader>e`: ファイルツリー
- `gd`: 定義ジャンプ
- `gr`: 参照一覧
- `K`: ホバー
- `<leader>ca`: コードアクション
- `<leader>rn`: リネーム
- `Ctrl+s`: 保存

## 参照

- [Ghostty ガイド](ghostty-guide.md)
- [Zellij ガイド](zellij-guide.md)
