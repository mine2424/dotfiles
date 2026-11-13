# 開発判断と現在の進捗

更新日: 2026-10-25

## P0：確認済みの判断

| 判断 | 内容 |
| --- | --- |
| 最初の評価先 | 本人の既存プロジェクトを使わず、テスト専用Git repoから開始する |
| Beethovenへ許可する操作 | テスト専用repoのファイル調査・編集・ローカルテスト |
| 別途判断する操作 | Beethovenによるcommit、push、外部へのコード送信。有料モデル呼出し前には接続・上限・送信内容を確認する |
| コードの書き方 | Codexで実装するが、本人が読んで修正できる少数のmoduleと素直な関数で進める |
| ルール・ハーネスの管理単位 | 開発全体の共通条件とproject/repo固有条件を管理する。projectとrepoは同じ単位とし、別階層や複数repo所属は作らない（ユーザー確認済み） |
| 共通ルール初期内容 | `rules.example.md`の初期内容を本人が採用。素直なコード・最小構成・日本語コメント・既存変更保護・検証・課金送信境界を含む。共通設定先へのコピーは未実施 |
| 共通ハーネス初期内容 | 必須checkはまだ設けない（ユーザー確認済み）。repoや将来の共通宣言で追加した必須条件を解除できない設計は維持する |
| 初回のモデル設定 | 利用者が初回設定で接続先・認証方式・課金方式・既定modelを選ぶ。複数接続を登録でき、特定の個人設定を製品の固定値にしない |
| 本人の利用予定 | Codex・Claude・Kimiはsubscriptionを利用予定。認証済み・model利用可能とはまだ扱わない |

## 最初の評価Task案

テスト専用repoに、単価（整数の円）と数量から合計を計算する小さなJavaScript関数を置く。初期実装は数量を反映しない不具合を持つ。依頼は「数量を反映するよう修正し、既存テストを通す」。正解コードはAgentの入力へ含めない。

受入基準は、空配列が0、単価100・数量3が300、複数商品の合計が正しいこと。テストと依頼外のファイルを変更しない。検証は`node --test`。既存dirty差分の保持、中断・再開は別のfixture条件で検証する。

このTask案をP3で試験用repoへ具体化し、基準SHAと実際の検証をmanifestへ記録した。詳細は[P3受入記録](p3-acceptance.md)。本人の通常操作による受入とは区別する。

## P1：実装判断

- Nodeは既存miseの24.21.0を使用。シェル既定の25系はこのpackageの対象外。共通のNode設定は変更しない。
- SQLiteはNode組込みの`node:sqlite`を採用候補として実装し、初期化・WAL・外部キー・snapshot・新しいschemaの拒否をローカル試験する。追加のnative driver依存は導入しない。
- Pi 1.4.0を固定し、SDKと公開`rpc-entry`を同じpackageから解決する。P1ではmetadataとファイル存在を確認するだけで、SDK/RPCの動作確認はP2。
- CLIはNode標準の`parseArgs`を使用。P1の2コマンドにCommanderやTUIライブラリーは追加しない。
- 型検査はTypeScript、試験はNode標準test runnerを使う。config、file/lock、store、CLIをフラットに配置する。
- P1は`doctor`と明示的な`init`を提供。対話、モデル、Worker、backupは未実装として表示する。
- npm標準cacheに既存の所有権エラーがあったため、導入には専用の一時cacheを使用した。既存cacheの所有権は変更していない。
- Piの推移依存undiciでnpm auditが問題を検出したため、同メジャーの8.12.2へoverrideしlockfileで固定した。[修正情報](https://github.com/advisories/GHSA-xjj6-f33q-929c)。実モデル通信の互換性はP2で確認する。

## 完了と未確認の区別

P1のローカル検証結果は[開発手順](development.md)を参照。GitHub Actionsの定義は作成するが、push前なのでGitHub CIは未実行。本人の端末操作による受入も未確認。

P2は利用者別の初回設定を入口に進める。本人の予定は上記3接続のsubscription。Pi 1.4.0の`openai/openai-codex`、`anthropic`、`kimi-coding`にsubscription OAuth定義があることを静的確認した。credentialの取得、auth設定変更、login、モデル呼出しはまだ行っていない。初回フロー・保存・確認状況は[初回設定設計](setup.md)を参照。

P1Rの宣言検査、worktree/repo識別、show/check/doctor、明示snapshot保存を追加し、計14テストでローカル確認した。共通とrepoは手編集可能な原本を読み、出所・hash・必須条件を保持する。Gitの読取を除きprocessを起動せず、診断ではstateを書かない。本人の共通設定、既存repoの規約、認証は変更していない。

信頼の記録・ハーネス実行・モデルへのルール適用はP3、Sessionとsnapshotの関連付け・継続時の照合も後続実装で行う。P1Rの保存先は既存artifact領域で、DB schemaの変更は行わない。

## P2：初回設定の実装

- `setup`の対話・非TTY宣言取込、複数接続・既定model・上限、追加・変更・削除・取消を実装した。保存しても認証・送信許可・モデル疎通は有効化しない。
- Pi AIをCoding Agentと同じ1.4.0で直接依存にし、公開provider exportのローカルcatalogだけを使用する。新たな外部libraryや独自provider registryは作らない。
- 接続のstatusはconfiguredのみ。認証・catalog以外の利用可否はnot_checkedとし、秘密値を保存しない。既存Policyやcredentialは変更しない。
- 計22テストと、実PTYの保存・Ctrl-C取消を一時領域で確認。GitHub CIと本人の受入、実認証・SDK/RPC・課金を伴う試験は未実施。

## P2：SDK/RPC adapterの契約試験

- `src/pi.ts`へ作成済みSDK session / 公式RpcClient用のturn adapterを追加した。認証・runtime作成・起動・CLIへの接続は行わず、P3のPolicyを先行実装しない。
- prompt受付と`agent_settled`を分離し、handled/queued、エラー、tool通知、確定usageを変換する。期限切れ・取消はabort要求を行うが、停止通知がなければ停止未確認として再利用を拒否する。プロセス回収は未実装。
- SDK型に合わせたfake sessionと、公式RpcClient＋fake子プロセスでローカル契約試験を追加した。実SDK session、bundled RPC、モデル疎通・session再開・子プロセス回収の証拠とは区別する。詳細は[モデル評価記録](model-evaluation.md)。
- 実接続前には本人が接続・model・上限・送信内容を確認する。既存認証の取得、login、別課金fallback、commit/pushは今回行っていない。

## P3：対話Agentの実装と評価条件

- 本人が「P3が完了するまで実装を続ける」と指示し、初回実モデル試験はCodex subscription・6.1-sol、上限は実装側の判断と回答した。固定Pi 1.4.0上のIDは`openai/gpt-6.1-sol`。当初の50,000 token・累計2分から、実測での期限混同修正と欠測留保を保持したまま残りを評価するため、進捗報告後に75,000 token・Session10分・Turn2分へ調整した。1並列・retryなしは維持する。
- `auth.ts`の接続別保管と明示login、`agent.ts`のSDK所有、`tools.ts`のPolicy、`harness.ts`の信頼・実行、`session.ts`の永続化、`dialogue.ts`/`terminal.ts`のCLIを実装した。別の推論loopやplugin基盤は作らず、Piの自動resource探索は無効化した。
- schema 1のSQLを維持してschema 2を追記し、Session/Turn文書を追加した。初版はstate全体のlockで1 Controllerとする。共有quotaの予約と並列実行はP5以降。
- ハーネス信頼は定義＋workspace内容のhashへ結ぶ保守的な実装とした。通常source編集でも再確認する。旧許可・旧Evidenceで新状態を合格にしない。host実行をOS sandboxとは表示しない。
- subscription金額はunknown。token欠測は0で埋めず、送信前の入力推定＋出力上限を消費枠へ留保し、実測値と区別する。入力推定はPiの内容推定と直近のcontext報告の大きい方に50%＋256 tokenの余裕を加える。JSON metadata全体のbytesをtokenとして扱わない。従量金額欠測・残予算不足・停止未確認では継続を止める。provider請求の厳密な上限保証とはしない。
- login期限切れ後に、本人が指定した個人アカウントでブラウザー操作を行い、権限付与の明示確認後にOAuthの保存成功を照合した。全46ローカル試験と、Codex実モデルでの編集・検証・追加指示・停止・圧縮・再開・非対話blockedの開発者受入を完了。報告token 58,596、欠測留保10,903、予算判定69,499/75,000。失敗・中断・欠測は記録に残した。
- 本人の通常操作による受入とGitHub CIは未確認。P4のbackup/restore、Workerは未実装。[P3受入記録](p3-acceptance.md)と[秘密を含まない証拠](evidence/p3-2026-10-25.json)を参照。

## P2の残要件と進行判断の訂正

- P3の報告で完了としたのは、Codex SDK経路の単体Agent実装と開発者受入。P2で要求するbundled RPC実測、比較接続、障害分類の確認範囲、routing例、configured/smoke_passed/task_evaluated/enabledの管理は残っている。
- これらを後続段階へ移す本人の合意はない。実装側が先送りした判断を訂正し、P0〜P3全体は未完了とする。次はP2の残要件を完了し、P4へ進む前に通過条件を確認する。
- SDKのfixture試験と既存成果物については、未実施ではなくP2チェックへの反映不足だったため分けて記録した。実際の未完了項目を、チェック欄の更新だけで完了にはしない。


## P2残要件の実装・評価結果（2026-10-25）

- 本人がClaude subscriptionと版固定`claude-sonnet-4-5-20250929`、同じ数量計算fixture、合計30k token・Turn2分・1並列・retryなしを承認した。SDK修正・検証で23,437を使い、再開が入力予算不足で止まったため、本人が合計60kへの増枠を承認。SDK累計28,671、RPC25,086、合計53,757/60,000。Codexの今回のRPC試験は別枠40kのうち報告14,038＋欠測留保5,805=19,843。
- ClaudeのOAuthを専用loginで起動し、本人の個人アカウントと表示された権限範囲を確認後、本人が接続を承認した。既存アプリの認証は取得せず、Beethovenの私有認証ストアへ保存した。
- 公式RpcClientは親環境・stderr・停止方式の問題を残すため、通信契約を維持した小さいOwnedRpcClientで固定版bundled entryを所有した。評価用extensionだけを明示loadし、共通のcodingTools/runHarnessを使う。Piの規約・extension等の自動探索は無効化する。通常対話はSDKを維持する。
- RPCではBeethoven自身の選択credentialだけをPi形式へ変換する。refreshの書戻しまで認証lockを保持し、停止未確認や親crashではmarkerと更新fileを残して再起動を拒否する。旧credentialでの自動上書き・他接続へのfallbackはない。
- 両接続のbundled RPCでread/edit/verify/shell、独立テスト、依頼外fileの保持、再起動・保存会話の再開、応答中断・process回収を確認した。起動時のmacOS path照合失敗、SDKの予算停止・ハーネス許可不足も記録した。応答の終了、ハーネス結果、本人受入を分離する。
- routing例とschema、宣言全体・実Pi版・fixture・証拠hash・料金根拠に結ぶ状態管理を追加した。評価保存だけではenabledにせず、隔離した評価用stateで明示enableとrouting選択を確認。通常設定への自動導入やWorker起動は行わない。
- 構造化障害と文字列推定を分け、401/403・429・timeout・欠測をローカル注入と実中断で確認。429は実providerへ誘発していない。従量APIの実課金・請求照合は未実施、subscription金額はunknown。比較fixture各1回で性能・品質順位や成功率は出さない。
- 計55ローカル試験と両subscriptionの開発者評価により、前節で残していたP2項目を完了した。本人の日常受入とGitHub CI、P4のbackup/restoreは未確認のまま維持する。[評価記録](model-evaluation.md)と[証拠](evidence/p2-2026-10-25.json)を参照。


## 通常端末起動と基本TUI（2026-10-25）

- 本人から、terminalでbeethovenを起動できる導入とTUIを合わせて対応する指示があった。従来はreadlineの行単位対話だけで、PATHへの登録も未実施だった。この差をP3の実装・受入記録へ明記する。
- 固定Piと同版の`@earendil-works/pi-tui` 1.4.0を直接依存へ追加し、Editor・ScrollView・alternate screenを利用する。別のAgent loop、Worker fleet画面は作らない。通常の対話だけをTUIとし、plain/非TTY/print/JSONを分離する。
- 未設定でも通信なしで案内画面を開く。既存setup wizardを再利用し、宣言保存・送信先許可・login・モデル開始を別操作とする。認証の非表示入力は既存Terminalへ切り替える。初期のpermission・上限を自動で拡大しない。
- ローカルinstallerはNode 24.21.0とこのcheckoutのbuildを固定したランチャーを~/.local/bin/beethovenへ登録した。cwdとXDGを維持し、別commandやsymlinkを上書きしない。実login shellと実PTYの起動・終了を確認した。
- UIは日本語・複数行、streamとtool、status・token/欠測、質問と承認、queue/draft分離、狭幅、Ctrl+C/Dと端末復元をローカル確認した。process probeの一時的なEPERM後に最終ESRCHを確認できても停止未確認が固定される問題も修正し、継続的な拒否では停止未確認を維持する回帰試験を追加した。
- 計61ローカル試験と実PTYの6条件を確認し、今回のモデル要求は0。本人の通常端末・実IMEの受入とGitHub CIは未確認。[操作ガイド](tui.md)を参照。


## 接続手順の短縮と全provider定義（2026-10-25）

- 本人が他のcoding agentを参考に設計し、そのまま実装・ローカル検証まで進めると回答した。追加でPi providersの全接続候補への対応を指示した。OpenCodeの/connectとClaude Codeの初回loginを参考に、初回・/connect・端末connect/対話setupを一つのwizardへ統合した。
- 接続ID・quotaGroup・有限の初期上限は自動設定し、provider/modelは検索pickerで選ぶ。送信先・課金方式・権限・上限を一度に確認してから認証し、許可保存・既定接続設定・入力画面への復帰まで進む。既存credentialの再利用と再認証、詳細設定・非TTY宣言取込を維持する。
- Piの公開builtinProvidersを接続一覧と実行の共通正本にした。固定版の全42定義を列挙、41が対話modelを持つ。分類専用をCoding Agent対応済みと装わない。全アカウント・全modelの実測とは区別する。
- OpenRouter／Radius等のOAuthは従量課金として扱い、空refreshを持つ非refresh型credentialも保持する。cloud authのkeyなしenv/profile/ADCとAzure resource/deploymentを私有storeで扱う。通常APIのambientキーへのfallbackは拒否する。
- OpenRouterのprovider fallbackを最終payloadで無効にし、stream usage.costを料金の報告元とする。0と欠測を区別し、欠測で従量課金の継続を止める。catalogの0料金項目を一律拒否せず、0単価の除算を防ぐ。動的router/latest指定は固定料金の評価外として簡単設定から除外する。
- 接続変更でもSession ID・会話・累計usage・待機入力を引き継ぐ。認証待ちの設定競合と、確認内容の変更を検出する。設定失敗はconfiguredとして再開でき、Task評価・自動Routerのenableは引き続き別とする。
- 全70ローカル試験、実PTYの旧6条件＋簡単設定7条件を確認。今回のproviderモデル要求は0で、新規の実アカウント認証・有料推論・本人受入・GitHub CIは未確認。[設計と公式参考資料](connect-design.md)を参照。


## モデル記録・同一TUIの認証・実Worker基盤（2026-10-25）

- 本人から各実行モデルの明示、connect中の通常terminalへの切替廃止、オーケストレーションとWorker状態の可視化を依頼された。範囲の確認に対し「実Worker起動基盤まで広げる」と回答したため、P4より先にP5の起動部分だけを追加した。P5全体の完了や並列化の承認とは扱わない。
- TUIを初回設定・対話・接続変更・認証で共有し、途中でalternate screenを終了しない。native AuthInteractionをTUIへ接続し、secret/manual code専用overlayで本文の描画・Editor履歴を防ぐ。認証timeout・取消でも入力focusを戻す。
- 実行開始時のconnection/provider/model/auth/billingをTurnへ保存し、結果にも含める。provider応答の報告model/providerも別に記録する。TUIの見出しは各Turn開始時に固定し、接続変更で過去のモデル表示を書き換えない。
- /workerは1つの実Node子processと専用worktreeを起動する。共通SDK/tools/harness・同じrule内容・権限・scopeを引き継ぎ、親Sessionの残予算を予約して精算する。生存・停止未確認・欠測のまま枠を返却しない。候補は保持し、自動commit・統合をしない。
- 状況表示は実際のモデルrequest・tool・harness・interaction・process eventと子process PIDから作る。通常Agentと未起動Workerを区別し、架空のDAGや並列Workerは表示しない。復旧はprocess不在の確認と本人の明示操作でのみ行い、不明usageは全予約を留保する。
- ローカルの実SDK＋scripted provider、実worktree・子process・harnessで実装を確認する。全76ローカル試験と実PTYの16条件が通過し、今回のモデル要求は0。[証拠](evidence/workers-tui-2026-10-25.json)を追加した。新しい実providerのWorker試験と本人受入、GitHub CI、P4/P5/P6残要件は別。詳細は[Workerガイド](workers.md)を参照。


## ロゴを参考にしたTUIデザイン（2026-10-25）

- 本人が提供した20種類のロゴ群を参考に、代表的なdark stacked・light horizontal・gold symbol・monochrome・app iconを確認した。小文字のワードマーク、星、濃紺・アイボリー・ゴールドを端末の文字・罫線・共通color tokenへ反映する。PNG表示機能の有無に依存せず、端末自体の背景やfont設定は変更しない。
- 通常ヘッダーにブランド、model/provider、課金・権限、cwd・短縮Session IDをまとめ、広い画面でtaglineを出す。実行dock・使用量・入力欄を会話と区別し、狭幅では情報量を減らす。会話のモデル記録やWorkerの実状態は維持する。
- 接続pickerと秘密入力を同じ枠で表示し、modal中は背面Editorのfake cursorを出さない。成功・失敗は色だけでなく文字・記号でも伝える。dark/light/mono、NO_COLORを用意し、COLORFGBGの明暗を初期選択へ反映する。
- 関連10試験で暗色・明色・色なし、幅とfocus、日本語・長いpath、秘密入力、palette contrastを確認。実PTYの16条件も両paletteで確認する。有料モデル要求や新規実アカウント認証は行わない。プレビューは実TUI rendererに架空のイベントを渡した描画確認であり、実Workerやモデルの実測記録ではない。


## OpenCodeを参照した会話継続・実行所有権の改善（2026-10-25）

- 本人からモデル送信後に端末へ戻る報告と、anomalyco/opencodeのcoding agent設計を確認して改善する指示があった。devのcommit `0b7f4c416104387deaa6c1184718d9eb7da35d93`を固定して参照した。
- [promptの失敗処理](https://github.com/anomalyco/opencode/blob/0b7f4c416104387deaa6c1184718d9eb7da35d93/packages/tui/src/component/prompt/index.tsx#L1201)、[TUIのresource scope](https://github.com/anomalyco/opencode/blob/0b7f4c416104387deaa6c1184718d9eb7da35d93/packages/tui/src/app.tsx#L245)、[run coordinator](https://github.com/anomalyco/opencode/blob/0b7f4c416104387deaa6c1184718d9eb7da35d93/packages/core/src/session/run-coordinator.ts)、[subagent job](https://github.com/anomalyco/opencode/blob/0b7f4c416104387deaa6c1184718d9eb7da35d93/packages/core/src/session/subagent-job.ts)を確認した。参考はUIと実行の寿命分離、操作のerror boundary、Sessionごとの実行所有権、停止要求とcleanup完了の区別、subagent jobの継続所有。コード・依存を移植せず、既存Pi SDKへこの境界を適用する。
- Turn例外が対話loop全体へ抜け、finallyでTUIを閉じる経路を操作単位の境界へ変更。未知の実行例外は実行保留、明示/resumeで同じSessionへ戻す。自動再送・予算リセット・無確認の接続変更はしない。print/JSON/非TTYの終了契約は維持し、終了理由を安全なmetadataとして記録する。
- 直近の保存metadataではTurnはcompletedだった。旧eventだけでは当時の画面終了要因を一意に確定できない。成功応答の継続と例外時の画面保持を、それぞれ実PTY＋実SDK/scripted providerで試験し、新しい実接続試験とは区別する。
- 監査MGMT-01〜04も修正。子のready/startと初期化時の中断保持、leader終了後のgroup回収継続、一覧paginationと全未精算予約検査の分離、検索の32 file単位yield・規約再検査・結果前の最終gateを追加。fileごとのworkspace/symlink境界は維持する。
- 同じ隔離repoの252小file検索で約3.419秒・規約検査253回から約0.221秒・9回へ変化。最初のtimer処理は約3.419秒後から約85ms後。この端末の単発計測で、provider速度や一般的SLAではない。
- 単一Workerと保守的な欠測留保を維持する。DAG・複数Worker scheduler・質問待ちの永続再開・quota全体管理・worktree保持ポリシーは今回の完了扱いにしない。

- 検証結果: 全83試験、Worker障害回帰8試験、実PTYの既存16条件＋送信後継続3経路が通過。実providerの新規モデル送信は0。[証拠](evidence/opencode-improvements-2026-10-25.json)に参照commit・source hash・計測値と未確認事項を記録した。


## OpenCode全体比較と横断改善（2026-10-25）

- 本人が、個別不具合に留まらずOpenCodeのcoding agent全体を参照して改善するよう指示した。dev commit `8fd2ec1b72bde36ba3835ae974377b32feaa013d`を固定し、TUI・Session coordinator・context/compaction・runner step/max-steps・job/inbox・subagent completion・restartを確認した。
- 比較はUIと実行の分離、コンテキストの余白、有限loop、jobの待機/継続、結果の消費と永続通知。OpenCodeのEffectやHTTP構成を移植せず、既存Pi 1.4.0と認証・課金・rules境界を維持して現行機能を横断改善する。

| 領域 | OpenCodeの参照点 | Beethovenへの反映 |
| --- | --- | --- |
| 実行所有権 | [run coordinator](https://github.com/anomalyco/opencode/blob/8fd2ec1b72bde36ba3835ae974377b32feaa013d/packages/core/src/session/run-coordinator.ts) | UI非依存のSessionController、二重実行と実行中解放の拒否、遅延event遮断 |
| 会話容量 | [context](https://github.com/anomalyco/opencode/blob/8fd2ec1b72bde36ba3835ae974377b32feaa013d/packages/core/src/session/context.ts)・[compaction](https://github.com/anomalyco/opencode/blob/8fd2ec1b72bde36ba3835ae974377b32feaa013d/packages/core/src/session/compaction.ts) | 入出力をcontext window内へ制限、/contextで見積りを提示し、/compactへ誘導。背景の有料要約は追加しない |
| 有限loop | [runner step](https://github.com/anomalyco/opencode/blob/8fd2ec1b72bde36ba3835ae974377b32feaa013d/packages/core/src/session/runner/step.ts) | 既存24 request上限に加え、同一workspace・同一引数の失敗4回で停止。修正後や次Turnは再判定 |
| Worker継続 | [job](https://github.com/anomalyco/opencode/blob/8fd2ec1b72bde36ba3835ae974377b32feaa013d/packages/core/src/job.ts)・[inbox](https://github.com/anomalyco/opencode/blob/8fd2ec1b72bde36ba3835ae974377b32feaa013d/packages/core/src/session/inbox.ts) | 質問を保存してprocessと枠を返し、同じ子Session/worktreeを明示再開。質問ID・所有親・接続・規約照合、差分usage精算 |
| 診断と永続化 | jobの履歴・結果通知 | 更新時刻/生存診断、最新順一覧、bounded log、atomic JSON、送信前取消の未使用枠返却 |

- Workerの予算割当変更だけに由来する同版snapshotの確認は、親が計算したexpectedRulesHashと子のresume-rules keyが完全一致する場合に限って内部で承認する。規約変更をこの経路で自動承認しない。shell等の実操作の承認は従来どおり。未完了requestのusageを0と推測しない。
- 新しい質問待ち再開は本更新のjob.jsonを対象とし、既存候補を削除・自動移行しない。単一Worker、最大24継続、無自動retry、無自動統合を維持する。P4、並列DAG、quota全体管理、候補統合、完全なcrash照合は別要件として残す。

- 検証は全90試験、実PTYの既存16条件＋対話4経路が通過。実SDKと実process/worktreeにscripted providerを組み合わせ、新規の実モデル送信は0。[参照commit・source hash・検証記録](evidence/opencode-whole-2026-10-25.json)を追加した。


## 会話保存と入力履歴（2026-10-25）

- 本人の「会話履歴を保存し、前に入力したpromptを再実行したい」という依頼で実装。既存SQLite schema 2とPi archiveを再利用し、DB migrationと新しい依存追加は行わない。
- prompt_submitted eventをTurn開始前に保存し、inputIdでTurnと対応付ける。旧Turnも検索し、同一入力の二重表示を防ぐ。同じ文章を繰り返し送った事実は別履歴として保持する。
- ↑/↓、Ctrl+R、/history、/sessionsをTUIに追加。呼出しは編集欄へ戻すだけで自動再送しない。通常は正規化したcwdで絞り込み、別workspaceの検索は--allの明示操作とする。
- Session切替は現在SDKの停止・解放後に保存Sessionを開く。接続、規約、scope、usageと既存の再開確認を維持し、別directoryへ自動移動しない。CLIのhistoryとsessions showはreadonlyで認証・送信を行わない。
- 復元するのはユーザー依頼と公開応答、記録されたprovider/model。旧archiveは親IDを追った現在branchを参照し、保存Turnのworkspace注記を照合してthinkingとtool内部情報を除外する。原本を書換えず、通常file・path境界・読込サイズを検査する。
- 履歴表示には上限を置き、原本を保持する。認証専用入力・承認回答をprompt履歴へ保存しない。入力本文自体はローカル平文保存。保存範囲と操作は[tui.md](tui.md)を参照。
- 全94試験と既存16条件＋対話4経路、再起動履歴1経路を実SDK/scripted provider・実PTYで確認。実providerの新規要求は0。P4 backup/restore、実IME操作と本人の日常利用受入は今回の完了対象に含めない。[証拠](evidence/conversation-history-2026-10-25.json)。


## P4〜P8と複数セッション可視化（2026-10-25、0.2.0）

本人がP8までの実装を指示し、private `mine2424/beethoven`の作成を指定した。追加でnodetermのように複数の稼働Sessionを可視化する依頼があった。開発用repoを作成し、実装・ローカル/CI・実モデル・本人受入を分けて進める。backup用repoは別途確認中で、未承認の送信先を作成/使用しない。今回の実モデル枠は後述の上限で承認・実施済み。

- runtimeは採用済みPi 1.4.0 SDKを実Node子processへ埋め込む。ControllerとのIPCはready/start・event・停止の所有に使い、Pi RPCを実装したと装わない。bundled RPC評価の証拠はP2を保持する。
- SQLite schema 3へRun/command/reservationを追加。version付きCommandの重複排除・epoch・effect・quota/path/resource予約をtransactionで保存する。Session/Runの所有権をGit common directory単位にし、別repoのSessionは同時実行可能にする。
- ready Taskをwaveで並列実行し、Task packetに依存の公開応答とbase SHAを記録。候補を専用worktreeへ直列統合し、独立harness・現在SHAのoperator受入を結び付ける。元cwdへ自動適用しない。Explorer/Reviewerは明示Taskだけをread-onlyにする。
- 自然言語からpropose_plan、または/orchestrateで計画を提案する。モデルが提案後もtoolを続けたりworkspaceを変えた場合は実行へ進めない。validated proposalの明示的な終了だけは、通常の未完了toolUseと分けてsettledと扱う。提案だけで実装verifyを成功扱いしない。
- 対話委譲は親のPolicy snapshot・接続・scope・権限・plan-onlyと残予算を引き継ぎ、実行後の増分を親へ精算する。unknown tokenを確定使用へ混ぜず、留保として保持する。待機中の時間を新しいmodel requestの消費へ自動加算しない。
- 強制終了時も起動/候補commit/統合を照合し、判定不能なeffectと予約を保持する。親がimport中に消えた場合のdisconnect取り逃しを防ぐため、子はIPCの現在状態も検査する。
- backupはNode標準のRSA 3072/OAEP-SHA256とAES-256-GCMで暗号化し、SQLite Backup APIとGit bundleを使う。50MiB暗号文/256MiB展開内容。除外・不足・symlinkを明示し、原本なしの別領域restore、path/hash/DB、旧PID/承認無効化を確認する。鍵の別保管は本人受入条件。
- GitHub inputは全page/cursorを揃え、partialをcompleteにしない。publishとprivate backupの送信capabilityは別。remote ref・Draft PR・blob hash・正しいheadの必須CI名を照合し、通信断後に二重作成しない。
- 更新はimmutable stageを先に構築・smoke/hash確認し、全Session/Run停止後にlauncherを切り替える。専用npm cacheで既存cacheの所有権を変更しない。rollbackはDB互換性を検査して旧launcherを戻し、DBを巻き戻さない。開発checkoutを直接参照する旧local launcherは、そのcheckoutを後で編集した場合の旧binary保存を保証しない。
- /monitor・Ctrl+O・beethoven monitorでSession/Run/Task/Workerのカード・依存・モデル・PID/heartbeatを表示する。nodetermのノード型表示を参考にし、無限canvasや任意terminal attach、tmux永続化とは分ける。Workerの応答はTaskごとのモデル見出しに分け、認証/質問時はmonitorを閉じてfreshな回答を受け取る。

[運用と確認範囲](operations.md)を参照。完了チェックを更新する場合も、本人の日常利用と実IME、今回の実モデル、private backupの実送信・別保管、実GitHub CI/publishの証拠を区別する。未実施の受入をチェックだけで完了にしない。

- 複数repoの対話化に合わせ、対話model・手動Worker・Run Taskの共有quota/全体4枠を原子的に判定する。native requestの送信前にpending requestと留保見積りを保存し、crash後のresumeではunknownを一度だけ引き継ぐ。staleなmodel枠はPID不在確認後の明示recoverだけで解放する。
- 固定planに明示して利用者が確認する接続は、allowedConnectionsに含まれる登録接続を使用する。自動Routerのenabled限定は維持し、未評価接続を自動選択する機能は追加しない。

## プロジェクト間の再利用資産（2026-10-25）

本人は資産検索・転用の仕組みを追加要求し、初期登録対象には「nothing」と回答した。実repoを探索・登録せず、Git fixtureで検証する。常駐の別モデルではなくMain/Workerのasset_search・asset_read toolを採用し、許可した接続にだけcommit固定の出典付き抜粋を渡す。sourceの明示登録と削除はCLIの本人操作だけにする。初期実装は上限付きの語句・定義検索とし、意味検索や自動package化は後続とする。

P8の今回の実モデル枠はCodex subscription/gpt-6.1-sol、合計20,000 token・各試験3分・1並列・自動再試行なしで承認済み。実際のfixture修正と独立3テスト、元pathなしの暗号化復元後の同一会話再開まで、計5要求・6,683 tokenで確認した。復元試験で判明したmacOS path aliasを修正した。GitHub Actionsは課金制限で開始できず、backup専用repoは未承認のため作成・送信していない。日常利用の本人受入を自動化試験で代替しない。

## Remote backupの承認とCI受入条件の変更（2026-10-25）

本人がmine2424/beethoven-backupのprivate作成・利用を承認した。実repoへの暗号文送信・再送・取得・restoreをP8試験archiveで確認。CIの問題は本人指示で今回の受入を妨げないが、CI判定自体を成功へ変更せず、失敗履歴を保持する。普段使いの全snapshot、鍵の別保管、本人の実操作は別条件。Apple Passwordsによる保管が候補だが、簡単な方法を再検討中。直接iCloud Keychain試作は署名権限不足（-34018）で不採用とし、現行CLIには追加しない。

## ローカルキーチェーン＋復旧コードの採用（2026-10-25、0.2.1）

本人が「Mac内は自動管理＋復旧コードをApple『パスワード』に保存」を選択した。署名権限不足の直接iCloudキーチェーン同期は採用せず、ローカルlogin keychainの固定service/accountへRSA鍵とコードを保存する。helperは秘密値をargvに取らず、pipeで受け渡し、既存itemの更新・削除・広いACL許可を実装しない。codeは128bitランダムで、scrypt（固定N/r/p、salt16B）とAES-256-GCM（IV12B、fingerprintをAAD）による暗号化復旧鍵をprivate repoへ保管する。codeは本人のterminalで明示的にclipboardへコピーし、本人がApple『パスワード』に保存する。コードと鍵の平文fileを作らない。

普段使いstateの8,913,127 byte暗号文を実repoへ送信・再取得し、既存ローカル鍵によるrestoreと、remote暗号化復旧鍵＋local codeによるrestoreを確認。後者は秘密鍵itemを読まずに復元した。本人はコード保管・日常利用を「これから操作する」と回答しており、端末外取り出し・本人受入は完了へ変更しない。
