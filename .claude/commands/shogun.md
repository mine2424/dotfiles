マルチエージェント shogun ワークフローを管理します。

## Steps

1. `.shogun/` ディレクトリの存在を確認する
2. `.shogun/dashboard.md` を読んでエージェントの現在の状態を把握する
3. `.shogun/queue/` の既存タスクを確認する
4. ユーザーの指示をタスクとして `.shogun/queue/shogun_to_karo.yaml` に書き込む
5. タスク投入後、dashboard を更新する

## Rules

- Karo への指示は YAML 形式で `queue/shogun_to_karo.yaml` に書き込む
- タスクには `command_id`, `north_star`, `purpose`, `acceptance_criteria`, `status`, `timestamp` を含める
- `status` は `assigned` で開始する
- 既存の進行中タスクがある場合はユーザーに確認してから新規タスクを投入する
- エージェントの作業ファイルを直接変更しない

$ARGUMENTS
