# 公開事例を踏まえたPi + Ponytail構成

## PlannotatorのPi導入（2026-11-17）

- [公式README](https://github.com/backnotprop/plannotator) と [Pi連携README](https://github.com/backnotprop/plannotator/tree/main/apps/pi-extension) を確認。Piはnpm Extensionだけで導入でき、汎用インストーラーは不要。
- npm配布物 `@plannotator/pi-extension@0.28.66` のmanifest、同梱README、index.tsの登録・セッション開始・終了処理、runtime-tls.tsを確認。Pi >=0.79.1、NodeのTLS修正推奨下限24.22.1を採用した。
- 本体UIを同梱し、コマンド・`--plan`・計画提出ツールを追加する。Planモードを有効にしない限り、通常のpstack運用を続けられる。固定モデルや独自のphase設定は追加しない。
- Planモードのbashは完全に制限されないためsandboxと扱わない。remoteモードの全interface待受にも注意する。
- Piのパッケージ管理は既存設定をマージする標準 `pi install` を使う。ローカルで未固定版から固定版への更新を確認した。
- 全依存・全ネットワーク経路・UIのセキュリティ監査はしていない。Inbox、共有、外部AIの利用は導入に含めない。

## v2: pstackを主軸にする（2026-11-16）

[Ubieの記事（2026-11-12）](https://zenn.dev/ubie_dev/articles/45501469c9c044)は、
固定のPlan→Build→Verifyから、Playbookを手掛かりにエージェントが進め方を判断する方式への移行と、
セッションの失敗・人間の修正から改善PRを作るOuter Loopを説明する。
今回は前者を採用し、後者の定期実行は次段階にする。Remocoのクラウド・アクセス制御基盤を再現したものではない。

| 一次資料 | 確認・採用した内容 |
| --- | --- |
| [Cursor公式pstack](https://github.com/cursor/plugins/tree/main/pstack) | poteto-modeと専門Skill・Playbook・Principleの分離という構成 |
| [Pi移植版 @zenspc/pi-pstack](https://github.com/zenspc/pi-extensions/tree/master/packages/pi-pstack) | npm 0.9.0の配布物を取得。package.json、Extension本体とconfig、poteto-mode、Pi委譲手順、同梱agent定義を確認 |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | npm名が `pi-subagents` の配布元。0.88.1のmanifest、ランタイム登録・起動フック、権限・agent発見・モデル/設定のドキュメントを確認 |
| [Ponytail 固定版](https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156) | pi-extensionのbefore_agent_startがsystemPrompt全体を返すことを確認。v2では旧Extensionを無効化し、Skillsだけを併用 |
| [Recruit「レビューは AI が書いて、人が選ぶ」](https://techblog.recruit.co.jp/article-8036/) | 公開記事の検索抜粋で確認できた候補選択の考え方を `/review` に反映。記事全文は取得できておらず、公式Skillの完全移植とは扱わない |

### 構成上の判断

- オーケストレーターはpstack、最小実装の助言はPonytail。New / Change / Fixは3つの短いローカルSkillで補完する。
- 共有制約はPRINCIPLES.mdに置き、AGENTSと各Skillから参照する。pstackの一般的な自律実行文言が公開や本番操作の許可を増やさないよう明示する。
- モデル割当はローカルのmodels.json。未指定は親モデル継承。複数Providerの課金は自動で増やさない。
- Ponytailの旧フックはPi 1.5.2のforceSystemPromptを使う経路に入り、後続Extensionの構造化指示と競合しうる。読込順へ依存させずフィルターで無効化する。
- 同梱comment-sickoはread-onlyを指示するがbashも持つ。ツール制限をOSサンドボックスとは扱わず、子の範囲・権限・成果を親が確認する。
- pstackのwatch-prにはBun、statechartのライブ検証には追加ツールが必要。初期導入だけですべての任意機能が利用可能とは扱わず、必要になった時に要件を確認する。
- 旧 `/work` は互換入口として残し、固定の工程は取り除いた。`/plan` と `/review` の編集しない制約は、その明示的な依頼にだけ適用する。

### ソース確認の範囲と検証

固定版の直接パッケージにインストール時のlifecycle scriptは宣言されていないことを確認した。
ただし、pi-subagentsは依存パッケージと実行コードを含む。全依存・全分岐のセキュリティ監査を実施したものではない。
npmの名前と作者・repositoryを照合して同名の別実装を取り違えないようにした。

`check-pi.py --smoke` は一時設定で実際のPi RPCとSDKを起動する。
スクリプト化したモデルを使い、指示合成、subagentツールでのagent一覧取得、Poteto Mode解除を検証する。
これはPlaybookを判断するLLMの品質や、実モデルでの委譲成功を証明しない。
結果はversions.mdに記録する。

## v1の調査・判断（履歴）

以下の「subagent等を後で追加」という判断はv2では上の構成へ更新した。

確認日: 2026-11-16。公開者自身のREADME・実装と、導入版に同梱された公式ドキュメントを確認した。
各人が公開している構成の参考例であり、利用者全体の傾向や生産性向上を証明する調査ではない。

## 参考にした事例

| 一次資料 | 確認した使い方 | 今回の判断 |
| --- | --- | --- |
| [Armin Ronacher / agent-stuff](https://github.com/mitsuhiko/agent-stuff)・[/discuss](https://github.com/mitsuhiko/agent-stuff/blob/main/commands/discuss.md) | 個人用のPrompt・Skill・Extensionをプロジェクト横断で利用。計画の入口はコード調査から入り、実装しない指示を持つ | 調査から始める `/plan` と、実装の `/work` を分ける。今回は自作の短い日本語Promptで実装 |
| [Abhinand / pi-setup](https://github.com/abhinand5/pi-setup) | 設定を別PCで復元し、ドライラン・バックアップ・スモークテストを用意。個人モデルは設定例から除外 | 設定の再現性と診断を採用。既存ファイルの保持を継続し、モデル・認証はPCごとに設定 |
| [Mario Zechner / pi-skills](https://github.com/badlogic/pi-skills) | 検索やブラウザー等を用途ごとのSkillとして提供。追加のNode依存やChrome、APIキーを要するものがある | 必要時に用途別に選ぶ。全Skillの一括導入は行わない |
| [Dietrich Gebert / Ponytail 固定版](https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156) | Pi用のモード切替と複雑さレビュー。READMEは検証・エラー処理等を省かない方針を説明 | `full`を基本に活用し、バグ・回帰を探す `/review` を補完として追加 |

参照先のmainブランチは変わりうる。コードやSkill本文をコピーしたものではなく、目的を参考に独自構成を作成した。
Ponytail作者のベンチマーク数値は、この環境で再現していないため採用の効果指標には使わない。

## 構成

1. miseでNodeを管理し、Pi版とPonytail SHAを固定する。
2. 個人原則は短いグローバルAGENTS、Repoの構成と検証は各RepoのAGENTSに置く。
3. `/plan` → `/work` → `/review` → `/ponytail-review` → `/handoff` を必要な場面で使う。
4. 再開・履歴分岐・圧縮はPi標準のセッション機能を使う。
5. 新しいPC・更新後は `check-pi.py --smoke` で、版と実際の読込を確認する。

標準機能の仕様は[Pi公式ソース](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs)に加え、
この環境のPi 1.5.2に同梱された `prompt-templates.md`、`settings.md`、`sessions.md`、`rpc-commands.md` を確認した。
Pi 1.5.2は今回の確認時にすでに導入されていた版で、最新との断定はしない。
実際のリソース読込を検証し、dotfilesの固定版を1.5.2へ合わせた。初期導入0.86.1の記録はversions.mdに残す。

## 追加候補の扱い

| 候補 | 追加を判断する条件 |
| --- | --- |
| 検索・ブラウザーSkill | 普段調査するサイト、検索の認証方法、Chromeの有無が決まること。例: pi-skillsのbrave-search / browser-tools |
| subagent | 独立して切り出せる調査が繰り返し発生し、追加使用量と変更の競合を管理できること |
| todo・goal Extension | 標準セッションとhandoffでは作業の取りこぼしが生じること |
| 差分UI・通知 | 普段使うターミナル・OSで必要性を確認すること。公開事例のOS固有設定はそのまま持ち込まない |

今回の受入は「別PCに再現できる」「既存の個人設定を保持する」「日々の作業の入口がある」
「モデル接続なしでも導入とリソース読込を検証できる」。モデル回答の品質と実開発での効果は、各PCで実タスクを使って確認する。
