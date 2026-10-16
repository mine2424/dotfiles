# Claude Code 開発環境ガイド

dotfiles で管理する Claude Code の共通設定。`setup.sh --claude` で `~/.claude/` に反映され、全プロジェクトで利用可能になる。

## 構成

```
.claude/
├── settings.json          # セキュリティ deny list + hooks
├── settings.local.json    # allow list (許可コマンド)
├── scripts/
│   └── deny-check.sh      # PreToolUse hook (コマンド検証)
├── agents/                # 汎用サブエージェント
│   ├── code-reviewer.md
│   ├── security-reviewer.md
│   ├── planner.md
│   └── build-error-resolver.md
├── commands/              # スラッシュコマンド
│   ├── plan.md
│   ├── code-review.md
│   ├── security-review.md
│   └── build-fix.md
└── rules/                 # 常時適用ルール
    ├── security.md
    ├── coding-style.md
    └── git-workflow.md
```

## セキュリティ設定

### deny list (settings.json)

| カテゴリ | 対象 |
|---------|------|
| 機密ファイル読取 | `.env`, `*.key`, `credentials/*`, SSH鍵, `*.pem`, `*.p12`, `*.pfx`, `*credentials.json`, `*.secret`, `*token*`, `*secret*key*` |
| 機密ファイル編集 | `.env`, `.env.*`, `~/.ssh/*` |
| 危険なコマンド | `eval`, `sudo`, `chmod 777`, `rm -rf /*` |
| Git 破壊操作 | `git push --force`, `git reset --hard` |
| 環境変数漏洩 | `env`, `printenv` |
| Bash経由の読取バイパス | `cat .env*`, `cat ~/.ssh/*`, `cat *.pem` |
| ネットワーク | `nc`, `netcat`, `ncat` |

### hooks

- **PreToolUse (Bash)**: `deny-check.sh` がコマンドを deny list と照合。`;`, `&&`, `||`, `|` で分割して各部分もチェック。

## スラッシュコマンド

Claude Code のプロンプトで `/command名` と入力して実行。

### /plan

実装前に計画を立てる。コードベースを分析し、変更するファイル・手順・リスクを整理して**ユーザー承認を待つ**。

```
> /plan ユーザー認証機能を追加したい
```

### /code-review

現在の未コミット変更（staged + unstaged）のコードレビュー。品質・セキュリティ・パフォーマンスの観点で問題を報告。

```
> /code-review
```

### /security-review

OWASP Top 10 に基づくセキュリティレビュー。ハードコードされたシークレット、インジェクション、認可漏れなどをチェック。

```
> /security-review
```

### /build-fix

ビルドエラーの診断と修正。プロジェクトのビルドコマンドを自動検出し、エラーを1つずつ修正・検証を繰り返す。

```
> /build-fix
```

## エージェント

Claude Code が Agent ツールで呼び出す専門サブエージェント。直接使うのではなく、Claude が複雑なタスクを委任する際に自動で選択される。

| エージェント | 用途 | ツール |
|------------|------|--------|
| code-reviewer | コード品質・セキュリティ・保守性レビュー | Read, Grep, Glob |
| security-reviewer | OWASP 基準の脆弱性分析 | Read, Grep, Glob, Bash |
| planner | 実装計画の立案 | Read, Grep, Glob |
| build-error-resolver | ビルドエラーの診断と修正 | Read, Grep, Glob, Bash |

## ルール

全セッションで自動読み込みされる共通ルール。Claude の振る舞いを制約する。

### security.md
- シークレットのハードコード禁止
- ユーザー入力のバリデーション必須
- パラメータ化クエリの使用
- エラーメッセージに内部情報を含めない

### coding-style.md
- 不変データをデフォルトに（const, readonly, final）
- 関数は40行以内、ネストは3階層以内
- 頼まれていない改善をしない
- 早すぎる抽象化より重複を許容

### git-workflow.md
- Conventional Commits 形式 (`type(scope): description`)
- main への force push 禁止
- コミット前にリンター・テストを実行
- `.env` やクレデンシャルをコミットしない

## デプロイメント

### 初回セットアップ / 更新

```bash
# dotfiles リポジトリで
./scripts/setup.sh --claude --force
```

### setup_claude() の動作

| 対象 | 方式 | 理由 |
|------|------|------|
| `scripts/` | コピー | フック実行スクリプト |
| `settings.local.json` | コピー | allow list は dotfiles が完全管理 |
| `settings.json` | **jq マージ** | permissions/hooks は dotfiles から、enabledPlugins 等のランタイム設定は保持 |
| `agents/`, `commands/`, `rules/` | コピー (置換) | dotfiles が完全管理 |

**ランタイムデータ（以下）は破壊しない:**
- `.credentials.json` (認証情報)
- `enabledPlugins`, `extraKnownMarketplaces` (プラグイン設定)
- `history.jsonl`, `sessions/`, `plugins/` (履歴・キャッシュ)

### プロジェクト固有設定を追加したい場合

各プロジェクトの `.claude/` ディレクトリに配置する。`~/.claude/` のグローバル設定と自動的にマージされる。

```
my-project/
├── .claude/
│   ├── commands/       # プロジェクト固有のコマンド
│   ├── rules/          # プロジェクト固有のルール
│   └── CLAUDE.md       # プロジェクトのコンテキスト
└── ...
```

## カスタマイズ

### コマンドを追加する

`dotfiles/.claude/commands/` に Markdown ファイルを作成:

```markdown
コマンドの説明文。

## Steps

1. 手順1
2. 手順2

## Rules

- ルール1
- ルール2

$ARGUMENTS
```

`$ARGUMENTS` はコマンド実行時の引数に置換される。

### エージェントを追加する

`dotfiles/.claude/agents/` に frontmatter 付き Markdown:

```markdown
---
name: agent-name
description: What this agent does
tools: Read, Grep, Glob
model: sonnet
---

エージェントへの指示内容...
```

**ツールは必要最小限に。** 50個のツールを持つエージェントより、5個に絞ったエージェントの方が効率的。

### ルールを追加する

`dotfiles/.claude/rules/` に Markdown ファイルを作成。ファイル名で役割がわかるようにする。内容は短く具体的に。

### 変更を反映する

```bash
./scripts/setup.sh --claude --force
```
