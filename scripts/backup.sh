#!/usr/bin/env bash
# backup.sh - システム状態をdotfilesにスナップショット
# 現在のPC環境をdotfilesにバックアップする

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
DRY_RUN=false
FORCE=false
COMPONENT="all"

#######################################
# 使用方法を表示
#######################################
show_usage() {
    cat <<EOF
使用方法: $(basename "$0") [オプション] [コンポーネント]

現在のシステム状態をdotfilesにバックアップします。

コンポーネント:
  --all              すべてをバックアップ（デフォルト）
  --brew             Brewパッケージ一覧をBrewfileに保存
  --gcloud           gcloud CLI設定をバックアップ
  --ssh              SSH設定をバックアップ（~/.ssh/config のみ）
  --npm              npmグローバルパッケージ一覧をバックアップ
  --macos            macOSシステム設定をバックアップ
  --mise             miseインストール済みバージョンをバックアップ

オプション:
  --dry-run          実際には実行せず、何が行われるか表示
  --force            確認なしで実行
  -h, --help         このヘルプを表示

例:
  # すべてをバックアップ
  $(basename "$0") --all

  # Brewfileのみ更新
  $(basename "$0") --brew

  # ドライランモード
  $(basename "$0") --all --dry-run

バックアップ後:
  git add Brewfile gcloud/ ssh/ npm/ macos/ mise/installed-versions.txt
  git commit -m "backup: update system snapshot"

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
            --brew)
                COMPONENT="brew"
                shift
                ;;
            --gcloud)
                COMPONENT="gcloud"
                shift
                ;;
            --ssh)
                COMPONENT="ssh"
                shift
                ;;
            --npm)
                COMPONENT="npm"
                shift
                ;;
            --macos)
                COMPONENT="macos"
                shift
                ;;
            --mise)
                COMPONENT="mise"
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
# バックアップ前の確認
#######################################
confirm_backup() {
    if [[ "$FORCE" == "true" ]]; then
        return 0
    fi

    if [[ "$DRY_RUN" == "true" ]]; then
        return 0
    fi

    echo ""
    log_warn "以下のバックアップが実行されます:"

    case "$COMPONENT" in
        all)
            echo "  - Brewパッケージ一覧 → Brewfile"
            echo "  - gcloud CLI設定 → gcloud/"
            echo "  - SSH設定 → ssh/config"
            echo "  - npmグローバルパッケージ → npm/packages.txt"
            echo "  - macOSシステム設定 → macos/defaults.sh"
            echo "  - miseバージョン情報 → mise/installed-versions.txt"
            ;;
        brew)
            echo "  - Brewパッケージ一覧 → Brewfile"
            ;;
        gcloud)
            echo "  - gcloud CLI設定 → gcloud/"
            ;;
        ssh)
            echo "  - SSH設定 → ssh/config"
            ;;
        npm)
            echo "  - npmグローバルパッケージ → npm/packages.txt"
            ;;
        macos)
            echo "  - macOSシステム設定 → macos/defaults.sh"
            ;;
        mise)
            echo "  - miseバージョン情報 → mise/installed-versions.txt"
            ;;
    esac

    echo ""

    if ! confirm "続行しますか？" "n"; then
        log_info "キャンセルしました"
        exit 0
    fi
}

#######################################
# Brewパッケージをバックアップ
#######################################
backup_brew() {
    log_section "Brewパッケージのバックアップ"

    if ! check_command brew; then
        log_error "Homebrewが見つかりません。インストールしてください"
        return 1
    fi

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local brewfile="$dotfiles_root/Brewfile"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] brew bundle dump --force --file=\"$brewfile\""
        return 0
    fi

    if [[ -f "$brewfile" ]] && [[ "$FORCE" == "false" ]]; then
        if ! confirm "既存のBrewfileを上書きしますか？" "n"; then
            log_info "スキップしました"
            return 0
        fi
    fi

    log_info "brew bundle dump を実行中..."
    if brew bundle dump --force --file="$brewfile"; then
        log_success "Brewfileを更新しました: $brewfile"
    else
        log_error "brew bundle dump に失敗しました"
        return 1
    fi
}

#######################################
# gcloud設定をバックアップ
#######################################
backup_gcloud() {
    log_section "gcloud CLI設定のバックアップ"

    local gcloud_src="$HOME/.config/gcloud"

    if [[ ! -d "$gcloud_src" ]]; then
        log_warn "gcloud設定が見つかりません: $gcloud_src"
        log_info "gcloud CLIがインストールされていないか、初期化されていない可能性があります"
        return 0
    fi

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local gcloud_dest="$dotfiles_root/gcloud"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] gcloud設定をバックアップ: $gcloud_src → $gcloud_dest"
        log_info "[DRY RUN] バックアップ対象:"
        log_info "[DRY RUN]   - configurations/"
        log_info "[DRY RUN]   - properties"
        log_info "[DRY RUN]   - active_config"
        log_info "[DRY RUN] 除外（セキュリティ上）:"
        log_info "[DRY RUN]   - credentials.db"
        log_info "[DRY RUN]   - access_tokens.db"
        log_info "[DRY RUN]   - legacy_credentials/"
        log_info "[DRY RUN]   - application_default_credentials.json"
        return 0
    fi

    # バックアップ先ディレクトリを作成
    safe_mkdir "$gcloud_dest" || return 1

    # configurations/ をバックアップ
    local configs_src="$gcloud_src/configurations"
    local configs_dest="$gcloud_dest/configurations"
    if [[ -d "$configs_src" ]]; then
        log_info "configurations/ をバックアップ中..."
        if check_command rsync; then
            rsync -a --delete "$configs_src/" "$configs_dest/" 2>/dev/null || {
                log_error "configurations/ のバックアップに失敗しました"
                return 1
            }
        else
            rm -rf "$configs_dest"
            cp -R "$configs_src" "$configs_dest" 2>/dev/null || {
                log_error "configurations/ のバックアップに失敗しました"
                return 1
            }
        fi
        log_success "configurations/ をバックアップしました"
    fi

    # properties をバックアップ
    local props_src="$gcloud_src/properties"
    local props_dest="$gcloud_dest/properties"
    if [[ -f "$props_src" ]]; then
        log_info "properties をバックアップ中..."
        cp "$props_src" "$props_dest" 2>/dev/null || {
            log_error "properties のバックアップに失敗しました"
            return 1
        }
        log_success "properties をバックアップしました"
    fi

    # active_config をバックアップ
    local active_src="$gcloud_src/active_config"
    local active_dest="$gcloud_dest/active_config"
    if [[ -f "$active_src" ]]; then
        log_info "active_config をバックアップ中..."
        cp "$active_src" "$active_dest" 2>/dev/null || {
            log_error "active_config のバックアップに失敗しました"
            return 1
        }
        log_success "active_config をバックアップしました"
    fi

    log_warn "認証情報（credentials.db, access_tokens.db, legacy_credentials/, application_default_credentials.json）はセキュリティ上の理由から除外しました"
}

#######################################
# SSH設定をバックアップ
#######################################
backup_ssh() {
    log_section "SSH設定のバックアップ"

    local ssh_src="$HOME/.ssh/config"

    if [[ ! -f "$ssh_src" ]]; then
        log_warn "SSH設定が見つかりません: $ssh_src"
        return 0
    fi

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local ssh_dest="$dotfiles_root/ssh/config"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] SSH設定をバックアップ: $ssh_src → $ssh_dest"
        log_info "[DRY RUN] 秘密鍵（id_*）および authorized_keys は除外"
        return 0
    fi

    safe_mkdir "$dotfiles_root/ssh" || return 1

    log_info "~/.ssh/config をバックアップ中..."
    if cp "$ssh_src" "$ssh_dest" 2>/dev/null; then
        log_success "SSH設定をバックアップしました: $ssh_dest"
        log_warn "ssh/config には内部ホスト名・IPアドレスが含まれる可能性があります。git push 前に内容を確認してください"
    else
        log_error "SSH設定のバックアップに失敗しました"
        return 1
    fi
}

#######################################
# npmグローバルパッケージをバックアップ
#######################################
backup_npm() {
    log_section "npmグローバルパッケージのバックアップ"

    if ! check_command npm; then
        log_warn "npmが見つかりません。スキップします"
        return 0
    fi

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local npm_dest="$dotfiles_root/npm/packages.txt"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] npm list -g --depth=0 --parseable の出力を保存: $npm_dest"
        return 0
    fi

    safe_mkdir "$dotfiles_root/npm" || return 1

    log_info "npmグローバルパッケージ一覧を取得中..."
    # npm自身を除外し、パッケージ名のみ保存
    npm list -g --depth=0 --parseable 2>/dev/null \
        | tail -n +2 \
        | sed 's|.*/||' \
        | grep -v '^npm$' \
        > "$npm_dest"

    local count
    count=$(wc -l < "$npm_dest" | tr -d ' ')
    log_success "npmグローバルパッケージを保存しました: $npm_dest ($count パッケージ)"
}

#######################################
# macOSシステム設定をバックアップ
#######################################
backup_macos() {
    log_section "macOSシステム設定のバックアップ"

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local macos_dest="$dotfiles_root/macos/defaults.sh"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] macOSシステム設定を読み取り、リストアスクリプトを生成: $macos_dest"
        return 0
    fi

    safe_mkdir "$dotfiles_root/macos" || return 1

    log_info "macOS設定を読み取り中..."

    # ヘルパー関数: 指定キーを安全に読み取り、defaults write コマンドを出力
    backup_defaults_key() {
        local domain="$1" key="$2" type="$3"
        local val
        val=$(defaults read "$domain" "$key" 2>/dev/null) || return 0
        case "$type" in
            bool)   echo "defaults write $domain $key -bool $([ "$val" = "1" ] && echo true || echo false)" ;;
            int)    echo "defaults write $domain $key -int $val" ;;
            float)  echo "defaults write $domain $key -float $val" ;;
            string) echo "defaults write $domain $key -string \"$val\"" ;;
        esac
    }

    {
        echo "#!/usr/bin/env bash"
        echo "# macOS システム設定 - backup.sh --macos で自動生成"
        echo "# 生成日時: $(date '+%Y-%m-%d %H:%M:%S')"
        echo ""

        echo "# --- Dock ---"
        backup_defaults_key "com.apple.dock" "autohide"     "bool"
        backup_defaults_key "com.apple.dock" "tilesize"     "int"
        backup_defaults_key "com.apple.dock" "orientation"  "string"
        backup_defaults_key "com.apple.dock" "show-recents" "bool"
        backup_defaults_key "com.apple.dock" "magnification" "bool"
        backup_defaults_key "com.apple.dock" "largesize"    "int"
        echo ""

        echo "# --- Finder ---"
        backup_defaults_key "com.apple.finder" "AppleShowAllFiles"       "bool"
        backup_defaults_key "com.apple.finder" "ShowPathbar"             "bool"
        backup_defaults_key "com.apple.finder" "ShowStatusBar"           "bool"
        backup_defaults_key "com.apple.finder" "FXPreferredViewStyle"    "string"
        backup_defaults_key "com.apple.finder" "_FXShowPosixPathInTitle" "bool"
        echo ""

        echo "# --- Keyboard ---"
        backup_defaults_key "NSGlobalDomain" "KeyRepeat"                          "int"
        backup_defaults_key "NSGlobalDomain" "InitialKeyRepeat"                   "int"
        backup_defaults_key "NSGlobalDomain" "ApplePressAndHoldEnabled"           "bool"
        backup_defaults_key "NSGlobalDomain" "NSAutomaticSpellingCorrectionEnabled" "bool"
        backup_defaults_key "NSGlobalDomain" "NSAutomaticCapitalizationEnabled"   "bool"
        backup_defaults_key "NSGlobalDomain" "NSAutomaticDashSubstitutionEnabled" "bool"
        backup_defaults_key "NSGlobalDomain" "NSAutomaticPeriodSubstitutionEnabled" "bool"
        backup_defaults_key "NSGlobalDomain" "NSAutomaticQuoteSubstitutionEnabled" "bool"
        echo ""

        echo "# --- Screenshot ---"
        backup_defaults_key "com.apple.screencapture" "type"            "string"
        backup_defaults_key "com.apple.screencapture" "disable-shadow"  "bool"
        # スクリーンショット保存先: $HOME相対化
        local sc_loc
        sc_loc=$(defaults read "com.apple.screencapture" "location" 2>/dev/null) || true
        if [[ -n "$sc_loc" ]]; then
            sc_loc="${sc_loc/#$HOME/\$HOME}"
            echo "defaults write com.apple.screencapture location -string \"$sc_loc\""
        fi
        echo ""

        echo "# 設定を即時反映"
        echo "killall Dock Finder SystemUIServer 2>/dev/null || true"
    } > "$macos_dest"

    chmod +x "$macos_dest"
    log_success "macOS設定リストアスクリプトを生成しました: $macos_dest"
}

#######################################
# miseバージョン情報をバックアップ
#######################################
backup_mise() {
    log_section "miseバージョン情報のバックアップ"

    if ! check_command mise; then
        log_warn "miseが見つかりません。スキップします"
        return 0
    fi

    local dotfiles_root
    dotfiles_root="$(get_dotfiles_root)"
    local mise_dest="$dotfiles_root/mise/installed-versions.txt"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] mise list の出力を保存: $mise_dest"
        return 0
    fi

    safe_mkdir "$dotfiles_root/mise" || return 1

    log_info "miseインストール済みバージョンを取得中..."
    if mise list > "$mise_dest" 2>/dev/null; then
        log_success "miseバージョン情報を保存しました: $mise_dest"
    else
        log_error "mise list の実行に失敗しました"
        return 1
    fi
}

#######################################
# すべてをバックアップ
#######################################
backup_all() {
    backup_brew
    backup_gcloud
    backup_ssh
    backup_npm
    backup_macos
    backup_mise
}

#######################################
# サマリーを表示
#######################################
show_summary() {
    log_section "バックアップ完了"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "ドライランモードで実行しました"
        log_info "実際にバックアップするには --dry-run オプションを外してください"
    else
        log_success "バックアップが完了しました"

        echo ""
        log_info "次のステップ（変更をgitに保存）:"
        case "$COMPONENT" in
            all)
                echo "  git add Brewfile gcloud/ ssh/ npm/ macos/ mise/installed-versions.txt"
                ;;
            brew)
                echo "  git add Brewfile"
                ;;
            gcloud)
                echo "  git add gcloud/"
                ;;
            ssh)
                echo "  git add ssh/"
                ;;
            npm)
                echo "  git add npm/"
                ;;
            macos)
                echo "  git add macos/"
                ;;
            mise)
                echo "  git add mise/installed-versions.txt"
                ;;
        esac
        echo "  git commit -m \"backup: update system snapshot\""
    fi
}

#######################################
# メイン処理
#######################################
main() {
    # 引数の解析
    parse_arguments "$@"

    # ヘッダー表示
    log_section "Dotfiles バックアップスクリプト"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "モード: ドライラン（実際には実行しません）"
    fi

    log_info "コンポーネント: $COMPONENT"

    # システム情報の表示
    log_debug "OS: $(detect_os)"

    # 確認
    confirm_backup

    # バックアップの実行
    case "$COMPONENT" in
        all)
            backup_all
            ;;
        brew)
            backup_brew
            ;;
        gcloud)
            backup_gcloud
            ;;
        ssh)
            backup_ssh
            ;;
        npm)
            backup_npm
            ;;
        macos)
            backup_macos
            ;;
        mise)
            backup_mise
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
