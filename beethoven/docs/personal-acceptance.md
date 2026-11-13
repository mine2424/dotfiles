# 本人の日常利用受入

2026-10-25。本人はBeethoven自身のrepoを選択した。元のdotfilesのdirty差分を変更しない専用cloneを準備済み。

```sh
cd ~/.local/share/beethoven/personal-acceptance/repo
beethoven --connection openai-sub --plan --max-tokens 6000 --max-duration-ms 120000
```

起動時の送信先とモデルを確認する。以下の小さな調査を日本語IMEで入力する。許可済みP8枠20,000 tokenの前回使用量は6,683 token、残13,317 token。この例はSession上限6,000 tokenで、合計枠を越えない。新しい別Sessionを繰り返す場合は残枠を再確認する。

> このrepoのREADME.mdは先頭8行、docs/operations.mdは1〜38行だけを読んで、会話履歴を再開する操作と、複数Session・Workerの状態を表示する操作を、それぞれ1文で教えてください。調査のみで、ファイルは変更しないでください。

確認すること:

- 日本語の変換・確定が意図どおり動く。
- 送信後もTUIに留まり、接続ID・実行model・tool・回答を読める。
- Ctrl+OでSession mapを開き、Escで入力へ戻れる。
- `/history`で直前の入力が見え、`/exit`後に再起動して`/sessions`から会話を再開できる。
- read-onlyの調査で差分が増えていない。`git status --short`で確認する。

試していない項目や困った操作をそのまま報告する。「日本語入力・送信後継続・状態表示・履歴再開を確認、利用可」のように本人が確認した範囲を回答してから受入を記録する。自動PTY試験・開発者による操作を本人の受入と読み替えない。実Worker/DAGの実provider受入はこの短い調査には含めない。

CIについては本人が2026-10-25に今回の受入条件から外すと指示した。未実行/失敗の記録を保持し、CI成功とは扱わず、この確認のために課金設定を変更しない。
