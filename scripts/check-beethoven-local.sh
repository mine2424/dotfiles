#!/usr/bin/env bash
# Local counterpart of the removed Beethoven CI. Dependencies must be installed first.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/utils/local-node.sh"
cd "$DOTFILES_LOCAL_ROOT/beethoven"
if [[ ! -x node_modules/.bin/tsc ]]; then
    echo '依存がありません。beethoven/ で npm ci --ignore-scripts を実行してください。' >&2
    exit 1
fi
npm run typecheck
npm test
# The PTY probes use temporary settings and scripted models, not the user's launcher or auth.
python3 - <<'PY'
import os
from pathlib import Path
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix='beethoven-local-check-') as tmp:
    subprocess.run(['node', 'scripts/install-local.mjs', '--bin-dir', tmp], check=True)
    env = dict(os.environ, BEETHOVEN_LAUNCHER=str(Path(tmp) / 'beethoven'))
    subprocess.run(['python3', 'scripts/check-tui-pty.py'], env=env, check=True)
    subprocess.run(['python3', 'scripts/check-dialogue-pty.py'], env=env, check=True)
PY
