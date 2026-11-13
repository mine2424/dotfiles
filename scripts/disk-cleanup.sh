#!/usr/bin/env bash
# macOS の容量調査・整理。デフォルトは読み取り専用。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/disk-cleanup.py" "$@"
