#!/usr/bin/env bash
# disk-cleanup.sh - キャッシュ・不要ファイルを削除してディスク空き容量を回復

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=./utils/common.sh
source "$SCRIPT_DIR/utils/common.sh"
# shellcheck source=./utils/cleanup-safe.sh
source "$SCRIPT_DIR/utils/cleanup-safe.sh"
# shellcheck source=./utils/cleanup-deep.sh
source "$SCRIPT_DIR/utils/cleanup-deep.sh"

MODE="report"
DRY_RUN=false
ASSUME_YES=false
DAYS=30
DATA_VOLUME="/System/Volumes/Data"
[[ -d "$DATA_VOLUME" ]] || DATA_VOLUME="/"

# 開発用ディレクトリ（worktree / node_modules 探索のルート）
DEV_ROOTS=("$HOME/development" "$HOME/orca")

# --report で表示する主な容量消費ポイント
REPORT_PATHS=(
    "$HOME/.npm"
    "$HOME/.cache/uv"
    "$HOME/.cache/pnpm"
    "$HOME/.local/share/pnpm/store"
    "$HOME/.local/share/mise"
    "$HOME/go/pkg"
    "$HOME/.codex/worktrees"
    "$HOME/.pub-cache"
    "$HOME/.cache/huggingface"
    "$HOME/Library/Caches"
    "$HOME/Library/Developer/Xcode/DerivedData"
    "$HOME/Library/Developer/Xcode/iOS DeviceSupport"
    "$HOME/Library/Developer/CoreSimulator/Devices"
    "$HOME/Library/Containers/com.docker.docker"
    "$HOME/Library/Application Support/Notion/Partitions"
    "$HOME/Library/Application Support/Claude/vm_bundles"
    "$HOME/Library/Android/sdk"
    "$HOME/Downloads"
)

show_usage() {
    cat <<EOF
 使用方法: $(basename "$0") [モード] [オプション]

 キャッシュや再生成可能なファイルを削除してディスク容量を回復します。
 詳細は docs/disk-maintenance.md を参照してください。

 モード:
   --report           容量レポートのみ表示（デフォルト、削除しない）
   --safe             再生成可能なキャッシュを削除
   --deep             --safe に加えて古いシミュレータ / worktree / 放置 node_modules 等を削除

 オプション:
   --dry-run          実際には削除せず、実行内容を表示
   -y, --yes          確認プロンプトを省略
   --days N           「古い」と判定する日数（デフォルト: 30）
   -h, --help         このヘルプを表示

 例:
   $(basename "$0")                        # レポートのみ
   $(basename "$0") --safe --dry-run       # safe の削除内容を確認
   $(basename "$0") --deep --days 60       # 60日以上放置のものまで削除
EOF
}

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --report) MODE="report" ;;
            --safe) MODE="safe" ;;
            --deep) MODE="deep" ;;
            --dry-run) DRY_RUN=true ;;
            -y|--yes) ASSUME_YES=true ;;
            --days)
                [[ "${2:-}" =~ ^[0-9]+$ ]] || { log_error "--days には日数（整数）を指定してください"; exit 1; }
                DAYS="$2"
                shift
                ;;
            -h|--help) show_usage; exit 0 ;;
            *) log_error "不明なオプション: $1"; show_usage; exit 1 ;;
        esac
        shift
    done
}

#######################################
# 共通ヘルパー（cleanup-safe.sh / cleanup-deep.sh から使用）
#######################################
run_or_echo() {
    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] $*"
        return 0
    fi
    "$@" || log_warn "失敗しました（続行します）: $*"
}

size_of() {
    du -sh "$1" 2>/dev/null | cut -f1
}

remove_path() {
    local path="$1"
    [[ -e "$path" || -L "$path" ]] || return 0
    log_info "削除: $path ($(size_of "$path"))"
    run_or_echo rm -rf "$path"
}

ask() {
    [[ "$ASSUME_YES" == "true" || "$DRY_RUN" == "true" ]] && return 0
    confirm "$1" "n"
}

free_kb() {
    df -k "$DATA_VOLUME" | awk 'NR==2 {print $4}'
}

format_kb() {
    awk -v kb="$1" 'BEGIN { printf "%.1fGB", kb / 1024 / 1024 }'
}

show_report() {
    log_section "ディスク使用状況"
    df -h "$DATA_VOLUME"

    log_section "主な容量消費ポイント"
    local path
    for path in "${REPORT_PATHS[@]}"; do
        if [[ -e "$path" ]]; then
            printf "%8s  %s\n" "$(size_of "$path")" "${path/#$HOME/~}"
        fi
    done

    if check_command docker && docker info >/dev/null 2>&1; then
        log_section "Docker"
        docker system df
    fi

    if check_command mise; then
        log_section "mise 未使用候補（mise ls --prunable）"
        mise ls --prunable 2>/dev/null || true
    fi
}

run_safe() {
    clean_docker
    clean_node_caches
    clean_python_caches
    clean_go_caches
    clean_xcode_caches
    clean_mise_cache
    clean_app_caches
    clean_logs
}

run_deep() {
    prune_sim_runtimes
    prune_device_support
    prune_worktrees
    prune_stale_artifacts
    prune_mise_versions
}

main() {
    parse_arguments "$@"

    if [[ "$MODE" == "report" ]]; then
        show_report
        exit 0
    fi

    log_section "ディスククリーンアップ（mode: $MODE, days: $DAYS, dry-run: ${DRY_RUN}）"
    if ! ask "$MODE モードで削除を実行しますか？"; then
        log_info "キャンセルしました"
        exit 0
    fi

    local before after
    before="$(free_kb)"

    run_safe
    if [[ "$MODE" == "deep" ]]; then
        run_deep
    fi

    after="$(free_kb)"
    log_section "完了"
    log_info "空き容量: $(format_kb "$before") → $(format_kb "$after")"
    if [[ "$DRY_RUN" == "false" ]]; then
        log_success "回復した容量: $(format_kb $((after - before)))"
    fi
}

main "$@"
