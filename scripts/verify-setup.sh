#!/usr/bin/env bash
# verify-setup.sh - セットアップの検証
# インストールされた設定とツールを検証

set -euo pipefail

# スクリプトのディレクトリを取得
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ユーティリティ関数の読み込み
# shellcheck source=./utils/common.sh
source "$SCRIPT_DIR/utils/common.sh"
# shellcheck source=./utils/os-detect.sh
source "$SCRIPT_DIR/utils/os-detect.sh"

# グローバル変数
VERBOSE=false
COMPONENT="all"
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_WARNINGS=0

#######################################
# 使用方法を表示
#######################################
show_usage() {
    cat <<EOF
使用方法: $(basename "$0") [オプション] [コンポーネント]

セットアップの検証を行います。

コンポーネント:
  --all              すべての設定を検証（デフォルト）
  --nvim             Neovim設定のみ検証
  --shell            シェル設定のみ検証
  --terminal         ターミナル設定のみ検証
  --cli              CLIツール設定のみ検証

オプション:
  --verbose          詳細な情報を表示
  -h, --help         このヘルプを表示

例:
  # すべての設定を検証
  $(basename "$0") --all

  # Neovim設定のみ検証
  $(basename "$0") --nvim

  # 詳細モードで検証
  $(basename "$0") --all --verbose

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
            --verbose)
                VERBOSE=true
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
# テストを実行
# Arguments:
#   $1 - テスト名
#   $2 - テストコマンド（成功時は0を返す）
#   $3 - 重要度（critical/warning、デフォルトはcritical）
# Returns:
#   0 - テスト成功
#   1 - テスト失敗
#######################################
run_test() {
    local test_name="$1"
    local test_command="$2"
    local severity="${3:-critical}"
    
    if [[ "$VERBOSE" == "true" ]]; then
        log_info "テスト: $test_name"
    fi
    
    if eval "$test_command" >/dev/null 2>&1; then
        if [[ "$VERBOSE" == "true" ]]; then
            log_success "✓ $test_name"
        fi
        ((TESTS_PASSED++))
        return 0
    else
        if [[ "$severity" == "warning" ]]; then
            log_warn "⚠ $test_name"
            ((TESTS_WARNINGS++))
        else
            log_error "✗ $test_name"
            ((TESTS_FAILED++))
        fi
        return 1
    fi
}

#######################################
# ファイルの存在を確認
# Arguments:
#   $1 - ファイルパス
#   $2 - 説明
#   $3 - 重要度（オプション）
#######################################
verify_file_exists() {
    local file_path="$1"
    local description="$2"
    local severity="${3:-critical}"
    
    # パスの展開
    file_path="${file_path/#\~/$HOME}"
    
    run_test "$description" "test -e '$file_path'" "$severity"
}

#######################################
# シンボリックリンクを確認
# Arguments:
#   $1 - リンクパス
#   $2 - 説明
#   $3 - 重要度（オプション）
#######################################
verify_symlink() {
    local link_path="$1"
    local description="$2"
    local severity="${3:-critical}"
    
    # パスの展開
    link_path="${link_path/#\~/$HOME}"
    
    run_test "$description" "test -L '$link_path'" "$severity"
}

#######################################
# コマンドの存在を確認
# Arguments:
#   $1 - コマンド名
#   $2 - 説明
#   $3 - 重要度（オプション）
#######################################
verify_command_exists() {
    local command_name="$1"
    local description="$2"
    local severity="${3:-critical}"
    
    run_test "$description" "command -v '$command_name' >/dev/null 2>&1" "$severity"
}

#######################################
# 設定ファイルの構文を確認
# Arguments:
#   $1 - ファイルパス
#   $2 - チェックコマンド
#   $3 - 説明
#######################################
verify_config_syntax() {
    local file_path="$1"
    local check_command="$2"
    local description="$3"
    
    # パスの展開
    file_path="${file_path/#\~/$HOME}"
    
    if [[ ! -f "$file_path" ]]; then
        if [[ "$VERBOSE" == "true" ]]; then
            log_debug "スキップ: $description（ファイルが存在しません）"
        fi
        return 0
    fi
    
    run_test "$description" "$check_command '$file_path'" "warning"
}

#######################################
# Neovim設定を検証
#######################################
verify_nvim() {
    log_section "Neovim設定の検証"
    
    # Neovimコマンドの存在確認
    verify_command_exists "nvim" "Neovimコマンド" "critical"
    
    # 設定ファイルの存在確認
    local nvim_config="$(get_config_dir nvim)"
    verify_file_exists "$nvim_config" "Neovim設定ディレクトリ" "critical"
    verify_file_exists "$nvim_config/init.lua" "Neovim初期化ファイル" "warning"
    
    # Neovimの起動テスト
    if check_command nvim; then
        run_test "Neovim起動テスト" "nvim --headless +quit" "warning"
    fi
    
    # LSP関連ツールの確認
    verify_command_exists "node" "Node.js（LSP用）" "warning"
    verify_command_exists "npm" "npm（LSP用）" "warning"
    verify_command_exists "git" "Git（プラグイン管理用）" "critical"
}

#######################################
# シェル設定を検証
#######################################
verify_shell() {
    log_section "シェル設定の検証"
    
    # Zshの確認
    verify_command_exists "zsh" "Zshコマンド" "critical"
    verify_file_exists "$HOME/.zshrc" "Zsh設定ファイル" "critical"
    
    # Sheldonの確認
    verify_command_exists "sheldon" "Sheldonコマンド" "warning"
    verify_file_exists "$(get_config_dir sheldon)/plugins.toml" "Sheldonプラグイン設定" "warning"
    
    # Starshipの確認
    verify_command_exists "starship" "Starshipコマンド" "warning"
    
    # Zshの構文チェック
    if check_command zsh; then
        run_test "Zsh設定の構文チェック" "zsh -n '$HOME/.zshrc'" "warning"
    fi
}

#######################################
# ターミナル設定を検証
#######################################
verify_terminal() {
    log_section "ターミナル設定の検証"
    
    # WezTermの確認
    verify_command_exists "wezterm" "WezTermコマンド" "warning"
    verify_file_exists "$(get_config_dir wezterm)/wezterm.lua" "WezTerm設定ファイル" "warning"
    
    # WezTermの構文チェック
    if check_command wezterm; then
        local wezterm_config="$(get_config_dir wezterm)/wezterm.lua"
        if [[ -f "$wezterm_config" ]]; then
            run_test "WezTerm設定の構文チェック" "wezterm --config-file '$wezterm_config' --version" "warning"
        fi
    fi
}

#######################################
# CLIツール設定を検証
#######################################
verify_cli_tools() {
    log_section "CLIツール設定の検証"
    
    # Gitの確認
    verify_command_exists "git" "Gitコマンド" "critical"
    verify_file_exists "$HOME/.gitconfig" "Git設定ファイル" "warning"
    
    # Yaziの確認
    verify_command_exists "yazi" "Yaziコマンド" "warning"
    verify_file_exists "$(get_config_dir yazi)/yazi.toml" "Yazi設定ファイル" "warning"
    
    # その他の便利ツール
    verify_command_exists "fzf" "fzf（ファジーファインダー）" "warning"
    verify_command_exists "rg" "ripgrep（高速検索）" "warning"
    verify_command_exists "fd" "fd（高速ファイル検索）" "warning"
    verify_command_exists "bat" "bat（catの代替）" "warning"
    verify_command_exists "eza" "eza（lsの代替）" "warning"
}

#######################################
# すべての設定を検証
#######################################
verify_all() {
    verify_nvim
    verify_shell
    verify_terminal
    verify_cli_tools
}

#######################################
# システム情報を表示
#######################################
show_system_info() {
    if [[ "$VERBOSE" != "true" ]]; then
        return 0
    fi
    
    log_section "システム情報"
    
    echo "OS: $(detect_os)"
    echo "OSバージョン: $(get_os_version)"
    echo "アーキテクチャ: $(get_architecture)"
    echo "シェル: $SHELL"
    echo "ホームディレクトリ: $HOME"
    echo "設定ディレクトリ: $(get_config_dir)"
}

#######################################
# レポートを生成
#######################################
generate_report() {
    log_section "検証結果サマリー"
    
    local total_tests=$((TESTS_PASSED + TESTS_FAILED + TESTS_WARNINGS))
    
    echo "総テスト数: $total_tests"
    log_success "成功: $TESTS_PASSED"
    
    if [[ $TESTS_WARNINGS -gt 0 ]]; then
        log_warn "警告: $TESTS_WARNINGS"
    fi
    
    if [[ $TESTS_FAILED -gt 0 ]]; then
        log_error "失敗: $TESTS_FAILED"
    fi
    
    echo ""
    
    if [[ $total_tests -gt 0 ]]; then
        local success_rate=$((TESTS_PASSED * 100 / total_tests))
        echo "成功率: ${success_rate}%"
    fi
    
    echo ""
    
    if [[ $TESTS_FAILED -eq 0 ]]; then
        log_success "すべての重要なテストが成功しました！"
        
        if [[ $TESTS_WARNINGS -gt 0 ]]; then
            log_info "一部の警告がありますが、基本的な機能は動作します"
        fi
        
        return 0
    else
        log_error "一部のテストが失敗しました"
        log_info "セットアップスクリプトを再実行してください: ./scripts/setup.sh"
        return 1
    fi
}

#######################################
# メイン処理
#######################################
main() {
    # 引数の解析
    parse_arguments "$@"
    
    # ヘッダー表示
    log_section "Dotfiles セットアップ検証"
    
    log_info "コンポーネント: $COMPONENT"
    
    if [[ "$VERBOSE" == "true" ]]; then
        log_info "モード: 詳細表示"
    fi
    
    # システム情報の表示
    show_system_info
    
    # 検証の実行
    case "$COMPONENT" in
        all)
            verify_all
            ;;
        nvim)
            verify_nvim
            ;;
        shell)
            verify_shell
            ;;
        terminal)
            verify_terminal
            ;;
        cli)
            verify_cli_tools
            ;;
        *)
            log_error "不明なコンポーネント: $COMPONENT"
            exit 1
            ;;
    esac
    
    # レポート生成
    if generate_report; then
        exit 0
    else
        exit 1
    fi
}

# スクリプトの実行
main "$@"
