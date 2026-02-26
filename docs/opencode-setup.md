# OpenCode + Z.AI セットアップガイド

## 1. インストール

```bash
# dotfiles 側の依存導入
./scripts/setup.sh --all --install

# もしくは手動
curl -fsSL https://opencode.ai/install | bash
# または
npm install -g opencode-ai
```

## 2. 認証

```bash
opencode auth login
```

プロバイダーで `Z.AI`（または `Z.AI Coding Plan`）を選び、API キーを設定します。

## 3. 起動

```bash
opencode
# モデル指定
opencode --model GLM-4.7
```

## 4. 便利エイリアス（zsh 設定）

- `oc`: `opencode`
- `oca`: `opencode auth`
- `ocl`: `opencode auth login`
- `ocm`: `opencode models`
- `ocs`: `opencode share`
- `ocus`: `opencode unshare`

## 5. トラブルシュート

```bash
which opencode
opencode --version
opencode auth status
```

必要に応じて再認証:

```bash
opencode auth login
```
