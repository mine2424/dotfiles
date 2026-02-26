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
  --claude           Claude設定のみ
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
            --claude)
                COMPONENT="claude"
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
    local required_commands=("git" "curl")
    
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
        brew install neovim ripgrep fd lazygit imagemagick tectonic luarocks \
            git zellij fzf bat eza yazi zsh sheldon starship mise \
            || log_warn "一部のパッケージのインストールに失敗しました"
        brew install --cask wezterm ghostty \
            || log_warn "一部のcaskパッケージのインストールに失敗しました"
    fi

    # npmグローバルパッケージのインストール
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
            # 既存設定を削除
            if [[ -e "$starship_config_dest" ]]; then
                log_warn "既存設定を削除: $starship_config_dest"
                rm -rf "$starship_config_dest"
            fi

            # ファイルをコピー
            if cp "$starship_config_src" "$starship_config_dest" 2>/dev/null; then
                log_success "Starship設定を適用しました"
            else
                log_error "Starship設定の適用に失敗しました"
                log_error "ソース: $starship_config_src"
                log_error "ターゲット: $starship_config_dest"
                return 1
            fi
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

    # Zellij設定
    local zellij_src="$dotfiles_root/zellij"
    local zellij_dest="$(get_config_dir zellij)"

    if [[ -d "$zellij_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] Zellij設定を適用: $zellij_src -> $zellij_dest"
        else
            # Zellij設定はディレクトリをコピー（シンボリックリンクではなく）
            # 既存設定を削除
            if [[ -e "$zellij_dest" ]] || [[ -L "$zellij_dest" ]]; then
                log_warn "既存設定を削除: $zellij_dest"
                rm -rf "$zellij_dest"
            fi

            # ディレクトリをコピー
            if cp -r "$zellij_src" "$zellij_dest" 2>/dev/null; then
                log_success "Zellij設定を適用しました"
            else
                log_error "Zellij設定の適用に失敗しました"
                return 1
            fi
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

    # Git設定
    local gitconfig_src="$dotfiles_root/.gitconfig"
    local gitconfig_dest="$HOME/.gitconfig"

    if [[ -f "$gitconfig_src" ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] Git設定を適用: $gitconfig_src -> $gitconfig_dest"
        else
            if safe_symlink "$gitconfig_src" "$gitconfig_dest"; then
                log_success "Git設定を適用しました"
            fi
        fi
    fi
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
        log_info "[DRY RUN] Claude設定を適用: $claude_src -> $claude_dest"
        return 0
    fi
    
    # ディレクトリをコピー（シンボリックリンクではなく、ファイルをコピー）
    # これは.claudeディレクトリ全体をコピーするため
    # 既存設定を削除
    if [[ -e "$claude_dest" ]] || [[ -L "$claude_dest" ]]; then
        log_warn "既存設定を削除: $claude_dest"
        rm -rf "$claude_dest"
    fi
    
    # ディレクトリをコピー
    if cp -r "$claude_src" "$claude_dest" 2>/dev/null; then
        # deny-check.shに実行権限を付与
        if [[ -f "$claude_dest/scripts/deny-check.sh" ]]; then
            chmod +x "$claude_dest/scripts/deny-check.sh"
        fi
        log_success "Claude設定を適用しました"
        return 0
    else
        log_error "Claude設定の適用に失敗しました"
        return 1
    fi
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

    log_info "npmグローバルパッケージをインストール中..."

    while IFS= read -r package; do
        [[ -z "$package" ]] && continue
        if [[ "$DRY_RUN" == "true" ]]; then
            log_info "[DRY RUN] npm install -g $package"
        else
            log_info "インストール: $package"
            npm install -g "$package" || log_warn "$package のインストールに失敗しました"
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
    setup_claude
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
        claude)
            setup_claude
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
