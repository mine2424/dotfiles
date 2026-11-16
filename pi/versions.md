# 採用バージョン

## v2: pstack中心の構成（2026-11-16）

- 固定元: versions.env。Pi 1.5.2、Node 24.21.0、pstack 0.9.0、pi-subagents 0.88.1。
- Ponytail SHAは継続。旧Extensionは無効化し、専門Skillsだけを利用する。
- New / Change / Fixの3つのSkillと共通PrinciplesをこのPCへ導入済み。
- 第三者コードの確認範囲はresearch.mdを参照。
- `python3 -m unittest discover -s scripts/tests -p test_setup_pi.py -v`: 12件成功。
  既存設定・個人Skill・Principlesの保持、冪等性、Ponytailフィルター移行とバックアップ、失敗伝播を確認。
- `python3 scripts/check-pi.py --smoke`: 19項目成功。
  実際のPi RPCによるコマンド/Skill読込に加え、Pi SDKとスクリプト化したモデルで
  pstack指示合成、共通原則への参照、subagentツール実行による同梱agent発見、Poteto Mode解除、Extensionイベントにエラーがないことを確認。
- 3つの独自Skillはskill-creatorのquick_validate.pyで検証成功。
- PRセルフレビューでローカルの旧Nodeが優先される問題を再現し、ランチャーのPATHを固定版Pi→miseのNode→ローカルbinの順へ修正。競合するNode/Piの回帰テストを追加。
- Linux/macOS向けのPiセットアップCIを追加。実モデル・子のモデル実行はCIに含めない。
- スモークは課金APIを使わず、子のモデル実行は行わない。ローカルでの再現手順はREADMEに記載。
- 実モデルのPlaybook判断・子の実装実行と複数モデルの比較、macOS・WSL実機は未確認。
- Outer Loopの自動スケジュールと改善PRの自動公開は未実装。

## v1の検証記録（履歴）

- Pi固定版: 1.5.2（確認時の導入版に合わせて更新）。Node 24.21.0、Ponytail SHAは初期構成を継続。
- 追加Prompt: plan / work / review / handoff。設定適用を実行し、このPCにもリンク済み。
- `python3 scripts/check-pi.py --smoke`: 10項目すべて成功。
  実際のPi RPCでPrompt、Ponytailコマンド、review Skillの登録を確認。
- セットアップと診断の回帰テスト: 9件。検証コマンドは以下の初期記録と同じ。
- 調査根拠: [research.md](research.md)。運用: [README.md](README.md)。
- モデル応答、Promptの遵守、macOS・WSL実機の動作は未確認。

## 初期導入時の記録

- バージョン定義: [versions.env](versions.env)
- 導入確認日: 2026-11-16
- 確認したOS: Linux x86_64（このCloud環境）。macOS・WSL実機は未確認。
- 確認したNode / Pi: 24.21.0 / 0.86.1
- 確認したPonytail: e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156（4.10.0）
- CLI導入: `bash scripts/setup-pi.sh --install` 成功。`pi --version` と `pi list` で確認。
- mise自動導入: 同日にmise未導入・PATH上のNode 18.19.1の環境から再実行し成功。
  mise 2026.11.8 → 管理対象Node 24.21.0 → Pi 0.86.1 → Ponytail登録まで確認。
- Extension読込: 隔離した一時設定で `pi --mode rpc --no-session --no-context-files` に `{"type":"get_commands"}` を送信。
  `ponytail`、`ponytail-review` 等のコマンドと6つのSkillを確認。終了0・stderrなし。
- セットアップ検証: `python3 -m unittest discover -s scripts/tests -p test_setup_pi.py -v`（7件成功）。
  ドライラン・既存設定/認証の保持・再実行・ランチャー退避・空白入りパス・独自設定ディレクトリ・失敗伝播を確認。
  miseの自動導入・PATH外のmise再利用・Node未導入/旧版からの導入・ダウンロード失敗・不完全なNode環境も確認。
- 静的確認: `bash -n scripts/setup.sh scripts/setup-pi.sh`、`git diff --check` 成功。
- 初回実装時の全体テスト: 33件中32件成功。既存のnpmバックアップテスト1件は環境にjqがなく失敗。
- 認証・モデル応答: 未確認
- 小さな変更と検証: 未確認
- 対話UIでのモード切替: 未確認。各PCで `/ponytail status` → `/ponytail off` → `/ponytail full` を確認する。
- 備考: CLI・Extension読込の確認と、認証済みの開発利用の確認は分けて記録する。
