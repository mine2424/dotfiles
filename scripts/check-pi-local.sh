#!/usr/bin/env bash
# Local regression checks; do not download packages or call a model from a Git hook.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
source "$SCRIPT_DIR/utils/local-node.sh"
command -v python3 >/dev/null
bash -n "$SCRIPT_DIR/setup.sh" "$SCRIPT_DIR/setup-pi.sh" "$SCRIPT_DIR/setup-hooks.sh" "$SCRIPT_DIR/check-pi-local.sh" "$SCRIPT_DIR/check-beethoven-local.sh" "$SCRIPT_DIR/utils/local-node.sh"
node --check "$SCRIPT_DIR/configure-pi.mjs"
node --check "$SCRIPT_DIR/smoke-pstack.mjs"
python3 -m unittest discover -s scripts/tests -p test_setup_pi.py -v
