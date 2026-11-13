# Beethoven 実装マイルストーン

更新日: 2026-10-25 / 状態: P4〜P8の機能を0.2.0へ追加。開発者試験・実モデル復元再開を確認、GitHub CIは本人指示で受入対象外、remote backup復元確認済み、0.2.1の鍵自動管理・復旧コードを実装、端末外保管と本人受入は操作中

このファイルは「次に何を決め、何を実装し、何を確認すれば先へ進めるか」を管理する入口です。仕様は[基本設計](docs/design.md)、[Orchestrator設計](docs/orchestrator.md)、[共通基盤設計](docs/components.md)を参照します。

追加要件: 共通とproject/repoのルール・ハーネスを管理します。**projectとrepoは同じ単位**です。[詳細設計](docs/rules-harness.md)に従い、P1Rの宣言・診断・snapshot保存、P3の対話への適用・ハーネス実行・信頼記録まで確認しました。単一Workerへの適用は先行基盤で確認し、P5全体とbackup/restoreは後続段階です。

**開発の大前提：Beethoven本体はCodexを使って開発します。Codexが生成するコードをあなた自身が理解・編集・保守できるよう、各Pでは必要最小限の構成と、処理を追いやすい素直なコードで実装します。** 実装・レビュー・リファクタリングは基本設計1.3章に従います。

- 将来の機能、汎用化、不要な抽象化・依存・設定を先回りして追加しません。
- 設計上の責務を、最初から別moduleや別serviceへすべて分割しません。
- 多段の委譲、不要なwrapper、細かすぎるファイル分割、過度な型技巧を避けます。抽象化を加えるときは、現在のどの問題を解決するかを説明します。
- 1回の変更を小さくし、変更箇所・処理の流れ・検証方法を説明します。あなたの手編集を保護します。
- コード内の日本語コメントで、関数の役割や重要な判断理由・変更時の注意点を説明します。別文書を読まないと意図が分からない実装にしません。
- 必須の動作・検証・課金境界・復旧・バックアップは維持し、実装方法を簡潔にします。

## 1. 現在地と最初の進め方

**0.2.0にP4〜P8の機能を追加しています。** 暗号化backup/別領域restore、永続Run/Task/Attempt・effect照合、最大4 WorkerとDAG、独立検証・直列統合・SHA受入、GitHub snapshot/publish/CI、更新・rollbackを実装しました。追加要件として、自然言語からの計画提案と、Ctrl+Oによる複数Session/Run/Workerの可視化も実装しました。[運用ガイド](docs/operations.md)が現在の操作入口です。

開発者試験はscripted Pi SDK・実Git/子process/PTYを使い、実モデル・GitHub実操作・本人受入とは分けます。`mine2424/beethoven`は本人指定でprivate作成済み。backupの実送信先・秘密鍵の別保管、今回の実モデル受入、本人の日常タスクと実IMEの受入は未確認です。以前のP3実モデル受入を今回の完了へ流用しません。

**P2の残要件を実装し、Codex・Claude subscriptionのSDK/bundled RPC実測、障害分類、routing例、接続状態管理を確認しました。当時の本人受入・実モデルの評価範囲は維持し、P4以降の追加機能とは分けて記録します。**

最初は次の順で進めてください。

1. **P0で、実験するrepoと小さな変更1件を選ぶ。** 成功がテストと差分で分かるものにします。
2. **そのrepoで許す操作と、最初に試すモデル接続・上限を決める。** すべてのモデルや将来の運用を一度に決める必要はありません。
3. **「P1の開発基盤を実装して」と依頼する。** 認証の準備が残っていても、秘密値や有料APIを使わず着手できます。
4. **接続を準備できたらP2、続いてP3を実施する。** 自然言語で調査・編集・検証できる状態を先に作ります。
5. **P4でバックアップから復元する。** 本人の追加指示で単一Worker起動基盤のみ先行実装しました。その後の追加実装はローカル試験と実接続・本人受入を分けます。

APIキーや復号鍵をチャットへ貼る必要はありません。本人がローカルの認証経路で設定し、実装側は参照先と使用可否だけを確認します。

### 全体の順序

```text
P0 最初の条件を決定
  → P1 開発・設定・永続化の基盤
  → P1R 共通/repoのルール・ハーネスの管理基盤
  → P2 Pi・モデル接続を評価
  → P3 単体の対話Coding Agent
  → P4 GitHubバックアップ・復元        ← ここで単体Coding Agent MVP（設計M0）
  → P5 単一Worker＋Orchestrator
  → P6 DAG・並列・統合
  → P7 GitHub Issue/Project・公開・CI  ← ここで並列開発MVP（設計M1）
  → P8 実運用・更新・配布の受入
  → P9 モデル効率の比較・改善
  → P10 学習によるルーティング         ← 実績が集まった後の発展段階
```

P番号はこの計画の作業順です。設計書のM0/M1/M2等とは区別します。各Pの最初に必要な範囲だけを実装し、次段階の機能を先回りして作りません。

## 2. 判断が必要な事項

「あなたが決めるもの」と「実装時に評価して決められるもの」を分けます。判断待ちは該当する操作だけを止め、独立した実装やfakeによる検証は進められます。

| 期限 | あなたが決めること | 実装側が用意する材料 |
| --- | --- | --- |
| P0 | 最初の対象repo・Task・受入基準 | 小さな変更の候補、現在の差分、既存の検証方法 |
| P0 | 編集・shell・commit・外部送信の許可範囲 | 対話はcwd編集、commitは依頼時、公開は別操作という初期案 |
| P2実接続前 | 初回設定で本人が接続・認証・課金方式・model・上限を選択 | 利用者別のsetup、対応表、接続手順、評価内容・想定する呼出し範囲。本人はCodex/Claude/Kimiのsubscription予定 |
| P2比較前 | 比較接続と追加評価の上限 | 同じTaskで比較する試験計画。全候補の契約は不要 |
| P4送信前 | backup用private repo、鍵の別保管、容量・保存頻度 | 暗号化・保存方式の評価結果、対象/除外/不足一覧 |
| P6 | 並列数とproviderごとの使用枠 | まず2並列で確認し、その後4まで増やす実行結果 |
| P7外部更新前 | 対象repoへのpush・Draft PR操作範囲 | 実際の差分、対象SHA、送信先・操作内容 |
| 無人運用前 | hostで扱う範囲と隔離環境の受入 | ファイル・credential・network・停止の実測結果 |

Pi版、SQLite driver、基本対話UI、GitHub adapterの実装方式は、[共通基盤設計8.1章](docs/components.md)の条件で実装側が比較します。結果と根拠を残し、設計に影響する変更は文書へ戻します。

## 3. P0：最初の開発条件を決める

**目的:** 実装を評価する対象と、許可・予算の境界を固定します。

あなたの作業:

- [x] 評価先はテスト専用Git repoから始める方針を本人が選択。P3の試験で実体・基準SHAをmanifestへ記録した。
- [x] 数量計算Task案を試験用に具体化し、3条件と`node --test`で開発者評価した。本人の通常操作による受入とは区別する。
- [x] テスト専用repoの調査・編集・ローカルテストまで許可。commit・push・外部送信は別途判断する。
- [x] 本人の利用予定はCodex/Claude/Kimiのsubscriptionと確認。製品は利用者ごとの初回設定で選べるようにする。実認証・model・上限はP2で確認する。

実装側の作業:

- [x] 設計の採用事項・未確定事項を`docs/decisions.md`へ記録した。
- [x] fixture用repoと、正常変更・失敗・既存dirty差分の再現条件を用意した。P3で実体を作成し評価した。
- [x] 数量計算Task案をテスト専用fixtureに具体化し、基準SHA・受入基準・`node --test`をmanifestへ記録した。本人の既存repoは使っていない。

**成果物:** 判断記録（配置案: `docs/decisions.md`）、最初のTask仕様、評価fixtureの定義。

**完了条件:** 何を変更すれば成功か、何が許可されているかが判断できる。未準備の接続はP2の前提待ちとして明示されている。

## 4. P1：開発・設定・永続化の基盤

**目的:** Beethovenをビルド・起動し、設定と状態を安全に扱えるようにします。設計の「0基盤」の初期範囲です。

実装側の作業:

- [x] `beethoven/`を単一TypeScript/Node packageとして作成し、bin、ビルド、型検査、必要なテストを用意した。
- [x] `beethoven/package-lock.json`を追跡できるよう、親`.gitignore`に限定した例外を追加した。
- [x] Pi SDK/RPCを同じ版で評価・固定できる構成を作った。PATH上の別Piへ無条件接続しない。実接続の確認はP2。
- [x] config/schema、個人/repo/CLIの出所と優先順位、実効権限、機密を含まない設定例を作った。
- [x] Node組込みSQLiteで最小schema、初期migration、snapshotの読込、WAL/外部キーをローカル検証した。実行時の所有権制御はP3/P5。
- [x] state root、maintenance lock、artifact保存、書込失敗時の中断を実装・検証した。Agent実行中の停止連携はP3/P5。
- [x] 有料通信を行わない`doctor`と、非対話エラー/JSON出力の土台を作った。
- [x] GitHub Actionsの定義を作り、ローカルの新規作業領域で同じ導入・型検査・6テストを通した。
- [ ] GitHub上でCIを実行する。未pushのため未実行。実モデル試験は通常CIと分ける。

あなたの確認:

- [ ] 自分の端末で起動・診断できることと、設定・実行データの保存場所を確認する。

**成果物:** package/lockfile、CLI骨格、設定例、migration、開発手順、CI。

**完了条件:** 新しい作業領域で依存導入からCLI起動まで再現でき、設定不正・schema不整合・秘密値の表示を防げる。使っていない機能をdoctorが利用可能と表示しない。

### P1R：ルール・ハーネス管理の追加基盤

**目的:** 本人が共通とrepoの規約・checkを編集し、何が適用されるかを確認できるようにします。別のproject階層は作りません。P3へ進む前に用意します。

- [x] 共通`rules.md`とrepo rootの`AGENTS.md`を参照し、同一の実体は一度だけ取り込む。モデルへの投入はP3。
- [x] `harness.json`のschema、必須checkの和集合、実行定義の対応・不足・競合を検査する。
- [x] repo/worktreeの識別と、scope・出所・hash・実効条件のsnapshotを実装し、明示commandで原本を保存する。
- [x] 非実行の`rules show/check`とdoctorへの診断を追加した。
- [x] repoからの制約解除拒否、2つのrepoの分離、共通ルールの適用をローカル試験した。
- [x] 本人が`rules.example.md`の初期内容を採用。共通必須checkは設けないと確認済み。repo規約は既存root `AGENTS.md`を再利用する。本人の設定先へのコピー・コマンド実行許可は行っていない。
- [ ] 本人の操作によるshow/check/snapshotの受入と、GitHub CIを確認する。

**完了条件:** RH-01〜03の宣言・診断範囲を満たす。checkの実行と変更時の信頼再確認はP3、backupはP4、Workerへの同版適用はP5〜P6で確認し、管理基盤だけで全要件完了にしない。

## 5. P2：Piとモデル接続を実測する

**目的:** 利用者別の初回設定を入口に、設計上の候補を実際に利用可能な接続へ変えます。設計の0aと[初回設定設計](docs/setup.md)に対応します。本人の予定を製品の固定接続にしません。

あなたの作業:

- [x] 初回はCodex subscription・gpt-6.1-solを選択し上限の判断を委任。専用評価設定と明示loginで認証した。その後Claudeも比較評価済み。Kimiは利用予定のまま。
- [x] 比較接続にClaude subscription・版固定Sonnet 4.5を本人が選択し、専用loginと同じfixtureのSDK/RPC評価を完了。API接続とは分離した。

実装側の作業:

- [x] 本人の3接続に対応するPi 1.4.0のsubscription OAuth定義を静的に確認した。実認証の証拠とは区別する。
- [x] 追加依頼で簡単設定を初回・`/connect`・対話setupへ統合。Piの全42provider定義を登録候補にし、対話可能な41と分類専用を区別した。実アカウント全件の認証・推論は未確認。[設計](docs/connect-design.md)を参照。
- [x] 接続宣言schema、同梱catalog、初回選択・保存・変更・削除・取消を実装。非機密宣言を個人設定へ保存し、credentialを取得しない。
- [x] `beethoven setup`を作り、非TTY取込・明示保存・競合検出・JSON診断を実装。実PTYの保存とCtrl-C取消、計22テストをローカル確認。初回対話起動への案内はP3。
- [x] SDK/RPC adapterを作り、採用版のevent・終了・エラー・tool・usage契約を確認する。
  - SDKはP3で実providerとread/edit/verify/停止・再開まで確認。今回Codex・Claudeのbundled RPC実測も完了。公式RpcClient＋fakeの契約試験も保持。[評価記録](docs/model-evaluation.md)を参照。
- [x] SDK経路のread/edit/shell、検証、abort、子プロセス回収、session保存・再開をfixtureとCodex実モデルで試した。証拠はP3受入記録を参照。
- [x] 同じ契約をbundled RPC経路で実測する。SDKの結果をRPCの成功へ流用しない。
- [x] 認証失敗、rate limit、timeout、usage欠測を分類し、別課金への無断切替を防ぐ。
- [x] `connections.example.json`と`docs/model-evaluation.md`を作成した。
- [x] `routing.example.json`と、それに対応する設定契約・検査を揃える。未知ID・重複・未評価・禁止送信先を拒否し、暗黙fallbackなしを確認。
- [x] 接続の`configured/smoke_passed/task_evaluated/enabled`とunsupportedを区別し、結果・Pi版・料金根拠・内容hashを保存。隔離stateで明示enableと選択を確認。

**初期の選び方:** 初回設定で本人が選んだ接続を1つ通し、その後に比較接続を追加する。本人はCodex/Claude/Kimiのsubscriptionを利用予定ですが、他の利用者へ同じ契約やモデルを要求しません。登録・認証・疎通・Task評価を別々に記録します。

**完了条件:** 基準・比較接続について実際の対応/非対応が説明できる。APIとsubscriptionの課金境界、停止・再開、使用量の精度が確認されている。fake試験だけでは完了にしない。

**今回の結果:** [P2評価記録](docs/model-evaluation.md)と[証拠](docs/evidence/p2-2026-10-25.json)。Claude累計53,757/60,000、Codex RPCは欠測留保込み19,843/40,000 token。小さいfixtureの開発者評価であり、本人受入・CI・請求照合・モデル優劣は未確認。

## 6. P3：単体の対話Coding Agentを完成させる

**目的:** `beethoven`を普段の開発の入口にします。設計の0bと共通基盤の対話部分です。

実装側の作業:

- [x] 引数なし起動、初回prompt付き対話、`--print`、JSON出力を同じSDK Sessionへ接続した。
- [x] 本人の追加依頼で基本TUIとローカルランチャーを実装。通常のlogin shellで`beethoven`起動を確認し、未設定時の案内、固定入力欄、会話スクロール、状態・使用量・承認を表示。`--plain`と非TTY/JSONを維持する。
- [x] 日本語・複数行入力、stream・ツール対象表示、質問・承認、Ctrl-C、非TTYを実装した。
- [x] 出所付きsnapshotを一度だけ適用し、Piの自動探索を無効化。Promptに版を付けた。
- [x] read/search/edit/shellをPolicyへ接続し、観測hash、dirty差分、scope、deadlineをローカル試験した。
- [x] read-only/計画のみの編集・任意shell拒否、送信先・認証/課金方式の固定を実装した。
- [x] SQLiteとPi会話fileの対応、追加指示、圧縮、resume・外部変更の再読込を実装・ローカル試験した。
- [x] 会話の表示復元、永続prompt履歴、↑/↓・Ctrl+R・/historyによる入力呼出し、/sessionsの会話選択、readonly CLI閲覧を追加。再起動の実PTYで自動送信なしと同じ会話の継続を確認。[操作と保存範囲](docs/tui.md#会話とプロンプト履歴)・[証拠](docs/evidence/conversation-history-2026-10-25.json)。
- [x] HEAD/内容hashと差分、検証log/status、利用者受入未確認を分けて報告する。
- [x] Session/Turnの有限予算、欠測・留保枠、接続・権限・課金方式を表示する。
- [x] P1Rの適用・信頼・preflight/verify・変更検出・resume照合を実装した。
- [x] [P3受入記録](docs/p3-acceptance.md)の開発者による実モデルシナリオを完了し、修正前の失敗・中断・欠測も保持した。本人の通常操作による受入、GitHub CI、P4のM0全体受入は別途確認する。

あなたの受入手順:

1. P0のrepoで起動し、自然言語で調査・修正・検証を依頼する。
2. 結果に対して追加修正を依頼し、同じ会話で継続する。
3. 実行を中断し、子プロセスが残らず入力へ戻ることを確認する。
4. 終了して再起動し、会話と未完了作業を継続する。
5. 既存変更が保護され、差分・検証結果・未確認事項を判断できるか確認する。

**成果物:** 単体Agent、操作ガイド、実Taskの検証記録。

**完了条件:** CA-01〜07・09とCA-10の対話範囲を実モデルで満たす。計画JSONやPiの直接操作がなくても開発を進められる。バックアップが残っているため、この時点ではM0全体の完成にはしない。

## 7. P4：GitHubバックアップと復元

**目的:** 端末故障後も会話・実行履歴・未完了コードを復元します。設計の0cです。

あなたの作業:

- [x] 専用private repoは`mine2424/beethoven-backup`を本人承認で作成。暗号化方式・容量は既存実装を使用。
- [ ] 鍵の端末外保管を確認する。簡単な管理方式を本人と選択中。snapshotは手動保持し、自動削除しない。
- [ ] ローカルsnapshotの対象一覧を確認し、準備した保存先への送信を指示する。

実装側の作業:

- [x] 全Session/Run停止・owner/未精算予約・process groupとmaintenance lockを確認するbackupを実装。
- [x] SQLite Backup API、設定・会話・log・artifact・Run/usage、repo bundleと未commit/untracked/binary・削除状態を収集。
- [x] 既知認証pathの除外、RSA-OAEP-SHA256/AES-256-GCM、manifest/hash、容量・変更・不足検出を実装。symlink等は除外一覧へ残す。
- [x] ローカルreceipt・private repoのremote blob再読取/照合receiptと一覧を実装。P8試験archiveで実private repoへの送信・再送照合・download・restoreを確認。普段使い全体のsnapshotは別確認。
- [x] 元state/repoを参照できない別領域で、hash・DB・commit・binary/未commit/削除状態の復元を開発者試験。
- [x] 旧PID・owner・承認を無効化し、pathを再配置。モデル自動起動なし・再認証と通常resume検査を維持。
- [x] 共通/repoの原本・snapshotとrepo pathを復元し、harness trustを除外。再開時に現在の権限・規約とcheck許可を再確認。

あなたの受入手順:

1. 停止中の状態をバックアップする。
2. 元データを削除せず、別の空ディレクトリを復元先に指定する。
3. 元のstate/repoへアクセスできない条件で復元する。
4. 会話・未完了コード・検証記録を照合し、必要な再認証後に継続する。

**完了条件:** CA-08の別領域復元試験に合格し、CA-01〜10のM0範囲を満たす。ここで初めて「単体Coding Agent MVP（M0）」を受入可能とする。private repoへのpush成功だけでは完了にしない。

## 8. P5：単一WorkerとOrchestrator

**目的:** 対話Agentと共通の権限・予算・証拠管理を使い、1 Taskを独立Workerへ渡します。設計の1準備・1制御の基本部分です。

先行追加（2026-10-25、本人の「実Worker起動基盤まで広げる」指示）:

- [x] /workerによる実子process・専用worktreeの単一起動、共通SDK/tools/harness、質問・停止・usage精算。
- [x] 開始時のrules内容・scope・権限の継承、dirtyな元workspaceの保持、モデル・実段階・PIDのTUI表示。
- [x] 未精算Workerの再起動拒否、process不在時だけの明示復旧と欠測予約の保持をローカル確認。
- [x] 質問待ちの永続保存・process終了・同じ子会話/worktreeでの再開・差分usage精算、状態/log診断をローカルと実PTYで確認。
- [x] UI非依存の実行所有権、context windowの送信前検査、同一失敗loop停止を追加。

追加監査で判明した初期化中断・孫process回収・古いSessionの予約見落としを修正し、会話TUIの送信後継続とerror boundaryも実PTYで確認した。この追加はP5全体の完了ではない。[Worker操作と範囲](docs/workers.md)を参照。以下に先行実装とP4〜P8追加の対応状況を記録する。本人受入・実provider・実GitHubの条件は残す。

実装側の作業:

- [x] 厳密なplan/DAG検証、Run/Task・試行/全起動カウンター、Task packet・Worker結果・統合記録を実装。
- [x] Proposalを許可と分離し、version付きCommandの重複排除、決定的な状態更新、Policy・epoch・effectをSQLiteで保存。
- [x] worktree、宣言済みpreflight、子process起動・監視・停止・質問保存と枠返却を実装。runtimeは採用済みPi SDKを子へ埋め込み、Pi RPCとは区別する。
- [x] 独立Verifier、候補commit、直列統合・再検証、現在SHAと検証に結ぶoperator受入を実装。元cwdは自動変更しない。
- [x] run status/logs/stop/answer/continue/retry/startとmonitorを実装。blocked理由・質問ID・予算・次の操作を記録。
- [x] 実ControllerのSIGKILL、子のIPC喪失、実Gitの候補commit/統合と未保存receiptを再現し、二重実行せず照合する開発者試験。
- [x] 明示retry（最大2）と質問/中断の継続を別計数し、Run Taskは最大10起動。累計token・金額・稼働時間を保持し、欠測を留保。
- [x] 共通SDK/tools/harness、同じrule内容・実効権限・scopeを渡し、必須gate・規約変更停止・検証を確認。

あなたの確認:

- [ ] 同じ小さなTaskをバッチで実行し、差分・検証・質問回答・再開・受入を確認する。

**成果物:** 単一Taskの実行trace、復旧試験、バッチ操作ガイド。

**完了条件:** LLMの自己申告やProposalで権限・受入を変えず、1 Taskを起動から受入まで追跡できる。OR-01〜03・06〜07の単一Task範囲を満たす。

## 9. P6：DAG・並列Worker・統合

**目的:** 独立Taskを並列化し、依存コードを検証済みSHAで引き渡します。設計の1aです。

実装側の作業:

- [x] 安定したready順、code/acceptance依存と下流blockedを実装。
- [x] state全体のquotaGroup/予算/path/resourceを原子的に予約・解放し、Git common directoryでrepo所有権を排他。
- [x] 実SDK/scripted providerの実子processで2並列→4並列を確認。接続で宣言したquota上限を守り、検証/統合は直列。実providerの並列受入は未実施。
- [x] 専用worktreeへの直列統合、競合/回帰停止、追加統合後の受入失効と現在SHAの再検証を実装。
- [x] 明示したTaskだけにExplorer/Reviewerを適用し、read-onlyで変更を拒否。モデルのレビューを人間の受入へ読み替えない。
- [x] propose_planと確認付きDAG委譲、親の残予算/権限継承、親編集停止、停止点のplan改版と旧履歴保持を実装。
- [x] Command重複・旧epoch・停止後dispatch拒否・共有quotaとpath予約、複数repo Session所有権の開発者試験。

あなたの受入手順:

1. A→Bの依存と、独立Cを含む小さな計画を確認する。
2. AとCが並列実行され、Aの統合後にBが起動することを確認する。
3. Aの失敗・質問待ち・停止時にBが先へ進まず、Cの成果が保持されることを確認する。
4. 使用量とresourceを見て、並列数を増やしてよいか判断する。

**完了条件:** OR-01〜08を満たす。二重起動・停止競合・予算超過の見落とし・親子の同時編集を防ぎ、競合を成果物を失わずblockedにできる。

## 10. P7：GitHub入力・公開・CI

**目的:** Issue/Projectを取り込み、明示した範囲でDraft PRとCIまで進めます。設計の1bです。

実装側の作業:

- [x] owner/repo/Project node ID、pagination/cursor、部分失敗・取得時刻/更新情報・hash付きsnapshotを実装。
- [x] propose_plan・/orchestrateの提案をschema/Policyへ通し、確認前に実行しない。
- [x] 開発repo専用capability、SHA受入済みRunのpush・Draft PR・receiptを実装。backup許可と分離。
- [x] 必須check名とhead SHAを照合し、skipped/欠落/別SHA/必須名未指定を合格にしない。
- [x] remote ref/PRを先に照合し、通信断後の再送と重複PR防止をtransport注入試験。実GitHubの受入は別記録。
- [x] GitHub入力/公開/CI/backup送信の失敗でローカル成果と履歴を消さず、同期状態を分離。

あなたの作業:

- [ ] テスト用repo/Issue/Projectと、公開操作の範囲を指定する。
- [ ] 公開前の差分・対象SHAを確認し、publishを指示する。
- [ ] Draft PR・CI・受入結果を確認する。merge・Issue close・deployは別の判断とする。

**完了条件:** 入力からDraft PR/CIまでを再現し、外部副作用の復旧も確認できる。P5/P6の条件を合わせて「並列開発MVP（M1）」を受入可能とする。

## 11. P8：普段使い・導入・更新の受入

**目的:** 開発端末だけで動く状態から、再導入・更新・復旧できる状態へ進めます。公開配布を自動的に含めません。

- [ ] 実際のrepoで日常タスクを行い、質問・承認の頻度、日本語入力、待ち理由、差分表示を見直す。
- [ ] 別作業領域で導入→認証→実Task→backup→restoreを再現する。
- [x] Pi固定版、schema 1/2→3、既存Session・設定保持、stage/hash失敗で現行維持、activate/rollbackの開発者試験。
- [x] 0.2.0のpackage/操作・認証・backup/restore・更新ガイド、doctor、既知の制約を整備。
- [ ] 無人運用が必要なら、隔離環境の評価を別Taskとして完了する。未検証のhost実行をsandbox済みと扱わない。
- [ ] あなたが利用範囲を受け入れ、残課題を修正対象または後続Taskとして整理する。

**完了条件:** 再導入・更新・復元を本人が手順どおり実行でき、利用できる範囲と未対応が分かる。公開packageの配布先・名称・公開操作は必要になった時点で別途決める。

## 12. P9：モデル効率の比較・改善

**目的:** 受入品質を保ち、実測に基づいて費用・時間を改善します。基本設計16章の「2: 分析」に対応します。

- [ ] Task種別ごとのmetricsと、費用・token・wall time・待ち時間・失敗・欠測を出力する。
- [ ] 同じbase/Task/tools/検証/上限でbenchmarkを行い、繰返し数・cache・順序を記録する。
- [ ] 基準モデルと費用重視モデルを比較し、合格したTask種別だけルール割当を有効にする。
- [ ] 設定済み昇格先への引き継ぎを実測し、失敗分を含む総費用と受入率を比較する。
- [ ] Qwen/Kimi等の追加候補は必要に応じて評価し、未評価接続を自動Routerへ混ぜない。

**あなたの判断:** 比較対象、評価予算、許容する品質条件を評価前に決め、結果を見て採用する。

**完了条件:** 同じ比較を再実行でき、少数例や欠測を理由に「最安・最速・高品質」を断定しない。基本の使用量計測・有限retryはP3/P5から実装し、この段階まで先送りしない。

## 13. P10：学習によるモデル選択

**着手条件:** P9の比較を再現でき、Task特徴量・候補集合・選択理由・受入結果を継続収集できていること。必要標本数と改善判定の基準は、探索前に評価計画へ定めます。

- [ ] 固定ルールをbaselineにして、オフラインのpolicy評価を行う。
- [ ] 品質・送信先・予算を候補制約とし、探索確率と上限を定める。
- [ ] 限定したTaskでのみ探索し、劣化時に固定ルールへ戻せるようにする。
- [ ] 受入率、再修正、総費用、完了時間で改善を確認する。

**完了条件:** 固定ルールに対する改善と品質維持を示せる。Bandit、動的並列数、競争・投票、MDPはそれぞれ別の実験とし、MVP完成の条件にしない。

## 14. 進捗の付け方と作業の依頼例

各Pは、該当するチェックが完了し、証拠とあなたの確認結果が残ってから完了にします。コード作成、ローカル試験、CI、実モデル確認、利用者受入を分けて記録してください。所要日数は未見積りで、接続評価後に作業量を見直します。

| 対象 | 現在の状態 | 次の行動 |
| --- | --- | --- |
| 設計文書 | 作成済み。実装・実機の証拠ではない | 判断が変わったら該当設計へ反映 |
| P0 | 評価先・操作範囲・本人のsubscription利用予定を確認済み | setupでmodel/上限を設定し、試験前にTaskと基準SHAを固定 |
| P1 | 基盤はローカル検証済み。本人受入・GitHub CIは未確認 | 開発手順で本人の操作を確認。CIは公開指示後に確認 |
| P1R | 管理基盤を実装し計14テスト成功。初期内容の判断済み | 本人の操作で受入。適用・実行・許可はP3、backupはP4へ |
| P2 | 基準・比較接続のSDK/bundled RPC評価、障害分類、routing・状態管理を完了 | 本人受入、CI、従量APIの請求照合は未確認。証拠を保持する |
| P3 | 単体Agentの実装・Codex実モデルによる開発者受入済み。P2残要件も通過 | 本人の通常操作による受入とGitHub CIは未確認 |
| P4 | private backup repo作成・暗号文送信/再取得/hash照合・別領域restoreをP8 archiveで確認 | 普段使いの全状態backup、鍵の端末外保管、本人復元受入 |
| P5〜P7 | 実SDK子Worker、DAG・資源管理・照合復旧・独立検証・候補統合を実装。private GitHubでDraft PR作成・重複防止を確認 | CIは本人指示で受入対象外。本人の並列開発受入は未確認 |
| P8 | 0.2.0のstage・更新/rollback、複数Session monitor、資産検索を実装。実モデルで修正→検証→backup→別領域restore→会話再開を確認 | CIは対象外。鍵の別保管・本人の日常利用受入 |
| P9〜P10 | 未着手 | 計測を蓄積し、比較後に最適化 |

各段階の結果には、実装PR/commit、実行環境、モデル接続・認証方式、試験結果・Evidence、未確認、あなたの受入日を追記します。証拠に秘密値を含めません。既存の無関係な差分を混ぜず、commit・pushは依頼された範囲で行います。

最初の実装依頼は、次の形で進められます。

```text
beethoven/milestone.md のP1を実装してください。
基本設計・Orchestrator・共通基盤設計に従い、P1の範囲を完了させてください。
Beethoven本体はCodexで開発しますが、私自身が生成コードを理解して修正できるようにしてください。
処理を追いやすい素直なコードと最小限の構成を優先してください。
将来機能の先行実装や不要な抽象化・依存追加は避けてください。
P2の有料モデル呼出し、認証設定変更、GitHubへの送信はまだ行いません。
検証結果、未確定事項、P2に進むために私が準備するものを報告してください。
```

以降は「P2を進めて」「P3の受入手順を一緒に確認して」のように段階を指定できます。前提が未充足なら、必要な判断と独立して進められる作業を分けて報告します。

### 設計要件との対応

| 要件・検証ID | 対応するP |
| --- | --- |
| CA-01〜07・09: 対話、操作、権限、再開、検証、非対話 | P1〜P3、P8 |
| CA-08: Beethoven全体のbackup/restore | P4、P8 |
| OR-01〜03・06〜07: 決定的制御、停止・復旧、権限 | P1/P3で共通部分、P5/P7で副作用を含め確認 |
| OR-04〜05・08: 資源、DAG、親子の編集 | P6 |
| BASE-01〜05: 設定、context、tool、store、UI | P1〜P3、P5〜P6 |
| BASE-06: 外部serviceとbackup | P4、P7 |
| BASE-07: 導入・更新・診断 | P1、P4、P8 |
| CA-10 / RH-01〜08: 共通とproject/repoのルール・ハーネス | P1R、P3〜P6、P8。必須条件・信頼・改版・復元を確認 |
| 接続選定・効率改善・学習 | P2、P9〜P10 |

## 2026-10-25 追加受入記録

private開発repoはhttps://github.com/mine2424/beethoven 。P7の実GitHub adapter試験はDraft PR #1で作成・再実行時の重複防止・head照合まで確認した（scripted provider、merge対象ではない）。GitHub Actionsはアカウントの課金制限で開始前に停止し、CI成功とは扱わない。

承認済みのCodex subscription/gpt-6.1-solによるP8 fixture修正は既存3テストに合格。暗号化backup後に元pathを使えない状態で復元し、同じ保存会話を再開した。合計5要求・6,683 token、使用量欠測0。macOS path aliasの復元不具合を修正し、alias・候補commitの再利用・復元Runの確認を回帰試験に追加した。今回の実モデル試験は資産検索や並列Workerの実provider受入まで証明するものではない。

追加要件の再利用資産は明示登録repo限定のasset_search/readとして実装。初期対象「nothing」に従い、実repoは未登録でfixtureのみ検証する。private backup repo、本人の実repo/IME/日常利用、鍵の端末外保管は未確認のまま保持する。

[今回の証拠](docs/evidence/p4-p8-2026-10-25.json): ローカル122試験、実PTY16条件＋対話6経路、実packageの固定lockfile導入・一時binへのactivate・16条件・byte一致rollbackを確認。ユーザーのglobal launcherはこの更新試験で変更していない。

## 2026-10-25 remote backupと本人受入の追加指示

本人は`mine2424/beethoven-backup`のprivate作成・利用を承認し、GitHub CIの問題を今回の受入から除外した。CIの失敗記録と厳密なCI判定実装は残し、成功へ書換えない。実repoにP8実モデル試験の暗号化archiveを送信し、二重送信が同じblobを参照すること、再取得のGit blob/SHA-256照合、元pathなしの復元・コード・会話使用量・承認無効化を確認した。[証拠](docs/evidence/remote-backup-2026-10-25.json)。普段使い全体のbackup完了ではない。

本人はApple「パスワード」による簡単な鍵管理を希望し、管理方法を検討中。CLIからのiCloudキーチェーン直接保存はOSStatus -34018で拒否されたため採用せず、平文file保管へ自動fallbackしていない。鍵の端末外保管は未確認のままとする。本人の日常利用対象はBeethoven自身を選択し、専用cloneと[日本語・履歴・状態表示の手順](docs/personal-acceptance.md)を準備した。本人の実施結果はまだ受領していない。

## 0.2.1の鍵管理と実state backup

本人の選択でローカルキーチェーン＋Apple『パスワード』用復旧コードを実装した。コードは本人のterminalでコピーし、本人が保存する。秘密鍵・コードの平文fileを作らず、GitHubにはsnapshotと暗号化復旧鍵だけを送信する。普段使いのstateから約8.9MBの暗号化snapshotを作成し、実repoへの送信・再取得と2経路のrestoreを確認した。元データは削除・変更していない。コードの別端末からの取り出しと日常利用は、本人が「これから操作する」と回答した段階で未受入とする。

[0.2.1の証拠](docs/evidence/managed-backup-2026-10-25.json): 128ローカル試験、Macローカルキーチェーン実保存・読戻し、約8.9MBの実state暗号文の送信/取得、通常鍵・復旧コードの2経路restoreを確認。本人の端末外取り出しと日常利用は操作中のまま記録する。
