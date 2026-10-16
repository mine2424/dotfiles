#!/usr/bin/env bash
# common.sh - 共通ユーティリティ関数
# 全スクリプトで使用する基本的な関数を提供

set -euo pipefail

# 多重読み込み防止
if [[ -n "${_COMMON_SH_LOADED:-}" ]]; then
    return 0
fi
readonly _COMMON_SH_LOADED=1

# カラーコード定義
readonly COLOR_RESET='\033[0m'
readonly COLOR_RED='\033[0;31m'
readonly COLOR_GREEN='\033[0;32m'
readonly COLOR_YELLOW='\033[0;33m'
readonly COLOR_BLUE='\033[0;34m'
readonly COLOR_CYAN='\033[0;36m'
readonly COLOR_BOLD='\033[1m'

# ログレベル
readonly LOG_LEVEL_ERROR=0
readonly LOG_LEVEL_WARN=1
readonly LOG_LEVEL_INFO=2
readonly LOG_LEVEL_SUCCESS=3
readonly LOG_LEVEL_DEBUG=4

# デフォルトログレベル
CURRENT_LOG_LEVEL=${LOG_LEVEL:-$LOG_LEVEL_INFO}

#######################################
# 情報メッセージを出力
# Arguments:
#   $@ - 出力するメッセージ
# Outputs:
#   青色の情報メッセージ
#######################################
log_info() {
    if [[ $CURRENT_LOG_LEVEL -ge $LOG_LEVEL_INFO ]]; then
        echo -e "${COLOR_BLUE}ℹ${COLOR_RESET} $*"
    fi
}

#######################################
# 成功メッセージを出力
# Arguments:
#   $@ - 出力するメッセージ
# Outputs:
#   緑色の成功メッセージ
#######################################
log_success() {
    if [[ $CURRENT_LOG_LEVEL -ge $LOG_LEVEL_SUCCESS ]]; then
        echo -e "${COLOR_GREEN}✓${COLOR_RESET} $*"
    fi
}

#######################################
# エラーメッセージを出力
# Arguments:
#   $@ - 出力するメッセージ
# Outputs:
#   赤色のエラーメッセージ（stderr）
#######################################
log_error() {
    if [[ $CURRENT_LOG_LEVEL -ge $LOG_LEVEL_ERROR ]]; then
        echo -e "${COLOR_RED}✗${COLOR_RESET} $*" >&2
    fi
}

#######################################
# 警告メッセージを出力
# Arguments:
#   $@ - 出力するメッセージ
# Outputs:
#   黄色の警告メッセージ
#######################################
log_warn() {
    if [[ $CURRENT_LOG_LEVEL -ge $LOG_LEVEL_WARN ]]; then
        echo -e "${COLOR_YELLOW}⚠${COLOR_RESET} $*"
    fi
}

#######################################
# デバッグメッセージを出力
# Arguments:
#   $@ - 出力するメッセージ
# Outputs:
#   シアン色のデバッグメッセージ
#######################################
log_debug() {
    if [[ $CURRENT_LOG_LEVEL -ge $LOG_LEVEL_DEBUG ]]; then
        echo -e "${COLOR_CYAN}[DEBUG]${COLOR_RESET} $*"
    fi
}

#######################################
# セクションヘッダーを出力
# Arguments:
#   $1 - セクションタイトル
# Outputs:
#   太字のセクションヘッダー
#######################################
log_section() {
    echo ""
    echo -e "${COLOR_BOLD}=== $1 ===${COLOR_RESET}"
    echo ""
}

#######################################
# ユーザーに確認を求める
# Arguments:
#   $1 - 確認メッセージ
#   $2 - デフォルト値（y/n、オプション、デフォルトはn）
# Returns:
#   0 - Yes
#   1 - No
#######################################
confirm() {
    local message="$1"
    local default="${2:-n}"
    local prompt
    
    if [[ "$default" == "y" ]]; then
        prompt="[Y/n]"
    else
        prompt="[y/N]"
    fi
    
    while true; do
        read -r -p "$(echo -e "${COLOR_YELLOW}?${COLOR_RESET} $message $prompt: ")" response
        
        # デフォルト値の使用
        if [[ -z "$response" ]]; then
            response="$default"
        fi
        
        case "$response" in
            [Yy]|[Yy][Ee][Ss])
                return 0
                ;;
            [Nn]|[Nn][Oo])
                return 1
                ;;
            *)
                log_warn "y または n で答えてください"
                ;;
        esac
    done
}

#######################################
# コマンドの存在を確認
# Arguments:
#   $1 - コマンド名
# Returns:
#   0 - コマンドが存在
#   1 - コマンドが存在しない
#######################################
check_command() {
    command -v "$1" >/dev/null 2>&1
}

#######################################
# 必須コマンドの存在を確認（存在しない場合はエラー終了）
# Arguments:
#   $@ - コマンド名のリスト
# Returns:
#   0 - すべてのコマンドが存在
#   1 - いずれかのコマンドが存在しない（エラー終了）
#######################################
require_command() {
    local missing_commands=()
    
    for cmd in "$@"; do
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
    
    return 0
}

#######################################
# ファイルまたはディレクトリの存在を確認
# Arguments:
#   $1 - パス
# Returns:
#   0 - 存在する
#   1 - 存在しない
#######################################
path_exists() {
    [[ -e "$1" ]]
}

#######################################
# ディレクトリを安全に作成
# Arguments:
#   $1 - ディレクトリパス
# Returns:
#   0 - 成功
#   1 - 失敗
#######################################
safe_mkdir() {
    local dir="$1"
    
    # ディレクトリが既に存在する場合は成功
    if [[ -d "$dir" ]]; then
        log_debug "ディレクトリは既に存在します: $dir"
        return 0
    fi
    
    # 壊れたシンボリックリンクのチェックと削除
    if [[ -L "$dir" ]]; then
        if [[ ! -e "$dir" ]]; then
            log_warn "壊れたシンボリックリンクを削除します: $dir"
            rm "$dir" 2>/dev/null || {
                log_error "シンボリックリンクの削除に失敗しました: $dir"
                return 1
            }
        else
            # シンボリックリンクが有効な場合は、その先を確認
            local target
            target="$(readlink "$dir")"
            if [[ -d "$target" ]]; then
                log_debug "シンボリックリンク先のディレクトリが存在します: $target"
                return 0
            fi
        fi
    fi
    
    # ファイルとして存在する場合はエラー
    if [[ -e "$dir" ]] && [[ ! -d "$dir" ]]; then
        log_error "パスが既に存在しますが、ディレクトリではありません: $dir"
        return 1
    fi
    
    # 親ディレクトリの確認と作成
    local parent_dir
    parent_dir="$(dirname "$dir")"
    if [[ ! -d "$parent_dir" ]] && [[ "$parent_dir" != "$dir" ]]; then
        log_debug "親ディレクトリを作成中: $parent_dir"
        if ! mkdir -p "$parent_dir" 2>/dev/null; then
            log_error "親ディレクトリの作成に失敗しました: $parent_dir"
            return 1
        fi
    fi
    
    # ディレクトリの作成
    if mkdir -p "$dir" 2>/dev/null; then
        log_debug "ディレクトリを作成しました: $dir"
        return 0
    else
        # より詳細なエラー情報を取得
        local error_msg
        error_msg="$(mkdir -p "$dir" 2>&1)"
        log_error "ディレクトリの作成に失敗しました: $dir"
        if [[ -n "$error_msg" ]]; then
            log_error "エラー詳細: $error_msg"
        fi
        return 1
    fi
}

#######################################
# シンボリックリンクを安全に作成
# Arguments:
#   $1 - ソースパス
#   $2 - リンク先パス
#   $3 - バックアップを作成するか（true/false、オプション）
# Returns:
#   0 - 成功
#   1 - 失敗
#######################################
safe_symlink() {
    local source="$1"
    local target="$2"
    
    # ソースの存在確認
    if [[ ! -e "$source" ]]; then
        log_error "ソースが存在しません: $source"
        return 1
    fi
    
    # ターゲットディレクトリの作成
    local target_dir
    target_dir="$(dirname "$target")"
    safe_mkdir "$target_dir" || return 1
    
    # 既存ファイル/リンクの処理
    if [[ -e "$target" ]] || [[ -L "$target" ]]; then
        if [[ -L "$target" ]]; then
            local current_source
            current_source="$(readlink "$target")"
            if [[ "$current_source" == "$source" ]]; then
                log_debug "シンボリックリンクは既に正しく設定されています: $target"
                return 0
            fi
        fi
        
        local backup_root backup_dir
        backup_root="$HOME/.local/state/dotfiles/backups"
        mkdir -p "$backup_root" || return 1
        backup_dir="$(mktemp -d "$backup_root/link.XXXXXX")" || return 1
        log_warn "既存設定を退避: $target -> $backup_dir/$(basename "$target")"
        mv "$target" "$backup_dir/$(basename "$target")" || return 1
    fi
    
    # シンボリックリンクの作成
    if ln -s "$source" "$target" 2>/dev/null; then
        log_debug "シンボリックリンクを作成: $target -> $source"
        return 0
    else
        log_error "シンボリックリンクの作成に失敗: $target -> $source"
        return 1
    fi
}

#######################################
# ファイルを安全にコピー
# Arguments:
#   $1 - ソースパス
#   $2 - コピー先パス
#   $3 - バックアップを作成するか（true/false、オプション）
# Returns:
#   0 - 成功
#   1 - 失敗
#######################################
safe_copy() {
    local source="$1"
    local target="$2"
    local backup="${3:-true}"
    
    # ソースの存在確認
    if [[ ! -e "$source" ]]; then
        log_error "ソースが存在しません: $source"
        return 1
    fi
    
    # ターゲットディレクトリの作成
    local target_dir
    target_dir="$(dirname "$target")"
    safe_mkdir "$target_dir" || return 1
    
    # 既存ファイルの処理
    if [[ -e "$target" ]]; then
        if [[ "$backup" == "true" ]]; then
            local backup_path="${target}.backup.$(date +%Y%m%d_%H%M%S)"
            log_info "既存ファイルをバックアップ: $target -> $backup_path"
            mv "$target" "$backup_path"
        else
            log_warn "既存ファイルを削除: $target"
            rm -rf "$target"
        fi
    fi
    
    # ファイルのコピー
    if cp -r "$source" "$target" 2>/dev/null; then
        log_debug "ファイルをコピー: $source -> $target"
        return 0
    else
        log_error "ファイルのコピーに失敗: $source -> $target"
        return 1
    fi
}

#######################################
# スクリプトのルートディレクトリを取得
# Returns:
#   dotfilesリポジトリのルートディレクトリパス
#######################################
get_dotfiles_root() {
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    # scripts/utils から2階層上がルート
    echo "$(cd "$script_dir/../.." && pwd)"
}

#######################################
# 現在のタイムスタンプを取得
# Arguments:
#   $1 - フォーマット（オプション、デフォルトは%Y%m%d_%H%M%S）
# Returns:
#   フォーマットされたタイムスタンプ
#######################################
get_timestamp() {
    local format="${1:-%Y%m%d_%H%M%S}"
    date +"$format"
}

#######################################
# バージョン比較
# Arguments:
#   $1 - バージョン1
#   $2 - バージョン2
# Returns:
#   0 - バージョン1 >= バージョン2
#   1 - バージョン1 < バージョン2
#######################################
version_ge() {
    local ver1="$1"
    local ver2="$2"
    
    # sort -V でバージョン番号をソート
    local sorted
    sorted="$(printf '%s\n%s' "$ver1" "$ver2" | sort -V | head -n1)"
    
    [[ "$sorted" == "$ver2" ]]
}

# スクリプトがsourceされた場合は関数のみ提供、直接実行された場合はテスト実行
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    log_section "common.sh テスト"
    
    log_info "これは情報メッセージです"
    log_success "これは成功メッセージです"
    log_warn "これは警告メッセージです"
    log_error "これはエラーメッセージです"
    log_debug "これはデバッグメッセージです（LOG_LEVEL=4で表示）"
    
    echo ""
    log_info "コマンド確認テスト:"
    for cmd in bash git ls nonexistent_command; do
        if check_command "$cmd"; then
            log_success "$cmd: 見つかりました"
        else
            log_warn "$cmd: 見つかりません"
        fi
    done
    
    echo ""
    log_info "dotfilesルート: $(get_dotfiles_root)"
    log_info "タイムスタンプ: $(get_timestamp)"
    
    echo ""
    log_success "common.sh のテストが完了しました"
fi
