---
name: existing-change
description: 既存コードの機能追加・仕様変更・リファクタで、影響範囲と互換性を調べ、pstackの適切なPlaybookで変更する。
---

# Change

グローバルAGENTSと同じagentディレクトリのPRINCIPLES.mdを読む。
pstackのpoteto-mode本体を読み、親セッションで依頼を分類する。工程の順番を固定しない。

howで呼び出し元・公開契約・テスト・CIを確かめる。whyは設計意図や履歴が判断に必要な時に使う。
変更してよい挙動と保持する挙動を分け、feature / refactoring / investigation等のPlaybookから選ぶ。
互換性のない変更が依頼に含まれていなければ、破壊的なAPI・データ移行を勝手に加えない。

実装・検証から新しい事実が出たら分類と範囲を見直す。Ponytailで余分な変更を削り、既存変更は保持する。
重要な差分の独立レビューにはinterrogateを使い、指摘を再確認して根拠・影響・確度を示す。
テスト成功と仕様の正しさを区別し、利用できない環境や未確認の互換性を最終報告に残す。
