# Pi + Ponytail のセットアップ

macOS・Linux・WSLで共通の手順。Git、Bash、curlを用意する。
`--install` はmiseがなければ自動導入し、`versions.env` のNode版（24.21.0）とnpmをmiseで管理する。
NodeがないPCや、古いNodeがPATHにあるPCでも同じコマンドで導入できる。WindowsではWSL内で実行する。
miseの導入には[公式インストーラー](https://mise.jdx.dev/installing-mise.html)を使う。
PATH上のmise、または `~/.local/bin/mise` があれば再利用する。
シェル設定や他のプロジェクトのNode既定版は変更せず、Piのランチャーが導入したNodeを選ぶ。

```bash
git clone https://github.com/mine2424/dotfiles.git ~/development/dotfiles
cd ~/development/dotfiles
bash scripts/setup-pi.sh --install --dry-run
bash scripts/setup-pi.sh --install
export PATH="$HOME/.local/bin:$PATH"
pi
```

Pi内で `/login` → `/model` → `/ponytail status` を実行する。
新規セッションでは通常 `full`。`/ponytail lite`、`/ponytail full`、
`/ponytail ultra`、`/ponytail off` で切り替える。`/ponytail-review` は変更の複雑さをレビューする。
認証とモデル選択は各PCで行う。APIキーをdotfilesに書かない。

通常セットアップからも使える。

```bash
bash scripts/setup.sh --pi --install --force
# 全環境セットアップにも含まれる
bash scripts/setup.sh --all --install
# 設定だけを適用（ダウンロードなし）
bash scripts/setup-pi.sh
```

Piだけを導入する場合、専用スクリプトはHomebrewや他のAIツールを導入しない。
通常の `setup.sh` は既存の必須コマンド（curl・jq・python3等）も確認する。

## 管理するもの

- `versions.env`: Pi版とPonytailのコミットを固定する唯一の設定元。
- `agent/AGENTS.md`: `~/.pi/agent/AGENTS.md` に個別リンク。既存の別ファイル・リンクは保持し、手動マージを案内する。
- `settings.example.json`: 設定がない場合だけコピー。既存の設定には `pi install` がPonytailを登録する。
- `prompts/*.md`: `~/.pi/agent/prompts/` に個別リンク。同名の既存ファイルは保持する。
- Pi本体: `~/.local/share/dotfiles/pi/`。sudoやシステムのnpmグローバル領域は使わない。
- 起動コマンド: `~/.local/bin/pi`。導入時に選んだNodeへのPATHも設定する。

`~/.local/bin/pi` が既存ファイルなら `~/.local/state/dotfiles/backups/` に退避する。
別のPiが起動する場合は `type -a pi` で確認し、`~/.local/bin` をPATHの先頭に置く。
認証・履歴・キャッシュは `~/.pi/agent/` に残し、Git管理もディレクトリ全体のリンクもしない。
`PI_CODING_AGENT_DIR` を設定している場合は、そのディレクトリを使う。

再実行しても既存の設定・認証を保持する。インストール失敗は非ゼロで終了し、再実行できる。
更新時は `versions.env` をレビューして変更し、同じ `--install` を実行する。
Piの依存パッケージまではlockしていないため、完全に同一の依存ツリーを保証するものではない。

## 確認と復旧

```bash
pi --version                  # versions.envのPI_VERSION（現在1.5.2）
pi list                       # 固定SHAのPonytail
python3 scripts/check-pi.py --smoke  # Node・Pi版、登録、実際のリソース読込
# 起動後: /ponytail status、/ponytail off、/ponytail full
# /modelでモデル選択後、短い質問を送り応答も確認
```

認証やモデル応答、対話UIの確認結果はPCごとに異なる。導入検証の記録は [versions.md](versions.md) を参照。
Ponytailを外す場合は `versions.env` の `PONYTAIL_SOURCE` の値を `pi remove` に渡す。
原則リンクを外す場合は `~/.pi/agent/AGENTS.md` のリンク先を確認してから削除する。
退避したランチャーは必要ならバックアップから戻す。

背景設計は [設計書](../docs/pi-ponytail-design.md)。現行の導入方法はこのREADMEとスクリプトを優先する。

## 毎日の開発

導入済みのPCでは `bash scripts/setup-pi.sh` でPromptを追加できる。起動中のPiは `/reload` で再読込する。
同名Promptを自作している場合は保持するので、必要な内容だけ手動でマージする。

| 操作 | 使いどころ |
| --- | --- |
| `/plan ログイン不具合の原因と修正案` | コードを調べ、編集せずに受入条件と検証方法を決める |
| `/work 決めた修正案を実装して` | 関連実装を調べ、変更・検証・差分確認まで進める |
| `/review` | staged/unstaged差分と関連する未追跡ファイルのバグ・回帰を探す。修正はしない |
| `/review mainとの比較` | merge-baseを確認してブランチ差分をレビューする |
| `/ponytail-review` | 変更に不要な複雑さがないかを別の観点で見る |
| `/handoff` | 翌日や別セッション向けに、検証済み事項と次の作業を会話内に残す |

Promptの計画・レビュー指定はモデルへの指示で、権限強制ではない。
レビューを独立した観点で行いたい場合は新規セッションで `/review` を実行する。
モデルは `/model` から選び、必要ならモデル選択画面で既定として保存する。
契約・利用枠が異なるため、モデルやAPIキーは共有設定へ固定しない。

翌日は同じRepoで `pi --continue`、過去の作業は `pi --resume`。
`/name` で作業名を付け、`/session` でセッションと使用量を確認する。
別案の比較は `/tree` または `/fork`、長い作業の整理は `/compact` を使う。
別PCへの設定再現と、未コミット差分・セッション履歴の移動は別。後者は必要なものを明示的に移す。

Repo固有の情報には [AGENTS雛形](project-AGENTS.example.md) を使う。
既存のRepoルールへ実在する起動・検証コマンドをマージするための雛形で、自動配置はしない。

## 診断と拡張方針

`python3 scripts/check-pi.py` は導入版、miseのNode、Ponytailの登録とSHA、Promptの存在を確認する。
`--smoke` は一時設定で実際のPi RPCを起動し、4つのPromptとPonytailコマンド/Skillを確認する。
他の個人Extensionや認証ファイルを読み込まない構成で、モデルへの質問は送らない。
Python 3が必要。結果はJSON、失敗時は終了コード1。再現可能な記録として保存できる。

```bash
python3 scripts/check-pi.py --smoke > /tmp/pi-development-check.json
```

同名の個人Promptも読込対象なので、内容の正しさは別途確認する。
検出した版の不一致は自動修復せず、`versions.env` を確認して `--install` を再実行する。
この診断はモデル応答やPrompt指示の遵守、完全な安全性を保証するものではない。

採用根拠と追加候補は [公開事例の調査・構成判断](research.md) を参照。
現在の外部依存はPiと固定SHAのPonytail。独自Extensionは追加せず、標準セッション機能を使う。
並列エージェント・MCP・ブラウザーは、利用するプロジェクトと認証・実行環境が定まった段階で追加する。
BeethovenのCLI・設定・モデル選択は独立しており、この構成から変更しない。
