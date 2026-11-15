# 公開事例を踏まえたPi + Ponytail構成

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
