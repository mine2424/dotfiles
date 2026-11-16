#!/usr/bin/env bash
# Use the already installed shared Node; Git hooks never install runtimes.
if command -v mise >/dev/null 2>&1; then
    DOTFILES_MISE="$(command -v mise)"
elif [[ -x "$HOME/.local/bin/mise" ]]; then
    DOTFILES_MISE="$HOME/.local/bin/mise"
else
    echo 'mise が必要です。先に bash scripts/setup-pi.sh --install を実行してください。' >&2
    return 1
fi
DOTFILES_LOCAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOTFILES_NODE_VERSION="$(sed -n 's/^node = "\([^"]*\)"$/\1/p' "$DOTFILES_LOCAL_ROOT/mise/config.toml")"
[[ -n "$DOTFILES_NODE_VERSION" ]] || { echo 'mise/config.toml にnodeの版がありません' >&2; return 1; }
DOTFILES_NODE_BIN="$("$DOTFILES_MISE" where "node@$DOTFILES_NODE_VERSION")/bin" || return 1
[[ -x "$DOTFILES_NODE_BIN/node" ]] || { echo 'mise install node を実行してください' >&2; return 1; }
export PATH="$DOTFILES_NODE_BIN:$PATH"
