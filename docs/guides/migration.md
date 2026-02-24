# 新しい Mac への移行手順書

新しい Mac への環境移行を行うための手順書。
バックアップは現在の Mac で、リストアは新しい Mac で実行する。

---

## 目次

- [事前確認：インストール済みアプリケーション一覧](#インストール済みアプリケーション一覧)
- [バックアップ手順（現在の Mac）](#バックアップ手順現在の-mac)
- [リストア手順（新しい Mac）](#リストア手順新しい-mac)
- [移行後の確認チェックリスト](#移行後の確認チェックリスト)
- [手動で再設定が必要なもの](#手動で再設定が必要なもの)

---

## インストール済みアプリケーション一覧

### Homebrew パッケージ（CLI/開発ツール）

| パッケージ | 用途 |
|-----------|------|
| `neovim` | メインエディタ |
| `ripgrep` | 高速テキスト検索（Telescope等で使用） |
| `fd` | 高速ファイル検索 |
| `lazygit` | TUI Git クライアント |
| `imagemagick` | 画像変換（Neovim用） |
| `tectonic` | LaTeX エンジン |
| `luarocks` | Lua パッケージマネージャ |
| `git` | バージョン管理 |
| `tmux` | ターミナルマルチプレクサ |
| `zellij` | ターミナルワークスペース（メイン） |
| `fzf` | ファジーファインダー |
| `bat` | `cat` 代替（シンタックスハイライト付き） |
| `eza` | `ls` 代替（アイコン・色付き） |
| `zsh` | シェル |
| `sheldon` | Zsh プラグインマネージャ |
| `starship` | クロスシェルプロンプト |
| `mise` | ランタイムバージョンマネージャ（node, python等） |
| `mas` | Mac App Store CLI（Brewfile 自動取得用） |

### Homebrew Cask（GUI アプリ）

| アプリ | 用途 |
|--------|------|
| `ghostty` | メインターミナル（高速、GPU加速） |
| `wezterm` | サブターミナル（クロスプラットフォーム） |

### Mac App Store アプリ

> `brew bundle dump` の実行後、Brewfile の `mas` エントリで確認できる。
> 以下は覚書として手動管理。

| アプリ名 | 用途 |
|---------|------|
| Xcode | iOS/macOS 開発（必要に応じて） |
| Keynote / Pages / Numbers | Apple Office スイート |
| 1Password | パスワードマネージャ（App Store版） |
| Slack | コミュニケーション |
| LINE | コミュニケーション |

> 実際の一覧は `backup.sh --brew` 後の Brewfile 内 `mas` エントリを参照。

### 手動インストール（パッケージマネージャ外）

| アプリ | 入手先 | 備考 |
|--------|--------|------|
| [Cursor](https://cursor.sh/) | 公式サイト | Claude Code 併用エディタ |
| [Claude Code](https://claude.ai/claude-code) | `npm install -g @anthropic-ai/claude-code` | AI コーディング CLI |
| [Moralerspace フォント](https://github.com/yuru7/moralerspace) | GitHub Releases | プログラミング向け日英混植フォント |

### npm グローバルパッケージ

> `backup.sh --npm` 後の `npm/packages.txt` を参照。
> 以下は覚書。

| パッケージ | 用途 |
|-----------|------|
| `@anthropic-ai/claude-code` | Claude Code CLI |
| `tree-sitter-cli` | Neovim Treesitter 用 |
| `@mermaid-js/mermaid-cli` | Mermaid ダイアグラム生成 |

### mise で管理するランタイム

> `backup.sh --mise` 後の `mise/installed-versions.txt` を参照。
> 以下は覚書。

| ランタイム | 用途 |
|-----------|------|
| `node` | JavaScript/TypeScript 開発 |
| `python` | Python 開発 |
| `ruby` | Ruby 開発 |
| `go` | Go 開発 |

---

## バックアップ手順（現在の Mac）

### Step 1: dotfiles リポジトリで全環境をスナップショット

```bash
cd ~/development/dotfiles

# 全コンポーネントをバックアップ
./scripts/backup.sh --all

# または個別に実行
./scripts/backup.sh --brew    # Homebrew パッケージ一覧
./scripts/backup.sh --ssh     # SSH 設定（~/.ssh/config のみ）
./scripts/backup.sh --npm     # npm グローバルパッケージ一覧
./scripts/backup.sh --macos   # macOS システム設定
./scripts/backup.sh --mise    # mise インストール済みバージョン
./scripts/backup.sh --gcloud  # gcloud CLI 設定
```

> **注意**: `ssh/config` に内部ホスト名・IP アドレスが含まれる場合は、
> push 前に内容を確認してください。

### Step 2: 変更を git にコミット

```bash
git add Brewfile gcloud/ ssh/ npm/ macos/ mise/installed-versions.txt
git commit -m "backup: update system snapshot $(date '+%Y-%m-%d')"
git push
```

### Step 3: Brewfile の内容を確認

```bash
# mas エントリで App Store アプリが含まれているか確認
grep "^mas " Brewfile

# 全体を確認
cat Brewfile
```

---

## リストア手順（新しい Mac）

### Step 1: 基本ツールのインストール

```bash
# Xcode コマンドラインツール（git などに必要）
xcode-select --install

# Homebrew のインストール
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Step 2: dotfiles をクローン

```bash
mkdir -p ~/development
git clone <repo-url> ~/development/dotfiles
cd ~/development/dotfiles
```

### Step 3: 全環境をリストア

```bash
# dotfiles 設定の適用 + 依存関係インストール（推奨）
./scripts/setup.sh --all --install

# または段階的に実行
./scripts/setup.sh --all          # 設定ファイルのみ適用
./scripts/setup.sh --install      # Homebrew パッケージ + npm インストール
```

`--install` フラグで実行される内容:
- `brew bundle install` で Brewfile のパッケージをすべてインストール
- `npm/packages.txt` の npm グローバルパッケージをインストール

### Step 4: macOS システム設定を適用

```bash
./scripts/setup.sh --macos
# または
bash macos/defaults.sh
```

> 設定反映のため、ターミナルを再起動してください。

### Step 5: SSH 設定を適用

```bash
./scripts/setup.sh --ssh
# ~/.ssh/config が作成される（既存ファイルは .bak でバックアップ）
```

### Step 6: mise でランタイムを再インストール

```bash
# バックアップ済みのバージョン一覧を確認
cat mise/installed-versions.txt

# 必要なランタイムを個別にインストール
mise install node@<version>
mise install python@<version>
# ...
```

### Step 7: gcloud CLI を再認証

```bash
# gcloud のインストール（Brewfile に含まれていない場合）
brew install --cask google-cloud-sdk

# 認証
gcloud auth login
gcloud auth application-default login

# バックアップ済みの設定を確認
ls gcloud/
```

### Step 8: 手動インストールが必要なもの

以下は自動化できないため、手動でインストール・設定する:

- [ ] **Cursor** — [cursor.sh](https://cursor.sh/) からダウンロード
- [ ] **Moralerspace フォント** — [GitHub Releases](https://github.com/yuru7/moralerspace/releases) からダウンロードしてインストール
- [ ] **Claude Code** — `npm install -g @anthropic-ai/claude-code` で自動インストール済みのはず
- [ ] **SSH 秘密鍵** — 安全な方法（AirDrop など）で手動転送
- [ ] **`.env` ファイル** — 各プロジェクトで手動再設定
- [ ] **API キー・シークレット** — 1Password などから取得して再設定
- [ ] **gcloud 認証** — `gcloud auth login` で再認証

### Step 9: Neovim の初期セットアップ

```bash
# Neovim 起動（lazy.nvim が自動的にプラグインをインストール）
nvim

# ヘルスチェック
:checkhealth

# LSP サーバーのインストール
:Mason
```

---

## 移行後の確認チェックリスト

```bash
# 設定の検証スクリプト（あれば実行）
./scripts/verify-setup.sh
```

| 確認項目 | コマンド |
|---------|---------|
| Homebrew パッケージ | `brew list` |
| Zsh 設定 | `echo $SHELL` → `/bin/zsh` |
| Starship プロンプト | ターミナルで確認 |
| Neovim 起動 | `nvim --version` |
| mise 動作 | `mise list` |
| git 設定 | `git config --list` |
| SSH 接続 | `ssh -T git@github.com` |
| npm グローバル | `npm list -g --depth=0` |

---

## 手動で再設定が必要なもの

以下はセキュリティ上の理由から dotfiles に含まれていないため、手動で再設定が必要。

| 項目 | 対応方法 |
|------|---------|
| SSH 秘密鍵（`~/.ssh/id_*`） | AirDrop または安全な転送で移行 |
| git の `user.email` / `user.name` | `git config --global user.email "..."` |
| gcloud 認証トークン | `gcloud auth login` で再取得 |
| API キー（`.env` 等） | 1Password などのパスワードマネージャから取得 |
| Cursor の設定・拡張機能 | Cursor の Sync 機能を使用 |
| Mac App Store アプリ | `mas install <app-id>` または手動インストール |
| Dock の手動配置 | macOS 設定から調整（`macos/defaults.sh` で基本設定は復元） |
| ウォールペーパー | System Settings から設定 |
| Face ID / Touch ID | System Settings から再設定 |
