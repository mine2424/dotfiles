# Beethoven TUIのデザイン

2026-10-25。提供ロゴの濃紺・アイボリー・ゴールド、小文字のワードマークと星印を端末向けに反映した。書体は利用者の端末設定を使う。

| 要素 | ダーク版 | ライト版 |
| --- | --- | --- |
| パネル | `#101D2D` | `#F4F0E7` |
| 主文字 | `#F4EFE4` | `#182332` |
| 補助文字 | `#ACB7C5` | `#536073` |
| ゴールド・focus | `#D6B36A` | `#856019` |
| 成功 | `#A5C9A4` | `#35633C` |
| 失敗 | `#F09A8C` | `#A1372A` |

主文字・補助文字・gold・成功・失敗は各panel背景とのコントラスト4.5:1以上を試験で確認する。会話本文の背景は端末の設定を維持するため、画面全体の見た目は利用者のterminal themeにも依存する。ライト端末で自動判定できなければ`BEETHOVEN_THEME=light`を指定する。

ヘッダーはブランド・選択model/provider・課金／権限・作業場所。会話は左右に2文字の余白を設け、ユーザー、Agent、ツールを文字・記号・色で分ける。下部に実行段階とWorker情報、使用量、入力欄、ショートカットを配置する。狭い端末ではtagline、path、Worker dockを省略し、入力と状態を優先する。既存の`/status`と`/workers`で詳細を確認できる。

接続pickerと秘密入力は共通のpanel。keyboardで検索・選択・決定・取消できる。modal中は背面入力のcursorを表示せず、閉じると元のdraftへ戻る。秘密値はmaskだけを描画し、履歴や会話へ入れない。

次は実rendererのframeを使ったプレビュー。会話、モデル、PIDと使用量は描画確認用の架空データで、モデル呼出し・Worker起動は行っていない。

- [ダーク版](evidence/tui-brand-2026-10-25/dark.png)
- [ライト版](evidence/tui-brand-2026-10-25/light.png)
- [接続picker](evidence/tui-brand-2026-10-25/dark-connect.png)
- [秘密入力](evidence/tui-brand-2026-10-25/light-private.png)

再生成はbuild後に`node scripts/preview-tui.mjs /tmp/beethoven-tui-brand`。同じrendererでdark/light/monoの通常画面・接続選択・秘密入力のSVG・JSON・textを生成する。PNGはframeのANSI色と文字をmacOS AppKitで可視化したもの。実端末とfontの細部は異なる。

確認: TUI関連10試験、実PTYの16条件、TypeScript build。新規の実モデル・有料推論は0。本人の実IME・端末別font表示の受入は未確認。
