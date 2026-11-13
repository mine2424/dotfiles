# ディスクメンテナンスガイド

開発用Macの容量を調査し、再生成可能なファイルを選んで整理します。
入口は `scripts/disk-cleanup.sh`。判定・処理は標準ライブラリのみの `scripts/disk-cleanup.py` にまとめています。
Python 3.10以上とmacOS標準の `du` / `lsof` / `ps`、開発成果物の判定にはGitが必要です。

## 使い方

```bash
cd ~/development/dotfiles

./scripts/disk-cleanup.sh                            # 調査のみ、保存・削除なし
./scripts/disk-cleanup.sh --report --save-report       # 計測を保存、次回は増分も表示
./scripts/disk-cleanup.sh --check                      # 空き容量だけを高速確認
./scripts/disk-cleanup.sh --safe --dry-run             # 使用中でないキャッシュの整理候補
./scripts/disk-cleanup.sh --deep --only artifacts --dry-run
./scripts/disk-cleanup.sh --deep --only artifacts      # 候補ごとに確認して削除
./scripts/disk-cleanup.sh --deep --artifact ~/development/example/build --dry-run
./scripts/disk-cleanup.sh --safe --cache ~/.gradle/caches --dry-run
./scripts/disk-cleanup.sh --deep --only caches,artifacts --days 60
```

`--only` は `caches,artifacts,simulators,worktrees` のカンマ区切りです。
`--safe` はキャッシュのみ。`--deep` の既定対象はキャッシュと開発成果物です。
シミュレータ・worktreeは種類を選ぶだけでは削除候補にならず、削除ID・パスの明示が必要です。
`--yes` は確認だけを省略し、保持設定・使用状況・更新日時の条件は省略しません。
`--days` は1以上、既定30日です。短くすると候補が増えるため、まずdry-runで確認してください。

不要と判断済みの最近の成果物は `--artifact <パス>`、既知のキャッシュは `--cache <パス>` で個別指定できます。
同じ種類では指定したパスだけを対象にし、更新日時の条件だけを外します。保持設定・実行中・Gitの条件は外しません。
任意のフォルダを削除する機能ではなく、探索された成果物または既知のキャッシュ以外のパスはエラーです。
削除ID・パスを明示して `--only` を省略した場合は、その種類だけを処理します。

## 保持設定

既定設定は `scripts/disk-cleanup.json`。このPCで利用中だったiOS 26.5は保持対象に指定しています。
別のPCや必要OSが変わった場合は `keep_runtimes` を見直してください。
ローカル用JSONは任意の場所に用意し、`--config /path/to/config.json` で指定できます。
指定したキーを置き換える方式で、配列も追加ではなく置き換えです。JSONをシェルコードとして実行しません。

```json
{
  "keep_paths": ["~/development/important-project"],
  "keep_runtimes": ["com.apple.CoreSimulator.SimRuntime.iOS-26-5"],
  "keep_devices": [],
  "minimum_free_gib": 50
}
```

一時的な保持には `--keep ~/development/important-project` を使います。繰り返し指定できます。
`keep_paths` 内の子だけでなく、その親を丸ごと削除する処理も止めます。
探索ルートは `development_roots` で指定でき、既定ではdevelopment・Orca・Codexのworktreeとプロジェクト・Documents/Codexを調べます。
シンボリックリンク経由の探索・削除は行いません。削除対象内のリンク先も辿りません。

## 整理対象と保持条件

| 種別 | 対象 | 保持する条件 |
|---|---|---|
| caches | npm取得キャッシュ、npx、uv、pip、Goビルド、SwiftPM、CocoaPods、Codex、Playwright、Puppeteer、Gradle、更新残骸、DerivedData | 保持設定、開いているファイル、関連ツールの実行、取得失敗。npxは期間内の更新も保持 |
| artifacts | `node_modules` / `.next` / `.turbo` / `.venv` / `.dart_tool` / `Pods` / `build` / `.build` | 保持設定、プロジェクト内へのプロセス参照、ソースまたは成果物の期間内更新、Git管理・除外設定の確認失敗 |
| simulators | 明示したランタイムUUID・端末UUIDだけ | 保持設定、起動中端末、ランタイムの最近の利用、削除不可状態 |
| worktrees | 明示した登録済みworktreeだけ | 保持設定、実行中、期間内更新、ロック、変更・未追跡・ignoredファイル、origin既定ブランチへの取り込み未確認 |

成果物は、Gitで無視され、かつGit管理ファイルを含まないディレクトリだけが対象です。
`build` という名前のソースフォルダを誤って削除しないための条件です。Git外のものは手動確認として表示します。
ソースの更新判定では成果物を除外し、成果物自身の更新日時も別途確認します。
通常のキャッシュは更新日時だけでは保持せず、使用状況を確認して整理します。
キャッシュ全体に30日間の未更新を要求すると、使うたびに保持されて容量を回復できないためです。
npxはMCPサーバーの実行環境にもなるため、実行中チェックに加えて期間内の更新も保持します。

実行中チェックには現在のユーザーの `lsof` と全体の `ps` を使用します。
取得に失敗した場合は削除しません。確認後・削除直前にも条件を再確認します。
OS権限で見えないプロセスや、確認直後の新規起動まで完全に防ぐものではありません。整理中に対象を起動しないでください。
取得不能な容量は0扱いせず「不明」と表示します。
一覧は容量順に上位30件を表示します。`--limit 0` で全件を表示できます。
表示件数は削除対象を限定しません。対象の限定には `--only` / `--artifact` / `--cache` を使います。

旧版の `--deep -y` によるOSの新しい順の削除、`delete unavailable`、miseの未参照推定によるアンインストール、
Goモジュールの全消去、Dockerの一括prune、ログの一括削除は実行しません。
旧版の `utils/cleanup-safe.sh` / `cleanup-deep.sh` は廃止し、判定をPython側に統合しています。

## シミュレータの整理

レポートにOSのUUIDと端末のUUIDを別々に表示します。ランタイムのUUIDは `xcrun simctl runtime list` でも取得できます。
同じバージョンでもビルドや対象機種が異なるため、「最新2件」では判断しません。

```bash
./scripts/disk-cleanup.sh --deep --only simulators --dry-run
./scripts/disk-cleanup.sh --deep --only simulators --runtime <ランタイムUUID> --dry-run
./scripts/disk-cleanup.sh --deep --only simulators --device <端末UUID> --dry-run
# 確認した後、--dry-runを外して実行
```

実行はAppleの `simctl runtime delete` / `simctl delete` に任せます。
端末の削除ではインストール済みアプリとその保存データを失います。必要なテストデータは先に退避してください。
OS保持指定と端末保持指定は別です。端末データを残すには `keep_devices` または `keep_paths` を使ってください。
端末を保持する指定は、その端末のOS削除も止めます。

OS削除は [XcodeのComponents設定](https://developer.apple.com/documentation/safari-developer-tools/adding-additional-simulators) からも行えます。
OSの `sizeBytes` と `du` の端末データ容量は別の見積もりです。マウントされたOSの見かけのサイズを足しません。

## worktreeの整理

Orcaのworktreeも探索します。まず成果物を整理し、残すファイルは退避してください。
Gitの取得では `GIT_OPTIONAL_LOCKS=0` を使用し、調査のためのindex更新を避けます。

```bash
./scripts/disk-cleanup.sh --deep --only worktrees --worktree ~/orca/workspaces/repo/task --dry-run
```

削除には、ローカルの `origin/HEAD` が指す既定ブランチにHEADが含まれることを要求します。
fetchは自動実行しません。remoteの情報が不足していれば保持するため、必要なら先にfetchしてください。
ignoredファイルも含めた空の作業状態を要求します。保持ブランチがあるだけでは削除しません。
削除前にGit共通ディレクトリの `cleanup-archives/<timestamp>.bundle` にHEADの履歴を保存し、
`git bundle verify` を通してから `git worktree remove` を実行します。`--force` は使いません。
復元例: `git clone /path/to/cleanup-archives/<timestamp>.bundle /path/to/recovered`。

## 再発を防ぐ計測

空き容量はまず50GiB以上、普段は80〜100GiBを運用目標とします。
`--check` はディレクトリを走査せず、閾値未満なら終了コード2、正常なら0、設定エラーなら1を返します。
自動削除は設定していません。週次確認や既存の監視からこのコマンドを呼べます。

`--report --save-report` は `~/.local/state/dotfiles/disk-report.json` に計測日時・各容量を保存します。
次のレポートで前回との差分を表示します。通常のレポートとdry-runはこのファイルを作成・更新しません。
`--save-report` と `--dry-run` の併用はエラーにします。
親子フォルダ、APFSの共有ブロック、疎ファイル等があるため、候補容量の合計と実際の回復量は一致しません。
実際の回復量は実行前後の空き容量差分で確認します。他のアプリの書き込みもこの差分に影響します。

## 手動で判断する対象

2026-11-11の実測です。これらをキャッシュと一緒には削除しません。

| 対象 | 使用量 | 対応 |
|---|---:|---|
| Unity Editor | 26.2GiB | Hubで必要なプロジェクトのバージョンを確認。6000.3.25f1が9.2、6000.5.3f1が17.0GiB |
| Docker.raw | 実割当16.9GiB | Docker起動後 `docker system df -v` で中身を確認。全体を回収できるとは限らない |
| AllMyRecords | 16.1GiB | 録音形式のCAFが12.6GiB。旧バックアップ約3GiBの重複は未検証。外部保存・保持期間を決める |
| Codexプロジェクト出力 | 大きい1件が10.5GiB | 調査データ・ZIPの保存要否を確認し、完成物と再取得可能な素材を整理 |
| Notion | 8.9GiB | アプリ側でキャッシュとオフラインデータの扱いを確認 |
| Claude Desktop | 13.2GiB | VM bundleが約11.4GiB。アプリの機能・保存データを確認して整理 |
| Android SDK / AVD | 10.8GiB | SDK Manager / Device Managerで必要なAPI・NDK・仮想端末を選ぶ |
| mise | 12.0GiB | `mise ls` とプロジェクトの設定・使用中プロセスを照合して不要バージョンを選ぶ |
| Music / Downloads | 12.3 / 5.7GiB | 音楽のローカルダウンロードや不要なインストーラ等を確認 |

Docker.rawは見かけ40GiBでも、実割当は約16.9GiBです。
[Docker公式資料](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/macfaqs/) によると、
ディスク上限を縮小すると既存ディスクが削除され、コンテナ・イメージを失います。容量整理のために安易に縮小しないでください。
外部ドライブへ移す場合もFinderで直接動かさずDockerの設定から行います。

## 検証

```bash
python3 -m unittest discover -s scripts/tests -p 'test_disk_cleanup.py' -v
bash -n scripts/disk-cleanup.sh
./scripts/disk-cleanup.sh --check
./scripts/disk-cleanup.sh --deep --only artifacts --dry-run
```

削除テストは一時フォルダのGitリポジトリとworktreeのみを使用します。
実環境ではレポート・dry-run・容量チェックで確認し、削除と区別します。

## 実施記録

| 日付 | モード | 実行前の空き容量 | 実行後の空き容量 | 備考 |
|---|---|---|---|---|
| 2026-10-02 | `--deep` + iOS DeviceSupport 手動削除 + `pnpm store prune` | 12.9GB | 119GB | Docker build cache 21GB, iOS 26.2/26.4 ランタイム 17GB, Codex worktree 16件 約10GB, Claude agent worktree 9件（ロック中の autest-sandbox 15件 約1GB は保留）, 放置 node_modules/.next/.venv 約15GB 等。uv キャッシュ 7.6GB は serena MCP 実行中のため未削除 |
| 2026-11-11 | 使用状況を再確認しキャッシュ・成果物を実削除 | 14.07GiB | 30.39GiB | キャッシュ整理で+8.27GiB（Gradle、Go、SwiftPM、DerivedData、更新残骸）。10リポジトリの成果物20ディレクトリ整理で+8.05GiB。Git追跡ファイルの変更状態は前後一致。空き容量差分には他プロセスの書き込みも含む。Unity新版6000.5.3f1約17GiBは使用予定を確認中で保持 |
| 2026-11-11 | ユーザー承認後にUnity 6000.5.3f1を削除 | 18.73GiB | 35.83GiB | 使用中でないことを再確認して対象バージョンのみ削除。6000.3.25f1のディレクトリ・実行ファイルの保持を確認。今回の差分+17.10GiB。前回計測後に空きが減少していたため、今回の開始時点を再計測 |
