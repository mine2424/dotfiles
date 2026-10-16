#!/usr/bin/env bash
# cleanup-safe.sh - 再生成可能なキャッシュの削除（disk-cleanup.sh --safe）
# disk-cleanup.sh から source され、run_or_echo / remove_path / DAYS 等を利用する

#######################################
# Docker: ビルドキャッシュと dangling イメージ
#######################################
clean_docker() {
    log_section "Docker"
    if ! check_command docker || ! docker info >/dev/null 2>&1; then
        log_warn "Docker が起動していないためスキップします"
        return 0
    fi
    run_or_echo docker builder prune -af
    run_or_echo docker image prune -f
}

#######################################
# npm / pnpm / puppeteer
#######################################
clean_node_caches() {
    log_section "Node.js キャッシュ"
    if check_command npm; then
        run_or_echo npm cache clean --force
    fi

    # 実行中の MCP サーバー等を壊さないよう、古い npx キャッシュのみ削除
    local dir
    if [[ -d "$HOME/.npm/_npx" ]]; then
        while IFS= read -r dir; do
            remove_path "$dir"
        done < <(find "$HOME/.npm/_npx" -mindepth 1 -maxdepth 1 -type d -mtime "+$DAYS")
    fi

    local mise_pnpm="$HOME/.local/share/mise/installs/pnpm/latest/pnpm"
    if check_command pnpm; then
        run_or_echo pnpm store prune
    elif [[ -x "$mise_pnpm" ]]; then
        run_or_echo "$mise_pnpm" store prune
    fi
    remove_path "$HOME/.cache/pnpm"
    remove_path "$HOME/.cache/puppeteer"
}

#######################################
# uv / pip
#######################################
clean_python_caches() {
    log_section "Python キャッシュ"
    # uvx 起動の MCP サーバー（serena 等）が動いているとキャッシュロック待ちで停止するためスキップ
    if pgrep -x uv >/dev/null 2>&1; then
        log_warn "uv プロセスが実行中のため uv キャッシュはスキップします（MCP サーバー停止後に再実行）"
    elif check_command uv; then
        run_or_echo uv cache clean
    fi
    remove_path "$HOME/Library/Caches/pip"
}

#######################################
# Go ビルドキャッシュ / モジュールキャッシュ
#######################################
clean_go_caches() {
    log_section "Go キャッシュ"
    if check_command go; then
        run_or_echo go clean -cache -modcache
    fi
}

#######################################
# Xcode DerivedData / SwiftPM / CocoaPods / 利用不可シミュレータ
#######################################
clean_xcode_caches() {
    log_section "Xcode キャッシュ"
    local derived="$HOME/Library/Developer/Xcode/DerivedData"
    local dir
    if [[ -d "$derived" ]]; then
        while IFS= read -r dir; do
            remove_path "$dir"
        done < <(find "$derived" -mindepth 1 -maxdepth 1)
    fi
    remove_path "$HOME/Library/Caches/org.swift.swiftpm"
    remove_path "$HOME/Library/Caches/CocoaPods"

    if check_command xcrun; then
        run_or_echo xcrun simctl delete unavailable
    fi
}

#######################################
# mise ダウンロードキャッシュ
#######################################
clean_mise_cache() {
    log_section "mise キャッシュ"
    if check_command mise; then
        run_or_echo mise cache clear
    fi
}

#######################################
# アプリのアップデータ残骸 / Codex キャッシュ / Homebrew
#######################################
clean_app_caches() {
    log_section "アプリキャッシュ"
    local caches="$HOME/Library/Caches"
    local dir
    for dir in "$caches"/*.ShipIt "$caches"/*-updater "$caches/com.openai.codex"; do
        remove_path "$dir"
    done

    if check_command brew; then
        run_or_echo brew cleanup --prune=all
    fi
}

#######################################
# 14日より古いログファイル
#######################################
clean_logs() {
    log_section "古いログ"
    local logs="$HOME/Library/Logs"
    [[ -d "$logs" ]] || return 0
    local count
    count="$(find "$logs" -type f -mtime +14 2>/dev/null | wc -l | tr -d ' ')"
    log_info "14日より古いログ: ${count} ファイル"
    if [[ "$DRY_RUN" == "false" && "$count" -gt 0 ]]; then
        find "$logs" -type f -mtime +14 -delete 2>/dev/null || true
    fi
}
