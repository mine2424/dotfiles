# Orchestrator 詳細設計

2026-10-25追記: `/worker`による単一SDK子process・専用worktree・残予算予約とTUI表示の基盤を先行実装した。[現在の実装範囲](workers.md)を参照。以下の完全なOrchestrator・DAG・統合設計は未実装部分を含む。

更新日: 2026-10-25 / 状態: 実装前の設計案

[基本設計](design.md)の5〜9・13章を具体化する。採用モデルや認証の候補は基本設計10章、共通の設定・ツール・永続化は[共通基盤設計](components.md)を参照する。本書の型・操作・数値はBeethovenの仕様案であり、Pi APIの実装確認ではない。

## 1. Orchestratorの定義

Orchestratorは**利用者の依頼を、権限・依存関係・予算・検証条件を守りながら実行するTypeScriptの制御層**。Controllerはこれを動かすフォアグラウンドプロセスであり、別々の状態管理システムにはしない。

自然言語の解釈、コード調査、タスク分割、修正方針にはLLMを使う。実行許可、状態遷移、所有権、予算、再試行、受入はコードで判定する。対話Agentはその制御層から使う推論・実装担当であり、全Workerに常駐の管理LLMを付けない。

| 構成要素 | 決めること・担当 | 直接行わないこと |
| --- | --- | --- |
| Interactive Agent | 会話、調査・編集・検証、計画・委譲の提案 | DB更新、枠の増加、無許可のモデル変更 |
| Planner | Task案、依存、scope、検証方法の候補 | 自分の計画を有効化して実行開始 |
| PolicyEvaluator | 権限、送信先、scope、操作の許可/質問/拒否 | コード品質の推測、LLMの意図から許可を拡大 |
| Scheduler | 実行可能Taskの選択、資源予約 | 受入基準の書換え、競合の意味的解消 |
| Router / BudgetLedger | 有効接続からの決定的選択、上限と予約 | 未採用接続の起動、欠測費用を0扱い |
| Supervisor | Pi接続、起動・監視・停止・回収 | Task成功の独断判定 |
| Verifier / Integrator | 候補検証、直列適用、統合検証 | 人間判定の代行、production操作 |
| StateStore | 状態・意思決定・副作用要求の原子的保存 | 未確認の実世界の成功を生成 |

モデル構成は基本設計10章を共有する。Orchestrator本体にはモデルを割り当てず、必要なPlannerやReviewerだけが基準接続等を消費する。LLM停止中でもstatus、stop、復旧照合、予算判定を行えるようにする。

## 2. モードごとの開始と終了

- **対話**: Session取得→規約・設定・既存差分の確認→Turnを永続化→権限/予算確認→SDK実行→tool/Evidence/usage保存→idleへ戻る。応答終了後も追加指示を受け付ける。
- **単発**: 同じTurn処理を使い、質問・承認が必要ならblockedで終了する。標準出力をJSONに固定した場合、診断はstderrへ分ける。
- **バッチ**: plan/config/baseを固定→DAG検証→Run開始→ready Taskをdispatch→候補検証→直列統合→基準別受入待ち。最後のWorker終了だけでRunを完了にしない。

対話から委譲するときは、AgentがTask案を提示し、Orchestratorが型・scope・依存・予算を検査する。既存の実行許可に並列委譲が含まれるなら追加確認を繰り返さず、権限や金額を増やす場合だけ質問する。実行開始とplan版を履歴に残す。

M1では1つのrepoの書込所有者は1 Controllerとする。親Sessionが委譲を開始する場合、そのControllerの下にRunを作り、同じ所有者として管理する。委譲中は親Agentのrepo編集を止め、状況参照・質問回答・停止を提供する。子の変更を親cwdへ自動適用しない。委譲結果は統合branchのSHAと差分を提示し、適用時に親cwdの既存差分を再検査する。

## 3. Command / Proposal / Event契約

| 種別 | 例 | 扱い |
| --- | --- | --- |
| 利用者Command | SubmitTurn、StartRun、Stop、Answer、Accept、Publish | CLI/UIからの認証されたローカル要求。scopeと期待versionを検査 |
| LLM Proposal | Task分割、昇格候補、追加検証、scope変更 | 要求者を記録し、Policyとschema検証を通す。操作許可とはしない |
| 観測Event | RuntimeSettled、ProcessExited、VerificationFinished | adapterから取得。対象実行世代と状態を照合して適用 |
| 制御Event | StopRequested、BudgetExhausted、LeaseExpired | dispatch停止等を優先処理。LLMへの追加promptだけで実施しない |

共通envelopeは`schemaVersion / id / targetId / correlationId / causationId / expectedVersion / ownerEpoch / createdAt / payload`。対象に不要なfieldは省略可能とし、Piのwire recordをこの形へ変換するのはadapterの責務とする。Eventには受信順seqと観測元も付ける。本文をログのトップレベルへ無条件出力しない。

同じrequest IDの再送は、同じpayloadなら保存済み結果を返し、異なるpayloadなら拒否する。完了済みTaskへの遅延イベント、旧ownerEpochからの要求は監査記録だけを残す。Piイベントに恒久IDがない場合、観測連番だけで完全な再送排除を保証せず、session等の実体と照合する。

## 4. 制御ループと状態遷移

```text
起動時: 所有権取得 → 未完了effectと実体を照合 → 復旧結果保存
実行中:
  1. 停止・取消・上限到達の要求を処理
  2. process/tool/検証/統合の結果を取り込み、状態と予算を更新
  3. 質問・承認への回答を照合
  4. blocked解除・依存失効・retry可能時刻を再評価
  5. ready Taskを安定順で選び、接続・予算・資源を予約
  6. effectを実行し、receiptを保存
  7. Run/Session状態を集計し、UIへ通知
```

イベント到着と次のdeadlineで起動し、busy pollingや定期的なLLM状態確認promptは使わない。Task内の遷移は直列化し、プロセスの稼働は並列化する。SQLite transaction内でnetwork、Git、モデル応答を待たない。

状態遷移は`現在状態 + Event + PolicySnapshot -> 次状態 + Effect案`のreducerで決定する。version付き更新で競合を検出し、受理event・遷移・予約・effect要求を同一transactionで保存する。stopを受理した後に新規dispatchする競合を防ぐため、予約時と実起動直前の両方で停止flagとownerEpochを検査する。

### 4.1 バッチ集計の規則

各Taskは`pending / ready / running / verifying / reviewing / integrating / retry_wait / awaiting_acceptance / accepted / blocked / interrupted / failed / cancelled`。reviewingはReviewer結果待ちで、常時のLLMレビューを意味しない。Attemptの実行結果と統合後の受入状態は別に保存する。

- 実行中または実行可能なTaskがあればRunはrunning。停止受理後はstopping。
- 全Taskがacceptedならcompleted。取消が全体へ適用された場合はcancelled。
- 実行も待機期限もなく、未解決の前提・承認で進めない場合はblocked。人間の基準判定だけが残ればawaiting_acceptance。
- クラッシュや利用者停止で継続可能な作業があればinterrupted。
- retryを使い切ったTaskがあれば、`fail-fast` policyに従い他Taskを止めるか独立Taskだけ継続する。初期は独立Taskを継続し、全稼働終了後にfailedとする。失敗Taskの下流は理由付きblockedとする。

状態だけでなく`reasonCode / affectedTaskIds / nextAction / retryAt`を保存する。blockedはControllerが終了可能な停止点とし、回答・前提更新後は明示resumeで再評価する。対話の進行中画面から回答する場合は同じ処理を継続できる。

## 5. dispatchの判定と資源

判定順は、plan有効性→依存とbase SHA→権限と送信先→接続のenabled状態→quota/cooldown→repo/path/resource→予算→並列枠。却下理由を記録し、先頭Taskが待ちでも独立した後続を評価する。優先度は基本設計8.1章に従い、動的なLLM採点はMVP外とする。

plan有効性の検査には[ルール・ハーネス](rules-harness.md)の適用snapshotを含める。共通/repoの必須check不足、未許可の実行定義、解決していない競合があれば対象Taskをblockedにする。Workerへ同じsnapshotを渡し、preflight失敗では起動せず、verifyの証拠が不足した候補は受入へ進めない。

resourceは安定したIDで取得順を統一し、必要資源を一括予約する。途中まで確保して他資源を待たない。モデル枠は呼出終了、worktree所有権は処理終了・回収確認、統合lockは適用/検証完了で解放する。停止要求時に実プロセスが残る枠を先に返さない。

quotaGroupはlocal state全体で共有し、別repoのControllerも同じSQLite予約を使う。repo所有権はGit common directoryのcanonical pathで識別し、別worktreeからの起動で同一repo制約を迂回しない。復元先ではrepo IDの対応を明示して再登録する。

## 6. 外部副作用とクラッシュ復旧

各effectを`planned / executing / succeeded / failed / unknown`で管理し、実行前に`effectId / target / ownerEpoch / inputHash / reconcile方法`を保存する。実行は少なくとも1回になり得るが、外部世界に対するexactly-onceは主張しない。

| effect | 再起動時に照合するもの | 判定不能の場合 |
| --- | --- | --- |
| Worker起動 | 起動manifest、PID開始時刻、session/worktree、所有者 | 新規起動を止め、旧プロセスを確認 |
| 候補commit | 対象tree hash、専用branch、commit metadata | dirty差分を保持してblocked |
| 統合 | 統合前後SHA、Git進行状態、専用branch | 勝手に再cherry-pickせずblocked |
| push / Draft PR | remote ref、head SHA、Runを識別するmetadata、PR identity | 重複送信せず結果照会を要求 |
| backup送信 | snapshot ID、暗号文hash、remote commit | remote保存済みと表示しない |

heartbeat喪失時は起動を止める。旧所有者が生きている可能性がある間は、新ownerEpochで作業を重ねない。owning lockとプロセス照合を通した場合だけ引き継ぐ。DBやディスクへの書込失敗時は新規dispatchを停止し、稼働プロセスの停止を試みる。保存できなかった最終usageを確定済みと報告しない。

GitHubへの接続不能だけでローカル成功を失敗へ上書きせず、公開・CI・backupの同期状態を別に保持する。publish/backupの再実行は保存済みeffectを照合する。

## 7. 質問・承認・再計画

質問は`questionId / task・session / reason / choices / requestedCapability / inputHash / planVersion / targetSHA / status`を持つ。回答は対象versionと有効範囲を照合し、古い計画・別SHAへの回答を流用しない。承認の範囲は1操作、Session、Run等で明示し、復元後に有効な権限として自動再使用しない。

再計画は進行中planを上書きせず差分案を作る。変更Taskと下流について停止・回収を先に行い、成果物を保存してから新版を有効化する。無関係なTaskは変更せず、下流base・証拠・予算を再評価する。権限や受入基準を変える場合は利用者の判断を必要とする。

M1の動的再計画は、停止点での明示操作に限定する。LLMが実行中DAGを勝手に追加・削除しない。再開、モデル変更、計画変更でも元の費用・時間・失敗履歴を残す。

ルールやハーネスの改版も同じ再計画の対象とし、影響Taskの停止・新版への移行・必要な再検証を行う。共通ルールの変更は、そのsnapshotを使うSession/Runを再評価し、無関係な条件へ変更を広げない。旧版を使う場合も現在の実行権限は再確認する。

## 8. 具体例と運用表示

Task A=API、B=Aを使うUI、C=独立した文書、並列2の場合、AとCを開始する。Cが先に終了すれば候補検証と統合を行う。Aを統合・検証して必要な依存条件を満たした後、その統合SHAからBを起動する。

Aの検証失敗ならBは未起動のまま理由を表示し、Aの修正を枠内で行う。Cの成功は保持する。Aが質問待ちならプロセスを回収して枠を返し、質問とCの結果を表示する。stopとA終了が同時なら成果物を保存するがBは起動しない。統合中に落ちた場合は、再起動後に統合branchを照合してからBの可否を判定する。

`status`は実行数だけでなく、各Taskのstage、担当接続・認証方式、base SHA、消費/予約/欠測、待ち理由、次に必要な操作を表示する。モデルの自然文による進捗率を実測の完了率にしない。

## 9. 実装成果物と受入

単一package内の`core/orchestrator`、`policy`、`scheduler`、`routing`、`budget`と、adapterの`pi`、`git`、`store`へ配置する。最初から独立サービスへ分割しない。

| 検証ID | 必須シナリオ |
| --- | --- |
| OR-01 | LLMなしで手書きDAGを実行し、stop/status/復旧できる |
| OR-02 | 同じCommand再送・遅延event・旧epochでも二重起動/二重受入しない |
| OR-03 | 停止と完了・dispatchが競合しても停止後に次Taskを起動しない |
| OR-04 | quota/予算/resourceの並列予約と解放を整合させる |
| OR-05 | 上記A/B/C例、質問待ち、下流停止、独立Task継続を再現する |
| OR-06 | 起動・commit・統合・公開の直前直後に落とし、副作用を照合して復旧する |
| OR-07 | LLMの提案だけで権限・予算・モデル・受入基準を変更しない |
| OR-08 | 対話から委譲中に親と子が同じrepoへ同時編集しない |

reducer・adapter fakeによる決定的な障害再現と、実Pi/実Git/明示許可したGitHub操作の確認を区別する。未検証を合格として扱わない。
