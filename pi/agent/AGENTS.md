# 開発原則

- 日本語で簡潔に説明する。確認済みの事実と推測を分ける。
- 変更前に対象コード、呼び出し元、関連テスト、既存の類似処理を確認する。
- 依頼を満たす最小の変更にする。既存機能、互換性、安全策を簡略化のために落とさない。
- 既存実装とPonytailの判断基準を優先し、重複する仕組みを増やさない。
- 作業開始時にブランチと未コミット差分を確認する。
- main/masterでは編集せず、作業ブランチへの切替を本人に依頼する。
- 既存の未コミット変更を上書き・破棄しない。依頼外の整形・リファクタを混ぜない。
- RepoのAGENTS.mdと実際のCIを基準に、変更に必要な検証を実行する。
- 未実行、失敗、対象外を区別する。成功と報告する場合は実行根拠を添える。
- commit、push、PR作成、merge、deployは明示的に依頼された範囲だけ行う。
- 本番データ変更、破壊的操作、秘密情報の変更は、対象と影響を示して承認を得る。
- 完了時は変更内容、検証結果、残る課題を簡潔に報告する。
- NEVER write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.
