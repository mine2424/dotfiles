# 利用者ごとの初回設定・モデル接続

更新日: 2026-10-25 / 状態: 初回設定・loginを実装。Codex/Claude subscriptionのSDK・RPC評価と状態管理を確認

## 現在の簡単設定

初回起動と`/connect`、`beethoven connect`、対話の`beethoven setup`に設定を統合した。接続先とモデルを検索して選び、まとめて確認して認証すると入力画面へ進む。ID等は自動設定し、上限は必要な場合だけ変更する。Pi 1.4.0の全42provider定義を列挙し、41の対話候補と分類専用を区別する。[新しい設計と検証範囲](connect-design.md)を現在の正本とする。

以下は初期設計と導入経緯。宣言取込・評価状態等の境界は維持し、利用者の手順は上記へまとめた。

## 1. 確定した方針

**利用する接続・認証・モデルは、利用者が初回設定で選ぶ。特定ユーザーの契約や特定モデルを製品の固定値にしない。** 複数接続を登録し、普段使う接続を1つ選べるようにする。既存利用者も設定を再実行して追加・変更できる。

今回の本人の利用予定はCodex・Claude・Kimiのサブスクリプション。本人用の評価プロファイルとして記録し、他の利用者への既定選択やAPI契約の必須条件にはしない。3接続のうち最初に動作確認する順序と、実際に使うモデルは設定時に決める。

## 2. 初回フロー

`beethoven setup`を明示的な設定入口とする。端末での接続宣言の追加・変更・削除・保存・取消に対応する。未設定の`beethoven`起動はsetupへの案内を返す。P3では認証を別操作の`beethoven login --connection ID`へ接続した。

1. **接続先を選択:** Codex、Claude、Kimi等から利用するものを複数選ぶ。未契約の接続を追加する必要はない。
2. **認証・契約を選択:** 各providerが対応するログイン方式と、サブスクリプション枠/API従量課金の違いを表示する。認証方式と課金方式は別に保存する。
3. **認証する:** 対応するPiのブラウザー/device flowやsecret入力を使う。既存アプリのcredentialを自動コピーしない。チャットへ秘密値を貼らせない。
4. **モデルを選択:** その接続で確認できるmodelから選ぶ。provider名だけで全modelの利用可能性を保証しない。catalogの更新で固定modelを黙って変更しない。
5. **既定接続・上限を選択:** 普段使う接続、token・時間・試行数・並列数、APIの場合の金額上限を設定する。全接続を登録しても自動の競争実行は有効にしない。
6. **保存前に確認:** 接続、auth method、billing kind、model、上限、設定差分を表示する。subscriptionから従量APIへのfallbackは既定で無効とする。
7. **疎通は別操作:** ローカル保存と認証成功をモデル応答の確認と分ける。送信内容・接続・上限を表示し、本人の指示後に最小の試験を行う。setup完了だけで有料promptを送らない。

キャンセル時は未完了の接続をenabledにしない。途中までの選択と認証状態を区別し、再開可能にする。非TTY/CIではwizardを開始せず、指定した宣言設定を検査し、不足時は具体的な前提待ちを返す。キーやtokenをコマンド引数へ書かせない。

現在の実装では下書きは保存確定までメモリーに置き、取消・Ctrl-C・EOFで破棄する。保存済みの設定は次回setupで編集できる。中断した未保存下書きの復元と、途中まで済んだ認証の再開は後続実装。

## 3. 認証経路の確認状況

導入済みPi 1.4.0のprovider定義を静的に確認した。credentialの読込やlogin、network疎通は実行していない。

| 利用者が選ぶ名称 | Piでの評価候補 | 確認内容と残作業 |
| --- | --- | --- |
| Codexのサブスクリプション | `openai`のChatGPT subscription経路、互換候補`openai-codex` | 同版は前者にOAuth定義、後者にlegacy表記がある。本人の契約・model・SDK/RPCで確認して経路を確定 |
| Claudeのサブスクリプション | `anthropic` | Claude Pro/Max用のsubscription OAuth定義を確認。実認証と利用可能modelは未確認 |
| Kimiのサブスクリプション | `kimi-coding` | Kimi Codeのsubscription OAuth定義を確認。通常のMoonshot API接続と区別して評価 |

これはPiに実装経路があるという確認であり、本人の契約で動くことや提供元の利用条件の確認を代替しない。一般ユーザーには採用版で対応した方式だけを提示し、非対応時に別課金へ切り替えて成功にしない。

確認したローカル資料は`@earendil-works/pi-ai/dist/providers/{openai,openai-codex,anthropic,kimi-coding}.js`と同梱OAuth実装。認証方式の案内は[Pi公式Providers](https://pi.dev/docs/latest/providers)も参照する。

## 4. 保存する情報

非機密の接続宣言は個人設定rootの`connections.json`を配置候補とする。既存の`config.json`とは役割を分け、repoが本人の接続・既定modelを勝手に登録しないようにする。

P2の初回設定では上記配置を実装し、秘密を含まない`connections.example.json`を用意した。schemaVersion=1、allowFallback=false、各接続のstatus=configuredを固定する。保存時のhash照合とrenameにより、設定画面を開いてからの別setupや手編集との競合を検出する。OS外の同時編集すべてを排他するものではない。

- 接続ID、表示名、provider/model、既定接続ID。
- `auth.method`（OAuth/API key等）、credentialの保管先参照。
- `billing.kind`（subscription/metered）、quotaGroup、token/時間/試行/並列上限。
- 接続の設定・認証・疎通・Task評価の状態、Pi版、確認日。

API keyによる認証でもCoding Plan等の契約枠を使う場合があるため、API key＝従量課金とは推定しない。OAuthもそれだけでは契約・modelの利用権を保証しない。subscriptionのタスク単位金額が不明ならunknownとし、0円の実測値にしない。

実token/鍵はPiの公開CredentialStore契約で扱い、本人専用の`auth/<接続ID>/credentials.json`へ0600で管理する。宣言・logs・snapshot・Git・通常backupへ含めない。複数接続が同じ契約を使う場合はquotaGroupを共有する。新規設定・追加・変更時には`allowedConnections`との対応も本人へ示し、既存の送信先制約を黙って広げない。

## 5. 実装順序と受入

P2で接続宣言schema、provider/auth対応表、秘密を含めない設定例、選択・保存・キャンセルを先に実装した。P3でloginとSDKの対話・単発実行を追加。実認証と疎通は明示した本人の操作と上限に従う。setupの処理を二重実装しない。

### 現在の確認結果

- Pi AI 1.4.0の公開provider exportから、Codex/OpenAI・Claude・Kimi Codeのローカルcatalogを読む。credential取得・OAuth・catalog更新通信は呼ばない。
- 対話の複数選択・既定接続・上限・保存、変更・削除・取消、利用者の保存先分離を試験した。
- 非TTYは`--from <file>`で検査し、保存には`--yes`が必要。入力や保存指示がなければ終了code 3のblockedを返す。
- 設定破損・秘密値の未知項目・認証済みを装うstatus・未対応model・競合を拒否する。保存済みの旧modelは読取可能にし、現catalogのmodelへ変更できる。
- 実際のPTYでsubscription接続の選択と保存、Ctrl-C時の取消を確認した。本人の設定先は使わず一時領域で試験した。
- 型検査と計22テストが成功。認証・送信許可・model利用可否は未確認で、setupの結果とdoctorへ明示する。

- 利用者AとBの接続・既定modelが分離し、固定の個人プロファイルを強制しない。
- 1接続だけでも開始でき、後から複数接続を追加・変更できる。
- auth methodとbilling kindが別に保存され、subscription失敗から従量APIへ無断で移行しない。
- setupのローカル保存試験と、実認証・モデル応答・Task評価を区別する。
- キャンセル・期限切れ・部分設定・非TTYでも秘密値を出力せず、未確認接続をenabledにしない。
- 本人の3接続は、実認証と利用modelが確認できるまで「利用予定」として扱う。


## P2評価後の状態管理

上記22テストはsetup単独の履歴。現在はCodexと、本人が比較用に選んだClaudeの専用login・実モデル評価も完了した。Kimiは引き続き利用予定で、認証・利用可能とはしない。

接続宣言はconfiguredのまま保存し、実評価はstate内の証拠付き記録へ分離する。`beethoven connections --json`で現在の評価状態、`beethoven routing check --json`で個人設定のrouting.jsonを読取診断する。Task評価済み接続だけを`connections enable --connection ID --yes`で有効化する。自動選択にはさらにallowedConnectionsへの許可が必要。宣言やPi版が変われば評価は失効する。[評価記録](model-evaluation.md)を参照。
