# P3 対話Coding Agent：実装と受入

更新日: 2026-10-25 / **P3の実装・開発者による実モデル受入まで完了。本人の通常操作による受入とGitHub CIは未確認。**

これはCodex SDK経路の単体Agentについての記録。その後、P2のRPC実測・Claude比較接続・接続状態管理等も完了した。現在の結果は[P2評価記録](model-evaluation.md)を参照する。P0〜P3の本人受入とGitHub CIは未確認で、全チェックの完了とは扱わない。

追加依頼で通常端末の`beethoven`ランチャーと基本TUIも実装・登録した。[操作ガイド](tui.md)と[追加検証記録](evidence/tui-2026-10-25.json)を参照。今回の全61ローカル試験・実PTY6条件を、下記の過去のCodex実モデル評価とは分けて記録する。

## 接続と評価条件

本人がCodex subscription・6.1-solを選択し、上限の設定を実装側へ委任した。固定Pi 1.4.0のモデルIDは`openai/gpt-6.1-sol`。当初は全試験50,000 token・累計2分としたが、実測でTurn/Sessionの期限混同を修正し、本人への進捗報告後に全試験75,000 token・Session累計10分・各Turn2分へ調整した。同時実行1、provider/Agent retryなし、別課金へのfallbackなし。初回manifestと上限改版記録を両方保持する。

`scripts/prepare-evaluation.mjs`で独立したGit repo・config・state保存先とmanifestを用意する。既存の本人repo・認証は使わない。Taskはdecisions.mdの数量計算バグ修正、検証は`node --test`。基準SHA、受入条件、実行環境は生成したmanifestへ記録する。fixtureの基準commitは試験準備で、Beethovenによる成果commitではない。

今回の基準SHAは`d2ed10c5e2818c4c1e511cd6822c571ddd3a6a42`。初回loginは期限切れになった後、本人の指定した個人アカウントでブラウザー認証を実施し、最後の権限付与は本人の明示確認後に確定した。ブラウザーの成功表示とローカルの保存結果を照合した。credentialは専用評価領域へ0600で保存し、既存アプリのcredentialはコピーしていない。

秘密を含まない[受入証拠JSON](evidence/p3-2026-10-25.json)に、各試行・失敗・Session/Turn ID・実測値・process回収・fixture保護・実装source hashを保存した。元のDB・会話・logsはJSONに記載した私有評価領域に保持する。認証token・callback URL・個人メールはこの証拠へexportしない。

## 実装・ローカル確認と実モデル確認

ローカルの統合試験はPi本体のSDK loopを利用する。providerだけを同梱Fauxの決定的な応答へ差し替え、Beethovenと同じPolicy・file tool・shell・ハーネス・SQLite・Pi会話fileを通す。推論品質・subscription対応の証明には使わない。

| 条件 | 実装・ローカル証拠 | 実モデル |
| --- | --- | --- |
| CA-01/09 対話・単発・JSON | `dialogue.ts`で同じSDK Sessionへ接続。未設定・認証不足・承認待ちは構造化blocked | 引数なしTTY、日本語複数行、初回prompt、print/JSONLを確認 |
| CA-02/10 規約・scope | 共通/repo原本とhashをsnapshot保存。Pi自動探索を使わず一度だけ適用。tool/request前の変更検出・resume時の新版確認 | 原本の適用、日本語コメント、改版確認、圧縮後の規約再掲を確認 |
| CA-03 編集・shell | 読取hash、scope、dirty差分の確認、競合拒否。任意shellは明示承認、POSIX process groupを回収 | cart.jsのみ編集。sleep 30実行中の停止・group消失を確認 |
| CA-04 質問・計画・検証 | 質問/回答を保存。read-only/計画のみの編集とshellを拒否。SDKで編集→失敗→修正→成功 | verifyで2件失敗→修正→3件成功。質問待ちを保存、readonlyは実行拒否 |
| CA-05 停止・追加指示・再開 | shell中断後の同一会話継続、会話file再開と外部編集再読込、圧縮後の規約・usage保持 | Ctrl-C後の継続、別起動resume、外部コメント再読、実モデル圧縮を確認 |
| CA-06 接続・認証・上限 | 接続別credential、OAuth時のAPI key fallback除外、上限の積集合、使用量と留保枠、明示した/model変更 | OAuth保存・疎通、固定gpt-6.1-sol、上限改版の確認、欠測留保を確認。別modelへの切替自体はローカル試験 |
| CA-07 差分・検証・未確認 | HEAD/作業hash、変更file・diff、検証status/log hash、受入未確認を分離。source変更で信頼・証拠が失効 | テスト・規約・ハーネス・既存メモを保持。HEAD不変、検証と受入を分離 |
| RH-04〜07 ハーネス | 定義とworkspace内容を信頼hashへ結合。preflight失敗はモデル呼出し前に停止。verifyは別processで実行 | 編集前と編集後で信頼を再確認。非TTYのshell承認待ちはcode 3 |

macOS / Node 24.21.0で全46ローカル試験が成功。providerを使わない試験と実モデル試験を分けた。POSIX orphan回収を含む全試験は通常のsignal権限で実行し、実行制限によるEPERMを製品不具合や成功へ読み替えていない。秘密入力は実PTYで入力値がechoされないことも確認した。

実モデルの報告tokenは**58,596**、中断した圧縮の欠測留保は**10,903**、予算判定上の合計は**69,499 / 75,000**。留保分は実測に足さず、実請求や正確な総tokenを断定しない。subscriptionの金額はunknownのまま。未回収processのreceiptは0件、記録した3 process groupは消失を再確認した。

実測中に見つけて修正したものは、対象限定の「変更しない」を全体の計画モードと誤判定する問題、JSONのmetadataまでtokenに換算して過大停止する問題、Turn/Session期限の混同、小さい会話の圧縮を起動失敗扱いする問題。対象限定の禁止・累計時間超過後の次Turn・小さい会話の圧縮を回帰試験へ含めた。修正前の試行や中断・欠測の記録を削除していない。

GitHub CI、本人の通常操作による受入、Windows、隔離環境、Worker、backup/restoreは今回のローカル証拠に含まない。P3が受入済みになってもM0全体の完成はP4の復元試験後。

## 操作手順

Node 24.21.0でビルドする。以降の`beethoven`は`node dist/src/cli.js`へ読み替えられる。

1. `beethoven setup`で接続・auth/billing・model・有限上限を保存する。初回起動が未設定ならsetupへの案内を返す。
2. 個人`config.json`の`allowedConnections`へ本人が接続IDを記載する。編集を許す場合は`permission: "workspace-write"`にする。setupとloginはPolicyを広げない。
3. `beethoven login --connection ID`をローカル端末で実行する。tokenやcallback URLをチャットへ貼らない。
4. 対象Git repo内で`beethoven`または`beethoven "依頼"`。開始時にcwd・HEAD・dirty・規約・接続/auth/billing・権限・上限と送信内容を確認する。
5. 非対話は`beethoven --print "依頼" --send --json`。`--send`は選択providerへのprompt・規約・会話・tool読取内容の送信確認。shellやハーネスの新たな承認は含まない。
6. `beethoven harness trust`でargv/cwd/環境名・定義hash・workspace hashを確認し、同じ対象へ`--yes`を付けると信頼を保存する。sourceが変われば失効する。対話中は実行前の確認も使える。
7. `/paste`は単独`.`まで複数行入力。末尾`\`でも継続入力できる。実行中の追加入力はqueueへ残る。Ctrl-CはTurnを停止し、確認できれば同じ会話へ戻る。
8. `/status`、`/permissions`、`/diff`、`/sessions`で状態を確認。`/compact`は現在の接続と残予算で明示的に圧縮する。`/model 接続ID`は登録済み接続へ確認後に変更し、履歴・使用量を保持する。
9. `/exit`で保存・終了。表示したIDを`beethoven --resume ID`へ指定して再開する。規約変更は新版の確認、file変更は再読込を必要とする。質問待ちで再開した場合は次の依頼入力を回答としても記録する。

JSON出力はSession、text/tool event、最後のresultのJSONL。終了codeは成功応答0、モデル/検証失敗・中断1、形式・保存等のエラー2、前提/承認待ち3。対話では途中の中断・失敗も終了codeへ保持するため、各Turnのstatusも照合する。応答終了はTask受入やcommitを意味しない。

## 境界と復旧

- `--plan`はSession全体を計画・調査に限定する。依頼中の「計画のみ」「変更しない」等も保守的に制限するが、自由文すべての意図を完全に機械判定するものではない。確実に限定する場合は`--plan`を指定する。
- file toolはcwd内、指定`--scope`内の編集を許す。scopeはresumeで広げられない。symlink、`.git`、定型credential fileは対象外。read-onlyでは任意shellを実行しない。
- shell/ハーネスはhost実行。OSによるworkspace・networkの隔離を保証しない。環境変数は基本項目と承認したrequiredEnv名だけを渡す。任意の推移依存までhashで保証しない。
- 初版のハーネス信頼はworkspace全体の内容hashへ結ぶ保守的な方式。通常のsource編集でも確認し直す。定義・テスト・package/lock・規約を編集する場合も確認する。
- `config.maxDurationMs`はSession累計、`connection.limits.maxDurationMs`は各Turnの期限。token上限は両設定の厳しい方をSessionへ適用する。1 requestの出力は最大4,096 token、1 Turnは最大24 request、provider/Agent retryは無効。
- tokenはPi確定応答の報告値、金額は従量接続のPi報告値。入力見積りはPiの内容推定と直近のcontext報告の大きい方へ50%＋256 tokenの余裕を加える。subscriptionの金額はnull。中断等の欠測はunknownのまま残し、subscriptionでは送信前の入力推定＋出力上限を消費枠へ留保する。留保分を実測tokenへ加えない。従量金額が欠測なら継続を止める。アプリの停止・推定値はprovider請求の厳密な上限保証ではない。
- 状態DB schema 2はschema 1へ追記する。migration前に整合snapshotを保存する。state全体のlockにより同時Controllerは1つ。crash後は`recover`で所有者消失を確認し、`recover --yes`でlockを解除する。生存PIDは奪わない。再開時に前回のprocess groupが残っていれば止まり、PID再利用を考慮して自動killしない。
- SDK停止を確認できなければSession再利用を拒否する。signalをOSに拒否された場合も回収済みにしない。POSIX以外のprocess回収は未対応。

P3の範囲はここで停止し、P4のbackup/restoreやP5のWorkerへ先回りしない。本人の通常操作、別repo・別provider・別OS、公開配布、CIはそれぞれ別の確認事項とする。
