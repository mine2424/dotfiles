# Pi + Ponytail 開発環境 詳細設計・手動構築ガイド

作成日: 2026-09-22

状態: 設計。Piのインストール、認証、設定の適用、実際の開発での動作確認は未実施。

## 1. 結論と設計方針

**dotfilesで小さな設定を管理し、Pi標準機能とPonytailをそのまま使う。構築・更新・復旧は本人が手動で行う。**

最初の完成形は、任意の開発リポジトリで`pi`を起動し、Ponytailを有効にした状態で、調査・最小変更・検証を一貫して進められること。独自の開発プラットフォームやワークフローエンジンは作らない。

- Piに任せる: モデル接続、ツール実行、コンテキスト読込、セッション、UI、パッケージ管理。
- Ponytailに任せる: 作る必要性の吟味、既存実装の再利用、標準機能の優先、過剰設計のレビュー。
- dotfilesに置く: 個人の短い原則、導入時の設定例、必要になった手順、採用バージョンの記録。
- 各リポジトリに置く: 構成、実在する検証コマンド、業務上の制約。
- 人間が担う: 作業開始時のブランチ選択、重要な設計判断、差分確認、commit・push・PR・merge。

初期構築では自作Extensionはゼロとする。繰り返し発生した問題だけを、既存機能→短い文書→小さな拡張の順で解決する。

## 2. 調査時点の前提

### 2.1 このdotfilesの状態

| 確認対象 | 確認結果 | 本設計への反映 |
| --- | --- | --- |
| `mise/config.toml` | Node `24.21.0`を指定 | 既存miseを継続利用。Node 24系のLTS更新を取り込み、動作確認した具体的なバージョンを固定する |
| `Brewfile` | `mise`と`node`を定義済み | 実際の`node`と`npm`の解決先を確認する |
| `scripts/setup.sh` | CLI・Claude等の既存セットアップあり。Pi専用処理なし | 今回は連携せず手動構築する |
| `docs/` | ツール別ガイドを配置 | この文書をPi/Ponytailの入口にする |
| `codex/`・`.claude/` | 既存AIツールの設定あり | Piには必要なルールだけを取り込む |
| `pi/`・`command -v pi` | 調査時点では存在／検出なし | 新規導入を標準手順とし、既存環境がある場合の退避も用意 |

設計書の初版作成では、この設計書のみを追加した。2026-09-22にNodeの採用版を`24.21.0`へ更新し、`mise/config.toml`にも反映した。実環境への導入と動作確認は別途行う。

### 2.2 公式仕様の確認基準

以下は導入候補を再現できるようにするための記録であり、組み合わせの動作保証ではない。

| 対象 | 確認した版／ソース |
| --- | --- |
| Pi CLI | npm公開版`@earendil-works/pi-coding-agent@0.86.1`。配布物のREADME・設定・パッケージ・Prompt仕様も確認 |
| Piソース | `earendil-works/pi`、commit `8c727937854b4f435df56809b022ae1015a17c9e` |
| Node要件 | Pi `0.86.1`は`>=22.19.0`。採用版の`24.21.0`は条件を満たす |
| Ponytail | `DietrichGebert/ponytail`、commit `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`。当該package.jsonは`4.10.0` |

Piの開発ブランチとnpm公開版は同一とは限らない。導入後の`pi --help`とインストール版同梱ドキュメントを優先する。以下のコマンド例は上記の版を基準にしている。[Piソース](https://github.com/earendil-works/pi/tree/8c727937854b4f435df56809b022ae1015a17c9e)、[npm版情報](https://registry.npmjs.org/@earendil-works/pi-coding-agent/0.86.1)、[Ponytailソース](https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156)

## 3. 参考設計から採用するもの・簡素化するもの

| 参考設計の要素 | 本設計での扱い | 理由 |
| --- | --- | --- |
| Pi + Ponytail | 初期必須 | 目的に直結する最小の組み合わせ |
| Global / Project AGENTS.md | 初期必須。既存ファイルがあれば追記・整理 | 原則とプロジェクト情報を分離する |
| `/work` | Phase 2でPromptを1つ追加 | 手順の入口は必要だが、状態機械は不要 |
| 9種類のSkill・6種類のPrompt | 実際に繰り返すものだけ追加 | 同じ手順を複数箇所に持たない |
| `safety.ts` | 問題が観測された場合に限定導入 | コマンド文字列検査だけで完全な保護はできない |
| `git-guard.ts` | 当面は手動Git操作と差分確認 | ブランチ管理・diff表示を自作しない |
| `quality-gate.ts` | Repoの検証コマンド＋既存CIで開始 | 言語別の自動推定は誤判定と保守を増やす |
| `session.ts`・`.ai/`一式 | Pi標準セッションを利用 | 履歴・作業状態の二重管理を避ける |
| 個人Pi Package | 当面不要。dotfiles内のファイルを個別リンク | 別リポジトリ、公開、配布、依存管理を増やさない |
| 独自Status Bar | Pi標準UI＋Ponytail表示を利用 | 初期用途では既存表示で足りる |
| Issue→PR自動化 | `gh`等の既存CLIを必要時に使う | コネクタやSDK/RPCを先に作らない |
| 自動モデル振分け・sub-agent | 導入しない | まず1タスク・1セッションの運用を安定させる |

Ponytailは**モデルへの指示と複雑さのレビューを提供する補助**であり、アクセス制御を強制するPolicy engineではない。Pi adapterは`before_agent_start`で指示を加え、モードをセッションに保存し、状態を表示する。すべてのモデル呼び出しやツール操作に対する安全性の保証とは区別する。[Pi adapter実装](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/pi-extension/index.js)

## 4. 全体構成と設定の所有者

```text
dotfiles/pi/                         本人が編集しGit管理
  agent/AGENTS.md ──個別リンク──> ~/.pi/agent/AGENTS.md
  settings.example.json ─初回コピー─> ~/.pi/agent/settings.json
  prompts/work.md ─個別リンク───> ~/.pi/agent/prompts/work.md  [Phase 2]
  skills/<name>/ ─個別リンク────> ~/.pi/agent/skills/<name>/  [必要時]

~/.pi/agent/                         Piが管理するローカル実体
  settings.json                     パッケージ登録・UI設定・モデル設定
  auth.json                         認証情報
  sessions/                         セッション履歴
  git/・npm/                        インストール済みパッケージ
  trust.json                        プロジェクトの信頼判断

開発リポジトリ/
  AGENTS.md                         構成・制約・検証方法
  .pi/                              Repo固有設定が必要な場合のみ
  docs/adr/                         長期に残す設計判断がある場合のみ
```

### 4.1 管理対象と管理しないもの

| ファイル／ディレクトリ | 所有者・変更方法 | Git管理 |
| --- | --- | --- |
| `pi/agent/AGENTS.md` | 本人がdotfiles側を編集 | する |
| `pi/settings.example.json` | 初回設定の小さな雛形。実設定全体の複製にしない | する |
| `pi/versions.md` | 動作確認したNode・Pi版・Ponytail SHA・日付を記録 | する |
| `pi/prompts/`・`pi/skills/` | 必要なファイルだけ追加 | する |
| `~/.pi/agent/settings.json` | Piコマンドまたは本人が編集する通常ファイル | しない |
| `auth.json`・`sessions/`・`trust.json`・パッケージキャッシュ | Piが生成・更新 | しない |
| Ponytailの既定モード設定 | 原則は標準の`full`。変更時だけ本人が設定 | 初期はしない |
| 各Repoの`AGENTS.md` | 各Repoでレビュー・管理 | そのRepoで管理 |

**`~/.pi`全体、`~/.pi/agent`全体、実際の`settings.json`をdotfilesへリンクしない。** `pi install`やモデル設定保存が実設定を書き換えるため、宣言した雛形と実行時状態を分ける。

秘密情報は雛形・AGENTS・Prompt・セッションの共有物に記載しない。設定やログを丸ごとGitに取り込む運用もしない。ローカルバックアップは共有せず、復元時に必要なファイルだけを選ぶ。

### 4.2 読込と既存設定の共存

Piはグローバルと作業ディレクトリの祖先にあるコンテキストファイルを読み込む。単純な「ProjectがGlobalを上書きする」仕組みではなく、指示は結合されるため矛盾を避ける。同じ場所の`AGENTS.override.md`が選ばれる場合や、`CLAUDE.md`を利用する場合も起動表示で確認する。[Context Files](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/README.md#context-files)

既存の`AGENTS.md`／`CLAUDE.md`を雛形で上書きしない。Codex・ClaudeのSkillを全部Piへ読み込ませる設定も初期には追加しない。Piの自動探索対象に既存の`~/.agents/skills/`等がある場合は、起動時の読込一覧と重複警告を確認する。[Skill探索仕様](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/skills.md#locations)

## 5. Phase 1: 最初に作るファイル

以下の`pi/`は**これから本人が作成する設計上の配置**。この設計書を追加しただけでは生成されない。

```text
dotfiles/
├── pi/
│   ├── agent/
│   │   └── AGENTS.md
│   ├── settings.example.json
│   └── versions.md
└── docs/
    └── pi-ponytail-design.md
```

### 5.1 `pi/agent/AGENTS.md`

初版は以下程度にとどめる。Ponytailのルール全文は転記せず、個人の運用原則を補足する。

```markdown
# 開発原則

- 日本語で簡潔に説明する。確認済みの事実と推測を分ける。
- 変更前に対象コード、呼び出し元、関連テスト、既存の類似処理を確認する。
- 依頼を満たす最小の変更にする。既存機能、互換性、安全策を簡略化のために落とさない。
- 既存実装とPonytailの判断基準を優先し、重複する仕組みを増やさない。
- 作業開始時にブランチと未コミット差分を確認する。
- main/masterでは編集せず、作業ブランチへの切替を本人に依頼する。
- 既存の未コミット変更を上書き・破棄しない。依頼外の整形・リファクタを混ぜない。
- RepoのAGENTS.mdと実際のCIを基準に、変更に必要な検証を実行する。
- 未実行、失敗、対象外を区別する。成功と報告する場合は実行根拠を添える。
- commit、push、PR作成、merge、deployは明示的に依頼された範囲だけ行う。
- 本番データ変更、破壊的操作、秘密情報の変更は、対象と影響を示して承認を得る。
- 完了時は変更内容、検証結果、残る課題を簡潔に報告する。
```

AGENTSはモデルへの指示であり、ブランチ保護や権限の強制ではない。機械的保証が必要な部分はCI・GitHub設定・実行環境側に置く。

### 5.2 `pi/settings.example.json`

```json
{
  "defaultProjectTrust": "ask"
}
```

デフォルト値を網羅しない。`packages`は`pi install`で実設定に追加する。認証、既定モデル、テーマ等は本人が選び、必要になった非機密設定だけを雛形へ昇格する。

`defaultProjectTrust`はプロジェクト由来の設定・拡張を読み込むかの判断であり、ツール実行ごとの許可やOSのサンドボックスではない。[設定仕様](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/settings.md)

### 5.3 `pi/versions.md`

```markdown
# 採用バージョン

- Node: 24.21.0
- Pi: 0.86.1
- Ponytail source: git:github.com/DietrichGebert/ponytail@e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156
- 導入確認日: 未確認
- 確認したOS: 未確認
- 認証・モデル応答: 未確認
- 小さな変更と検証: 未確認
- 備考: 設計時点の候補値。手動受入後に記入する。
```

Pi CLIはバージョン、PonytailはGit SHAを固定する。これで主要な導入元は再現できるが、OS・認証・モデル提供状況・推移依存まで完全に固定するものではない。

## 6. 手動構築の手順

各項目を確認してから次へ進む。一括実行するインストーラは作らない。既存Pi環境がある場合は、設定を上書きせず差分を見て統合する。

### 6.1 Nodeと作業場所を確認

```bash
cd "$HOME/development/dotfiles"
git status --short
command -v node
command -v npm
node --version
npm --version
command -v pi
```

`pi`未導入なら最後のコマンドが非ゼロ終了するのは正常。Nodeが未導入の場合は既存mise運用に従って導入し、改めて確認する。HomebrewとmiseでNodeが共存している場合、npmグローバル導入先がどちらになるかを確認する。

```bash
mise current node
npm prefix -g
```

### 6.2 既存Pi設定を退避

Piを終了してから実行する。退避先はdotfilesの外に置く。

```bash
PI_BACKUP_DIR="$HOME/.local/state/pi-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$PI_BACKUP_DIR"
chmod 700 "$PI_BACKUP_DIR"
if [ -e "$HOME/.pi/agent" ]; then
  cp -Rp "$HOME/.pi/agent" "$PI_BACKUP_DIR/agent"
fi
```

既存リンクがある場合は`ls -ld`・`readlink`で元の参照先を別途記録する。退避には認証情報や会話が含まれうるため、Gitへ追加しない。Ponytailの共有設定を変更する場合は、その設定ファイルも事前に退避する。

### 6.3 Pi CLIを導入

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.86.1
pi --version
pi --help
```

権限エラーが出ても`sudo npm install`に切り替えず、Nodeとnpmの参照先を確認する。Nodeバージョンを後日変更した際は、グローバルCLIが再導入を必要とすることがある。

### 6.4 設定ファイルを作成してリンク

第5章の3ファイルを本人がエディタで作成する。

```bash
mkdir -p "$HOME/development/dotfiles/pi/agent"
mkdir -p "$HOME/.pi/agent"
```

作成後、**リンク先の`AGENTS.md`が存在しないことを確認してから**以下を実行する。既存ファイルやリンクがあれば、内容と参照先を確認・退避し、必要な指示を統合した後で置き換える。`ln -sf`による強制上書きは使わない。

```bash
ln -s "$HOME/development/dotfiles/pi/agent/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"
```

`settings.json`が存在しない場合だけ雛形をコピーする。存在する場合はエディタで必要なキーだけ統合する。

```bash
if [ ! -e "$HOME/.pi/agent/settings.json" ] && [ ! -L "$HOME/.pi/agent/settings.json" ]; then
  cp "$HOME/development/dotfiles/pi/settings.example.json" "$HOME/.pi/agent/settings.json"
fi
ls -l "$HOME/.pi/agent/AGENTS.md"
python3 -m json.tool "$HOME/.pi/agent/settings.json" >/dev/null
```

期待結果: AGENTSだけがdotfilesを参照し、settingsは通常ファイルで、有効なJSONになっている。

### 6.5 Ponytailを確認して導入

まず固定した[ソース](https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156)の`package.json`、`pi-extension/index.js`、そこから読み込む`hooks/`、利用する`skills/`を確認する。その後、以下を実行する。

```bash
pi install git:github.com/DietrichGebert/ponytail@e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156
pi list
```

`-l`は付けない。全Repoで使うグローバルパッケージとして導入する。Piパッケージはコードを実行でき、依存導入も伴う。Pi本体の`--ignore-scripts`指定が別途行う`pi install`まで継承されるとは考えない。[パッケージ導入仕様](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/packages.md)

期待結果: `pi list`に固定SHA付きのPonytailが1件表示され、実設定の`packages`に登録される。Ponytailをさらに`~/.pi/agent/extensions/`へコピーしたり、そのSkillを別途リンクしたりしない。

### 6.6 認証と初回起動

開発Repoのルートで`pi`を起動する。信頼確認が出た場合、Repoの`.pi/`や関連設定を確認して判断する。

Pi内で次を順番に行う。

```text
/login
/model
/ponytail status
```

利用するプロバイダーを選択して本人が認証する。APIキーを使う場合もPiの認証導線等を使い、dotfilesの追跡ファイルへ書かない。モデルは利用可能な一覧から選ぶ。特定のモデル名は本設計で固定しない。起動時の既定値として保存したい場合はモデル選択画面の`Ctrl+S`を使う。

最初の依頼例:

```text
このリポジトリのAGENTS.mdと主要な構成を確認し、利用可能な検証コマンドを説明してください。
今回は調査だけにして、ファイル変更やインストールは行わないでください。
```

これは自然言語による作業範囲指定であり、書込み権限を技術的に外すものではない。

## 7. Ponytailの運用

### 7.1 モード

| 用途 | 開始時の選択 | 運用上の考え方 |
| --- | --- | --- |
| 通常の機能追加・修正 | `full` | 基本はこれだけで運用する |
| 設計案を広く比較する調査 | 必要なら`lite` | 早すぎる絞り込みを避けたい場合だけ手動で変更 |
| 限定範囲の整理 | 必要なら`ultra` | 機能・安全策・テストを削る理由にはしない |
| 挙動の切り分け | `off` | Ponytailの影響を確認するため一時的に使う |

上表は個人運用上の推奨であり、タスク種別による公式の自動ルーティングではない。

```text
/ponytail status
/ponytail full
/ponytail lite
/ponytail ultra
/ponytail off
```

Pi adapterでは、状態の確認は明示的に`/ponytail status`を使う。確認した実装では引数なしの`/ponytail`はモード設定の動作をするため、他ホストの説明と混同しない。

既定値は`full`。保存済みセッションを再開すると、そのセッションのモードが復元される。全体既定を変えたい場合だけ`/ponytail default full`等を利用する。この設定は`PONYTAIL_DEFAULT_MODE`やPonytail共通設定の影響を受け、他の対応ホストにも関係しうる。初期構築では追加の環境変数や共通設定を作らない。[設定解決実装](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/hooks/ponytail-config.js)

### 7.2 レビュー

`/ponytail-review`は不要な複雑さを探すレビューで、正しさ・性能・セキュリティのレビューを代替しない。確認したSkillは指摘を出すもので、自動修正は行わない。[review Skill](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/skills/ponytail-review/SKILL.md)

レビュー前に対象を明示する。未コミット変更なら`git diff`・`git diff --cached`・未追跡ファイルを含め、PR全体なら実際のbase branchとの比較を指定する。`git diff`だけではcommit済みの変更や未追跡ファイルは見えない。

通常は同一セッションで「正しさの確認→Ponytail review」を行う。認証・認可・外部入力・秘密情報を扱う変更ではセキュリティ観点も指定する。レビューのためだけに3つの常駐agentを作らない。

## 8. 各リポジトリへの適用

### 8.1 最小のProject AGENTS.md

まず既存の指示とCIを調査する。以下は記入項目の雛形であり、未確認のパスやコマンドをそのまま置かない。

```markdown
# Repository

## 構成
- エントリポイント:
- 主な機能の配置:
- データアクセスの配置:
- テストの配置:

## 制約
- 既存の互換性・データ整合性に関する制約:
- 変更してはいけない生成物・migration等:

## 検証
- 実行ディレクトリ:
- 依存導入方法と前提:
- formatの確認コマンド:
- lint:
- typecheck:
- 関連test:
- build:
- 外部サービスが必要な検証と実行条件:
```

TypeScriptだから`pnpm typecheck`、Goだから常に`go test ./...`と決め打ちしない。package.json・Makefile・既存スクリプト・CIから実在するコマンドを確認して記入する。該当しない検証は「対象外」と理由を書く。monorepoでは各コマンドのcwdも必要。

### 8.2 追加ディレクトリを作る条件

| 追加先 | 作る条件 |
| --- | --- |
| `.pi/settings.json` | Repoだけで有効にしたい設定がある |
| `.pi/skills/`・`.pi/prompts/` | 他Repoでは使えない手順が繰り返し必要 |
| `docs/adr/` | 代替案・選定理由を長期に残す必要がある |
| 一時メモ | 複数日にまたがる作業で、セッション再開だけでは足りない |

一時メモは最初から`.ai/`一式を作らず、必要なら`docs/ai/current.md`の1ファイルから始める。作業対象、確認した事実、未完了、検証結果を短く書き、ローカルだけなら`.git/info/exclude`にそのパスを登録する。完了後は本人が整理し、恒久的な判断だけをADR等へ移す。

## 9. Phase 2: `/work`と必要なSkill

### 9.1 追加の判断

まずPhase 1で数件の実作業を行う。同じ指示を3回以上繰り返したら、以下の基準で追加する。

- 短い開始指示だけで足りる: Prompt。
- 手順や参照資料が必要: Skill。
- 既存AGENTSやPonytailに同じ内容がある: 追加せず元を整理。

初期追加は`work.md`を1つだけ。Skillは候補を用意しても、必要性を確認するまでファイルを作らない。

### 9.2 `pi/prompts/work.md`の設計

```markdown
---
description: 調査から検証・差分確認まで、Repoの手順に沿って作業する
argument-hint: "<依頼内容またはIssue URL>"
---
対象: $ARGUMENTS

AGENTS.mdを確認し、現在のブランチと既存差分を把握してください。
対象が空、または作業対象を特定できない場合は、変更前に必要な情報を確認してください。
Issue参照の場合は内容を取得し、取得できなければ本文の共有を依頼してください。
対象コード、呼び出し元、関連テスト、類似実装を調べ、変更方針を短く示してください。
大きな設計変更・互換性変更・新規依存が必要なら、実装前に判断点を確認してください。
依頼の範囲内で最小限の変更を行い、Repoが定める必要な検証を実行してください。
最後に差分を確認し、変更内容、検証結果、残る課題を報告してください。
commit・push・PR作成は、明示的に依頼された場合だけ行ってください。
```

`/work`は文章を展開するだけで、フェーズ状態、権限、検証完了を機械的に管理しない。テンプレート本文に`/skill:...`を書くだけで複数コマンドが順次実行されるとは扱わない。Skillの確実な明示起動が必要なら、ユーザーが別途実行する。[Prompt仕様](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/prompt-templates.md)

配置後、リンク先が存在しないことを確認してリンクする。

```bash
mkdir -p "$HOME/.pi/agent/prompts"
ln -s "$HOME/development/dotfiles/pi/prompts/work.md" "$HOME/.pi/agent/prompts/work.md"
```

Piで`/reload`を実行し、`/work`の補完と引数の展開を確認する。使用例:

```text
/work ログイン後の画面遷移が失敗する原因を調べ、最小限の修正をしてください
/work https://github.com/OWNER/REPO/issues/589
```

`/bug`はPi本体の不具合報告コマンドと衝突するため、自作テンプレート名に使わない。

### 9.3 Skill候補の責務

| 候補 | 入力 | 必須の出力・境界 |
| --- | --- | --- |
| `investigate` | 症状・問い・対象範囲 | コード根拠、確認済み事実、仮説、次の確認。原則編集しない |
| `bugfix` | 期待動作・実際の動作 | 再現、原因、最小修正、回帰確認。機能削除で解消しない |
| `implement` | 受入条件と対象範囲 | 既存パターンの確認、実装、必要な検証結果 |
| `review` | 比較元・比較先・対象差分 | 根拠箇所、影響、再現条件、重要度。原則修正しない |

追加する場合は`pi/skills/<name>/SKILL.md`に`name`・`description`と手順を書く。`~/.pi/agent/skills/<name>`へ個別リンクし、`/skill:<name>`で確認する。`bugfix`の手順は「再現→原因追跡→類似実装確認→修正→回帰確認」に絞る。database・release等は実際の反復が発生してから追加する。

## 10. 日常の開発フロー

```text
本人: Repo・ブランチ・未コミット差分を確認
  ↓
Pi: 調査 → 方針提示 → 最小変更 → 検証 → 差分レビュー
  ↓                       ↑
本人: 大きな判断点のみ確認 ─┘
  ↓
本人: 差分・未実行検証を確認 → commit / push / PR → merge判断
```

これは作業上の順序であり、独自の状態機械として実装しない。調査専用タスクは調査で完了する。小さな修正は、通常の進捗共有以外に固定の承認工程を増やさない。

### 10.1 開始

Repoルートで以下を確認する。

```bash
git status --short
git branch --show-current
```

main/masterにいる場合、本人が作業用ブランチを選ぶ。新しい作業であれば、重複しない名前を決めて`git switch -c fix/example-task`等で作成する。既存差分がある場合は、その所有者と今回の対象を確認する。勝手にstash・reset・一括stageしない。

並行作業は必要になった時だけGit worktreeを手動で作る。同じ作業ツリーを複数のagentに同時編集させない。

### 10.2 検証

検証コマンドはRepoの定義を利用し、結果を`成功／失敗／未実行／対象外`で報告する。未実行の理由が依存不足・認証不足・サービス未起動なら、その条件を書く。

検証後にコードを変更した場合、影響する検証結果は古くなるため再実行する。テストの成功と、本番環境やブラウザでの受入成功は分けて記録する。formatが変更を書き込むコマンドか、確認のみかも区別する。

### 10.3 終了・PR

```bash
git diff --check
git diff --stat
git diff
git diff --cached
git status --short
```

PR全体を確認するときは、実際のbaseを確認して`git diff <base>...HEAD`等を併用する。必要な変更だけを本人がstageし、既存CIの結果も見てPRを作成する。PiにPR本文を作らせる場合も、未実行の検証を成功と記載させない。

Issue読込に`gh`を使う場合は、本人が`gh auth status`で接続先を確認する。`gh issue view`・`gh pr create`等の既存CLIで足りる間は専用Extensionを作らない。初期運用でmergeや本番deployを自動化しない。

### 10.4 継続

作業ディレクトリに戻って`pi -c`、または`pi -r`で再開する。過去の検証結果は、その後の差分や環境変更を確認してから利用する。セッション全体をナレッジベースとしてGitへ保存しない。[セッション仕様](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/README.md#sessions)

## 11. Phase 3以降: 拡張が必要になった場合の設計

**この章は導入候補の条件と境界を定めるもので、初期構築の必須タスクではない。** 追加時は1機能ずつ導入し、効果がなければ戻す。

### 11.1 `safety.ts`を追加する条件と契約

条件: 誤った破壊的操作や保護対象への書込みが実際に問題になり、既存の運用・権限制限だけでは足りない。

| 項目 | 最小設計 |
| --- | --- |
| 配置 | `pi/extensions/safety.ts`を作成し、グローバルExtensionsへ個別リンク |
| 入力 | `tool_call`のツール名・引数・実行cwd |
| 対象 | 確実に識別できる`write`／`edit`の保護パス、明示的な危険Git操作等 |
| 出力 | 許可、または対象・理由付きのブロック／確認 |
| 承認 | 操作内容と対象に限定。同一セッションの全操作を一括許可しない |
| 非対話実行 | 確認が必要な操作を自動許可しない。拒否理由を返す |
| 状態 | 最初は永続化しない |

パス検査ではcwdからの解決、`..`、既存の親ディレクトリのsymlinkを考慮する。ただし`bash`経由のPython・リダイレクト・外部スクリプト・Extension自身のI/Oを、単純な正規表現では網羅できない。ユーザーの`!`コマンドには別イベントもある。`tool_call`だけでOS全体を保護できるとは説明しない。

許可ツールを狭めるか、実行環境で権限を制限する必要があるかを先に判断する。公式の`permission-gate.ts`・`protected-paths.ts`は出発点として参照するが、包括的なサンドボックスとは扱わない。[Extensions仕様・公式例一覧](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/extensions.md)

導入時の最低確認: 正常操作、拒否、承認取消、非対話、相対パス、symlink、意図的な回避例。対応できない経路を明記する。Piのプロジェクト信頼確認と、この補助的な操作確認を混同しない。

### 11.2 検証の自動化を追加する条件

条件: 検証の実行漏れが反復し、Repoの既存コマンドを一つにまとめても改善しない。

最初はRepo側の`make verify`や既存npm script等に集約する。それでもPi内の表示が必要な場合だけ`/verify` Extensionを検討する。

- 言語・ファイル名からコマンドを推測しない。Repoが明示したコマンドを使う。
- 実行前にコマンドとcwdを表示し、終了コード・実行時刻・対象差分を記録する。
- `成功／失敗／未実行／対象外`を区別する。
- コード変更後は影響する成功表示を無効化する。
- 未追跡・stage済み差分も対象に含める。HEADだけで鮮度を判定しない。
- Extensionを通さずcommitやpushは可能なので、merge条件の強制はCI側に置く。

`quality-gate.ts`という名前を先に付けて、表示だけの機能を強制ゲートと誤認させない。

### 11.3 その他の拡張判断

| 候補 | 追加の判断 |
| --- | --- |
| Git状態表示 | 手動確認で支障が出たら表示専用から開始。自動stash・branch作成は含めない |
| diffサイズ警告 | 個人の目安として扱う。行数を減らすための機能・テスト削除を促さない |
| 個人Pi Package | ファイル数や利用端末が増え、個別リンクの管理が実際に負担になった時 |
| 作業状態のUI | 必要な状態が定義できてから。標準のモデル・コスト表示を再実装しない |
| session拡張 | 標準の保存・再開で解決できない具体的な問題がある場合のみ |

個人Package化するなら最初はdotfiles内のローカルPackageとし、`pi install /absolute/path/to/dotfiles/pi/package`で登録する。既存リンクとPackageの二重読込を解消してから移行する。別のprivate repoやnpm公開は必須にしない。

## 12. 更新・復旧・移行

### 12.1 更新

1. 作業中のPiを終了し、実設定を第6章と同様に退避する。
2. Piの変更履歴、Ponytailの差分、Node要件を確認する。
3. Piは採用する版を指定して`npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<確認した版>`を実行する。
4. Ponytailは確認した新SHAを付けて`pi install git:github.com/DietrichGebert/ponytail@<新SHA>`を実行する。
5. 第13章の受入確認を行い、成功した組み合わせを`pi/versions.md`へ記録する。

`<確認した版>`と`<新SHA>`は実値へ置き換える。自動更新を常設せず、初期運用では`pi update --all`による一括更新も使わない。Gitパッケージの管理クローンは更新で再配置されうるため、直接編集しない。[更新・固定refの仕様](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/packages.md)

### 12.2 復旧・無効化

| 症状 | 対応 |
| --- | --- |
| Ponytailだけ一時停止したい | `/ponytail off`。パッケージの除去やExtensionコードの無効化とは別 |
| Extension起動時に失敗 | 切り分け用に`pi --no-extensions`。自作保護Extensionも無効になるので通常作業には使わない |
| Ponytailを導入前に戻したい | Piを終了し、下記の`pi remove`で登録を解除。共通設定は他ホストへの影響を確認して復元 |
| 更新後だけ失敗 | Piを以前のnpm版へ再導入し、Ponytailを以前の固定SHAで再登録 |
| AGENTSやPromptの変更だけ戻したい | dotfilesの該当変更を確認し、必要な内容だけ復元して`/reload` |
| 設定ファイルが壊れた | Piを終了し、退避した`settings.json`だけを選んで復元 |
| `pi`が見つからない | `command -v node`、`npm prefix -g`、PATHとmiseのNode選択を確認 |
| `/ponytail status`が期待と違う | 保存セッション、既定モード、環境変数、共通設定を確認 |
| RepoのPrompt等が出ない | プロジェクト信頼、配置、構文、重複名、起動エラーを確認 |

Ponytailの登録解除コマンドは導入に用いたsourceを指定する。

```bash
pi remove git:github.com/DietrichGebert/ponytail@e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156
```

個別リンクを外す場合は`ls -l`と`readlink`でリンクであることと参照先を確認し、`unlink "$HOME/.pi/agent/AGENTS.md"`等で**リンクだけ**外す。必要なら退避済みの元ファイルを戻す。`~/.pi/agent`全体の削除・上書き復元は、認証や新しいセッションを失うため行わない。

### 12.3 新しいMacへの移行

dotfilesをcloneし、記録済みNode／Pi版の導入、AGENTS等の個別リンク、Ponytail固定SHAの導入、本人の認証、受入確認の順で行う。古い端末の`trust.json`や認証情報を無条件に複製しない。セッション移行が必要な場合だけ、本人が対象履歴を選んで別途移す。

## 13. 手動受入チェックリスト

各段階で必要な項目だけを実施する。ここではまだチェックを付けない。

### Phase 1の完了条件

- [ ] `pi --version`が採用版と一致する。
- [ ] `pi list`にPonytailが重複なく登録され、固定SHAを確認できる。
- [ ] `~/.pi/agent/AGENTS.md`だけがdotfilesを参照し、実設定は通常ファイルになっている。
- [ ] 起動時に期待するGlobal / Projectの指示が読み込まれる。
- [ ] `/login`と`/model`で認証・モデル応答を確認した。
- [ ] `/ponytail status`で`full`を確認し、切替後に戻せる。
- [ ] 小さな調査依頼でファイルを変更せず、コードに基づく回答が得られる。
- [ ] 作業ブランチ上で小さな修正を行い、実在する検証コマンドを実行できる。
- [ ] 差分に依頼外の変更がなく、成功／未実行の報告を区別できる。
- [ ] 終了後に`pi -c`で対象セッションを再開できる。
- [ ] Gitの追加候補に秘密情報、auth、sessions、キャッシュが含まれない。
- [ ] `pi/versions.md`へ確認日と結果を記録した。

### Phase 2の完了条件

- [ ] `/work`が補完に出て、引数が依頼文へ展開される。
- [ ] 引数なし・Issue取得失敗時に、対象を捏造せず確認へ戻る。
- [ ] 追加したSkillだけが重複なく読み込まれる。
- [ ] `/ponytail-review`と正しさのレビューの対象・役割が区別される。
- [ ] 小さな作業で不要な承認待ちや、依頼していない外部書込みが発生しない。

### 拡張追加時の完了条件

- [ ] 追加した理由と解消した反復問題を説明できる。
- [ ] 許可・拒否・失敗・非対話の挙動を確認した。
- [ ] 無効化・切り戻しを確認し、既存の正常作業を妨げない。
- [ ] 保証できない操作経路や未検証事項を記録した。

## 14. 段階別の実施範囲

| 段階 | 本人が実施すること | 完了判断 |
| --- | --- | --- |
| Phase 1 | Pi・Ponytail、Global AGENTS、1つのRepoへの適用 | 第13章のPhase 1を満たす |
| 観察期間 | 数件、目安1週間の実作業。繰り返した指示と失敗をメモ | 追加が必要なものを具体例で説明できる |
| Phase 2 | `/work`、必要なSkillのみ | 同じ説明を繰り返す負担が減る |
| Phase 3 | 必要な保護・検証補助を1つずつ | 対象の失敗が減り、正常操作を妨げない |
| 以後 | 必要ならPackage化、既存CLIでのPR作業補助 | 手動手順より維持コストを含めて簡単になる |

この設計に沿っても、Phase 1だけで運用を続けてよい。拡張の追加数を完成度の指標にしない。

## 15. 参照資料

本文中の仕様リンクは調査時点のcommitに固定した。再構築時は採用版の同梱資料と照合する。

- [Pi公式サイト](https://pi.dev/)
- [Pi README](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/README.md)
- [Pi Settings](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/settings.md)
- [Pi Packages](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/packages.md)
- [Pi Skills](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/skills.md)
- [Pi Prompt Templates](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/prompt-templates.md)
- [Pi Extensions](https://github.com/earendil-works/pi/blob/8c727937854b4f435df56809b022ae1015a17c9e/packages/coding-agent/docs/extensions.md)
- [Ponytail README](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/README.md)
- [Ponytail Pi adapter](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/pi-extension/index.js)
- [Ponytail共通設定](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/hooks/ponytail-config.js)
- [Ponytail review Skill](https://github.com/DietrichGebert/ponytail/blob/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/skills/ponytail-review/SKILL.md)
