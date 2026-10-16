#!/usr/bin/env bash
# setup.sh - メインセットアップスクリプト
# dotfilesの設定を適用し、必要なツールをインストール

set -uo pipefail

# スクリプトのディレクトリを取得
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ユーティリティ関数の読み込み
# shellcheck source=./utils/common.sh
source "$SCRIPT_DIR/utils/common.sh"
# shellcheck source=./utils/os-detect.sh
source "$SCRIPT_DIR/utils/os-detect.sh"
# shellcheck source=./utils/logger.sh
source "$SCRIPT_DIR/utils/logger.sh"

# グローバル変数
SCRIPT_VERSION="3.0.0"
DRY_RUN=false
FORCE=false
COMPONENT="all"
INSTALL_DEPENDENCIES=false

#######################################
# 使用方法を表示
#######################################
show_usage() {
    cat <<EOF
使用方法: $(basename "$0") [オプション] [コンポーネント]

dotfilesの設定を適用し、必要なツールをインストールします。

コンポーネント:
  --all              すべての設定を適用（デフォルト）
  --nvim             Neovim設定のみ
  --shell            シェル設定のみ（Zsh + Starship）
  --terminal         ターミナル設定のみ（WezTerm）
  --cli              CLIツール設定のみ（Git, Zellij等）
  --desktop          Cursor / Zed設定のみ
  --claude           Claude設定のみ
  --shogun           multi-agent-shogun設定のみ
  --ssh              SSH設定のみ（~/.ssh/config）
  --macos            macOSシステム設定のみ

 オプション:
   --install          依存関係もインストール（npmグローバルパッケージを含む）
   --dry-run          実際には適用せず、何が行われるか表示
   --force            確認なしで実行
   -h, --help         このヘルプを表示

例:
  # すべての設定を適用（設定ファイルのみ）
  $(basename "$0") --all

  # 依存関係もインストールしてフルセットアップ
  $(basename "$0") --all --install

  # Neovim設定のみ適用
  $(basename "$0") --nvim

  # ドライランモード
  $(basename "$0") --all --dry-run

EOF
}

#######################################
# 引数を解析
#######################################
parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --all)
                COMPONENT="all"
                shift
                ;;
            --nvim)
                COMPONENT="nvim"
                shift
                ;;
            --shell)
                COMPONENT="shell"
                shift
                ;;
            --terminal)
                COMPONENT="terminal"
                shift
                ;;
            --cli)
                COMPONENT="cli"
                shift
                ;;
            --desktop)
                COMPONENT="desktop"
                shift
                ;;
            --claude)
                COMPONENT="claude"
                shift
                ;;
            --shogun)
                COMPONENT="shogun"
                shift
                ;;
            --ssh)
                COMPONENT="ssh"
                shift
                ;;
            --macos)
                COMPONENT="macos"
                shift
                ;;
            --install)
                INSTALL_DEPENDENCIES=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --force)
                FORCE=true
                shift
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            *)
                log_error "不明なオプション: $1"
                show_usage
                exit 1
                ;;
        esac
    done
}

#######################################
# 必須要件を確認
#######################################
check_requirements() {
    log_section "必須要件の確認"
    
    local missing_commands=()
    
    # 基本コマンドの確認
    local required_commands=("git" "curl" "jq" "python3")
    
    for cmd in "${required_commands[@]}"; do
        if ! check_command "$cmd"; then
            missing_commands+=("$cmd")
        fi
    done
    
    if [[ ${#missing_commands[@]} -gt 0 ]]; then
        log_error "必須コマンドが見つかりません: ${missing_commands[*]}"
        log_info "以下のコマンドをインストールしてください"
        for cmd in "${missing_commands[@]}"; do
            echo "  - $cmd"
        done
        return 1
    fi
    
    log_success "すべての必須要件が満たされています"
    return 0
}

#######################################
# 依存関係をインストール
#######################################
install_dependencies() {
    log_section "依存関係のインストール"
    
    local os
    os="$(detect_os)"
    local pkg_manager
    pkg_manager="$(detect_package_manager)"
    
    log_info "OS: $os"
    log_info "パッケージマネージャ: $pkg_manager"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] 依存関係のインストールをスキップ"
        return 0
    fi
    
    case "$os" in
        "$OS_MACOS")
            install_dependencies_macos
            ;;
        "$OS_LINUX"|"$OS_WSL")
            install_dependencies_linux
            ;;
        *)
            log_error "未対応のOS: $os"
            return 1
            ;;
    esac
}

#######################################
# macOS用の依存関係をインストール
#######################################
install_dependencies_macos() {
    # Homebrewのインストール確認
    if ! check_command brew; then
        log_info "Homebrewをインストールしています..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi

    log_info "パッケージをインストールしています..."

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local brewfile="$dotfiles_root/Brewfile"

    if [[ -f "$brewfile" ]]; then
        log_info "Brewfileからインストール: $brewfile"
        brew bundle install --file="$brewfile" || log_warn "一部のパッケージのインストールに失敗しました"
    else
        # Brewfileがない場合のフォールバック（新規セットアップ時）
        log_warn "Brewfileが見つかりません: $brewfile"
        log_warn "scripts/backup.sh --brew を実行してBrewfileを生成してください"
        log_info "フォールバック: パッケージを直接インストールします..."
        brew install neovim ripgrep fd lazygit imagemagick tectonic luarocks plantuml \
            git zellij fzf bat eza yazi zsh sheldon starship mise \
            || log_warn "一部のパッケージのインストールに失敗しました"
        brew install --cask wezterm ghostty \
            || log_warn "一部のcaskパッケージのインストールに失敗しました"
    fi

    # Install the declared runtimes before restoring their global tools.
    mise -C "$dotfiles_root" install || return 1
    install_npm_packages

    log_success "依存関係のインストールが完了しました"
}

#######################################
# Linux用の依存関係をインストール
#######################################
install_dependencies_linux() {
    local distro
    distro="$(detect_linux_distro)"
    
    log_info "ディストリビューション: $distro"
    
    case "$distro" in
        ubuntu|debian)
            install_dependencies_debian
            ;;
        fedora|rhel)
            install_dependencies_fedora
            ;;
        arch|manjaro)
            install_dependencies_arch
            ;;
        *)
            log_warn "未対応のディストリビューション: $distro"
            log_info "手動でパッケージをインストールしてください"
            return 1
            ;;
    esac
}

#######################################
# Debian/Ubuntu用の依存関係をインストール
#######################################
install_dependencies_debian() {
    sudo apt update
    
    local packages=()
    
    case "$COMPONENT" in
        all|nvim)
            packages+=("neovim" "ripgrep" "fd-find")
            ;;
    esac
    
    case "$COMPONENT" in
        all|shell)
            packages+=("zsh")
            ;;
    esac
    
    case "$COMPONENT" in
        all|cli)
            packages+=("git" "zellij" "fzf")
            ;;
    esac
    
    if [[ ${#packages[@]} -gt 0 ]]; then
        sudo apt install -y "${packages[@]}" || log_warn "一部のパッケージのインストールに失敗しました"
    fi
    
    # Sheldonのインストール
    if [[ "$COMPONENT" == "all" ]] || [[ "$COMPONENT" == "shell" ]]; then
        if ! check_command sheldon; then
            log_info "Sheldonをインストールしています..."
            curl --proto '=https' -fLsS https://rossmacarthur.github.io/install/crate.sh | \
                bash -s -- --repo rossmacarthur/sheldon --to ~/.local/bin
        fi
    fi
    
    # Starshipのインストール
    if [[ "$COMPONENT" == "all" ]] || [[ "$COMPONENT" == "shell" ]]; then
        if ! check_command starship; then
            log_info "Starshipをインストールしています..."
            curl -sS https://starship.rs/install.sh | sh -s -- --yes
        fi
    fi
    
    log_success "依存関係のインストールが完了しました"
}

#######################################
# Fedora/RHEL用の依存関係をインストール
#######################################
install_dependencies_fedora() {
    log_warn "Fedora/RHELのサポートは未実装です"
    return 1
}

#######################################
# Arch用の依存関係をインストール
#######################################
install_dependencies_arch() {
    log_warn "Archのサポートは未実装です"
    return 1
}

#######################################
# Neovim設定を適用
#######################################
setup_nvim() {
    log_section "Neovim設定の適用"
    
    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local nvim_config_src="$dotfiles_root/nvim"
    local nvim_config_dest="$(get_config_dir nvim)"
    
    if [[ ! -d "$nvim_config_src" ]]; then
        log_warn "Neovim設定が見つかりません: $nvim_config_src"
        log_info "後で実装します"
        return 0
    fi
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] Neovim設定を適用: $nvim_config_src -> $nvim_config_dest"
        return 0
    fi
    
    # シンボリックリンクの作成
    if safe_symlink "$nvim_config_src" "$nvim_config_dest"; then
        log_success "Neovim設定を適用しました"
    else
        log_error "Neovim設定の適用に失敗しました"
        return 1
    fi
}

#######################################
# シェル設定を適用
#######################################
setup_shell() {
    log_section "シェル設定の適用"

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"

    apply_config_files shell

    # Zsh設定
    local zshrc_src="$dotfiles_root/zsh/zshrc"
    local zshrc_dest="$HOME/.zshrc"

    if [[ -f "$zshrc_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] Zsh設定を適用: $zshrc_src -> $zshrc_dest"
        else
            if safe_symlink "$zshrc_src" "$zshrc_dest"; then
                log_success "Zsh設定を適用しました"
            fi
        fi
    fi

    # Zshローカル設定（zellij auto-start等）
    local zshrc_local_src="$dotfiles_root/zsh/zshrc.local"
    local zshrc_local_dest="$HOME/.zshrc.local"

    if [[ -f "$zshrc_local_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] Zshローカル設定を適用: $zshrc_local_src -> $zshrc_local_dest"
        else
            if safe_symlink "$zshrc_local_src" "$zshrc_local_dest"; then
                log_success "Zshローカル設定を適用しました"
            fi
        fi
    fi

    # Sheldon設定
    local sheldon_src="$dotfiles_root/zsh/sheldon"
    local sheldon_dest="$(get_config_dir sheldon)"

    if [[ -d "$sheldon_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] Sheldon設定を適用: $sheldon_src -> $sheldon_dest"
        else
            if safe_symlink "$sheldon_src" "$sheldon_dest"; then
                log_success "Sheldon設定を適用しました"
            fi
        fi
    fi

    # Starship設定
    local starship_config_src="$dotfiles_root/starship/.config/starship.toml"
    local starship_config_dest="$HOME/.config/starship.toml"

    if [[ -f "$starship_config_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] Starship設定を適用: $starship_config_src -> $starship_config_dest"
        else
            safe_symlink "$starship_config_src" "$starship_config_dest" || return 1
        fi
    else
        log_warn "Starship設定が見つかりません: $starship_config_src"
    fi
}

#######################################
# ターミナル設定を適用
#######################################
setup_terminal() {
    log_section "ターミナル設定の適用"

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"

    # WezTerm設定
    local wezterm_src="$dotfiles_root/wezterm"
    local wezterm_dest="$(get_config_dir wezterm)"

    if [[ -d "$wezterm_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] WezTerm設定を適用: $wezterm_src -> $wezterm_dest"
        else
            if safe_symlink "$wezterm_src" "$wezterm_dest"; then
                log_success "WezTerm設定を適用しました"
            fi
        fi
    fi

    # Ghostty設定
    local ghostty_src="$dotfiles_root/ghostty"
    local ghostty_dest="$(get_config_dir ghostty)"

    if [[ -d "$ghostty_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] Ghostty設定を適用: $ghostty_src -> $ghostty_dest"
        else
            if safe_symlink "$ghostty_src" "$ghostty_dest"; then
                log_success "Ghostty設定を適用しました"
            fi
        fi
    fi
}

#######################################
# CLIツール設定を適用
#######################################
setup_cli_tools() {
    log_section "CLIツール設定の適用"

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"

    apply_config_files cli

    # Zellij設定
    local zellij_src="$dotfiles_root/zellij"
    local zellij_dest="$(get_config_dir zellij)"

    if [[ -d "$zellij_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] Zellij設定を適用: $zellij_src -> $zellij_dest"
        else
            safe_symlink "$zellij_src" "$zellij_dest" || return 1
        fi
    fi

    # Yazi設定
    local yazi_src="$dotfiles_root/yazi/.config/yazi"
    local yazi_dest="$(get_config_dir yazi)"

    if [[ -d "$yazi_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] Yazi設定を適用: $yazi_src -> $yazi_dest"
        else
            if safe_symlink "$yazi_src" "$yazi_dest"; then
                log_success "Yazi設定を適用しました"
            fi
        fi
    fi

    # mise設定
    local mise_src="$dotfiles_root/mise"
    local mise_dest="$(get_config_dir mise)"

    if [[ -d "$mise_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] mise設定を適用: $mise_src -> $mise_dest"
        else
            if safe_symlink "$mise_src" "$mise_dest"; then
                log_success "mise設定を適用しました"
            fi
        fi
    fi


}

# Apply only explicitly listed files; never replace an application state directory.
apply_config_files() {
    local args=(apply --group "$1")
    [[ "$DRY_RUN" == "true" ]] && args+=(--dry-run)
    python3 "$SCRIPT_DIR/config-files.py" "${args[@]}"
}

setup_desktop() {
    apply_config_files desktop
}

#######################################
# Claude設定を適用
#######################################
setup_claude() {
    log_section "Claude設定の適用"

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local claude_src="$dotfiles_root/.claude"
    local claude_dest="$HOME/.claude"

    if [[ ! -d "$claude_src" ]]; then
        log_warn "Claude設定が見つかりません: $claude_src"
        return 0
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] Claude設定をマージ: $claude_src -> $claude_dest"
        return 0
    fi

    # ターゲットディレクトリが無ければ作成（既存は削除しない）
    [[ ! -d "$claude_dest" ]] && mkdir -p "$claude_dest"

    # 1. scripts ディレクトリをコピー
    if [[ -d "$claude_src/scripts" ]]; then
        mkdir -p "$claude_dest/scripts"
        cp -r "$claude_src/scripts/"* "$claude_dest/scripts/" 2>/dev/null
        chmod +x "$claude_dest/scripts/"*.sh 2>/dev/null
        log_success "Claude scripts を適用しました"
    fi

    # 2. settings.local.json をコピー（allow list は dotfiles が完全管理）
    if [[ -f "$claude_src/settings.local.json" ]]; then
        cp "$claude_src/settings.local.json" "$claude_dest/settings.local.json"
        log_success "Claude settings.local.json を適用しました"
    fi

    # 3. settings.json をマージ（permissions + hooks は dotfiles、それ以外は既存を保持）
    if [[ -f "$claude_src/settings.json" ]]; then
        if [[ -f "$claude_dest/settings.json" ]] && command -v jq &>/dev/null; then
            local tmp_merged
            tmp_merged="$(jq -s '
                .[0] as $home | .[1] as $dotfiles |
                $home * {
                    permissions: $dotfiles.permissions,
                    hooks: $dotfiles.hooks
                } * {
                    enabledPlugins: (($home.enabledPlugins // {}) * ($dotfiles.enabledPlugins // {})),
                    extraKnownMarketplaces: (($home.extraKnownMarketplaces // {}) * ($dotfiles.extraKnownMarketplaces // {}))
                }
            ' "$claude_dest/settings.json" "$claude_src/settings.json")"
            echo "$tmp_merged" > "$claude_dest/settings.json"
            log_success "Claude settings.json をマージしました"
        else
            cp "$claude_src/settings.json" "$claude_dest/settings.json"
            log_success "Claude settings.json を適用しました"
        fi
    fi

    # 4. agents, commands, rules ディレクトリをコピー（dotfiles が完全管理）
    local claude_dirs=("agents" "commands" "rules")
    for dir in "${claude_dirs[@]}"; do
        if [[ -d "$claude_src/$dir" ]]; then
            rm -rf "$claude_dest/$dir"
            cp -r "$claude_src/$dir" "$claude_dest/$dir"
            log_success "Claude $dir を適用しました"
        fi
    done

    # 5. プラグインの自動インストール
    if command -v claude &>/dev/null && command -v jq &>/dev/null; then
        log_info "Claude プラグインの同期を開始します..."

        # dotfiles の settings.json から管理対象のマーケットプレイスとプラグインを取得
        local marketplaces plugins
        marketplaces="$(jq -r '.extraKnownMarketplaces // {} | to_entries[] | "\(.key)=\(.value.source.source):\(.value.source.repo // .value.source.path)"' "$claude_src/settings.json" 2>/dev/null)"
        plugins="$(jq -r '.enabledPlugins // {} | keys[]' "$claude_src/settings.json" 2>/dev/null)"

        # マーケットプレイスの登録（未登録のもののみ）
        local known_marketplaces_file="$claude_dest/plugins/known_marketplaces.json"
        while IFS='=' read -r mp_name mp_source; do
            [[ -z "$mp_name" ]] && continue
            if [[ -f "$known_marketplaces_file" ]] && jq -e --arg name "$mp_name" '.[$name]' "$known_marketplaces_file" &>/dev/null; then
                log_info "マーケットプレイス '$mp_name' は登録済みです"
            else
                local source_type="${mp_source%%:*}"
                local source_value="${mp_source#*:}"
                if [[ "$source_type" == "github" ]]; then
                    log_info "マーケットプレイス '$mp_name' を登録中..."
                    if claude plugin marketplace add "$source_value" 2>&1; then
                        log_success "マーケットプレイス '$mp_name' を登録しました"
                    else
                        log_warn "マーケットプレイス '$mp_name' の登録に失敗しました"
                    fi
                elif [[ "$source_type" == "directory" ]]; then
                    log_info "ローカルマーケットプレイス '$mp_name' を登録中..."
                    if claude plugin marketplace add "$source_value" 2>&1; then
                        log_success "マーケットプレイス '$mp_name' を登録しました"
                    else
                        log_warn "マーケットプレイス '$mp_name' の登録に失敗しました"
                    fi
                fi
            fi
        done <<< "$marketplaces"

        # プラグインのインストール（未インストールのもののみ）
        local installed_plugins_file="$claude_dest/plugins/installed_plugins.json"
        while IFS= read -r plugin_name; do
            [[ -z "$plugin_name" ]] && continue
            if [[ -f "$installed_plugins_file" ]] && jq -e --arg name "$plugin_name" '.plugins[$name]' "$installed_plugins_file" &>/dev/null; then
                log_info "プラグイン '$plugin_name' はインストール済みです"
            else
                log_info "プラグイン '$plugin_name' をインストール中..."
                if claude plugin install "$plugin_name" 2>&1; then
                    log_success "プラグイン '$plugin_name' をインストールしました"
                else
                    log_warn "プラグイン '$plugin_name' のインストールに失敗しました（ネットワーク接続を確認してください）"
                fi
            fi
        done <<< "$plugins"
    else
        log_warn "claude CLI が見つかりません。プラグインの手動インストールが必要です"
        log_info "  claude plugin marketplace add samber/cc-skills-golang"
        log_info "  claude plugin install cc-skills-golang@samber"
    fi

    log_success "Claude設定の適用が完了しました"
}

#######################################
# multi-agent-shogun設定を適用
#######################################
setup_shogun() {
    log_section "multi-agent-shogun設定の適用"

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local shogun_src="$dotfiles_root/shogun"
    local shogun_home="$HOME/.local/share/shogun"
    local upstream_repo="https://github.com/yohey-w/multi-agent-shogun.git"

    if [[ ! -d "$shogun_src" ]]; then
        log_warn "shogun設定が見つかりません: $shogun_src"
        return 0
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] shogun設定を適用: $shogun_src -> $shogun_home"
        log_info "[DRY RUN] upstream clone: $upstream_repo -> $shogun_home/upstream/"
        log_info "[DRY RUN] bin/ リンク: $shogun_src/bin/* -> ~/.local/bin/"
        log_info "[DRY RUN] Zellij レイアウト: shogun.kdl -> ~/.config/zellij/layouts/"
        return 0
    fi

    # 1. 依存チェック
    local missing_deps=()
    command -v zellij >/dev/null 2>&1 || missing_deps+=("zellij")
    command -v python3 >/dev/null 2>&1 || missing_deps+=("python3")
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log_warn "shogun の依存が不足しています: ${missing_deps[*]}"
        log_info "brew install ${missing_deps[*]} でインストールしてください"
        return 0
    fi

    # 2. ディレクトリ作成
    mkdir -p "$shogun_home"
    mkdir -p "$HOME/.local/bin"

    # 3. upstream clone / pull
    if [[ -d "$shogun_home/upstream/.git" ]]; then
        log_info "upstream を更新しています..."
        git -C "$shogun_home/upstream" pull origin main --quiet 2>/dev/null || true
    else
        log_info "upstream を clone しています..."
        git clone --quiet "$upstream_repo" "$shogun_home/upstream"
    fi
    local ref
    ref="$(git -C "$shogun_home/upstream" rev-parse HEAD)"
    echo "$ref" > "$shogun_home/.upstream-ref"
    log_success "upstream ref: ${ref:0:12}"

    # 4. lib/, scripts/ を upstream からコピー
    for dir in lib scripts; do
        if [[ -d "$shogun_home/upstream/$dir" ]]; then
            rm -rf "${shogun_home:?}/$dir"
            cp -r "$shogun_home/upstream/$dir" "$shogun_home/$dir"
            find "$shogun_home/$dir" -name "*.sh" -exec chmod +x {} \;
        fi
    done
    log_success "lib/, scripts/ をコピーしました"

    # 5. instructions をマージ（upstream + dotfiles オーバーライド）
    if [[ -d "$shogun_home/upstream/instructions" ]]; then
        rm -rf "${shogun_home:?}/instructions"
        cp -r "$shogun_home/upstream/instructions" "$shogun_home/instructions"
    fi
    if [[ -d "$shogun_src/instructions" ]] && [[ -n "$(ls -A "$shogun_src/instructions" 2>/dev/null)" ]]; then
        cp -r "$shogun_src/instructions"/* "$shogun_home/instructions/" 2>/dev/null || true
    fi
    log_success "instructions/ をマージしました"

    # 6. skills をマージ
    if [[ -d "$shogun_home/upstream/skills" ]]; then
        rm -rf "${shogun_home:?}/skills"
        cp -r "$shogun_home/upstream/skills" "$shogun_home/skills"
    fi
    if [[ -d "$shogun_src/skills" ]] && [[ -n "$(ls -A "$shogun_src/skills" 2>/dev/null)" ]]; then
        cp -r "$shogun_src/skills"/* "$shogun_home/skills/" 2>/dev/null || true
    fi
    log_success "skills/ をマージしました"

    # 7. config をマージ（dotfiles 優先）
    mkdir -p "$shogun_home/config"
    if [[ -d "$shogun_home/upstream/config" ]]; then
        cp -r "$shogun_home/upstream/config"/* "$shogun_home/config/" 2>/dev/null || true
    fi
    if [[ -d "$shogun_src/config" ]]; then
        cp -r "$shogun_src/config"/* "$shogun_home/config/"
    fi
    log_success "config/ をマージしました"

    # 8. Python venv
    if [[ ! -d "$shogun_home/.venv" ]]; then
        log_info "Python venv を作成しています..."
        python3 -m venv "$shogun_home/.venv"
        "$shogun_home/.venv/bin/pip" install --quiet PyYAML
        log_success "venv を作成しました"
    fi

    # 9. bin/ スクリプトをシンボリックリンク
    if [[ -d "$shogun_src/bin" ]]; then
        for script in "$shogun_src/bin"/*; do
            local name
            name="$(basename "$script")"
            chmod +x "$script"
            ln -sf "$script" "$HOME/.local/bin/$name"
        done
        log_success "bin/ スクリプトをリンクしました"
    fi

    # 10. Zellij shogun レイアウトをコピー
    local zellij_layouts_src="$dotfiles_root/zellij/layouts"
    local zellij_layouts_dest
    zellij_layouts_dest="$(get_config_dir)/zellij/layouts"
    if [[ -f "$zellij_layouts_src/shogun.kdl" ]]; then
        mkdir -p "$zellij_layouts_dest"
        cp "$zellij_layouts_src/shogun.kdl" "$zellij_layouts_dest/shogun.kdl"
        log_success "Zellij shogun レイアウトを適用しました"
    fi

    log_success "multi-agent-shogun設定の適用が完了しました"
}

#######################################
# SSH設定を適用
#######################################
setup_ssh() {
    log_section "SSH設定の適用"

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local ssh_src="$dotfiles_root/ssh/config"
    local ssh_dir="$HOME/.ssh"
    local ssh_dest="$ssh_dir/config"

    if [[ ! -f "$ssh_src" ]]; then
        log_warn "SSH設定が見つかりません: $ssh_src"
        log_info "backup.sh --ssh でバックアップしてください"
        return 0
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] SSH設定を適用: $ssh_src -> $ssh_dest"
        return 0
    fi

    # ~/.ssh/ ディレクトリを作成
    safe_mkdir "$ssh_dir" || return 1
    chmod 700 "$ssh_dir"

    # 既存の ~/.ssh/config をバックアップ
    if [[ -f "$ssh_dest" ]]; then
        local backup_dest="${ssh_dest}.bak.$(date '+%Y%m%d%H%M%S')"
        log_info "既存のSSH設定をバックアップ: $backup_dest"
        cp "$ssh_dest" "$backup_dest" || log_warn "バックアップに失敗しました"
    fi

    # ファイルをコピーして権限を設定
    if cp "$ssh_src" "$ssh_dest" 2>/dev/null; then
        chmod 600 "$ssh_dest"
        log_success "SSH設定を適用しました: $ssh_dest"
    else
        log_error "SSH設定の適用に失敗しました"
        return 1
    fi
}

#######################################
# macOSシステム設定を適用
#######################################
apply_macos_defaults() {
    log_section "macOSシステム設定の適用"

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local macos_script="$dotfiles_root/macos/defaults.sh"

    if [[ ! -f "$macos_script" ]]; then
        log_warn "macOS設定スクリプトが見つかりません: $macos_script"
        log_info "backup.sh --macos でバックアップしてください"
        return 0
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] 以下のmacOS設定を適用します:"
        cat "$macos_script"
        return 0
    fi

    log_info "macOS設定を適用中..."
    if bash "$macos_script"; then
        log_success "macOS設定を適用しました"
        log_info "ターミナルの再起動が必要な場合があります"
    else
        log_error "macOS設定の適用に失敗しました"
        return 1
    fi
}

#######################################
# npmグローバルパッケージをインストール
#######################################
install_npm_packages() {
    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local packages_file="$dotfiles_root/npm/packages.txt"

    if ! check_command npm; then
        log_warn "npmが見つかりません。npmグローバルパッケージのインストールをスキップします"
        return 0
    fi

    if [[ ! -f "$packages_file" ]]; then
        log_warn "npmパッケージ一覧が見つかりません: $packages_file"
        log_info "backup.sh --npm でバックアップしてください"
        return 0
    fi

    local node_bin=""
    if check_command mise; then
        node_bin="$(mise -C "$dotfiles_root" where node)/bin" || return 1
    else
        node_bin="$(dirname "$(command -v node)")"
    fi

    log_info "npmグローバルパッケージをインストール中..."

    while IFS= read -r package; do
        [[ -z "$package" ]] && continue
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] npm install -g $package"
        else
            log_info "インストール: $package"
            env PATH="$node_bin:$PATH" npm install -g "$package" || log_warn "$package のインストールに失敗しました"
        fi
    done < "$packages_file"

    if [[ "$DRY_RUN" != "true" ]]; then
        log_success "npmグローバルパッケージのインストールが完了しました"
    fi
}

#######################################
# すべての設定を適用
#######################################
setup_all() {
    setup_nvim
    setup_shell
    setup_terminal
    setup_cli_tools
    setup_desktop
    setup_claude
    setup_shogun
    setup_ssh
    apply_macos_defaults
}

#######################################
# セットアップ前の確認
#######################################
confirm_setup() {
    if [[ "$FORCE" == "true" ]]; then
        return 0
    fi
    
    if [[ "$DRY_RUN" == "true" ]]; then
        return 0
    fi
    
    echo ""
    log_warn "以下の設定が適用されます:"
    
    case "$COMPONENT" in
        all)
            echo "  - Neovim設定"
            echo "  - シェル設定（Zsh + Starship）"
            echo "  - ターミナル設定（WezTerm + Ghostty）"
            echo "  - CLIツール設定（Git, Zellij等）"
            echo "  - Claude設定"
            echo "  - multi-agent-shogun設定"
            echo "  - SSH設定（~/.ssh/config）"
            echo "  - macOSシステム設定"
            ;;
        nvim)
            echo "  - Neovim設定"
            ;;
        shell)
            echo "  - シェル設定（Zsh + Starship）"
            ;;
        terminal)
            echo "  - ターミナル設定（WezTerm + Ghostty）"
            ;;
        cli)
            echo "  - CLIツール設定（Git, Zellij, mise等）"
            ;;
        claude)
            echo "  - Claude設定"
            ;;
        shogun)
            echo "  - multi-agent-shogun設定"
            ;;
        ssh)
            echo "  - SSH設定（~/.ssh/config）"
            ;;
        macos)
            echo "  - macOSシステム設定"
            ;;
    esac
    
    echo ""
    
    if [[ "$INSTALL_DEPENDENCIES" == "true" ]]; then
        log_info "依存関係もインストールされます"
    fi
    
    echo ""
    
    if ! confirm "続行しますか？" "n"; then
        log_info "キャンセルしました"
        exit 0
    fi
}

#######################################
# サマリーを表示
#######################################
show_summary() {
    log_section "セットアップ完了"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "ドライランモードで実行しました"
        log_info "実際にセットアップするには --dry-run オプションを外してください"
    else
        log_success "セットアップが完了しました"
        
        echo ""
        log_info "次のステップ:"
        echo "  1. シェルを再起動: exec \$SHELL"
        echo "  2. 設定を確認: $(basename "$0") --help"
        echo "  3. 検証を実行: ./scripts/verify-setup.sh"
    fi
}

#######################################
# メイン処理
#######################################
main() {
    # 引数の解析
    parse_arguments "$@"
    
    # ヘッダー表示
    log_section "Dotfiles セットアップスクリプト v${SCRIPT_VERSION}"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "モード: ドライラン（実際には適用しません）"
    fi
    
    log_info "コンポーネント: $COMPONENT"
    
    # システム情報の表示
    log_debug "OS: $(detect_os)"
    log_debug "設定ディレクトリ: $(get_config_dir)"
    
    # 必須要件の確認
    if ! check_requirements; then
        exit 1
    fi
    
    # 確認
    confirm_setup
    
    # 依存関係のインストール
    if [[ "$INSTALL_DEPENDENCIES" == "true" ]]; then
        install_dependencies
    fi
    
    # セットアップの実行
    case "$COMPONENT" in
        all)
            setup_all
            ;;
        nvim)
            setup_nvim
            ;;
        shell)
            setup_shell
            ;;
        terminal)
            setup_terminal
            ;;
        cli)
            setup_cli_tools
            ;;
        desktop)
            setup_desktop
            ;;
        claude)
            setup_claude
            ;;
        shogun)
            setup_shogun
            ;;
        ssh)
            setup_ssh
            ;;
        macos)
            apply_macos_defaults
            ;;
        *)
            log_error "不明なコンポーネント: $COMPONENT"
            exit 1
            ;;
    esac
    
    # サマリー表示
    show_summary
}

# スクリプトの実行
main "$@"
