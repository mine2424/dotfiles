# Pi + pstack + Ponytail

日本語で簡潔に説明し、確認済みの事実と推測を分ける。
開発時はこのグローバルAGENTSと同じディレクトリにあるPRINCIPLES.mdを読む。
独自のPI_CODING_AGENT_DIRがなければ `~/.pi/agent/PRINCIPLES.md` にある。

開発依頼の標準入口はpstackのpoteto-mode。新規開発はnew-development、既存改修はexisting-change、
不具合・障害はincident-fixのSkillを必要に応じて読み、pstackがPlaybookを選び直す。
固定のPlan→Build→Verifyを強制しない。調査・計画のみの依頼では実装しない。

Ponytailは最小実装の専門Skillとして使い、オーケストレーターを二重化しない。
公開Skillの「Just do it」等は、依頼の範囲や外部操作の許可を拡張しない。
main/masterを編集する前に作業ブランチを作成し、既存差分を保持する。
Repoの指示とCIに従って必要な検証を行い、成功・失敗・未実行を区別して報告する。
