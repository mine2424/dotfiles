# 共通・project/repoのルールとハーネス設計

更新日: 2026-10-25 / 状態: P3の対話適用・実行・信頼管理を実装し、Codex実モデルの開発者受入まで確認

[基本設計](design.md)、[共通基盤設計](components.md)、[Orchestrator設計](orchestrator.md)を補足する。P1のconfig loaderとは別に、P1Rの`rules.ts`で宣言を検査し、P3の`agent.ts`・`harness.ts`で対話へ適用・実行・許可を管理する。現在の試験範囲は[P3受入記録](p3-acceptance.md)を参照。Worker適用とbackup/restoreは後続段階。

**本人が確認した初期方針:** `rules.example.md`の文章ルールを採用する。共通ハーネスには現時点で必須checkを設けず、`harness.example.json`を空の宣言とする。どちらも共通設定先への自動コピーはしない。

## 1. 目的と対象

**開発全体で守る原則を共通化し、project/repo固有の条件を追加して、対話Agent・Worker・検証・復旧で一貫して使えるようにする。projectとrepoは同じ管理単位とする（ユーザー確認済み）。** 本人が読み書きできるMarkdownと小さな宣言JSONで管理し、初期から独自言語やplugin基盤を作らない。

| 用語 | 管理する内容 | 適用・確認の方法 |
| --- | --- | --- |
| ルール | コードの書き方、日本語コメント、作業範囲、設計・レビュー上の原則 | モデルへ出所付きで渡し、レビューで確認。文章を与えただけで遵守を保証しない |
| 実行ポリシー | 編集・shell・送信先・権限・予算等の制約 | 既存のPolicy/設定合成で判定。ルール本文から許可を生成しない |
| ハーネス | 作業を支える事前確認、既存テスト・型検査・lint、期限、必要環境、受入証拠との対応 | 許可したコマンドをController/Verifierが実行し、結果をEvidenceへ保存 |

ハーネスはPiや既存tool実行・状態管理を組み合わせて構成する。ルール管理のために別のAgent Runtimeを作らない。LLMレビューを使う場合も既存Reviewerの役割へ接続する。

Beethoven本体をCodexで開発する際の「素直なコード・最小構成・コード内コメント」は基本設計1.3章の原則として維持する。この管理機能を本体開発にも適用する場合は、規約の正本を決めて参照し、Codex用指示とBeethoven用指示に同じ文章を二重管理しない。

## 2. 適用範囲と配置案

適用は「共通」と「project/repo」の二層を基本とし、Taskではその具体化・追加制約を扱う。別のproject ID、複数repoの所属登録、project専用の管理階層は作らない。既存の1 Run・1 repo制約を維持する。

```text
~/.config/beethoven/                  # 個人の共通設定root。XDG指定に追従
  rules.md                           # 全開発での文章ルール
  harness.json                       # 全開発で必要なcheck IDと条件

<repo>/
  AGENTS.md                          # 既存の開発規約を優先して再利用
  .beethoven/config.json             # 既存の宣言設定
  .beethoven/harness.json            # repoで実行する具体的なcheck
```

repoの文章ルールは`AGENTS.md`を基本とし、同内容の`.beethoven/rules.md`を自動作成しない。既存の別ファイルを正本とする場合は、本人が明示登録した文書を参照する。初期はrepo全体の規約に絞り、path別の複雑な優先規則は後続の必要が生じてから追加する。

P1Rで実装した探索先は共通`rules.md`とrepo rootの`AGENTS.md`のみ。他の正本文書の登録は必要時の追加作業とし、現在は自動探索しない。共通ファイルのdotfilesへのsymlinkは利用可能だが、repo側の原本がsymlinkでrepo外を指す場合は診断で拒否する。読込上限は原本ごと1MiB。

project/repoの識別にはcanonicalなGit common directoryを使う。規約の探索は確認したrepo rootを基準にし、登録外の親directoryや他repoを自動探索しない。Git管理外での起動は共通ルールのみとし、repo専用ハーネスが必要な実行はrepo指定を求める。

worktreeは元repoと同じ管理単位だが、文章ルール・ハーネスの実体はそのTaskの固定版から取得する。別cloneや復元先はpathが変わるため本人が対応を確認する。remote URLの一致だけで信頼を継承しない。

## 3. 合成・競合・例外

文章ルールは共通→project/repo→Taskの順に出所を付けて渡す。下位の文書を読み込んだだけで上位が失効する仕組みにはしない。具体化と、制約の解除を区別する。

| 種類 | 合成方法 | 競合時 |
| --- | --- | --- |
| 書き方・設計原則 | 適用文書を併記し、repo固有の具体化を追加 | 機械的に意味の矛盾を完全検出できない。検出・申告した競合は質問し、黙って片方を捨てない |
| 接続・path・権限・予算 | 個人→project/repo→CLIの明示制約の共通部分。上限は厳しい方 | 拡大要求は拒否または本人判断。Task本文で自動解除しない |
| 必須check | 各層の必須IDを和集合にする | repo/Taskで必須checkを削除・任意へ変更できない |
| checkの具体的実行方法 | 共通の要件IDをrepoのargv等へ結び付ける | 同IDの実行定義が複数あれば曖昧な上書きをせず、正本を選ぶまでblocked |
| 許可の有効範囲 | 本人が指定した操作・Session/Run・対象版の範囲 | 期限切れや対象変更で再評価。復元時の承認自動復活は禁止 |

checkの不足を「対象外」にする場合も理由・判断者・適用範囲を記録し、必須IDの黙示的な省略をしない。初期は恒久的な例外DSLを作らず、本人が上位の宣言を改版するか、対象SHA/Taskに限った判断記録を残す。文章ルールの例外とtool実行許可は別記録とする。

## 4. ハーネスの最小宣言

共通は「何を必須とするか」、project/repoは「このrepoでどう実行するか」と追加要件を管理する。既存のpackage script・test suite・CI定義を再利用し、検証コマンドや規約の本文をBeethoven専用に複製しない。

共通の`harness.json`へ必須checkを追加する場合の例（現在の採用初期値は必須なし）:

```json
{
  "schemaVersion": 1,
  "requirements": [{ "id": "tests", "required": true, "stage": "verify" }]
}
```

repoの`.beethoven/harness.json`の例:

```json
{
  "schemaVersion": 1,
  "checks": [{
    "id": "tests",
    "stage": "verify",
    "argv": ["npm", "test"],
    "cwd": ".",
    "timeoutMs": 600000,
    "acceptanceIds": ["AC-01"],
    "requiredEnv": []
  }]
}
```

例のcheck・基準IDは実repoで定義する。Task固有の受入基準が異なる場合は実行前に対応を検査し、存在しないIDへ合格証拠を付けない。MVPのstageは`preflight / verify`に限定する。前処理や後処理を無制限に差し込めるhook機構は作らない。

check ID、argv、cwd、期限、必要環境変数名、stage、基準IDをschemaで検査する。cwdは許可workspace内とし、環境変数の値やcredentialを宣言に含めない。人間確認の項目は既存の受入基準として管理し、shellのexit codeへ変換しない。

preflight失敗はWorker起動前にblocked/環境失敗へ分類する。verifyは候補状態を固定してControllerが独立実行し、pass/fail/unknown/not_applicableと証拠を残す。対象状態が変われば必要な証拠を失効させる。checkを起動しただけでTaskをacceptedにしない。

## 5. 信頼と実行許可

文章を読ませること、check定義の検証、コマンドの実行許可を区別する。現在の`--trust-repo-config`はP1の宣言設定用であり、新たなハーネスの実行許可には拡張しない。

信頼確認時は、出所、対象repo、実行argv/cwd、期限、要求する権限と必要環境を表示する。許可は定義hash、参照するscript/package script・lockfile等の確認可能な版、実行先とPolicyを結び付ける。定義が同じでも実行コードが変われば再評価する。

任意の推移依存やshellの挙動までhashで完全に保証できるとは表示しない。host実行と隔離実行の違いは既存設計に従う。Agentがテストや実行定義を書き換え、必須条件を弱めて自分で合格にすることを禁止する。必要な変更は差分を提示し、再確認する。

check不許可・環境不足・非対話の承認待ちではblockedとし、明示された必須gateを飛ばして継続しない。許可済みの同じ対象・条件について毎回確認を繰り返さない。read-onlyの診断はハーネスを実行しない。

## 6. 実行中の適用・Worker・復旧

起動/Task開始時に、適用scope、repo identity、各ルールのpath/hash/版、実効ポリシー、check一覧、信頼・不足・競合をまとめた**適用snapshot**を保存する。本文の原本とhashをartifactとして残し、再開時に参照先が書き換わっていても当時の条件を確認できるようにする。

対話AgentとWorkerは同じsnapshotを基準に、必要な文書とcheck情報を受け取る。独自loaderとPiの自動探索で二重投入しない。summaryやモデル切替後もルールの正本・実行制約はDB/snapshotから取得する。完了時にはルールの適用状況とcheck結果、未確認を報告する。

実行中のrule/harness変更は監視またはtool実行前・段階境界で検出する。snapshotを黙って差し替えず、影響する編集/検証を止めて差分を示す。関連Taskの停止・plan改版・再検証はOrchestratorの再計画処理を使う。変更scopeだけを再確認し、無関係なrepoの実行を止めない。

resumeでは旧snapshotと現ファイルを照合し、変更があれば「旧版を使う/新版へ移る」を本人が判断する。本人が認めても、現在の権限・送信先制約より緩い旧版を無条件実行しない。新しいcheckや実行コードには新しい信頼確認を必要とする。

## 7. 管理操作・Git管理・バックアップ

本人がMarkdown/JSONを直接編集し、差分を見て運用できることを基本とする。操作案:

```bash
beethoven rules show --json    # 有効scope・出所・hash・実効条件を表示
beethoven rules check          # 宣言の整合・不足・競合を検査。コマンドは実行しない
beethoven rules snapshot       # 検査済み原本をローカルartifactへ明示保存
```

信頼確認は明示操作として追加するが、初期から管理画面や自動配布serverを作らない。診断は欠けた必須check、未信頼定義、repo不明、版差異を表示する。

共通の非機密ファイルはdotfiles等でGit管理できるようにし、project/repo規約・check定義は対象repoで管理する。端末固有pathや承認記録はGit管理する文書と分ける。適用snapshot・実行履歴・Evidence・repo識別情報をBeethovenの暗号化backupへ含め、repo側の必要な原本も復元できるようにする。

復元後はrepoのpath対応を確認し、原本・hash・必須check・現在の権限を検証する。旧端末での実行許可をそのまま有効化しない。

## 8. 実装順序と受入条件

P1Rではルール読取・JSON schema・合成・repo識別・出所・hash・snapshotとshow/check/doctorを実装した。追加8件と既存6件の計14テストでローカル確認。RH-01〜03の宣言範囲を対象とし、モデル適用やcheck実行・承認の試験とは区別する。

| 段階 | 実装する最小範囲 |
| --- | --- |
| P1R（P3着手前） | rule/harness schema、repo識別、合成・出所・snapshot、非実行のshow/check、宣言の決定的な試験 |
| P3 | 対話へルールを一度だけ適用、Policy・信頼確認、preflight/verify、変更検出・再開時の照合 |
| P4 | 原本・snapshot・repo対応のbackup/restore |
| P5〜P6 | Workerへの同版引継ぎ、必須gate、影響Taskの停止・plan改版 |
| P7〜P8 | repo CIとの対応、本人の編集・更新・復元手順の受入 |

P1Rは当初フラットなresolverとschema検査から作り、汎用ルールエンジンや任意コードhookを導入しない。

| ID | 受入シナリオ |
| --- | --- |
| RH-01 | 2つのテストrepoに同じ共通条件と別々のrepo条件を適用し、worktreeも同じ管理単位として識別する |
| RH-02 | repo/Task/CLIが上位の権限や必須checkを黙って解除できない |
| RH-03 | show/checkで出所・hash・不足・競合が分かり、shell/モデルを実行しない |
| RH-04 | check定義・参照scriptの変更が再評価され、古い許可・証拠で成功扱いしない |
| RH-05 | 対話/Worker/モデル切替/圧縮/再開で適用snapshotを保持し、二重投入しない |
| RH-06 | preflight失敗、verify失敗、環境不足、承認待ちを分類し、必須gateを省略しない |
| RH-07 | 本人が文章と宣言を手編集し、影響scopeを確認して改版できる |
| RH-08 | 別領域へ原本・snapshot・repo識別情報を復元し、pathと実行許可を再確認できる |
