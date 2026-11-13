現在の運用・P4〜P8の追加実装は[operations.md](operations.md)を参照。以下のP3評価数は当時の記録。

# 開発・ローカル確認

P3の対話Coding Agentを実装し、全70ローカル試験とCodex・Claude subscriptionのSDK/bundled RPC実モデルによる開発者評価を完了した。[P2評価記録](model-evaluation.md)と[P3受入記録](p3-acceptance.md)を現在の確認入口とする。本人の通常操作による受入とGitHub CIは未確認。

## 導入と確認

`beethoven/`を作業ディレクトリとし、Node 24.21.0を使う。

```bash
mise exec node@24.21.0 -- npm ci --ignore-scripts
mise exec node@24.21.0 -- npm run typecheck
mise exec node@24.21.0 -- npm test
mise exec node@24.21.0 -- node dist/src/cli.js --help
mise exec node@24.21.0 -- node dist/src/cli.js doctor --json
```

npm cacheの所有権エラーが出る環境では、導入コマンドへ`--cache /tmp/beethoven-npm-cache`を追加できる。既存cacheを変更する必要はない。依存のinstall scriptは実行しない。Piのnative機能を実際に使えるかはP2で別途確認する。

`doctor`はnetwork呼出し、モデル実行、認証情報の取得、state作成を行わない。Piの版とentry point、Node、設定、存在するDBのschema、maintenance lockを表示する。capabilitiesは機能の実装有無で、接続の認証・利用可否は`not_checked`、`executionReady: false`と区別する。Worker・DAG・backup・monitor・更新は実装有無を表示し、認証済み・本人受入済みという意味にはしない。

状態DBが必要な場合だけ、次を実行する。

```bash
mise exec node@24.21.0 -- node dist/src/cli.js init
```

既定は`~/.local/state/beethoven/`、個人設定は`~/.config/beethoven/config.json`。`XDG_STATE_HOME`と`XDG_CONFIG_HOME`で変更できる。`config.example.json`は設定例であり、自動コピーしない。

repoの`.beethoven/config.json`は`--trust-repo-config`を付けた場合だけ読む。現段階で読み込むのは宣言設定のみ。repoは個人の権限・予算・許可接続を狭められるが拡大できない。CLIの`--permission`、`--max-tokens`、`--max-duration-ms`、`--max-cost-usd`も明示済みの制約を越えられない。

## 実装の読み方

| ファイル | 担当 |
| --- | --- |
| `src/cli.ts` | 引数、help、doctor、init、固定Piの配置確認 |
| `src/config.ts` | 設定の検証・出所・制約の合成、保存先 |
| `src/files.ts` | 私有ディレクトリ、maintenance lock、artifactの原子的保存 |
| `src/store.ts` | 初期schema、migration前snapshot、DB初期化 |
| `src/rules.ts` | repo識別、規約・ハーネスの検査、合成・出所・hash・snapshot生成 |
| `src/connections.ts` | ローカルcatalog、接続宣言の検査・読込・競合を確認した保存 |
| `src/setup.ts` | 初回選択・変更・削除・確認、取消、非対話取込 |
| `src/pi.ts` | SDK/RPC turn adapter。受付と終了、確定usage、期限・取消の変換。認証・起動・Policyはauth/agent/toolsが担当 |
| `src/auth.ts` | 接続別の私有credential保存、Pi OAuth/API key login、認証方式の固定 |
| `src/agent.ts` | SDK session所有、規約の適用、予算、Turn、停止・再開・圧縮 |
| `src/session.ts` | SQLiteのSession/Turn文書、状態とeventのtransaction保存 |
| `src/tools.ts` | 読取・検索・編集・shell・検証・質問とPolicy |
| `src/workspace.ts` | scope・symlink検査、内容hash、競合検出、Git状態 |
| `src/harness.ts` | 実行内容の信頼確認、preflight/verify、証拠の失効 |
| `src/process.ts` | POSIX process groupのTERM/KILL・回収確認 |
| `src/dialogue.ts`, `src/terminal.ts` | TTY/非TTYの同じ実行経路、入力queue、非表示secret入力 |
| `tests/foundation.test.ts` | 権限拡大拒否、lock競合、snapshot、保存失敗、診断・秘密値非表示 |
| `tests/rules.test.ts` | repo/worktreeの分離、必須checkの継承・不足・競合、非実行診断、原本保存 |
| `tests/setup.test.ts` | 利用者別の分離、認証/課金の区別、誤設定拒否、対話・非TTY、変更・取消・競合 |
| `tests/pi.test.ts` | fake sessionと公式RpcClient＋fake子プロセスによる契約試験。実接続の試験ではない |

P3でschema 2を追記し、Session/Turnの文書を保存するtableを追加した。schema 1のSQLは維持し、既存DBのsnapshotを取ってから前方migrationする。P3はstate全体のmaintenance lockで1 Controllerに制限する。共有quotaの予約・ownerEpoch・並列ControllerはP5以降。crash後は`recover`で消失した所有者のlockを確認し、`--yes`で解除する。生存PIDは奪わず、再開時は未回収process groupも検査する。

## 共通ルールとrepoハーネスの確認

```bash
mise exec node@24.21.0 -- node dist/src/cli.js rules show --json
mise exec node@24.21.0 -- node dist/src/cli.js rules check --json
# 保存が必要な場合だけ実行する。モデル・ハーネスの実行許可にはならない。
mise exec node@24.21.0 -- node dist/src/cli.js rules snapshot --json
```

共通は個人設定directoryの`rules.md`と`harness.json`、repoはGit rootの`AGENTS.md`と`.beethoven/harness.json`を読む。共通の初期内容は`rules.example.md`を本人が採用し、共通必須checkは現時点では設けない。例のファイルを置くだけでは有効にならず、本人の設定先へのコピーはまだ行っていない。

`show/check`はGitの読取によるrepo識別だけを行い、モデル・shell・宣言されたコマンドを実行せず、stateも作らない。`doctor`は規約本文を省いた適用元・hash・問題の要約を表示する。宣言不正・必須check不足・stage競合・重複は終了code 3で返す。不正JSONの本文や未知の項目の値は出力しない。

共通とrepoには同じJSON形式（`schemaVersion: 1`、任意の`requirements`/`checks`）を使う。宣言の具体例は[ハーネス設計4章](rules-harness.md)を参照。rootの規約のみが対象で、別文書の登録・path別規約・check実行と許可は未実装。

`snapshot`は診断に合格した原本・適用設定を内容hash名で既存artifact領域へ保存し、保存先とhashを返す。P3ではSessionへsnapshotを関連付け、各tool・provider request前に変更を検知する。変更後のresumeは現在のPolicyで新版を確認し、旧版の許可は引き継がない。backupはP4。単独snapshot操作ではDBを作成しない。

## 初回の接続設定

```bash
# 対話で登録・変更・削除し、保存前に全体を確認する
mise exec node@24.21.0 -- node dist/src/cli.js setup
# ネットワークを使わず、同梱model・認証方式を確認する
mise exec node@24.21.0 -- node dist/src/cli.js setup --catalog --json
# 非TTY向け。最初は検査・表示のみで未保存となり、終了codeは3
mise exec node@24.21.0 -- node dist/src/cli.js setup --from connections.example.json --json
# 内容を確認し保存する場合だけ、同じコマンドへ --yes を追加する
```

保存先は個人設定directoryの`connections.json`。`connections.example.json`は本人の予定に合わせた3つのsubscriptionの例で、製品の固定既定値ではない。モデルは同梱catalog上の候補で、契約での利用を保証しない。

setupは認証情報を入力・取得せず、`pi:<接続ID>`という参照だけを保存する。P3では別操作の`login --connection ID`を追加した。認証は個人設定の`auth/<接続ID>/credentials.json`へ0600で保存し、既存アプリの認証を自動取得・コピーしない。OAuthのURLは本人がブラウザーで開き、API keyはローカルの非表示入力を使う。subscriptionは金額unknownをnullで表し、従量APIは正のUSD上限と料金根拠を要求する。自動fallbackは無効。

既存の`config.json`の権限・送信許可は変更しない。登録したIDがallowedConnectionsにない場合は、setup結果とdoctorで`notAllowedConnectionIds`へ表示する。保存成功をそのまま実行可能とは扱わない。

## 検証の範囲

2026-10-25、Node 24.21.0で確認。元の作業領域と、source/package/lockfileだけをコピーした別の一時領域で確認した。

- `npm ci --ignore-scripts`、型検査、ビルド、6テスト: 別領域で成功。
- `doctor --json`: Node/Pi版、RPC entry存在、未初期化DB、未実装capabilityを確認。
- `npm audit`: override適用後の検出は0件。モデル通信・bundled RPCの動作確認を代替するものではない。

P1Rでは8件追加して計14テスト。Git fixture・worktree、候補コマンドの非実行、非書込診断、snapshot原本保存を確認した。例外条件は一時repoで再現し、本人の共通ルールをインストールしたり既存repoへcommitしたりはしていない。

P2のsetupでさらに8件追加して計22テスト成功。実際のPTYでも、対話でのsubscription設定保存とCtrl-C取消を確認。すべて一時設定先を使い、本人の認証・設定fileは変更していない。

- ローカル試験は一時ディレクトリを使い、本人の`~/.local`、認証、既存repoを変更しない。
- SQLiteの整合snapshotを別DBとして開いてデータを確認する。製品全体のbackup/restore試験はP4。
- GitHub Actionsは定義のみ。未push・未実行なのでCI成功とは報告しない。
- ここまでのP1/P1R/setup試験では、モデル疎通・tool・abort・session再開を検証していない。P3で追加したローカルSDK試験は下記とは分け、[P3受入記録](p3-acceptance.md)へ記載する。

P2のturn adapterに7件の契約試験を追加。計29テストで、早いsettled、受付と終了の区別、usage重複防止、期限・取消、エラー分類、日本語JSONLをローカル確認した。SDKはfake session、RPCは公式clientとfake子プロセスを使用し、実Piの起動・モデル通信・子プロセス回収は確認していない。[評価記録と次の手順](model-evaluation.md)を参照。


## P2残要件の追加確認

2026-10-25、計55テスト成功。bundled RPCの実起動・要求timeout・環境分離・process group回収、OAuth refresh書戻しと停止未確認時の再起動拒否、routingと接続状態の失効・明示enable、読取専用CLI診断を追加した。モデル呼出しを含まないテストと、Codex/Claudeの実モデル証拠を分けている。

- `src/rpc.ts`: 固定版bundled entry、制限付きJSONL、親環境の不継承、要求期限、停止確認。
- `src/rpc-evaluation-extension.ts`: 明示評価専用。共通のtool/ハーネスPolicyと有限予算。
- `src/routing.ts`: 役割・Task種別の検査、証拠hash付き接続評価、明示enable、送信先と有効状態の選択。
- `tests/rpc.test.ts`、`rpc-credentials.test.ts`、`routing.test.ts`: RPC実起動・秘密分離・期限・認証lock・状態・設定診断。
- `scripts/evaluate-sdk.mjs`、`evaluate-rpc.mjs`: 本人が承認した私有fixtureと接続だけで使う実モデル評価runner。通常のnpm testから実モデルは呼ばない。
- `scripts/export-p2-evidence.mjs`: 非機密の証拠集約とTask評価保存。再exportは旧enableを解除するため、有効化は評価確認後の別操作とする。

古い段階の試験数・未確認事項は上記の履歴として保持する。現在の実接続結果はモデル評価記録を参照する。


## 通常端末への登録とTUI

`mise exec node@24.21.0 -- npm run install:local`で`~/.local/bin/beethoven`へ同じNodeを固定したランチャーを登録する。この端末で登録済み。新しいlogin shellでもcommand解決・versionを確認した。cwdを変更せず起動し、通常のXDG保存先を利用する。

`src/tui.ts`はPi TUI 1.4.0のEditor・alternate screen・ScrollViewを使い、Sessionとは別にUI用の実行状態を生成しない。`src/welcome.ts`は未設定時の通信なし案内、同じsetup wizard、明示した送信先許可、既存loginへの切替を扱う。`--plain`では従来の行表示、print/JSONでは非TUIを使う。

今回の計61テストに加えて`python3 scripts/check-tui-pty.py`で実PTYの6条件を確認。モデル要求は0。process group probeの一時的なEPERMは履歴として残し、最後のESRCHで消失を確認できた場合だけ回収済みとする。最後までprobeが拒否された場合は停止未確認を維持する回帰試験を追加した。

詳細は[TUI操作ガイド](tui.md)。本人の端末での受入・IME操作、GitHub CIは未確認。


## 接続の簡単設定と全provider定義

`src/connect.ts`に検索・自動ID・有限上限・一括確認・認証・許可保存を集約した。初回と`/connect`、端末のconnect/対話setupから再利用する。高度な宣言編集と非TTY取込は維持する。`src/providers.ts`はPi公開builtinProvidersを正本にし、OpenRouterのpayload制約・報告費用の抽出も担当する。

Pi 1.4.0の42定義を列挙し、41に対話modelがある。APIキー、subscription／従量OAuth、cloud envとAzure deployment metadataを扱う。全providerの実アカウント試験ではない。今回の型検査と全70ローカル試験、実PTYの旧6条件＋簡単設定7条件を確認し、新たなモデル要求は0。OpenRouterはscripted SDKと報告costの有無・0をローカル検証した。

同じSession内の/connectではSDK停止・lock解放後に設定し、同じID・使用量と入力queueを再開する。API secretとmanual OAuth codeは非表示入力へ送る。詳細・参考資料・未確認事項は[接続設計](connect-design.md)を参照。

単一Workerのローカル試験は`tests/worker.test.ts`と専用scripted childを使い、実Node process・worktree・SDK・harness・中断・予算精算・read-only・明示復旧を確認する。実providerの利用はない。モデル実行の由来と認証の非表示overlayは`tests/agent.test.ts`と`tests/tui.test.ts`、接続・認証中にTUIを維持する実PTY確認は`scripts/check-tui-pty.py`。

全体比較後の追加試験: controller.test.tsで所有権と遅延event、agent.test.tsでcontext拒否・反復失敗、worker.test.tsで待機からの同会話再開・差分精算・未送信枠返却・observer例外・binary snapshotを確認。check-dialogue-pty.pyにはTUIでのWorker質問・log閲覧・回答再開を追加した。
