# 接続設定を短くする設計と実装

更新日: 2026-10-25

## 参考にした操作

OpenCodeは`/connect`へ接続追加を集約し、認証後にモデルを選択できる。[公式Providers](https://opencode.ai/docs/providers/)。Claude Codeは初回ログインを入口にし、通常利用の前に内部ID等を手入力させない。[公式初日ガイド](https://support.claude.com/en/articles/14552382-your-first-day-in-claude-code)。OpenRouterはAPIキーに加えてブラウザのPKCE認証も提供する。[公式OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth)。

Beethovenではこれらを参考に、接続・モデル・確認の流れを一つのwizardへまとめた。認証とモデル要求は別の内部処理として維持する。モデル選択を認証前に置き、送信先・課金・上限を確認してから認証を開始できる。

## 利用者の操作

```text
beethoven
  → 接続先を検索して選択
  → モデルを検索して選択
  → 接続内容を確認し「接続して入力画面へ」
  → ブラウザ認証／APIキー・必要な接続情報の入力
  → そのまま依頼を入力
```

初回はpickerを自動で開く。後からは`/connect`、端末からは`beethoven connect`または対話の`beethoven setup`で同じwizardを使う。接続ID・credentialRef・quotaGroupは自動設定し、上限は有限の既定値を表示する。必要な場合だけ「上限を変更する」を開く。APIキーと課金方式を同一視せず、サブスク／契約枠とAPI従量課金を選択肢に明記する。

成功時に送信許可と既定接続を保存するため、別の`/allow`・`/login`・`/start`は不要。同じ接続の自分の認証があれば再利用し、「再認証して接続する」も選べる。旧commandは互換用、詳細な宣言編集は`/advanced`へ残す。`setup --from ...`による非TTY取込は従来通り宣言の検査・保存だけを行う。

## providerの範囲

Pi AI 1.4.0の公開`providers/all`の`builtinProviders()`を接続一覧と実行の共通正本にした。特定4社の手書き列挙を廃止し、全42定義を列挙する。41に対話モデルがあり、TypeSafeは分類専用で対話モデルがない。分類専用をCoding Agentの対話接続として成功扱いせず、用途の違いを表示する。helpers・modelデータ・faux試験providerは外部接続サービスに数えない。

モデルは採用版のローカルcatalogを表示し、設定だけでcatalog更新や有料疎通を実行しない。catalog掲載と実際の利用権・tool対応・実接続成功を区別する。OpenRouterの自動router／動的latest指定は、固定料金に基づく予算を評価できないため簡単設定から除外する。

| 接続方式 | 設定方法と注意 |
| --- | --- |
| subscription OAuth | Piの`isSubscription`定義に基づきサブスクとして表示。ブラウザの本人認証へ進む |
| 従量OAuth | OpenRouterやRadius等。OAuthでも従量課金と表示し、正の金額上限を要求 |
| 通常のAPIキー | 非表示のローカル入力。宣言・会話表示・引数にキーを含めない |
| APIキーによるCoding Plan | Kimi・Qwen Token Plan等の契約枠を通常の従量APIから分ける |
| AWS／GCP | Pi nativeのprofile・credential chain・ADC・service accountの選択とprovider-scoped envを保持。外部CLIやcloud側の準備が必要な方式を省略しない |
| Azure | キーに加えてresource／deploymentを取得し、modelとの対応を私有credential envへ保存。既存キーでモデルを追加する際は不足するdeploymentだけを補う |
| Cloudflareなど | Pi nativeの認証手順を使い、account／gateway等の補助情報も同じCredentialStoreへ保存 |

全providerの実アカウント認証や推論を確認したわけではない。共通の列挙・宣言・native adapter選択、credential形状とローカル契約を確認した範囲として記録する。既存のCodex/Claude実測を他providerの実測へ流用しない。

## 許可と取消

最終確認に接続・model・課金方式・現在の権限・上限と、次の入力から依頼／規約／読取内容を送ることを表示する。内部操作が複数であることを利用者の複数commandへ転嫁しない。

確認前の取消では保存・認証を行わない。確認後に認証が失敗した場合はconfigured宣言を残して再開可能にし、送信許可を新規追加しない。認証だけをsmoke／Task評価済みとはしない。評価用Routerのenabledは引き続き別の実評価を必要とする。

認証待ちの間の設定変更はhash照合で拒否する。まとめて確認した内容をcwd・接続宣言・規約の出所/hash・実効権限・上限へ結び、内容が同じ場合だけ開始時の重複確認を省く。変わっていれば確認を取り直す。repoによる送信先や権限の縮小はそのまま適用する。profileと許可fileの保存途中で失敗しても、未認証の新規接続を自動利用しない。

APIキー・OAuthコードは非表示入力を使う。通常APIでは選択した自分のCredentialStoreがなければambient APIキーへfallbackしない。AWS／GCPの外部資格情報は本人がnative認証手順で選択した方式に限る。既存アプリの認証をコピーしない。

## 会話途中の接続追加

入力の安全な境界でSDKを閉じてlockを解放し、接続wizardを開く。登録後は同じSession IDを再開し、以前の使用量と規約を引き継ぐ。入力待機列と編集中のdraftも保持する。接続変更を理由に予算・履歴をリセットしない。

## OpenRouterの実行

OpenRouterは従量課金として扱う。SDKへ渡す最終payloadで`allow_fallbacks=false`、`require_parameters=true`を指定する。上流providerの許可範囲はOpenRouterアカウント側の設定にも従い、特定上流providerへの固定を実装済みとは扱わない。[公式provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)。

tokenは従来の確定応答から集計する。費用はOpenRouter streamの`usage.cost`を保持し、Pi catalogによる推計を実請求額として代用しない。0の確定費用は0として認め、欠測はnullのまま従量課金の継続を止める。[公式usage accounting](https://github.com/OpenRouterTeam/docs/blob/main/cookbook/administration/usage-accounting.mdx)。

価格が0のcache項目や無料モデルを一律拒否せず、出力単価0で除算しない。送信前の入力費用留保にはinput/cacheの大きい単価を使う。アプリの予算は推定に基づく実行制御であり、提供元のキー制限・請求照合の代替にはしない。

今回の実装は通常のSDK対話経路を対象とする。既存のRPC評価runnerはsubscription向けで、全provider・従量APIのRPC実測まで済んだとは扱わない。

## 検証

ローカル試験では全42定義との一致、全対話providerの宣言・adapter選択、OpenRouter OAuthの従量扱い、空refresh、cloud env、Azure metadata、取消・認証失敗・再利用・予算・課金欠測・fallback拒否を確認する。実PTYでは接続検索・model検索・単一確認・重複allow/startなしのSession開始・接続変更後の待機入力維持を確認し、provider_requestが0でSession数が1のままであることをDBで照合する。

新たなproviderの実アカウント認証と有料推論、全モデルの利用可能性、本人受入、GitHub CIは未確認。provider別の受入は接続・model・上限・fixtureを選んで別途実施する。
