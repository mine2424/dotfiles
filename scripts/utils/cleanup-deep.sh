#!/usr/bin/env bash
# cleanup-deep.sh - 判断を伴う不要ファイルの削除（disk-cleanup.sh --deep）
# disk-cleanup.sh から source され、run_or_echo / remove_path / ask / DAYS / DEV_ROOTS 等を利用する

# プラットフォームごとに残すシミュレータランタイム数（新しい順）
SIM_RUNTIMES_TO_KEEP=2

#######################################
# ディレクトリ配下（成果物ディレクトリを除く）が DAYS 日以上更新されていないか
#######################################
is_stale() {
    local dir="$1"
    local recent
    recent="$(find "$dir" -maxdepth 3 \
        \( -name node_modules -o -name .git -o -name .next -o -name .turbo -o -name .venv \
           -o -name .dart_tool -o -name Pods -o -name .DS_Store \) -prune \
        -o -mtime "-$DAYS" -print -quit 2>/dev/null)"
    [[ -z "$recent" ]]
}

#######################################
# 古いシミュレータランタイム（各プラットフォームで新しい N 個を残す）
#######################################
prune_sim_runtimes() {
    log_section "古いシミュレータランタイム（各プラットフォーム最新 ${SIM_RUNTIMES_TO_KEEP} 個を保持）"
    check_command xcrun || return 0

    local id version platform size
    while read -r id version platform size; do
        [[ -n "$id" ]] || continue
        if ask "$platform $version (${size}GB) を削除しますか？"; then
            log_info "削除: $platform $version (${size}GB)"
            run_or_echo xcrun simctl runtime delete "$id"
        fi
    done < <(xcrun simctl runtime list -j 2>/dev/null | python3 -c '
import json, sys
keep = int(sys.argv[1])
groups = {}
for key, rt in json.load(sys.stdin).items():
    ver = tuple(int(p) for p in rt["version"].split(".") if p.isdigit())
    groups.setdefault(rt.get("platformIdentifier", ""), []).append((ver, rt.get("identifier", key), rt))
for platform, items in groups.items():
    items.sort(key=lambda item: item[0], reverse=True)
    for _, rid, rt in items[keep:]:
        print(rid, rt["version"], platform.split(".")[-1], round(rt.get("sizeBytes", 0) / 1e9, 1))
' "$SIM_RUNTIMES_TO_KEEP")

    run_or_echo xcrun simctl delete unavailable
}

#######################################
# 実機接続時に作られる DeviceSupport（DAYS 日以上前のもの）
#######################################
prune_device_support() {
    log_section "Xcode DeviceSupport（${DAYS}日以上前）"
    local base="$HOME/Library/Developer/Xcode"
    local dir
    for support in "$base/iOS DeviceSupport" "$base/watchOS DeviceSupport"; do
        [[ -d "$support" ]] || continue
        while IFS= read -r dir; do
            if ask "$(basename "$dir") ($(size_of "$dir")) を削除しますか？"; then
                remove_path "$dir"
            fi
        done < <(find "$support" -mindepth 1 -maxdepth 1 -type d -mtime "+$DAYS")
    done
}

#######################################
# 古い git worktree（Codex / Claude Code が作成したもの）
#######################################
prune_worktrees() {
    log_section "古い git worktree（${DAYS}日以上未更新）"
    local candidates=() root wt
    shopt -s nullglob
    candidates=("$HOME"/.codex/worktrees/*/*)
    for root in "${DEV_ROOTS[@]}"; do
        candidates+=("$root"/*/.claude/worktrees/* "$root"/*/*/.claude/worktrees/*)
    done
    shopt -u nullglob

    for wt in "${candidates[@]}"; do
        prune_worktree "$wt"
    done
}

prune_worktree() {
    local wt="$1"
    [[ -f "$wt/.git" ]] || return 0
    is_stale "$wt" || return 0

    local common_dir
    if ! common_dir="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
        log_warn "スキップ（git 情報を取得できません）: $wt"
        return 0
    fi
    if [[ -f "$(git -C "$wt" rev-parse --path-format=absolute --git-dir)/locked" ]]; then
        log_warn "スキップ（ロック中。不要なら git worktree unlock 後に再実行）: $wt"
        return 0
    fi
    if [[ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]]; then
        log_warn "スキップ（未コミットの変更あり）: $wt"
        return 0
    fi
    if [[ -z "$(git -C "$wt" for-each-ref --contains HEAD --count=1 refs/heads refs/remotes 2>/dev/null)" ]]; then
        log_warn "スキップ（どのブランチにも含まれないコミットあり）: $wt"
        return 0
    fi

    ask "worktree を削除しますか: $wt ($(size_of "$wt"))" || return 0
    log_info "削除: $wt ($(size_of "$wt"))"
    run_or_echo git --git-dir="$common_dir" worktree remove "$wt"

    # Codex は worktrees/<id>/<repo> 構成のため空になった <id> も削除
    local parent
    parent="$(dirname "$wt")"
    if [[ "$DRY_RUN" == "false" && "$parent" == "$HOME/.codex/worktrees/"* ]]; then
        rmdir "$parent" 2>/dev/null || true
    fi
}

#######################################
# 放置プロジェクトの依存・ビルド成果物
#######################################
prune_stale_artifacts() {
    log_section "放置プロジェクトの成果物（${DAYS}日以上未更新）"
    local targets=() root dir
    for root in "${DEV_ROOTS[@]}"; do
        [[ -d "$root" ]] || continue
        while IFS= read -r dir; do
            if is_stale "$(dirname "$dir")"; then
                targets+=("$dir")
            fi
        done < <(find "$root" -maxdepth 6 \( -name .git -prune \) -o \
            \( -type d \( -name node_modules -o -name .next -o -name .turbo -o -name .venv \
                -o -name .dart_tool -o -name Pods \) -prune -print \) 2>/dev/null)
    done

    if [[ ${#targets[@]} -eq 0 ]]; then
        log_info "対象なし"
        return 0
    fi
    for dir in "${targets[@]}"; do
        printf "%8s  %s\n" "$(size_of "$dir")" "${dir/#$HOME/~}"
    done
    ask "上記 ${#targets[@]} 件を削除しますか？（npm/pnpm install 等で再生成できます）" || return 0
    for dir in "${targets[@]}"; do
        remove_path "$dir"
    done
}

#######################################
# mise: どの設定ファイルからも参照されていないバージョン
# （mise prune は tracked-configs のみを見るため、使用中のバージョンも消し得る）
#######################################
is_version_referenced() {
    grep -rqsF --exclude-dir=node_modules --exclude-dir=.git \
        --include=.tool-versions --include=mise.toml --include=.mise.toml --include=config.toml \
        --include=.fvmrc --include=.nvmrc --include=.node-version --include=.python-version \
        -- "$1" "${DEV_ROOTS[@]}" "$HOME/.config/mise" "$HOME/.tool-versions"
}

prune_mise_versions() {
    log_section "mise 未参照バージョン"
    check_command mise || return 0

    local tool version
    while read -r tool version _; do
        [[ -n "$tool" ]] || continue
        if is_version_referenced "$version"; then
            log_info "保持（設定ファイルで参照あり）: $tool@$version"
            continue
        fi
        ask "$tool@$version をアンインストールしますか？" || continue
        run_or_echo mise uninstall "$tool@$version"
    done < <(mise ls --prunable 2>/dev/null)

    remove_orphan_tarballs
}

# flutter 等の http バックエンドはインストール実体が http-tarballs に残るため掃除する
remove_orphan_tarballs() {
    local tarballs="$HOME/.local/share/mise/http-tarballs"
    [[ -d "$tarballs" ]] || return 0
    local links dir
    links="$(find "$HOME/.local/share/mise/installs" -maxdepth 2 -type l -exec readlink {} \; 2>/dev/null)"
    for dir in "$tarballs"/*; do
        [[ -d "$dir" ]] || continue
        if ! grep -qF "$(basename "$dir")" <<< "$links"; then
            remove_path "$dir"
        fi
    done
}
