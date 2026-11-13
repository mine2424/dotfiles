# P2：Pi・モデル接続の評価記録

更新日: 2026-10-25 / 状態: P2の実装と開発者による実モデル評価を完了

[秘密を含まないP2証拠](evidence/p2-2026-10-25.json)を今回の正本とする。Codex SDKの先行評価は[P3受入記録](p3-acceptance.md)と[当時の証拠](evidence/p3-2026-10-25.json)を保持する。本人の日常操作による受入、GitHub CI、P4のbackup/restoreは未確認。

## 接続・条件・結果

本人が比較接続にClaude subscription、版固定の`anthropic/claude-sonnet-4-5-20250929`を選択した。専用loginで認証し、接続承認画面で本人が権限付与を許可した。既存アプリのcredentialをコピーせず、Beethovenの接続別0600ストアへ保存した。

| 経路 | 実測 | 使用量 |
| --- | --- | --- |
| Codex subscription / `openai/gpt-6.1-sol` / SDK | P3でread/edit/shell、verify、追加指示、abort、回収、保存・再開・圧縮を確認 | P3の過去記録を維持 |
| 同接続 / bundled RPC | read/edit/verify/shell、停止後の再起動・会話再開、応答中断、process group回収、依頼外file保持 | 報告14,038、欠測留保5,805、判定19,843 / 今回40,000 token |
| Claude subscription / SDK | 同じ数量計算fixtureの修正・独立テスト成功。保存済み会話を再開し、応答のsettledを確認 | 報告28,671 token |
| 同接続 / bundled RPC | read/edit/verify/shell、停止後の再起動・会話再開、応答中断、process group回収、依頼外file保持 | 報告25,086、留保0 token |

Claude合計は53,757 / 60,000 token。最初の30,000では再開用入力枠を確保できず、送信前に止めた。本人の追加承認後に60,000へ変更した。各Turn2分、1接続1並列、自動retryなし。Codex RPCは既存P3とは別枠の40,000 tokenで評価した。上限は内容推定に基づく実行制御であり、provider請求の厳密な上限保証とはしない。

各fixtureのGit commit日時は異なるが、Git treeは一致する。数量反映、空配列0、複数商品340、テスト・規約・package・ハーネスの保持を独立検証した。小さいfixture各1回の結果であり、速度・品質・費用の優劣や成功率は評価していない。

## SDK/RPCの契約と所有

`src/pi.ts`は受付、stream/tool通知、確定message_end、agent_settled、期限・取消を共通形式へ変換する。RPCのprompt応答は受付だけで、agent_endも終了判定に使わない。handledはrunなし、queuedはこのadapterでは追跡せず再利用を拒否する。completedは応答終了で、Task・本人受入の合格を意味しない。

`src/rpc.ts`はPi 1.4.0の公開bundled `rpc-entry`を、実行中と同じNodeで起動する。親のAPI keyやPATHを引き継がず、HOME/agent directoryを隔離する。JSONLと送信queueを制限し、日本語の分割decode、要求timeout、TERM/KILLとprocess group消失を検査する。stderrは本文を保持・表示しない。公式RpcClient＋fakeの契約試験も残すが、公式clientの環境継承・stderr転送・停止方式を実providerのsupervisorとして採用しない。

評価では`rpc-evaluation-extension.ts`だけを明示loadし、Piのextensions・MCP・skills・prompts・themes・AGENTS自動探索を無効化した。共通の`codingTools`・`runHarness`を使い、編集先cart.js、shellは承認済みNodeテストだけに限定する。規約snapshotの変化、接続・modelの変更、期限・予算不足で停止する。通常対話は引き続きSDKで動く。この評価用RPC所有処理の確認を、Workerの並列quotaやcrash復旧全体の完了とは扱わない。

`withRpcCredentials`はBeethoven自身の選択接続だけをPi CLIのauth.json形式へ変換する。認証lockを子の停止確認・refreshの書戻しまで保持する。親crashや停止不明ではmarkerと更新fileを残し、新規起動を拒否する。未確認のrefreshを旧credentialで上書きしない。markerの自動回収は行わず、processと両方の認証fileを本人の私有環境で照合する。

## 障害とusageの扱い

401/403、429、408/504、ETIMEDOUT等の構造化status/codeを優先し、Piが文字列だけを返す場合は認証・rate limit・timeoutを推定分類する。本文・認証値は結果へ返さない。rate limitを実providerへ故意に発生させる試験は行わず、分類はローカル注入試験で確認した。

usageは確定応答だけを数え、累積stream・agent_end・session統計を再加算しない。中断時はadapterのusage=nullを保持する。Codex RPCの中断はprovider ledgerにも欠測があり、入力推定＋出力上限の5,805 tokenを留保した。Claudeではadapter取消後に確定したprovider ledgerを停止前に保存できたため、25,086にその値を含む。adapterの欠測を過去にさかのぼって0へ変えない。

subscriptionは本人の選択、固定providerのsubscription OAuth定義、認証・実推論成功を契約経路の根拠とする。請求額・残枠は取得できず金額はnull。Pi catalogのtoken価格をsubscription請求へ換算しない。従量APIの実課金試験は未実施だが、auth方式の固定、親API keyの不継承、allowFallback=false、正の金額上限必須を検証し、subscription障害からAPIへ切り替える経路はない。

準備中のRPC起動失敗（macOSの/varと/private/varの照合）、30kでの再開停止、再開後に評価runnerがハーネス許可を返さずblockedになった試行を証拠へ残した。後者のprovider応答自体はsettled/completed、独立テストは成功している。blockedを成功へ書き換えていない。

## routingと接続状態

`routing.example.json`は`connections.example.json`のIDと一致する。役割別・Task種別の選択を宣言し、未知ID・重複・未知項目・fallback=trueを拒否する。Verifier/Integratorはモデルなしなので割当を持たない。`routedConnection`は許可送信先かつenabledだけを選ぶ。未設定はrouting_unconfigured、未評価・非対応はconnection_not_enabled、禁止先はconnection_not_allowedとして区別し、障害を契機に他課金へ再選択しない。Worker/DAGの自動起動は実装していない。

接続宣言statusはconfiguredのまま保つ。実評価はstate/evaluationsと内容hash付きartifactsへ保存し、Pi版・宣言全体・fixture・証拠・料金根拠・使用量に結ぶ。SDK/RPC疎通でsmoke_passed、Task・停止・再開・依頼外file保持でtask_evaluated、明示enableでenabledへ進む。unsupportedも保持する。宣言やPi版の変更はconfiguredへ戻し、再評価で旧enableを解除する。評価JSONへの手書きstatusだけで有効化しない。

```bash
beethoven connections --json
beethoven routing check --json
beethoven connections enable --connection <ID> --yes
```

最初の2つは読取専用。routing.jsonは個人設定directoryへ置く。評価記録のないenableは拒否する。今回の2接続は隔離した評価用stateで明示enableとrouting選択まで確認した。通常対話の明示接続選択と、将来の自動Routerによる選択は区別する。

再現用は`scripts/evaluate-sdk.mjs`、`scripts/evaluate-rpc.mjs`、`scripts/export-p2-evidence.mjs`。前2つは実モデルへ送信するので、私有fixture manifest・本人のconfig・接続ID・残token予算を明示して使う。exportは非機密項目を集約し、Task評価を保存するが自動enableしない。
