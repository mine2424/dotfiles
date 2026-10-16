#!/usr/bin/env python3
"""Apply or inspect the explicit, credential-free config file manifest."""
import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['audit', 'apply'])
    parser.add_argument('--group', choices=['all', 'shell', 'cli', 'desktop'], default='all')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    home = Path.home()
    backup_root = None
    different = 0
    for entry in json.loads((ROOT / 'scripts/config-files.json').read_text()):
        if args.group not in ('all', entry['group']):
            continue
        source = ROOT / entry['source']
        target = home / entry['target']
        if entry['target'].startswith('.config/'):
            target = Path(os.environ.get('XDG_CONFIG_HOME', str(home / '.config'))) / entry['target'][8:]
        content = source.read_text().replace('__HOME__', str(home)).encode()
        if target.is_file() and target.read_bytes() == content:
            print(f'OK {entry["target"]}')
            continue
        different += 1
        print(f'{"UPDATE" if target.exists() or target.is_symlink() else "ADD"} {entry["target"]}')
        if args.action == 'audit' or args.dry_run:
            continue
        if target.exists() or target.is_symlink():
            if backup_root is None:
                base = home / '.local/state/dotfiles/backups'
                base.mkdir(parents=True, exist_ok=True, mode=0o700)
                backup_root = Path(tempfile.mkdtemp(prefix='config-', dir=base))
            backup = backup_root / entry['target']
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(target), str(backup))
        target.parent.mkdir(parents=True, exist_ok=True)
        # Write individual files; directories containing sessions and secrets are never copied.
        target.write_bytes(content)
    if backup_root:
        print(f'Backup: {backup_root}')
    if args.action == 'audit':
        print(f'Differences: {different}')
        return int(different > 0)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
