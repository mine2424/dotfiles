#!/usr/bin/env bash
# Install the repository's local hooks using a pinned, mise-managed Lefthook.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
if command -v mise >/dev/null 2>&1; then
    mise_command="$(command -v mise)"
elif [[ -x "$HOME/.local/bin/mise" ]]; then
    mise_command="$HOME/.local/bin/mise"
else
    echo 'mise が必要です。先に bash scripts/setup-pi.sh --install を実行してください。' >&2
    exit 1
fi
# Read this tool's version without installing the other language runtimes.
version="$(sed -n 's/^lefthook = "\([^"]*\)"$/\1/p' "$ROOT/mise/config.toml")"
[[ -n "$version" ]] || { echo 'mise/config.toml に lefthook の版がありません' >&2; exit 1; }
if [[ -n "$(git config --get core.hooksPath || true)" ]]; then
    echo '既存の core.hooksPath を保持しました。Lefthookとの統合を手動で確認してください。' >&2
    exit 1
fi
hook="$(git rev-parse --git-path hooks)/pre-push"
if [[ -e "$hook" || -L "$hook" ]]; then
    if ! grep -q '^call_lefthook()' "$hook"; then
        echo "既存のpre-pushフックを保持しました: $hook" >&2
        exit 1
    fi
fi
"$mise_command" install "lefthook@$version"
"$mise_command" exec "lefthook@$version" -- lefthook install
