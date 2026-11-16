# Beethoven

0.2.1では、Macのキーチェーンによる鍵の自動管理と、Apple「パスワード」に保存する復旧コードを追加しました。初回は`beethoven backup setup --repo mine2424/beethoven-backup --yes`、続いて`beethoven backup recovery --copy`でコードを保管します。[簡単設定と復旧](docs/operations.md#鍵ファイルを扱わない簡単設定macos021)を参照してください。

この端末では `beethoven` で起動できます。対話はTUI、初回は接続先とモデルを検索し、確認・認証するとそのまま入力できます。後からの追加は `/connect`。各Turnのモデルと実行段階を表示し、`/worker <依頼>`で実Workerを専用worktreeへ起動できます（[対応範囲](docs/workers.md)）。[起動・TUI操作ガイド](docs/tui.md)を参照してください。

Pi 1.4.0を使うTypeScriptのCoding Agentです。対話・会話履歴に加え、計画の提案、DAG・最大4 Worker、候補検証と専用worktreeへの直列統合、セッションマップ、暗号化backup/restore、GitHub Draft PR/CI照合、段階的な更新・rollbackを実装しています。

通常の対話からWorkerへの委譲を依頼するか、`/orchestrate <依頼>`を使い、実行する計画と上限を確認します。**Ctrl+O**または`/monitor`で複数Session・Run・Workerの稼働状況を確認できます。詳しくは[運用・復元ガイド](docs/operations.md)を参照してください。

他プロジェクトの関数・型を再利用する`assets`検索を追加しました。初期登録は0件で、本人がrepoと抜粋送信を許可する接続を登録してから使います。[資産の登録と利用](docs/operations.md#他プロジェクトの資産を再利用する)を参照してください。

P4〜P8の機能を実装し、受入確認を進めています。ローカルのscripted SDK/Git試験、実モデルと本人の日常利用受入は分けて記録します。過去の実モデル評価は[P2](docs/model-evaluation.md)・[P3](docs/p3-acceptance.md)、現在の残条件は[milestone](milestone.md)を参照してください。host実行はOS sandboxではありません。

- [マイルストーン](milestone.md): 実装順序、残作業、判断待ち・受入条件
- [開発・ローカル確認](docs/development.md): 導入、ビルド、診断、実装ファイルの役割
- [開発判断](docs/decisions.md): 確認済みの方針とP1の技術選択
- [基本設計書](docs/design.md): 対話Coding Agentの要件、並列開発、認証、バックアップ、実装順序・受入条件・要件対応表
- [Orchestrator詳細設計](docs/orchestrator.md): 制御ループ、LLMとの責務、dispatch、停止・復旧、質問・承認・再計画
- [共通基盤設計](docs/components.md): 設定、コンテキスト、ツール、永続化、イベント、外部連携、導入・診断
- [ルール・ハーネス設計](docs/rules-harness.md): 開発全体とproject/repoの規約、必須check、適用・信頼・更新・復元
- [初回設定設計](docs/setup.md): 利用者ごとの複数接続、認証・課金方式、既定model、設定と疎通の分離
- [接続の簡単設定](docs/connect-design.md): 他のcoding agentを参考にした導線、全providerの対応範囲
- [モデル評価記録](docs/model-evaluation.md): SDK/RPC adapterのローカル契約試験、実接続前の残作業
- [P3受入記録](docs/p3-acceptance.md): 実装・ローカル試験・実モデル・本人受入の区別と操作手順

構想中の仮称`forge`を、このディレクトリでは`beethoven`に統一しています。設計書のコマンド例には未実装のものを含みます。現在利用できる操作は開発手順を参照してください。

## ローカル検証（Lefthook）

GitHub ActionsのCIは削除し、push前にローカルで検証する方針です。
依存は初回に `beethoven/` で `mise exec node@24.21.0 -- npm ci --ignore-scripts` で用意します。
リポジトリルートで `bash scripts/setup-hooks.sh` を実行すると、関連変更のpush前に
型検査・テスト・一時ランチャーでのPTY検証が動きます。手動実行は `bash scripts/check-beethoven-local.sh`。
フックは依存をダウンロードせず、不足時はセットアップ方法を示して終了します。
