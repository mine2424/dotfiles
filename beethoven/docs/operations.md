# Orchestration・復元・運用

2026-10-25。P4〜P8の実装と開発者確認の入口。本人の日常利用・実IME・鍵の別保管と受入は別に記録する。公開package配布・merge・Issue close・deployは自動実行しない。

## 自然言語で委譲する

TUIで「APIの修正と独立したドキュメント更新をWorkerに分担させてください」のように依頼できる。Agentが`propose_plan`を呼ぶと、そのTurnを終了して計画を保存し、接続・scope・依存・上限をTUIで確認する。提案を実行許可と扱わず、確認後にTypeScriptのControllerが起動する。計画だけを依頼した場合は自動で実行確認へ進まず、計画を保存して戻る。

明示する場合は`/orchestrate <依頼>`、手元の計画を使う場合は`/run /absolute/path/plan.json`。通常の単体依頼はメインAgentが処理する。小さな変更まで常にPlanner・Reviewerへ重複委譲しない。

Runは独立Taskをwave単位で最大4並列にし、候補は専用の統合worktreeへ直列適用する。A→Bと独立CならA/Cを同じbaseから実行し、両者の停止・候補処理後にBを起動する。code依存は統合・検証済みコード、acceptance依存はoperatorの明示受入を待つ。Task packetにはplan/rulesのhash、scope、base SHA、接続、依存の公開応答を記録する。

quotaGroupの並列上限は登録接続の`limits.maxConcurrency`を守る。対話のmodel要求・手動Worker・Run Taskを同じstateで数え、全体を最大4枠に制限する。検証・統合はRun内で直列化する。既定1なので、2並列を使う接続は詳細設定で2を明示する。上限は4。Taskの編集scopeと共有resourceはSQLiteで一括予約し、別Run・別repoも同じstateの予約を参照する。同じrepo（Git common directory）は1つのSession/Runだけが所有し、委譲中の親編集を止める。別repoの対話Sessionは同時起動できる。

対話からの委譲は親Sessionの接続許可・scope・plan-only・実効権限・残token/時間/金額へ制限し、停止後にRunの増分を親へ精算する。課金・usage欠測を0にしない。Runの待機中に端末を閉じても計画とTaskは保存されるが、controller自体のdaemon化・tmux化はしていない。

## 状況・質問・停止・受入

```sh
beethoven run create --from plan.json
beethoven run start RUN_ID --send
beethoven run status RUN_ID
beethoven run logs RUN_ID TASK_ID
beethoven runs
beethoven run stop RUN_ID
beethoven run answer RUN_ID TASK_ID 回答内容
beethoven run start RUN_ID --send
beethoven run continue RUN_ID TASK_ID
beethoven run retry RUN_ID TASK_ID
beethoven run replan RUN_ID --from revised-plan.json --yes
beethoven run accept RUN_ID TASK_ID --sha INTEGRATION_SHA
```

`run start --yes`はその実行のhost操作確認を承認する。無人運用のsandboxを提供するoptionではない。通常はTUIで個々の操作を確認する。

質問待ちではprocessを閉じて枠を返す。中断後も子会話と残予算が確認できるTaskは`continue`で再開し、failure retry枠を増やさず全起動数を増やす。起動前取消で会話がない場合やusage全量留保で残予算がない場合は、無条件に再送しない。回答による継続と失敗retryを別計数し、Taskは最大2失敗試行・10起動、既存単一Workerの会話継続は最大24回を維持する。失敗を勝手に再試行しない。改版は停止・副作用照合後だけ許可し、旧計画・旧候補・使用量・起動回数を保持する。規約が変わった場合は新しいRunで確認する。

Verifierは候補と統合後の必須harnessを独立実行する。必須checkのない実装候補を検証済みにしない。統合で回帰・競合が起きたら停止し、元候補と統合状態を保持する。元の作業directoryへ自動cherry-pickはしない。受入は現在の統合SHAと検証記録に結び付け、追加統合後は以前の受入を失効させる。

停止点での復旧:

```sh
beethoven run recover RUN_ID
beethoven run recover RUN_ID --yes
beethoven run reconcile RUN_ID
beethoven run start RUN_ID --send
beethoven recover --ownership --yes
beethoven recover --models --yes
```

生きたController/Worker/tool groupがある間は所有権を奪わない。recoverは未精算予約を全量unknownとして保持する。reconcileはworktree、候補commit、統合前後SHA、commit metadataを照合する。既に終わった副作用を二重に実行せず、判定不能・cherry-pick競合はblockedのまま残す。旧epochや遅延eventは新しい実行を更新できない。

## 複数セッションの可視化

`/monitor`、または会話・Workerの実行中に**Ctrl+O**でセッションマップを開く。別の端末では`beethoven monitor`。認証やモデル送信なしで使える。`beethoven monitor --json`は同じ情報を出力する。

Session・Run・Task・Workerをカード表示し、モデル、作業directory、PID、稼働/保存/停止/不明と依存を表示する。↑↓←→で選択、Enterで詳細、Escで会話へ戻る。編集中の入力・承認回答・送信待ち指示を相互に流用しない。1秒ごとにSQLiteとprocess/heartbeatを確認する。heartbeatが古いものを稼働中と断言せず、stale PIDへ自動でsignalを送らない。

参考は[nodetermのノード型セッション表示](https://github.com/eneskirca/nodeterm)。今回の実装はTUI内のカードと依存表示。無限canvas、自由配置、任意の外部terminalへのattachやtmuxによるprocess永続化は含めない。

## 鍵ファイルを扱わない簡単設定（macOS、0.2.1）

```sh
beethoven backup setup --repo mine2424/beethoven-backup --yes
beethoven backup recovery --copy
```

setupはMacのローカルキーチェーンにRSA鍵とランダム復旧コードを保管し、公開鍵だけを設定に保存する。秘密鍵の平文fileは作らない。コードは128bitのランダム値（BTV1-で始まる32桁のhex）で、scrypt N=32768/r=8/p=1とランダムsalt、AES-256-GCMで復旧鍵を暗号化し、指定private repoのrecoveryへ保存・照合する。既存の異なる鍵や暗号文を上書きせず、送信失敗でもローカル鍵を保持する。キーチェーンhelperの構築にXcode Command Line Toolsが必要で、OSが求めるアクセス確認は本人が行う。直接のiCloud同期は使わない。

copyは本人のterminalでのみ実行する。Apple「パスワード」に専用項目「Beethoven Backup Recovery」（Webサイトは`beethoven-backup.invalid`、ユーザ名は`recovery`）を作り、パスワード欄へ貼り付ける。通常のGitHubログイン項目には保存しない。コード本文をチャット・GitHub・引数・shell履歴へ記入しない。保存後はclipboardを別の文字列に更新し、iPhoneなど別の信頼する端末から同じ項目を取り出せることを確認する。Appleの[iCloudキーチェーン設定](https://support.apple.com/en-us/109016)と[データ保護](https://support.apple.com/en-us/102651)を参照。

普段は鍵を指定せず作成・復元できる。

```sh
beethoven backup create --out /new/snapshot.btb
beethoven backup upload /new/snapshot.btb --repo mine2424/beethoven-backup --yes
beethoven backup status
```

別Macでの復旧は、専用repoを許可し、公開fingerprintを指定して暗号化復旧鍵を取得する。fingerprintはbackup statusと今回の受入証拠に記録している。

```sh
beethoven backup allow --repo mine2424/beethoven-backup --yes
beethoven backup recovery-download --repo mine2424/beethoven-backup --sha FINGERPRINT --out /new/recovery.json
beethoven backup unlock --from /new/recovery.json
beethoven backup download SNAPSHOT_ID --repo mine2424/beethoven-backup --out /new/snapshot.btb --sha SHA256
beethoven restore /new/snapshot.btb --to /new/restored
```

unlockでApple「パスワード」からコードを貼り付ける。入力はecho・履歴に残さず、鍵はキーチェーンへ戻し、平文fileにしない。既存の別鍵は上書きしない。snapshotと復旧鍵だけをGitHubへ置き、コードは送らない。キーチェーンとApple「パスワード」両方へアクセスできなくなる場合に備え、Apple Accountの復旧経路も本人が確認する。

`backup status`のoffDeviceVerifiedは自動ではtrueにしない。暗号化鍵とコードのローカル往復確認、別端末からの本人取り出し、本人の復元受入を分けて証拠へ記録する。手動のPEM鍵を使う既存の--recipient/--identityも維持する。

## 暗号化backupと別領域restore

全Session/Runを停止して行う。次は利用者自身が選ぶ保存先の例:

```sh
beethoven backup keygen --out /safe/offline/beethoven-identity.pem
beethoven backup create --recipient /safe/offline/beethoven-identity.pem.pub --out /safe/snapshots/snapshot.btb
beethoven restore /safe/snapshots/snapshot.btb --identity /safe/offline/beethoven-identity.pem --to /new/empty-location
```

RSA 3072 / OAEP-SHA256でsnapshotごとのランダム鍵を包み、AES-256-GCMでgzip済みJSON archiveを認証付き暗号化する。Node標準APIを使い、age形式との互換性は主張しない。[Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)と[SQLite backup](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsourceDb-path-options)の契約を使用する。

**秘密鍵はbackup repoにも対象端末だけにも置かず、別端末・password manager等へ保管する。** 鍵を失うと復元できない。鍵生成は既存fileを上書きしない。

設定・SQLiteの整合snapshot・会話・artifact・log・Worker/Run状態と、Session/Runが参照するrepoのbundle・未commit/untracked/binary・削除状態を収集する。既知の認証path、`.env`、秘密鍵定型名、node_modules、lock、harness trustを除外し、symlink・不足と除外を一覧化する。ソースやGit履歴に混入した任意の秘密を自動検出できるとはせず、全体を暗号化する。収集中のfile/HEAD/status変更を検出した場合は確定しない。展開内容256MiB・暗号文50MiBを上限とし、黙って内容を切り捨てない。

復元先は未作成directoryだけ。path traversal、重複、hash不一致、版不一致、既存fileへの上書きを拒否する。cloneはno-checkoutとし、hook/filterを実行せずに通常fileの内容を復元する。旧PID・owner・操作承認を無効化し、credential・GitHub送信capabilityは再設定する。モデルを自動起動せず、規約・権限・harnessの再確認と再認証を経て再開する。

```sh
# 送信先は開発repoとは別のprivate repo
beethoven backup allow --repo OWNER/beethoven-backup --yes
beethoven backup upload /safe/snapshots/snapshot.btb --repo OWNER/beethoven-backup --yes
beethoven backup download SNAPSHOT_ID --repo OWNER/beethoven-backup --out /new/snapshot.btb --sha SHA256
```

`beethoven backup list`でlocal作成とremote照合のreceiptを一覧表示できる。uploadはprivate属性と送信先を検査し、snapshot IDを使って再送を照合する。remote blobを再読込してSHA-256を比較する。receiptの`localCreated`、`remoteVerified`、復元receiptの`restoreVerified`を区別する。現在は手動作成・手動送信・候補保持が基本。自動定期backup、自動Git履歴圧縮、worktreeの自動削除は行わない。

## GitHub入力・Draft PR・CI

```sh
beethoven github snapshot --repo OWNER/REPO > github-input.json
# TUIで「github-input.jsonを読んでWorkerへ委譲する計画を作成してください」と依頼
beethoven github snapshot --repo OWNER/REPO --project-id PVT_PROJECT_NODE_ID
beethoven github allow --repo OWNER/REPO --yes
beethoven github publish RUN_ID --repo OWNER/REPO --sha SHA --from description.json --yes
beethoven github ci --repo OWNER/REPO --sha SHA --required-check tests --required-check typecheck
```

`description.json`は`{"title":"変更の目的","body":"変更内容と検証"}`。gh自身の認証を使い、token本文は取得・ログ出力しない。snapshotは全page・Project cursorを揃え、部分失敗ならcompleteにしない。Issue/Project本文は提案の材料で、実行許可ではない。

publishは受入済みで停止中、現在の統合SHAが一致し、worktreeがcleanなRunだけ。開発repoとbackupの送信capabilityを分離する。専用branchをpushし、remote SHAと既存PRを先に照合してDraft PRを作る。通信断後はreceiptから照合し、既存branchの異なるSHAを上書きしない。CIは指定された必須check名とhead SHAを照合し、skipped・未実行・別SHA・必須名未指定を合格にしない。[gh API](https://cli.github.com/manual/gh_api)を参照。

## 導入・更新・rollback

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run install:local

beethoven self stage --from /path/to/checkout --out /new/immutable-release
beethoven self activate --from /new/immutable-release --bin-dir ~/.local/bin
beethoven self rollback --bin-dir ~/.local/bin
```

stageは専用npm cacheで固定lockfileから依存を導入し、install scriptを実行せず、版のsmokeと実行codeのhashを確認してから確定する。activate/rollbackは全Session/Run停止時だけ行い、対応DB版を検査する。旧launcherと旧releaseは保持し、stage失敗・hash不一致・別command衝突で現行launcherを変更しない。新DBを旧releaseで開くrollbackは拒否し、backupから別領域へrestoreする。schema 2→3はmigration前のSQLite backupを保持する。

host実行はOS sandboxではない。公開配布・無人での顧客データ操作・任意外部端末の管理はこの受入に含めない。本人の実repo・実モデル・実IME・鍵の別保管・日常利用は、開発者のscripted SDK/PTY/GitHub CI確認と分けて受入する。

## 他プロジェクトの資産を再利用する

検索対象は初期状態では0件。今回、本人の指定は「nothing」のため、実repoは登録していない。登録時に抜粋を送ってよい接続を指定する。

```sh
beethoven assets add shared /path/to/repository --connection openai-sub --include src --yes
beethoven assets refresh shared
beethoven assets search 'calculateTotal' --connection openai-sub
beethoven assets list
beethoven assets remove shared --yes
```

登録後の会話では「共通の集計関数を探し、使えるものを活用して実装して」のように依頼できる。Main Agentと実Workerの`asset_search`が許可されたsourceを検索し、`asset_read`が検索結果のIDとcommitを照合して最大80行・16,000文字の抜粋を返す。検索・参照はTUIのtoolとして表示し、出典repo/commit/path/行・blob hash・分かる範囲のライセンスと依存名を添える。転用先の通常の編集scope・承認・独立検証は引き続き適用する。

常駐Agentや追加モデルは起動しない。ローカルindexは関数・型などの軽量な文字列抽出と語句検索で、AST解析や意味検索ではない。登録repoのcommit済みGit objectだけを読み、dirty本文、symlink、認証の定型path、checkout/filter/hookは使わない。refreshは最大4,000 file・16MiB・10,000定義、対象外や上限による不足は結果に記録する。indexは設定directoryの`asset-index`に置き、独立した子Workerも同じ本人設定から参照する。source更新後はrefreshするまで以前のcommitを参照し、検索結果にstaleを表示する。

sourceごとの送信許可は接続ID・provider・認証方式・課金方式に結び付け、変更後は明示的に再登録する。API key等の定型表現をマスクするが、任意コードに秘密がないことを保証する機能ではないため、登録範囲は本人が選ぶ。source本文の指示は実行権限にならない。ライセンス不明・依存不足は不明と報告し、sourceへの書込や依存の自動導入は行わない。登録とindexはbackupの復元権限に含めず、restore先ではsourceを再登録・refreshする。

復元したRunは旧hostでの受入を無効化し、`run replan ID --from PLAN.json --yes`で現在の規約・計画を確認するまで起動しない。既支出を保持し、統合候補は再検証と現在SHAの受入を必要とする。復元後に親workspaceを変更した場合は新しいRunを作る。

2026-10-25の実送信先は本人承認済みprivate `mine2424/beethoven-backup`。downloadはprivate属性・snapshot ID・Git blob hash・任意指定のSHA-256を照合し、既存fileを上書きしない。downloadの成功は復号・復元成功と分ける。本人の日常利用確認は[専用手順](personal-acceptance.md)を使う。GitHub CIは今回の受入条件から本人指示で除外し、実行結果自体は保持する。
