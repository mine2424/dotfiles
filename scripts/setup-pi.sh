#!/usr/bin/env bash
# Portable Pi + Ponytail setup. Bootstraps mise and its pinned Node runtime.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/utils/common.sh"
source "$DOTFILES_ROOT/pi/versions.env"

install=false
dry_run=false
for arg in "$@"; do
    case "$arg" in
        --install) install=true ;;
        --dry-run) dry_run=true ;;
        --help|-h)
            echo 'Usage: bash scripts/setup-pi.sh [--install] [--dry-run]'
            echo 'Default: apply initial settings only. --install: install pinned Pi and Ponytail.'
            exit 0 ;;
        *) log_error "不明なオプション: $arg"; exit 1 ;;
    esac
done

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
prefix="$HOME/.local/share/dotfiles/pi"
launcher="$HOME/.local/bin/pi"
if [[ "$dry_run" == true ]]; then
    log_info "[DRY RUN] 初回設定: $agent_dir/settings.json（既存は保持）"
    log_info "[DRY RUN] 原則リンク: $agent_dir/AGENTS.md（既存は保持）"
    log_info "[DRY RUN] 開発Prompt: $agent_dir/prompts/{plan,work,review,handoff}.md（既存は保持）"
    if [[ "$install" == true ]]; then
        log_info "[DRY RUN] mise がなければ https://mise.run から ~/.local/bin/mise に導入"
        log_info "[DRY RUN] mise install node@$PI_NODE_VERSION（既存Nodeの有無・版に関係なくmiseで管理）"
        log_info "[DRY RUN] npm install --global --prefix $prefix @earendil-works/pi-coding-agent@$PI_VERSION"
        log_info "[DRY RUN] pi install $PONYTAIL_SOURCE"
        log_info "[DRY RUN] ランチャー: $launcher"
    fi
    exit 0
fi

if [[ "$install" == true ]]; then
    command -v git >/dev/null || { log_error 'git をインストールしてください'; exit 1; }
    if command -v mise >/dev/null; then
        mise_command="$(command -v mise)"
    elif [[ -x "$HOME/.local/bin/mise" ]]; then
        mise_command="$HOME/.local/bin/mise"
    else
        command -v curl >/dev/null || { log_error 'mise の自動導入には curl が必要です'; exit 1; }
        log_info 'mise を ~/.local/bin/mise にインストールします'
        curl -fsSL https://mise.run | MISE_INSTALL_PATH="$HOME/.local/bin/mise" sh
        mise_command="$HOME/.local/bin/mise"
    fi
    "$mise_command" install "node@$PI_NODE_VERSION"
    node_bin="$("$mise_command" where "node@$PI_NODE_VERSION")/bin"
    [[ -x "$node_bin/node" && -x "$node_bin/npm" ]] || {
        log_error "mise の Node $PI_NODE_VERSION に node/npm が見つかりません: $node_bin"; exit 1;
    }
    export PATH="$node_bin:$PATH"
    "$node_bin/node" -e 'const [a,b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 19)) { console.error("Pi requires Node >=22.19.0"); process.exit(1); }'
    "$node_bin/npm" install --global --prefix "$prefix" "@earendil-works/pi-coding-agent@$PI_VERSION"
fi

mkdir -p "$agent_dir"
if [[ ! -e "$agent_dir/settings.json" && ! -L "$agent_dir/settings.json" ]]; then
    cp "$DOTFILES_ROOT/pi/settings.example.json" "$agent_dir/settings.json"
fi
if [[ ! -e "$agent_dir/AGENTS.md" && ! -L "$agent_dir/AGENTS.md" ]]; then
    ln -s "$DOTFILES_ROOT/pi/agent/AGENTS.md" "$agent_dir/AGENTS.md"
elif [[ "$(readlink "$agent_dir/AGENTS.md" || true)" != "$DOTFILES_ROOT/pi/agent/AGENTS.md" ]]; then
    log_warn "既存の $agent_dir/AGENTS.md を保持しました。原則は必要に応じて手動でマージしてください"
fi

# 個別リンクにして、利用者の他のPromptや同名ファイルを置換しない。
mkdir -p "$agent_dir/prompts"
for prompt in "$DOTFILES_ROOT/pi/prompts/"*.md; do
    target="$agent_dir/prompts/$(basename "$prompt")"
    if [[ ! -e "$target" && ! -L "$target" ]]; then
        ln -s "$prompt" "$target"
    elif [[ "$(readlink "$target" || true)" != "$prompt" ]]; then
        log_warn "既存Promptを保持しました: $target"
    fi
done

if [[ "$install" == true ]]; then
    # An explicit agent directory also prevents project-local installation.
    PI_CODING_AGENT_DIR="$agent_dir" "$prefix/bin/pi" install "$PONYTAIL_SOURCE"
    # Keep the selected Node available even outside a mise-enabled shell.
    mkdir -p "$prefix" "$HOME/.local/bin"
    {
        echo '#!/usr/bin/env bash'
        printf 'export PATH=%q:"$PATH"\n' "$node_bin"
        printf 'exec %q "$@"\n' "$prefix/bin/pi"
    } > "$prefix/launch-pi"
    chmod +x "$prefix/launch-pi"
    safe_symlink "$prefix/launch-pi" "$launcher"
    "$launcher" --version
    "$launcher" list
fi
log_info "Pi設定を適用しました: $agent_dir"
log_info 'PATH に ~/.local/bin を追加し、pi → /login → /model → /ponytail status を実行してください'
