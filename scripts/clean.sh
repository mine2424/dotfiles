#!/usr/bin/env bash
# clean.sh - 既存の設定ファイルをクリーニング

set -euo pipefail

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
DRY_RUN=false
COMPONENT="all"
FORCE=false

#######################################
# 使用方法を表示
#######################################
show_usage() {
    cat <<EOF
 使用方法: $(basename "$0") [オプション] [コンポーネント]
 
 既存の設定ファイルをクリーニングします。
 
 コンポーネント:
   --all              すべての設定をクリーニング（デフォルト）
   --nvim             Neovim設定のみ
   --shell            シェル設定のみ（Zsh, Bash）
   --terminal         ターミナル設定のみ（WezTerm, Starship）
   --cli              CLIツール設定のみ（Git, Zellij等）
 
 オプション:
   --dry-run          実際には削除せず、何が削除されるか表示
   --force            確認なしで実行
   -h, --help         このヘルプを表示
 
 例:
   # ドライランモード（何が削除されるか確認）
   $(basename "$0") --dry-run
 
   # すべての設定をクリーニング
   $(basename "$0") --all
 
   # Neovim設定のみクリーニング
   $(basename "$0") --nvim
 
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
# アイテムを削除（またはドライラン表示）
# Arguments:
#   $1 - パス
#   $2 - 説明
# Returns:
#   0 - 成功（または存在しない）
#   1 - 失敗
#######################################
remove_item() {
    local path="$1"
    local description="$2"
    
    # パスの展開
    path="${path/#\~/$HOME}"
    
    # 存在確認
    if [[ ! -e "$path" ]] && [[ ! -L "$path" ]]; then
        log_debug "スキップ（存在しません）: $description"
        return 0
    fi
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] 削除予定: $description"
        log_info "           パス: $path"
        return 0
    fi
    
    log_info "削除: $description"
    log_debug "パス: $path"
    
    if rm -rf "$path" 2>/dev/null; then
        return 0
    else
        log_error "削除に失敗しました: $path"
        return 1
    fi
}

#######################################
# Neovim設定をクリーニング
#######################################
clean_nvim() {
    log_section "Neovim設定のクリーニング"
    
    local items=(
        "$(get_config_dir nvim):Neovim設定ディレクトリ"
        "$(get_data_dir nvim):Neovimデータディレクトリ"
        "$(get_cache_dir nvim):Neovimキャッシュディレクトリ"
        "$HOME/.viminfo:Vim情報ファイル"
    )
    
    local removed_count=0
    for item in "${items[@]}"; do
        IFS=':' read -r path description <<< "$item"
        if remove_item "$path" "$description"; then
            ((removed_count++))
        fi
    done
    
    if [[ "$DRY_RUN" == "false" ]]; then
        log_success "Neovim設定をクリーニングしました（${removed_count}アイテム）"
    fi
}

#######################################
# シェル設定をクリーニング
#######################################
clean_shell() {
    log_section "シェル設定のクリーニング"
    
    local items=(
        "$HOME/.zshrc:Zsh設定ファイル"
        "$HOME/.zshenv:Zsh環境変数ファイル"
        "$HOME/.zprofile:Zshプロファイル"
        "$HOME/.zsh_history:Zsh履歴ファイル"
        "$(get_config_dir sheldon):Sheldon設定"
        "$HOME/.bashrc:Bash設定ファイル"
        "$HOME/.bash_profile:Bashプロファイル"
        "$HOME/.bash_history:Bash履歴ファイル"
    )
    
    local removed_count=0
    for item in "${items[@]}"; do
        IFS=':' read -r path description <<< "$item"
        if remove_item "$path" "$description"; then
            ((removed_count++))
        fi
    done
    
    if [[ "$DRY_RUN" == "false" ]]; then
        log_success "シェル設定をクリーニングしました（${removed_count}アイテム）"
    fi
}

#######################################
# ターミナル設定をクリーニング
#######################################
clean_terminal() {
    log_section "ターミナル設定のクリーニング"
    
    local items=(
        "$(get_config_dir wezterm):WezTerm設定"
        "$(get_config_dir starship.toml):Starship設定"
        "$(get_config_dir alacritty):Alacritty設定"
    )
    
    local removed_count=0
    for item in "${items[@]}"; do
        IFS=':' read -r path description <<< "$item"
        if remove_item "$path" "$description"; then
            ((removed_count++))
        fi
    done
    
    if [[ "$DRY_RUN" == "false" ]]; then
        log_success "ターミナル設定をクリーニングしました（${removed_count}アイテム）"
    fi
}

#######################################
# CLIツール設定をクリーニング
#######################################
clean_cli_tools() {
    log_section "CLIツール設定のクリーニング"
    
    local items=(
        "$HOME/.gitconfig:Git設定"
        "$HOME/.gitignore_global:Gitグローバル除外設定"
        "$(get_config_dir yazi):Yazi設定"
        "$HOME/.vimrc:Vim設定"
    )
    
    local removed_count=0
    for item in "${items[@]}"; do
        IFS=':' read -r path description <<< "$item"
        if remove_item "$path" "$description"; then
            ((removed_count++))
        fi
    done
    
    if [[ "$DRY_RUN" == "false" ]]; then
        log_success "CLIツール設定をクリーニングしました（${removed_count}アイテム）"
    fi
}

#######################################
# すべての設定をクリーニング
#######################################
clean_all() {
    clean_nvim
    clean_shell
    clean_terminal
    clean_cli_tools
}

#######################################
# クリーニング前の確認
#######################################
confirm_clean() {
    if [[ "$FORCE" == "true" ]]; then
        return 0
    fi
    
    if [[ "$DRY_RUN" == "true" ]]; then
        return 0
    fi
    
    echo ""
    log_warn "以下の設定がクリーニングされます:"
    
    case "$COMPONENT" in
        all)
            echo "  - Neovim設定"
            echo "  - シェル設定（Zsh, Bash）"
            echo "  - ターミナル設定（WezTerm, Starship）"
            echo "  - CLIツール設定（Git, Zellij等）"
            ;;
        nvim)
            echo "  - Neovim設定"
            ;;
        shell)
            echo "  - シェル設定（Zsh, Bash）"
            ;;
        terminal)
            echo "  - ターミナル設定（WezTerm, Starship）"
            ;;
        cli)
            echo "  - CLIツール設定（Git, Zellij等）"
            ;;
    esac
    
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
    log_section "クリーニング完了"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "ドライランモードで実行しました"
        log_info "実際にクリーニングするには --dry-run オプションを外してください"
    else
        log_success "クリーニングが完了しました"
    fi
}

#######################################
# メイン処理
#######################################
main() {
    # 引数の解析
    parse_arguments "$@"
    
    # ヘッダー表示
    log_section "Dotfiles クリーニングスクリプト"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "モード: ドライラン（実際には削除しません）"
    fi
    
    log_info "コンポーネント: $COMPONENT"
    
    # システム情報の表示
    log_debug "OS: $(detect_os)"
    log_debug "設定ディレクトリ: $(get_config_dir)"
    
    # 確認
    confirm_clean
    
    # クリーニングの実行
    case "$COMPONENT" in
        all)
            clean_all
            ;;
        nvim)
            clean_nvim
            ;;
        shell)
            clean_shell
            ;;
        terminal)
            clean_terminal
            ;;
        cli)
            clean_cli_tools
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
