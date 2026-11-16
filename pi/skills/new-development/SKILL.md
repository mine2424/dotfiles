---
name: new-development
description: 新しい機能やプロジェクトを作る依頼で、pstackのPlaybookを使って受入条件から最小の実装を組み立てる。
---

# New

グローバルAGENTSと同じagentディレクトリのPRINCIPLES.mdを読む。
pstackのpoteto-mode本体を読み、親セッションで依頼を分類する。子にPlaybook全体を丸投げしない。

既存の構成・起動手段・CIを調べ、利用者に見える最小の成果と受入条件を定める。
まだ情報がない新規Repoでは、言語・起動コマンド・外部サービスを推測して確定しない。
feature、prototype、investigation等から現状に合うPlaybookを選び、実装から学んだことに応じて戻る・省く・分割する。

API・型・モジュールの境界が課題ならarchitect、実装前の挙動を確かめるならtdd、案の比較が必要ならarenaを選ぶ。
PonytailのSkillで不要な依存や抽象化を避ける。UIや認証を扱う変更には対応する実環境検証を加える。
完了は実装量ではなく受入条件と実行証拠で判断し、未確認事項も報告する。
