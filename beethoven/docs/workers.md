# 単一Workerの起動・保存・再開

更新日: 2026-10-25

P4〜P8追加で[DAG・最大4 Worker・セッションマップ](operations.md)も実装した。以下は従来の`/worker`単一起動操作の仕様。通常の対話は1 Agent。`/worker <依頼>`を確認すると同じ接続の実Node子processを起動し、専用worktreeでPi SDK・共通tools・harnessを使う。最大1 Workerで、自動Task分解・並列化・自動commit・統合は行わない。

```text
/worker cart.jsの数量計算を修正して既存テストで確認してください
/workers
/workers <Worker ID>
/workers logs <Worker ID>
/worker resume <Worker ID> 数量を反映してください
```

質問は保存して`waiting_input`へ移り、子processを終了して親の実行枠を返す。回答は`/worker resume ID 回答`。回答を省略するとTUIが保存した質問を表示する。承認待ちも記録するが、回答文字列だけでshellや編集を許可しない。必要な操作は通常の承認画面で確認する。

再開は同じ親Session・接続・子Session・worktreeで行い、質問ID、rule内容、権限、編集scopeを照合する。規約変更・別接続・回答先不一致を黙認しない。再開で累計使用量はリセットせず、前回のcheckpointから増えた分だけ親へ加算する。待機からの継続は最大24回。モデルの障害retryとは別で、自動retryは行わない。完了・失敗したTaskの無条件再実行には使えない。

TUIには実際のmodel/tool/verify/interaction eventとPIDから段階を表示する。状態は1秒ごとに更新し、`updatedAt`とprocessの存在からlivenessを診断する。古いPIDへ自動でsignalを送ったり、heartbeat欠測だけでlockを奪ったりしない。ログは私有directory内に最大約1MiB、読取は末尾200件まで。OAuth token・APIキー・IPC tokenをログ本文へ記録しない。

## 元の作業の保護

- commit済みHEADのあるrepo rootで起動。開始時のtracked・untracked・dirtyなfileを専用worktreeへ複製し、元のfileとindexを変更しない。binary bytesとfile modeも維持する。
- checkout hook・smudge filter・ignored依存の自動bootstrapを実行しない。symlink、認証定型file、Git管理情報は対象外。各file 4MiB・合計64MiB・既存のfile数制限を適用し、競合を検出する。準備中も32 file単位で中断を確認する。
- 共通/repoのrules・harness内容を照合。plan-only、権限、scope、親の残token・USD・時間を継承する。待機からの再開でも権限を拡大しない。
- 同じhostで実行し、worktreeはOS sandboxではない。shell/harnessの承認は通常Agentと共通。credentialは選択した接続の私有storeを参照し、別providerへfallbackしない。

結果は未統合の候補。変更file・差分・検証結果を示し、`<stateDir>/workers/<ID>/worktree`へ保持する。untracked本文はGit diffに出ないため実体も確認する。job.jsonは所有者・子会話・規約と継続回数、status.jsonは状態と質問、manifest.jsonは起動条件、result.jsonは直近結果を記録する。JSONは内容競合を検出してrenameで確定する。

本更新より前の候補も削除しない。job.jsonがない候補はこの継続機能の対象外で、既存の差分確認・保守的な復旧を維持する。

## 予算・停止・復旧

親の残予算を起動前にSQLiteへ予約し、親モデルを同時に動かさない。ready/startで起動権を渡し、起動前・初期化中の中断を保持する。子とtoolの消失後に、永続provider request/response記録で使用量を精算する。送信前の取消や、全responseを保存できたケースでは未使用分を返す。未完了requestの課金を推測して0にせず、残りを留保する。

Worker本体が終了しても所有process groupの消失まで回収し、停止未確認ならlockと予約を維持する。UI observerの例外で監視処理を放棄せず、中断・回収へ進む。状態保存に失敗した場合も未精算予約を保持する。安全確認と復旧は表示の100件制限に依存しない。

```sh
beethoven workers --json
beethoven workers <Worker-ID>
beethoven workers logs <Worker-ID>
beethoven recover
beethoven recover --yes
beethoven workers recover <Worker-ID>
beethoven workers recover <Worker-ID> --yes
```

復旧はcontroller/Worker/tool processの不在を確認して明示実行する。PID記録がない等の不確実な状態は自動復旧しない。異常終了の明示復旧では従来どおり予約全枠を欠測として残す。

## 範囲と確認

実SDK＋scripted provider、実process・worktree・編集・harness、質問待機・同じ会話の再開・差分精算・中断・observer例外をローカル確認し、実PTYからも操作する。新しい実providerのWorker受入、有料推論、本人受入・GitHub CIは未確認。

P5の単一Worker基盤の改善であり、P5/P6全体の完了ではない。DAG・複数Worker scheduler・候補commit/統合・自動bootstrap・quotaGroup全体の予約・worktreeのarchive/削除・完全なcrash副作用照合は残す。
