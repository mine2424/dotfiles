# カラースキーム統合ガイド

Neovim / WezTerm / Zellij / Ghostty で配色を揃えるための最小ガイドです。

## 方針

- Neovim を配色の中心にする
- WezTerm はタブ/フレーム中心に調整する
- Zellij はテーマを Neovim に寄せる

## Neovim

`tokyonight` など単一テーマを固定し、まずエディタ内の視認性を安定させます。

## WezTerm

- `ansi` / `brights` の過剰な上書きを避ける
- タブバーと分割線の色をテーマに合わせる

## Zellij

`zellij/config.kdl` でテーマ色と境界線色を Neovim に合わせます。

## Ghostty

背景透過を使う場合は、Neovim 側の背景設定と合わせて可読性を確認します。

## 確認手順

1. Neovim を起動して通常バッファの配色を確認
2. WezTerm タブバーと分割線を確認
3. Zellij 分割境界と選択中タブの色を確認
4. Ghostty 透過時のコントラストを確認
