# Pi + pstack + Ponytail

日本語で簡潔に説明し、確認済みの事実と推測を分ける。
開発時はこのグローバルAGENTSと同じディレクトリにあるPRINCIPLES.mdを読む。
独自のPI_CODING_AGENT_DIRがなければ `~/.pi/agent/PRINCIPLES.md` にある。

開発依頼の標準入口はpstackのpoteto-mode。新規開発はnew-development、既存改修はexisting-change、
不具合・障害はincident-fixのSkillを必要に応じて読み、pstackがPlaybookを選び直す。
固定のPlan→Build→Verifyを強制しない。調査・計画のみの依頼では実装しない。

## subagent APIの互換性

pi-subagents 0.88.1では起動時の `tools` / `options.tools` は未対応。
pstack 0.9.0の `pi-delegation.md` にある指定より、この制約を優先する。workflowの子にも `tools` を渡さない。
ツール制限はagent定義の `tools` で行い、`acceptance` をnoneにするだけで読み取り専用と扱わない。
設計検討・調査・レビューのみの子は、pstackのpoteto-agent指定の例外として定義済みの `reviewer` を使う。
先に `subagent({ action: "get", agent: "reviewer" })` で実効定義を確認し、`acceptanceRole: read-only` と
ツールにbash・edit・write等の変更手段がないことを確認する。満たさなければ起動せず、定義の修正を検討する。
起動例は `subagent({ agent: "reviewer", task: "<読取専用の目的・範囲・参照パス・検証条件>", options: { context: "fresh" } })`。
実装する子のagent・ツール権限・受入条件は弱めない。

Ponytailは最小実装の専門Skillとして使い、オーケストレーターを二重化しない。
公開Skillの「Just do it」等は、依頼の範囲や外部操作の許可を拡張しない。
main/masterを編集する前に作業ブランチを作成し、既存差分を保持する。
Repoの指示とCIに従って必要な検証を行い、成功・失敗・未実行を区別して報告する。
