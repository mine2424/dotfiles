#!/usr/bin/env bash
# sync.sh - 設定ファイルの双方向同期
# dotfilesとローカルPC間で設定を同期

set -euo pipefail

# スクリプトのディレクトリを取得
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ユーティリティ関数の読み込み
# shellcheck source=./utils/common.sh
source "$SCRIPT_DIR/utils/common.sh"
# shellcheck source=./utils/os-detect.sh
source "$SCRIPT_DIR/utils/os-detect.sh"

# グローバル変数
DIRECTION="push"  # push: dotfiles -> local, pull: local -> dotfiles
DRY_RUN=false
FORCE=false
COMPONENT="all"

#######################################
# 使用方法を表示
#######################################
show_usage() {
    cat <<EOF
使用方法: $(basename "$0") [方向] [オプション] [コンポーネント]

dotfilesとローカルPC間で設定を同期します。

方向:
  push               dotfiles -> ローカルPC（デフォルト）
  pull               ローカルPC -> dotfiles

コンポーネント:
  --all              すべての設定を同期（デフォルト）
  --nvim             Neovim設定のみ
  --shell            シェル設定のみ
  --terminal         ターミナル設定のみ
  --cli              CLIツール設定のみ
  --codex            Codex設定のみ
  --claude           Claude設定のみ

オプション:
  --dry-run          実際には同期せず、何が行われるか表示
  --force            確認なしで実行
  -h, --help         このヘルプを表示

例:
  # dotfilesからローカルPCに反映（デフォルト）
  $(basename "$0") push

  # ローカルPCからdotfilesに取り込み
  $(basename "$0") pull

  # WezTerm設定のみ同期
  $(basename "$0") push --terminal

  # ドライランモード
  $(basename "$0") push --dry-run

EOF
}

#######################################
# 引数を解析
#######################################
parse_arguments() {
    # 最初の引数が方向指定かチェック
    if [[ $# -gt 0 ]] && [[ "$1" == "push" || "$1" == "pull" ]]; then
        DIRECTION="$1"
        shift
    fi
    
    while [[ $# -gt 0 ]]; do
        case "$1" in
            push|pull)
                DIRECTION="$1"
                shift
                ;;
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
            --codex)
                COMPONENT="codex"
                shift
                ;;
            --claude)
                COMPONENT="claude"
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
# ファイルを同期
# Arguments:
#   $1 - ソースパス
#   $2 - ターゲットパス
#   $3 - 説明
#######################################
sync_file() {
    local source="$1"
    local target="$2"
    local description="$3"
    
    # パスの展開
    source="${source/#\~/$HOME}"
    target="${target/#\~/$HOME}"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        if [[ -e "$source" ]]; then
            log_info "[DRY RUN] 同期予定: $description"
            log_info "           $source -> $target"
        else
            log_warn "[DRY RUN] スキップ（存在しません）: $source"
        fi
        return 0
    fi
    
    # ソースが存在しない場合はスキップ
    if [[ ! -e "$source" ]] && [[ ! -L "$source" ]]; then
        log_debug "スキップ（存在しません）: $source"
        return 0
    fi
    
    log_info "同期: $description"
    log_debug "$source -> $target"
    
    # ターゲットディレクトリの作成
    local target_dir
    target_dir="$(dirname "$target")"
    safe_mkdir "$target_dir" || return 1

    # ディレクトリ同期は内容をミラー（ネストを避ける）
    if [[ -d "$source" ]]; then
        safe_mkdir "$target" || return 1
        if check_command rsync; then
            if rsync -a --delete "$source"/ "$target"/ 2>/dev/null; then
                log_success "同期完了: ${description}"
                return 0
            fi
        fi
        if cp -R "$source"/. "$target"/ 2>/dev/null; then
            log_success "同期完了: ${description}"
            return 0
        fi
        log_error "同期に失敗しました: ${description}"
        return 1
    fi

    # ファイルのコピー
    # 既に存在する場合は、同一かどうかをチェック
    if [[ -e "$target" ]] && [[ -f "$source" ]] && [[ -f "$target" ]]; then
        if cmp -s "$source" "$target" 2>/dev/null; then
            log_debug "ファイルは既に同一です: $target"
            log_success "同期完了: ${description}（変更なし）"
            return 0
        fi
    fi
    
    if cp -r "$source" "$target" 2>/dev/null; then
        log_success "同期完了: ${description}"
        return 0
    else
        # cpが失敗した場合でも、ターゲットが存在し、同一の場合は成功として扱う
        if [[ -e "$target" ]] && [[ -f "$source" ]] && [[ -f "$target" ]]; then
            if cmp -s "$source" "$target" 2>/dev/null; then
                log_debug "ファイルは既に同一です: $target"
                log_success "同期完了: ${description}（変更なし）"
                return 0
            fi
        fi
        log_error "同期に失敗しました: ${description}"
        return 1
    fi
}

#######################################
# Codexの設定ディレクトリを取得
# Returns:
#   Codex設定ディレクトリパス
#######################################
get_codex_home() {
    if [[ -n "${CODEX_HOME:-}" ]]; then
        echo "${CODEX_HOME/#\~/$HOME}"
        return 0
    fi

    local xdg_codex
    xdg_codex="$(get_config_dir codex)"

    if [[ -f "$HOME/.codex/config.toml" ]] || [[ -f "$HOME/.codex/AGENTS.md" ]]; then
        echo "$HOME/.codex"
        return 0
    fi

    if [[ -f "$xdg_codex/config.toml" ]] || [[ -f "$xdg_codex/AGENTS.md" ]]; then
        echo "$xdg_codex"
        return 0
    fi

    if [[ -d "$HOME/.codex" ]] || [[ -L "$HOME/.codex" ]]; then
        echo "$HOME/.codex"
        return 0
    fi

    if [[ -d "$xdg_codex" ]] || [[ -L "$xdg_codex" ]]; then
        echo "$xdg_codex"
        return 0
    fi

    echo "$HOME/.codex"
}

#######################################
# Neovim設定を同期
#######################################
sync_nvim() {
    log_section "Neovim設定の同期"
    
    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local nvim_config="$(get_config_dir nvim)"
    local nvim_dotfiles="$dotfiles_root/nvim"
    
    if [[ "$DIRECTION" == "push" ]]; then
        # dotfiles -> local: nvim/ -> ~/.config/nvim
        if [[ "$DRY_RUN" == "true" ]]; then
            if [[ -d "$nvim_dotfiles" ]]; then
                log_info "[DRY RUN] Neovim設定を同期予定: $nvim_dotfiles -> $nvim_config"
            else
                log_warn "[DRY RUN] Neovim設定が見つかりません: $nvim_dotfiles"
            fi
        else
            if [[ -d "$nvim_dotfiles" ]]; then
                # 親ディレクトリ（~/.config）の確認
                local config_parent
                config_parent="$(dirname "$nvim_config")"
                if [[ ! -d "$config_parent" ]]; then
                    log_info "親ディレクトリを作成中: $config_parent"
                    safe_mkdir "$config_parent" || {
                        log_error "親ディレクトリの作成に失敗しました: $config_parent"
                        return 1
                    }
                fi
                
                # ターゲットディレクトリの作成
                log_info "ディレクトリを作成中: $nvim_config"
                safe_mkdir "$nvim_config" || {
                    log_error "ディレクトリの作成に失敗しました: $nvim_config"
                    log_info "権限を確認してください: ls -ld $(dirname "$nvim_config")"
                    return 1
                }
                
                # ディレクトリの内容をコピー（既存のファイルは上書き）
                log_info "ファイルをコピー中..."
                if rsync -a --delete "$nvim_dotfiles/" "$nvim_config/" 2>/dev/null || \
                   { cp -r "$nvim_dotfiles"/* "$nvim_config/" 2>/dev/null && \
                     cp -r "$nvim_dotfiles"/.[!.]* "$nvim_config/" 2>/dev/null; }; then
                    log_success "Neovim設定を同期しました"
                else
                    log_error "Neovim設定の同期に失敗しました"
                    log_info "ソース: $nvim_dotfiles"
                    log_info "ターゲット: $nvim_config"
                    return 1
                fi
            else
                log_warn "Neovim設定が見つかりません: $nvim_dotfiles"
            fi
        fi
    else
        # local -> dotfiles: ~/.config/nvim -> nvim/
        if [[ "$DRY_RUN" == "true" ]]; then
            if [[ -d "$nvim_config" ]]; then
                log_info "[DRY RUN] Neovim設定を同期予定: $nvim_config -> $nvim_dotfiles"
            else
                log_warn "[DRY RUN] Neovim設定が見つかりません: $nvim_config"
            fi
        else
            if [[ -d "$nvim_config" ]]; then
                # ターゲットディレクトリの作成
                safe_mkdir "$nvim_dotfiles" || return 1
                
                # ディレクトリの内容をコピー（既存のファイルは上書き）
                if rsync -a --delete "$nvim_config/" "$nvim_dotfiles/" 2>/dev/null || \
                   { cp -r "$nvim_config"/* "$nvim_dotfiles/" 2>/dev/null && \
                     cp -r "$nvim_config"/.[!.]* "$nvim_dotfiles/" 2>/dev/null; }; then
                    log_success "Neovim設定を同期しました"
                else
                    log_error "Neovim設定の同期に失敗しました"
                    return 1
                fi
            else
                log_warn "Neovim設定が見つかりません: $nvim_config"
            fi
        fi
    fi
}

#######################################
# シェル設定を同期
#######################################
sync_shell() {
    log_section "シェル設定の同期"
    
    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    
    if [[ "$DIRECTION" == "push" ]]; then
        # dotfiles -> local
        sync_file "$dotfiles_root/zsh/zshrc" "$HOME/.zshrc" "Zsh設定"
        sync_file "$dotfiles_root/zsh/zshenv" "$HOME/.zshenv" "Zsh環境変数"
        sync_file "$dotfiles_root/zsh/zprofile" "$HOME/.zprofile" "Zshプロファイル"
        sync_file "$dotfiles_root/zsh/sheldon" "$(get_config_dir sheldon)" "Sheldon設定"
        sync_file "$dotfiles_root/starship/.config/starship.toml" "$(get_config_dir)/starship.toml" "Starship設定"
        sync_file "$dotfiles_root/npm/npmrc" "$HOME/.npmrc" "npm設定"
        sync_file "$dotfiles_root/npm/.config/npm/npmrc" "$(get_config_dir)/npm/npmrc" "npmグローバル設定"
    else
        # local -> dotfiles
        sync_file "$HOME/.zshrc" "$dotfiles_root/zsh/zshrc" "Zsh設定"
        sync_file "$HOME/.zshenv" "$dotfiles_root/zsh/zshenv" "Zsh環境変数"
        sync_file "$HOME/.zprofile" "$dotfiles_root/zsh/zprofile" "Zshプロファイル"
        sync_file "$(get_config_dir sheldon)" "$dotfiles_root/zsh/sheldon" "Sheldon設定"
        sync_file "$(get_config_dir)/starship.toml" "$dotfiles_root/starship/.config/starship.toml" "Starship設定"
        sync_file "$HOME/.npmrc" "$dotfiles_root/npm/npmrc" "npm設定"
        sync_file "$(get_config_dir)/npm/npmrc" "$dotfiles_root/npm/.config/npm/npmrc" "npmグローバル設定"
    fi
}

#######################################
# ターミナル設定を同期
#######################################
sync_terminal() {
    log_section "ターミナル設定の同期"
    
    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local wezterm_config="$(get_config_dir wezterm)/wezterm.lua"
    local zellij_config="$(get_config_dir zellij)/config.kdl"
    local zellij_config_dir="$(dirname "$zellij_config")"
    local zellij_layouts_dir="$zellij_config_dir/layouts"
    local zellij_dotfiles_dir="$dotfiles_root/zellij"
    
    if [[ "$DIRECTION" == "push" ]]; then
        # dotfiles -> local
        sync_file "$dotfiles_root/wezterm/.config/wezterm/wezterm.lua" "$wezterm_config" "WezTerm設定"
        sync_file "$zellij_dotfiles_dir/config.kdl" "$zellij_config" "Zellij設定"
        
        # Zellijレイアウトディレクトリを同期
        if [[ -d "$zellij_dotfiles_dir/layouts" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                log_info "[DRY RUN] Zellijレイアウトを同期予定: $zellij_dotfiles_dir/layouts -> $zellij_layouts_dir"
            else
                safe_mkdir "$zellij_layouts_dir" || {
                    log_error "ディレクトリの作成に失敗しました: $zellij_layouts_dir"
                    return 1
                }
                if cp -r "$zellij_dotfiles_dir/layouts"/* "$zellij_layouts_dir/" 2>/dev/null; then
                    log_success "Zellijレイアウトを同期しました"
                else
                    log_warn "Zellijレイアウトの同期に失敗しました（空または存在しません）"
                fi
            fi
        fi
    else
        # local -> dotfiles
        sync_file "$wezterm_config" "$dotfiles_root/wezterm/.config/wezterm/wezterm.lua" "WezTerm設定"
        sync_file "$zellij_config" "$zellij_dotfiles_dir/config.kdl" "Zellij設定"
        
        # Zellijレイアウトディレクトリを同期
        if [[ -d "$zellij_layouts_dir" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                log_info "[DRY RUN] Zellijレイアウトを同期予定: $zellij_layouts_dir -> $zellij_dotfiles_dir/layouts"
            else
                safe_mkdir "$zellij_dotfiles_dir/layouts" || {
                    log_error "ディレクトリの作成に失敗しました: $zellij_dotfiles_dir/layouts"
                    return 1
                }
                if cp -r "$zellij_layouts_dir"/* "$zellij_dotfiles_dir/layouts/" 2>/dev/null; then
                    log_success "Zellijレイアウトを同期しました"
                else
                    log_warn "Zellijレイアウトの同期に失敗しました（空または存在しません）"
                fi
            fi
        fi
    fi
}

#######################################
# CLIツール設定を同期
#######################################
sync_cli_tools() {
    log_section "CLIツール設定の同期"
    
    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local local_bin="$HOME/.local/bin"
    local codex_home
    codex_home="$(get_codex_home)"
    
    if [[ "$DIRECTION" == "push" ]]; then
        # dotfiles -> local
        if [[ -f "$dotfiles_root/cli-tools/gitconfig" ]]; then
            sync_file "$dotfiles_root/cli-tools/gitconfig" "$HOME/.gitconfig" "Git設定"
        fi
        # tmux設定は tmux/.tmux.conf に配置されている
        if [[ -f "$dotfiles_root/tmux/.tmux.conf" ]]; then
            sync_file "$dotfiles_root/tmux/.tmux.conf" "$HOME/.tmux.conf" "tmux設定"
        fi
        if [[ -d "$dotfiles_root/codex" ]]; then
            sync_file "$dotfiles_root/codex" "$codex_home" "Codex設定 ($codex_home)"
        fi
        
        # dev と agent コマンドを ~/.local/bin に同期
        # ディレクトリが存在しない場合は作成
        if [[ ! -d "$local_bin" ]]; then
            safe_mkdir "$local_bin" || {
                log_error "ディレクトリの作成に失敗しました: $local_bin"
                return 1
            }
        fi
        
        # devコマンド
        if [[ -f "$dotfiles_root/scripts/dev" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                log_info "[DRY RUN] devコマンドを同期予定: $dotfiles_root/scripts/dev -> $local_bin/dev"
            else
                log_info "同期: devコマンド"
                if cp "$dotfiles_root/scripts/dev" "$local_bin/dev" 2>/dev/null; then
                    chmod +x "$local_bin/dev"
                    log_success "同期完了: devコマンド"
                else
                    log_error "同期に失敗しました: devコマンド"
                    return 1
                fi
            fi
        fi
        
        # agentコマンド
        if [[ -f "$dotfiles_root/scripts/agent" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                log_info "[DRY RUN] agentコマンドを同期予定: $dotfiles_root/scripts/agent -> $local_bin/agent"
            else
                log_info "同期: agentコマンド"
                if cp "$dotfiles_root/scripts/agent" "$local_bin/agent" 2>/dev/null; then
                    chmod +x "$local_bin/agent"
                    log_success "同期完了: agentコマンド"
                else
                    log_error "同期に失敗しました: agentコマンド"
                    return 1
                fi
            fi
        fi
    else
        # local -> dotfiles
        if [[ -f "$HOME/.gitconfig" ]]; then
            sync_file "$HOME/.gitconfig" "$dotfiles_root/cli-tools/gitconfig" "Git設定"
        fi
        # tmux設定は tmux/.tmux.conf に配置されている
        if [[ -f "$HOME/.tmux.conf" ]]; then
            sync_file "$HOME/.tmux.conf" "$dotfiles_root/tmux/.tmux.conf" "tmux設定"
        fi
        if [[ -d "$codex_home" ]]; then
            sync_file "$codex_home" "$dotfiles_root/codex" "Codex設定 ($codex_home)"
        fi
        
        # dev と agent コマンドを dotfiles に同期
        # devコマンド
        if [[ -f "$local_bin/dev" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                log_info "[DRY RUN] devコマンドを同期予定: $local_bin/dev -> $dotfiles_root/scripts/dev"
            else
                log_info "同期: devコマンド"
                if cp "$local_bin/dev" "$dotfiles_root/scripts/dev" 2>/dev/null; then
                    chmod +x "$dotfiles_root/scripts/dev"
                    log_success "同期完了: devコマンド"
                else
                    log_error "同期に失敗しました: devコマンド"
                    return 1
                fi
            fi
        fi
        
        # agentコマンド
        if [[ -f "$local_bin/agent" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                log_info "[DRY RUN] agentコマンドを同期予定: $local_bin/agent -> $dotfiles_root/scripts/agent"
            else
                log_info "同期: agentコマンド"
                if cp "$local_bin/agent" "$dotfiles_root/scripts/agent" 2>/dev/null; then
                    chmod +x "$dotfiles_root/scripts/agent"
                    log_success "同期完了: agentコマンド"
                else
                    log_error "同期に失敗しました: agentコマンド"
                    return 1
                fi
            fi
        fi
    fi
}

#######################################
# Codex設定を同期
#######################################
sync_codex() {
    log_section "Codex設定の同期"

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local codex_home
    codex_home="$(get_codex_home)"

    if [[ "$DIRECTION" == "push" ]]; then
        sync_file "$dotfiles_root/codex/config.toml" "$codex_home/config.toml" "Codex設定 (config.toml)"
    else
        sync_file "$codex_home/config.toml" "$dotfiles_root/codex/config.toml" "Codex設定 (config.toml)"
    fi
}

#######################################
# Claude設定を同期
#######################################
sync_claude() {
    log_section "Claude設定の同期"
    
    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local claude_dotfiles="$dotfiles_root/.claude"
    local claude_local="$HOME/.claude"
    
    if [[ "$DIRECTION" == "push" ]]; then
        # dotfiles -> local
        if [[ -d "$claude_dotfiles" ]]; then
            # ディレクトリ全体をコピー
            if [[ "$DRY_RUN" == "true" ]]; then
                log_info "[DRY RUN] Claude設定を同期予定: $claude_dotfiles -> $claude_local"
            else
                # ディレクトリをコピー
                if cp -r "$claude_dotfiles" "$claude_local" 2>/dev/null; then
                    # deny-check.shに実行権限を付与
                    if [[ -f "$claude_local/scripts/deny-check.sh" ]]; then
                        chmod +x "$claude_local/scripts/deny-check.sh"
                    fi
                    log_success "Claude設定を同期しました"
                else
                    log_error "Claude設定の同期に失敗しました"
                    return 1
                fi
            fi
        else
            log_warn "Claude設定が見つかりません: $claude_dotfiles"
        fi
    else
        # local -> dotfiles
        if [[ -d "$claude_local" ]]; then
            if [[ "$DRY_RUN" == "true" ]]; then
                log_info "[DRY RUN] Claude設定を同期予定: $claude_local -> $claude_dotfiles"
            else
                # ディレクトリをコピー
                if cp -r "$claude_local" "$claude_dotfiles" 2>/dev/null; then
                    log_success "Claude設定を同期しました"
                else
                    log_error "Claude設定の同期に失敗しました"
                    return 1
                fi
            fi
        else
            log_warn "Claude設定が見つかりません: $claude_local"
        fi
    fi
}

#######################################
# すべての設定を同期
#######################################
sync_all() {
    sync_nvim
    sync_shell
    sync_terminal
    sync_cli_tools
    sync_claude
}

#######################################
# 同期前の確認
#######################################
confirm_sync() {
    if [[ "$FORCE" == "true" ]]; then
        return 0
    fi
    
    if [[ "$DRY_RUN" == "true" ]]; then
        return 0
    fi
    
    echo ""
    log_warn "以下の設定が同期されます:"
    
    if [[ "$DIRECTION" == "push" ]]; then
        log_info "方向: dotfiles -> ローカルPC"
    else
        log_info "方向: ローカルPC -> dotfiles"
    fi
    
    case "$COMPONENT" in
        all)
            echo "  - Neovim設定"
            echo "  - シェル設定（Zsh + Starship）"
            echo "  - ターミナル設定（WezTerm + Zellij）"
            echo "  - CLIツール設定（Git, tmux等）"
            echo "  - dev/agentコマンド"
            echo "  - Claude設定"
            ;;
        nvim)
            echo "  - Neovim設定"
            ;;
        shell)
            echo "  - シェル設定（Zsh + Starship）"
            ;;
        terminal)
            echo "  - ターミナル設定（WezTerm + Zellij）"
            ;;
        cli)
            echo "  - CLIツール設定（Git, tmux等）"
            echo "  - dev/agentコマンド"
            ;;
        codex)
            echo "  - Codex設定（config.toml）"
            ;;
        claude)
            echo "  - Claude設定"
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
    log_section "同期完了"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "ドライランモードで実行しました"
        log_info "実際に同期するには --dry-run オプションを外してください"
    else
        log_success "同期が完了しました"
        
        if [[ "$DIRECTION" == "push" ]]; then
            log_info "dotfilesの設定がローカルPCに反映されました"
            log_info "シェルを再起動してください: exec \$SHELL"
        else
            log_info "ローカルPCの設定がdotfilesに取り込まれました"
            log_info "変更をコミットしてください: git add . && git commit"
        fi
    fi
}

#######################################
# メイン処理
#######################################
main() {
    # 引数の解析
    parse_arguments "$@"
    
    # ヘッダー表示
    log_section "Dotfiles 同期スクリプト"
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "モード: ドライラン（実際には同期しません）"
    fi
    
    log_info "方向: $DIRECTION"
    log_info "コンポーネント: $COMPONENT"
    
    # システム情報の表示
    log_debug "OS: $(detect_os)"
    
    # 確認
    confirm_sync
    
    # 同期の実行
    case "$COMPONENT" in
        all)
            sync_all
            ;;
        nvim)
            sync_nvim
            ;;
        shell)
            sync_shell
            ;;
        terminal)
            sync_terminal
            ;;
        cli)
            sync_cli_tools
            ;;
        codex)
            sync_codex
            ;;
        claude)
            sync_claude
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
