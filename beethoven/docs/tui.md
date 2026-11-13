# ターミナルでの起動とTUI

更新日: 2026-10-25

通常のターミナルで、作業するGit repoへ移動して起動する。

```sh
cd /path/to/repository
beethoven
```

この端末では`~/.local/bin/beethoven`へランチャーを登録済み。Node 24.21.0とこのcheckoutのbuildを使い、呼出し元のcwdとXDG設定を維持する。repoごとのNode設定やシェルの既定Nodeを変更しない。

開始確認の回答後に接続・保存状態のエラーが起きた場合も、画面を保持する。表示された原因を確認し、`/retry`で会話の開始を再試行するか、`/connect`で接続を変更できる。失敗前の依頼は自動送信しないため、開始後に改めて入力する。終了は`/exit`またはCtrl+C。

## ロゴに合わせたテーマ

小文字の`beethoven`、星印、`AI DEVELOPS IN HARMONY`をヘッダーに置き、濃紺・アイボリー・ゴールドを共通tokenにした。会話・ツール・Worker状況・入力欄の階層を分け、成功と失敗は記号と文字でも示す。接続選択と秘密入力も同じ配色の枠を使い、modal中は背面の入力cursorを隠す。

通常はダーク版。`COLORFGBG`の背景値が明るい場合はライト版を選ぶ。明示する場合は次を使える。

```sh
BEETHOVEN_THEME=dark beethoven
BEETHOVEN_THEME=light beethoven
NO_COLOR=1 beethoven
```

`BEETHOVEN_THEME=mono`でも色を使わない。端末自体の背景・font・設定は変更しない。[デザインとプレビュー](tui-design.md)を参照。

## 初回の案内画面

通常環境の接続が未設定の場合も、通信せずTUIを開く。

初回は接続先pickerが自動で開く。接続先・modelを検索して選び、まとめて確認した後、ブラウザ認証またはAPIキー等を登録すると、そのまま依頼を入力できる。`/allow`・`/login`・`/start`を個別に入力する必要はない。後からは`/connect`、端末からは`beethoven connect`または`beethoven setup`で同じ設定を開く。

接続ID等は自動設定。上限は「上限を変更する」で調整できる。認証登録と有料疎通・Task評価は分け、設定中にモデル要求を送らない。既存の自分の認証は再利用でき、再認証も選択できる。詳細宣言編集は`/advanced`、保存先は`/status`、終了は`/exit`。[設計・provider対応範囲](connect-design.md)を参照。

現在の作業権限は確認画面へ表示する。初期状態はread-onlyで、編集権限への変更は個人設定で明示する。

## 画面と操作

各Turnの見出しと結果にprovider/model・接続IDを固定して残す。接続を変えても過去の結果のモデル名は変わらず、保存Turnとprovider応答eventにも記録する。上部にmodel・課金方式・権限・cwd、中央に会話・tool実行・検証結果、下部に状態・使用量・入力欄を表示する。入力欄は画面下に保持し、会話は独立してスクロールできる。狭い画面ではヘッダーを縮退し、入力欄と状態を優先する。

| 操作 | 動作 |
| --- | --- |
| Enter | 入力を送信。実行中の追加指示は待機列へ |
| Shift+Enter / Ctrl+J | 改行。IMEや端末でShift+Enterが区別できない場合はCtrl+Jを使う |
| 複数行paste | 1つの依頼として扱う |
| PageUp / PageDown、wheel | 会話のスクロール |
| ↑ / ↓ | 入力履歴を前後に呼び出す。再起動後も利用可能 |
| Ctrl+R、`/history [検索語]` | 保存済みpromptを検索し、入力欄へ戻す |
| Ctrl+C | 実行中はTurnを中断。待機中は終了 |
| Ctrl+D | 入力が空なら終了 |
| `/connect` | 接続を追加・変更し、同じ会話へ戻る |
| `/help` | 対話commandの一覧 |
| `/status`、`/permissions` | Session・上限・権限の詳細 |
| `/model [接続ID]` | 現在の接続を表示。変更は確認後に反映 |
| `/diff` | 現在の差分 |
| `/sessions`、`/sessions ID` | 保存会話を検索・選択して開き、会話表示とmodel contextを再開 |
| `/worker <依頼>` | 実Workerを専用worktreeで起動。[範囲と復旧](workers.md) |
| `/worker resume ID [回答]` | 保存した質問待ちWorkerを同じ会話・worktreeで再開 |
| `/workers [ID]`、`/workers logs ID` | 最新順のWorker一覧・状態・ログ |
| Ctrl+O、`/monitor` | 実行中もSession・Run・Task・Workerのカードと依存を確認 |
| `/orchestrate <依頼>`、`/run PLAN_FILE` | 計画を確認してDAG実行。[運用ガイド](operations.md) |
| `/context` | 会話の入力見積り・modelの容量・使用割合を確認 |
| `/resume` | 実行エラー後に同じSessionの保存状態を確認して再開。依頼は自動再送しない |
| `/compact` | 同じSessionを圧縮 |
| `/exit` | 終了。Session IDと再開commandを端末へ残す |

接続・認証は同じTUI上で行い、会話・編集中入力・待機列を保持する。APIキーとOAuthの手動codeは専用の非表示入力で受け取り、Editor履歴や会話へ入れない。ブラウザ認証URLを表示して開き、認証中もTUIを維持する。

承認・質問では、要求を表示した後の新しい回答だけを受け付ける。実行中にqueueした指示と、承認前から編集していたdraftを回答へ流用しない。中断してもqueueした指示は保持する。

欠測は金額・tokenとも0へ変換せず、token留保と欠測表示を分ける。応答完了、検証結果、本人受入は別表示。providerやtoolの出力中の端末制御文字は除去する。画面の履歴保持は最大200 component、各表示は64k文字までで、Sessionの正本には影響しない。

## 送信後の会話継続

応答完了は1 Turnの終了で、TUIの終了ではない。続けて依頼を入力できる。送信・commandの例外は画面内で示す。未知の実行例外ではモデル実行を保留し、`/status`・`/sessions`等で確認、`/resume`で同じSessionを開き直す。停止未確認ならlockで再開を拒否する。上限・usage・scopeを保持し、自動再送や接続fallbackはしない。

終了は`/exit`、待機中のCtrl+C、空入力のCtrl+D。終了理由は`dialogue_exit`へ構造化metadataだけを記録する。`--print`や非TTYは1回の結果で終了する。

`python3 scripts/check-dialogue-pty.py`は実PTY＋実SDK/scripted providerで、通常応答後の追加会話、予算停止後の操作、runtime例外後の保留・手動再開を検査する。Sessionと画面の維持、自動再送なし、生の例外本文を表示しないことも確認する。

## 行単位・非対話の利用

```sh
beethoven --plain
beethoven --print '依頼' --send --json
beethoven --resume <Session ID>
```

`--plain`とTERM=dumbでは従来の行単位表示を使う。JSON／非TTY／printではTUIを起動しない。簡単設定はTUI用。非TTYの宣言取込は`beethoven setup --from <file>`、認証だけは`beethoven login`を使える。

## ビルドとコマンド登録の再現

```sh
cd /path/to/dotfiles/beethoven
mise exec node@24.21.0 -- npm ci --ignore-scripts
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- npm run install:local
```

installは同じcheckoutが生成した通常fileだけを更新し、別の既存command・symlinkを上書きしない。モデル通信や認証変更は行わない。`--bin-dir`をinstallerへ渡せば試験用の別directoryへ登録できる。checkoutやNodeを移動・削除した場合は、既存ランチャーの参照先を確認して登録し直す。

## 確認範囲

Nodeのローカル試験では、日本語・複数行入力、stream・tool・blocked表示、画面resize、queueと承認の分離、draft保持、Ctrl+C/D、制御文字除去、ランチャーの引用・cwd・Node固定・衝突拒否を確認する。

`python3 scripts/check-tui-pty.py`は実PTYで初回画面、setup取消、送信先の明示許可、login不足、送信前取消と端末復元を確認する。隔離設定を使い、モデル要求は0。配色変更後も、ダーク版／ライト版の実PTYで同じ16条件を確認した。TUIの関連10試験では120×40・80×24・32×12・20×8、色なし、コントラスト、modalのfocusと秘密値の保護を確認。通常端末での本人受入・実IME操作は未確認。Codex/Claudeのモデル評価は[P2記録](model-evaluation.md)を参照し、今回のUI試験で新しい有料要求は行わない。

会話容量は直近requestの保守的な入力推定で、厳密なtokenizer値ではない。model context windowを越える送信は事前に止め、/compact・/model・規約量の調整へ案内する。同じworkspaceで同じtool失敗が4回続く場合も停止し、次の明示Turnまでモデルループを継続しない。圧縮は現在も/compactによる明示操作で、背景の有料要約は追加していない。


## 会話とプロンプト履歴

モデルへ渡す依頼は自動でローカル保存する。予算等でTurnを開始できなかった依頼も履歴から呼び出せる。通常は現在と同じ作業directoryの履歴だけを表示し、`/history --all [検索語]`で他のdirectoryも明示的に検索できる。検索は本文に対する部分一致。pickerを開いてからは表示中の最大200件を絞り込むため、古い依頼は`/history 検索語`で探す。

Ctrl+Rでpickerを開いて取り消した場合は編集中の入力を保持する。選択すると依頼を入力欄へ戻し、編集してEnterを押すまで送信しない。↑/↓の履歴は起動時に最大100件・合計2MiBを読み込み、長い入力は検索pickerから呼び出す。slash command・承認回答・認証専用入力はprompt履歴に加えない。

`/sessions`は同じdirectoryの保存済み会話を最大100件表示する。選んだSessionの接続・規約・権限・使用量を従来の再開手順で検査し、過去の質問・応答と記録されたprovider/modelを復元する。`beethoven --resume ID`も同じ表示復元を行い、`--connection`を省略した場合は保存時の接続を選ぶ。閲覧・復元だけではモデルへ要求を送らない。

```sh
beethoven history 数量
beethoven history --all --json
beethoven history show PROMPT_ID
beethoven sessions
beethoven sessions show SESSION_ID --json
beethoven --resume SESSION_ID
```

保存先は既存の`${XDG_STATE_HOME:-~/.local/state}/beethoven/state.sqlite`と`sessions/`。未設定の環境で履歴を閲覧してもDBは新規作成しない。新しい応答は履歴表示用に最大256,000文字を保存し、TUIは最近100メッセージ・1メッセージ最大64,000文字を表示する。元のPi会話fileは保持する。旧会話は保存済みpromptと照合して公開応答のtextだけを読み、thinkingや内部workspace注記を表示しない。旧原本の読込は16MiBを上限とし、読めないときは警告してpromptを表示する。既存archiveの移行・上書きはしない。

履歴はローカルの平文データで、依頼本文に直接記入した秘密情報も本文として残る。認証情報は従来どおり専用入力を使う。今回の保存は端末内の継続利用を対象とし、P4の端末故障に備えたbackup/restoreとは別。

履歴追加後は全94ローカル試験、既存の接続・認証16条件、対話4経路と履歴の実PTY再起動試験が通過。履歴試験では↑・Ctrl+Rの検索・入力欄への呼出し・明示送信・別Sessionへの切替・`--resume`による公開応答復元とモデル要求数を照合した。新規の実provider送信は0。[証拠](evidence/conversation-history-2026-10-25.json)。
