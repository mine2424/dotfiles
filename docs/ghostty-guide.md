# Ghostty ネイティブ分割ガイド

## 概要

Ghostty はターミナルエミュレータ自体にペイン分割機能を内蔵しています。
Zellij などのターミナルマルチプレクサを使わずに、Ghostty だけでペイン管理が完結します。

### Zellij との比較

| 項目 | Ghostty ネイティブ | Zellij |
|------|-------------------|--------|
| 起動オーバーヘッド | なし | あり（プロセス追加） |
| 設定の複雑さ | 低（Ghostty config のみ） | 高（KDL 設定言語） |
| セッション永続化 | なし | あり（detach/attach） |
| スクロールバック | ターミナル依存 | Zellij が管理 |
| macOS との親和性 | 高（Cmd キー使用） | 中（キー競合あり） |
| プラグイン | なし | あり |

セッション永続化が不要な場合（SSH 接続元でなく、ローカルで作業する場合）は
Ghostty ネイティブ分割で十分です。

---

## 設定ファイルの場所

```
~/.config/ghostty/config
    ↕ シンボリックリンク
~/development/dotfiles/ghostty/config
```

`dotfiles/ghostty/config` を編集すると即座に反映されます。
Ghostty を再起動するか `Cmd+Shift+,` でリロードしてください。

---

## キーバインド一覧

### ペイン分割

| キーバインド | 動作 |
|-------------|------|
| `Cmd+D` | 右に分割（垂直分割） |
| `Cmd+Shift+D` | 下に分割（水平分割） |

### ペイン間移動

| キーバインド | 動作 |
|-------------|------|
| `Cmd+Alt+←` | 左のペインへ移動 |
| `Cmd+Alt+→` | 右のペインへ移動 |
| `Cmd+Alt+↑` | 上のペインへ移動 |
| `Cmd+Alt+↓` | 下のペインへ移動 |

### ペインリサイズ

| キーバインド | 動作 |
|-------------|------|
| `Cmd+Shift+Alt+←` | 左にリサイズ（20px） |
| `Cmd+Shift+Alt+→` | 右にリサイズ（20px） |
| `Cmd+Shift+Alt+↑` | 上にリサイズ（20px） |
| `Cmd+Shift+Alt+↓` | 下にリサイズ（20px） |

### ペインを閉じる

| キーバインド | 動作 |
|-------------|------|
| `Cmd+W` | 現在のペインを閉じる |

> **Note**: `cmd+ctrl+left/right` は macOS の「Mission Control: Space の切り替え」と競合するため、
> リサイズには `cmd+shift+alt` を使用しています。

---

## Zellij 操作との対応表（移行者向け）

| 操作 | Ghostty ネイティブ | 旧 Zellij |
|------|-------------------|-----------|
| 右に分割 | `Cmd+D` | `Ctrl+P` → `r` |
| 下に分割 | `Cmd+Shift+D` | `Ctrl+P` → `d` |
| 左ペインへ | `Cmd+Alt+←` | `Ctrl+P` → `h` |
| 右ペインへ | `Cmd+Alt+→` | `Ctrl+P` → `l` |
| 上ペインへ | `Cmd+Alt+↑` | `Ctrl+P` → `k` |
| 下ペインへ | `Cmd+Alt+↓` | `Ctrl+P` → `j` |
| リサイズ（左） | `Cmd+Shift+Alt+←` | `Ctrl+N` → `h` |
| リサイズ（右） | `Cmd+Shift+Alt+→` | `Ctrl+N` → `l` |
| リサイズ（上） | `Cmd+Shift+Alt+↑` | `Ctrl+N` → `k` |
| リサイズ（下） | `Cmd+Shift+Alt+↓` | `Ctrl+N` → `j` |
| ペインを閉じる | `Cmd+W` | `Ctrl+P` → `x` |

---

## 設定のリロード方法

Ghostty の設定を変更した後は、以下のいずれかで反映できます：

1. **`Cmd+Shift+,`**: Ghostty をリロード（再起動不要）
2. **Ghostty を再起動**: 確実に反映される

---

## トラブルシューティング

### `Cmd+D` が効かない場合

macOS のシステム設定でショートカットが競合していないか確認してください。

```
システム設定 → キーボード → キーボードショートカット
```

### キーバインドを追加・変更したい場合

`dotfiles/ghostty/config` を編集し、Ghostty をリロードしてください。

```
keybind = cmd+shift+t=new_tab
```

使用可能なアクションは [Ghostty 公式ドキュメント](https://ghostty.org/docs/config/keybind) を参照してください。
