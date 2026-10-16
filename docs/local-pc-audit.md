# ローカルPC設定の棚卸し（2026-10-16）

## 調査範囲

このMacのホーム直下、`~/.config`、シェル起動ファイル、Homebrewの明示導入パッケージとCask、mise、npm、uv、`/Applications`、Cursor/Zed、LaunchAgentsのファイル名を確認した。macOS 27.0.1 / arm64。個人文書、ソースコード全体、Keychain、ブラウザプロファイルの内容を収集する作業ではない。

開始時から多数の未コミット変更があり、それらを保持した。コミット・push、アプリの一括更新、ディスク削除は実行していない。

## 管理対象の追加・更新

| 対象 | 保存先・扱い |
|---|---|
| Homebrew | `Brewfile` を `brew leaves` / `brew list --cask` の実測で更新。推移依存はHomebrewに任せる。既存shogunが必要とする未導入のfswatchも宣言を保持 |
| Git | `git/gitconfig` に既存の公開用ユーザー情報、GitHub SSH変換、LFSフィルタ。`git/ignore` に共通ignore |
| GitHub CLI | `gh/config.yml` のみ。ログイン情報を含む `hosts.yml` は対象外 |
| tmux | `tmux/tmux.conf` を追加。起動時のTPM自動cloneを外し、既存TPMがあるときだけ読み込む |
| Cursor | `cursor/settings.json`、Markdown CSS、19件の拡張ID。設定内の `__HOME__` は適用時に展開 |
| Zed | `zed/settings.json`。テーマ・フォント・パネル等の既存設定を保存。既存の `trust_all_worktrees` 設定も保持しているため、移行時は内容を確認 |
| macOS | `macos/defaults.sh` にDark表示、キーリピート、Dock、Finder表示形式の実測値。全plistは収集せず、アプリ再起動もしない |
| シェル | setupから漏れていた `.zshenv` / `.zprofile` / npm設定を適用対象に追加。Docker PATHを可搬化、mise shimsと対話シェルのactivateを追加 |
| ランタイム | Node 24.21.0 / Python 3.14.3を保持。Goの `latest` を実際に選択されている1.27.1に固定 |
| npm | 存在しない `/Users/mine/.npm-global` を削除。miseのNodeごとにグローバルツールを管理。ログインシェルで取得したPiのパッケージ名を `npm/packages.txt` に保存 |
| Codex | 保存用baselineのモデル・推論設定を実機の選択値に更新。通知パスを可搬化し、旧skillsフラグを削除。稼働中のユーザーconfigは上書きしない |
| アプリ一覧 | `docs/local-applications.txt` は `/Applications` のアプリ名のスナップショット。全アプリの自動インストール指定ではない |

Brewfileの `codex` は実機どおりCask。Claude Codeは実機で `~/.local/bin/claude` のネイティブ版を使用していたため、古いbrew/npmの重複導入指定を外した。npmパッケージ一覧は名前を保存する既存方式で、バージョン固定ではない。Piの手動構築方針は [既存設計書](pi-ponytail-design.md) を参照。

## 適用と検証

```bash
# 11個の明示指定ファイルだけを比較（差分があれば終了コード1）
python3 scripts/config-files.py audit
python3 scripts/config-files.py apply --dry-run
python3 scripts/config-files.py apply

# セットアップに統合済み
./scripts/setup.sh --shell --dry-run
./scripts/setup.sh --cli --dry-run
./scripts/setup.sh --desktop --dry-run
./scripts/setup.sh --all --dry-run

# Cursor拡張は必要なものを選び、手動導入
# /Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension <ID>

# 検証
python3 -m unittest discover -s scripts/tests -v
./scripts/verify-setup.sh --all --verbose
```

対象は `scripts/config-files.json` に限定。`~/.config` 全体やエディタのUserディレクトリ全体をコピーしない。`XDG_CONFIG_HOME` を尊重する。適用時に異なる既存設定があれば `~/.local/state/dotfiles/backups/config-*` へ退避し、同一内容なら書き換えない。既存のsymlink作成処理も、置換前に `backups/link.*` へ退避するように変更した。

このPCでは11ファイルを適用・照合した。既存ファイルのバックアップは `~/.local/state/dotfiles/backups/config-_d7g32vu` と `config-_ord4j7k`。macOS設定スクリプトは保存とdry-runのみ。Codexのbaselineも既存ユーザー設定へ自動マージしていない。

## 収集・自動同期しないもの

- `~/.codex` / `~/.claude` の認証情報、セッション、履歴、DB、プラグインキャッシュ。syncのディレクトリ全体コピーを廃止し、Codexは共通指示と通知スクリプト、Claudeはagents/commands/rules/scriptsだけを対象にした。Claudeのsettingsは既存setupのマージ処理で適用する。
- Codexの `config.toml` はMCP認証、ローカル接続先、プロジェクト信頼、デスクトップ機能等が混在するため、保存用baselineと必要なキーだけ手動比較する。設定仕様は [OpenAI公式リファレンス](https://learn.chatgpt.com/docs/config-file/config-reference) を確認。実機の通知先はアプリ管理のComputer Useクライアントであり、保存用スクリプトとは別に保持する。
- SSH秘密鍵、GPG、gcloud/ADC、Docker認証、GitHubログイン、Supabase、Wrangler、npmトークン、ブラウザ・メール・Keychain、顧客データ。
- `~/.config/opencode/tui.json` のOrcaローカルプラグイン参照、LaunchAgentsの業務別ジョブ、アプリ独自の接続情報。対応アプリ／プロジェクト側で復元する。
- Karabinerは標準のANSIプロファイルのみ、lazygit設定は空だったため追加なし。`~/.local/bin` のアプリ管理リンク／プロジェクトCLIや古い独自スクリプトも一括コピーしない。
- uvの `shinkoku v0.6.3` は用途固有ツールとして記録のみ。税務データや認証状態を取り込まない。

`.gitignore` の認証・実行状態の除外を追加した。ignoreは既存の追跡ファイルやGit履歴を消さない。従来から追跡されている `.claude/settings.local.json` も残っているため、公開範囲の見直しは別途必要。

## 検証の限界

ファイル一致、シェル/TOML/JSON/Rubyの構文、バックアップと再実行、同期で認証・履歴を保護するテストを確認する。アプリGUIの動作、新しいMacでの全依存インストール、各サービスへの再ログインは別の確認になる。検証コマンドは20秒で打ち切り、警告を集計して最後まで実行する。

## 今回の検証結果

- 管理対象11ファイル: 差分0。
- 安全性の回帰テスト4件: 成功。dry-run、既存リンクの退避、再適用、Codex認証・履歴の保持、npm scoped名の保持と取得失敗時のバックアップ保護、検証失敗時の最終集計を確認。
- 既存検証40件: 38件成功、重大エラー0、警告2。WezTermの `--version` は20秒でタイムアウト、fswatchは未導入。Brewfileにはfswatchを保持。CLI実行の確認でありGUI動作の合格を意味しない。
- Bash/Zsh構文、TOML、JSONC、BrewfileのRuby構文、`git diff --check`: 成功。
- setup全体とsync pull全体: dry-runを確認。
- 変更・未追跡ファイル65パスへの代表的な秘密鍵／トークン形式の検索: 検出0。機密情報の不存在を保証するものではない。
