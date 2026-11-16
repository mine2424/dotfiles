# Pi + pstack + Ponytail v2

Piがモデル・ツール・セッションを管理し、pstackが依頼を分類してPlaybookと委譲先を選ぶ。
Ponytailは最小実装の専門Skill、共通Principlesは変更範囲・検証・公開の制約を担う。
工程を固定せず、作業で得た事実に応じて調査・設計・実装・検証を組み替える。

## 導入

macOS・Linux・WSLでGit、Bash、curlを用意する。Nodeはmiseで自動導入する。
WindowsではWSL内で実行する。

```bash
git clone https://github.com/mine2424/dotfiles.git ~/development/dotfiles
cd ~/development/dotfiles
bash scripts/setup-pi.sh --install --dry-run
bash scripts/setup-pi.sh --install
export PATH="$HOME/.local/bin:$PATH"
python3 scripts/check-pi.py --smoke
pi
```

診断にはPython 3も必要。通常セットアップの `bash scripts/setup.sh --pi --install --force` と
`--all --install` も同じ構成を使う。全環境を入れない場合は専用スクリプトを推奨する。
設定と独自Skillのリンクだけなら `bash scripts/setup-pi.sh`。外部パッケージの追加と
Ponytailのv2移行には `--install` が必要。

固定版は [versions.env](versions.env) を唯一の設定元とする。
Pi 1.5.2、pstack 0.9.0、pi-subagents 0.88.1、Ponytailは確認済みSHAを採用。
依存パッケージの全ツリーをlockするものではない。更新時は配布物を確認して固定値を変え、再検証する。

## 最初の利用

Piで `/login` → `/model` → `/pstack status` を実行する。
必要に応じ `/setup-pstack` で利用可能なモデルとthinkingを役割ごとに割り当てる。
未設定の役割は親モデルを継承する。同一モデルの複数サンプルは複数モデルレビューではない。
モデル設定 `~/.pi/agent/pstack/models.json` と認証はPCごとに管理し、dotfilesへ同期しない。

```text
/poteto-mode このRepoのログイン失敗を再現して修正して。仕様と既存の互換性は維持して。
```

これが標準入口。Poteto Modeはセッションに残り、解除は `/poteto-mode off`。
`/pstack off` はSkillカタログの表示設定で、Poteto Modeの解除とは別。
一度だけのprint/JSON実行では移植版の注意事項に従い `/skill:poteto-mode <依頼>` を使う。
新規セッションで開始することを推奨する。既存セッションへ `/reload` しただけでは
pi-subagentsのツールが追加されない場合があるので、同梱のguideを参照する。

## New / Change / Fix

| 独自Skill | 適用する依頼 | 判断の重点 |
| --- | --- | --- |
| `/skill:new-development` | 新しい機能・プロジェクト | 受入条件と最小の成果、必要な設計・試作 |
| `/skill:existing-change` | 既存改修・リファクタ | 呼び出し元、保持すべき挙動、互換性 |
| `/skill:incident-fix` | 不具合・障害対応 | 影響、再現、緩和と根本原因、回帰防止 |

pstackの標準Playbookを複製せず、その上にRepo共通の判断を加える。
[Principles](principles.md) は別ファイルで、どのPlaybookにも共通して適用する。
グローバルAGENTSがその読込とルーティングを案内し、子のbriefにも原則とSkillの実パスを渡す。

| pstackの専門機能 | Piでの呼出し例 |
| --- | --- |
| 動作・意図を調査 | `/skill:how`、`/skill:why` |
| API・型・境界を設計 | `/skill:architect` |
| TDD・回帰防止 | `/skill:tdd` |
| 差分の多視点レビュー | `/skill:interrogate` |
| 複数案を比較 | `/skill:arena` |
| 余分な実装・説明を整理 | `/skill:unslop` |
| 経験から改善案を作る | `/skill:reflect`、`/skill:correct` |

Skillは必要時に選択する。すべてを毎回実行するチェックリストにはしない。
Piでは通常のSkillに `/skill:` が必要。`/poteto-mode`、`/setup-pstack`、`/pstack` はExtensionコマンド。
pstackの配布元はCursor公式版の第三者移植で、同じ製品や全機能の同等性を保証するものではない。

## Ponytailとレビュー

v2ではPonytailの旧Extensionを `extensions: []` にし、Skillだけを読み込む。
旧版のシステムプロンプト全体差替えとpstackの構造化された指示追加が競合しない構成にするため。
`/ponytail status`、`/ponytail off` 等の旧コマンドはv2では使わない。

- `/skill:ponytail`: 既存・標準機能を使い、必要なものだけを作る判断。
- `/skill:ponytail-review`: 不要な複雑さのレビュー。
- `/review`: 正しさ・回帰・境界条件のレビュー。指摘候補を根拠と確度付きで提示し、投稿・修正はしない。

Recruit記事からは「AIの候補を人が選ぶ」考え方を参考にした。公式Skillの導入や完全再現ではない。
仕様が不明なものは質問に分け、複数のモデルを使った場合は実行したモデルも報告する。
UI・認可・入力検証等の重要な変更は、そのRepoの実画面や回帰ハーネスで検証する。

既存の `/plan` は編集しない調査、`/work` はpstackへルーティングする互換Prompt、
`/handoff` は会話内への引き継ぎ。これらを順番に実行する必要はない。
`/work` のPrompt展開はstickyモードの切替ではない。
再開は `pi --continue` / `pi --resume`、履歴の別案は `/tree` / `/fork` を使う。

## 設定の保持と復旧

AGENTS、PRINCIPLES、3つのSkill、4つのPromptは個別リンク。同名の個人ファイルは保持して警告する。
保持された内容にv2の原則が反映されるとは限らないので、警告時は必要な内容を手動マージする。
`settings.json` は初回だけコピーし、外部パッケージ登録はPi標準コマンドで行う。
Ponytailのフィルター移行は対象の登録だけを変更し、他のモデル・パッケージ・Skillフィルターを保持する。
移行前の設定はローカルの `settings.json.before-pstack.<時刻>` へ保存する。
認証・履歴・キャッシュ・モデル割当はGit管理しない。`PI_CODING_AGENT_DIR` にも対応する。

Piは `~/.local/share/dotfiles/pi/`、起動は `~/.local/bin/pi`。
ランチャーは固定版Piのbin、miseのNode、ローカルbinの順でPATHを選び、旧Nodeや別のグローバルPiの混入を防ぐ。既存ランチャーはローカルの
`~/.local/state/dotfiles/backups/` へ退避する。他のプロジェクトのNode既定版は変えない。
版や設定が壊れた場合は診断してから再実行する。ローカル退避ファイルを公開しない。
Repo固有情報は [AGENTS雛形](project-AGENTS.example.md) を既存ルールへマージする。

## 検証と次の段階

```bash
python3 -m unittest discover -s scripts/tests -p test_setup_pi.py -v
python3 scripts/check-pi.py --smoke > /tmp/pi-pstack-check.json
```

GitHub ActionsでのPi用CIは実行せず、push前のローカル検証にする。
各PCのdotfilesチェックアウトで一度フックを設定する。

```bash
bash scripts/setup-hooks.sh        # miseでLefthookを導入しpre-pushを設定
bash scripts/check-pi-local.sh     # 手動でも同じ検証を実行できる
```

Lefthookは `mise/config.toml` に固定する。フックは関連ファイルの変更時だけ、構文検査と
セットアップ回帰テストを実行する。パッケージ導入・モデル呼出し・実環境診断はpush時には行わない。
既存のpre-pushやcore.hooksPathがある場合は保持して停止するので、手動で統合する。
フックは各チェックアウトに導入が必要で、GitHub側での必須チェックではない。

診断は版・登録・Skillリンク・Ponytail旧Extensionの無効化を確認する。
`--smoke` は一時設定と実際のPi RPC/SDKを使い、スクリプト化したローカルモデルで
pstackの指示合成、サブエージェント定義の発見、モード解除を確認する。
他の個人Extensionや認証ファイルはロードせず、課金APIは呼ばない。
実モデルによるPlaybook選択・子の実装品質・複数モデルのレビューは別の受入確認が必要。
macOS・WSLの実機確認も未実施。結果は [versions.md](versions.md) に記録する。

Outer Loopの自動スケジュールは次段階。まず対象セッションとRepoを明示してreflect / correctで
改善案を作り、差分を人がレビューしてから反映する。無関係な履歴の収集や自動公開はしない。
依頼時にのみ改善PRを作る。UbieのRemoco相当のクラウド基盤は構築しない。

根拠とソース確認の範囲は [research.md](research.md)。初期設計は
[履歴資料](../docs/pi-ponytail-design.md)。現行手順はこのREADMEを優先する。
