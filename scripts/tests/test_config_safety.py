import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import shutil
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('config_files', SCRIPTS / 'config-files.py')
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class ConfigSafetyTests(unittest.TestCase):
    def test_dry_run_backup_idempotency_and_symlink_preservation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            home, repo = root / 'home', root / 'repo'
            home.mkdir()
            (repo / 'scripts').mkdir(parents=True)
            (repo / 'setting').write_text('home=__HOME__\n')
            (repo / 'scripts/config-files.json').write_text(json.dumps([
                {'group': 'cli', 'source': 'setting', 'target': '.config/tool/config'}]))
            original = home / 'outside'
            original.write_text('keep original')
            target = home / '.config/tool/config'
            target.parent.mkdir(parents=True)
            target.symlink_to(original)
            env = {'HOME': str(home), 'XDG_CONFIG_HOME': str(home / '.config')}
            with patch.object(config, 'ROOT', repo), patch.dict(os.environ, env), contextlib.redirect_stdout(io.StringIO()):
                with patch.object(sys, 'argv', ['config-files.py', 'apply', '--dry-run']):
                    self.assertEqual(config.main(), 0)
                self.assertTrue(target.is_symlink())
                self.assertFalse((home / '.local/state').exists())
                with patch.object(sys, 'argv', ['config-files.py', 'apply']):
                    self.assertEqual(config.main(), 0)
                    self.assertEqual(config.main(), 0)
                self.assertEqual(original.read_text(), 'keep original')
                self.assertEqual(target.read_text(), f'home={home}\n')
                backups = list((home / '.local/state/dotfiles/backups').iterdir())
                self.assertEqual(len(backups), 1)
                self.assertTrue((backups[0] / '.config/tool/config').is_symlink())
                with patch.object(sys, 'argv', ['config-files.py', 'audit']):
                    self.assertEqual(config.main(), 0)

    def test_codex_sync_keeps_local_config_auth_and_sessions(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            codex = home / '.codex'
            codex.mkdir()
            for name in ['config.toml', 'auth.json', 'history.jsonl']:
                (codex / name).write_text('local-only')
            (codex / 'sessions').mkdir()
            (codex / 'sessions/session.jsonl').write_text('session')
            env = dict(os.environ, HOME=str(home), CODEX_HOME=str(codex), XDG_CONFIG_HOME=str(home / '.config'))
            subprocess.run(['bash', str(SCRIPTS / 'sync.sh'), 'push', '--codex', '--force'], env=env, check=True, capture_output=True)
            for name in ['config.toml', 'auth.json', 'history.jsonl']:
                self.assertEqual((codex / name).read_text(), 'local-only')
            self.assertEqual((codex / 'sessions/session.jsonl').read_text(), 'session')
            self.assertTrue((codex / 'AGENTS.md').is_file())

    def test_scoped_npm_backup_and_failed_listing_preserve_previous_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scripts = root / 'scripts'
            (scripts / 'utils').mkdir(parents=True)
            shutil.copy2(SCRIPTS / 'backup.sh', scripts / 'backup.sh')
            for name in ['common.sh', 'os-detect.sh', 'logger.sh']:
                shutil.copy2(SCRIPTS / 'utils' / name, scripts / 'utils' / name)
            binary = root / 'bin'
            binary.mkdir()
            npm = binary / 'npm'
            npm.write_text("#!/bin/sh\nprintf '%s\\n' "
                           "'{\"dependencies\":{\"@scope/tool\":{\"version\":\"1\"},\"npm\":{},\"corepack\":{}}}'\n")
            npm.chmod(0o755)
            env = dict(os.environ, HOME=str(root), PATH=str(binary) + os.pathsep + os.environ['PATH'])
            command = ['bash', str(scripts / 'backup.sh'), '--npm', '--force']
            subprocess.run(command, env=env, check=True, capture_output=True)
            listing = root / 'npm/packages.txt'
            self.assertEqual(listing.read_text(), '@scope/tool\n')
            npm.write_text('#!/bin/sh\nexit 1\n')
            result = subprocess.run(command, env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(listing.read_text(), '@scope/tool\n')

    def test_verifier_reports_missing_critical_file_at_end(self):
        with tempfile.TemporaryDirectory() as temp:
            env = dict(os.environ, HOME=temp, XDG_CONFIG_HOME=str(Path(temp) / '.config'))
            result = subprocess.run(['bash', str(SCRIPTS / 'verify-setup.sh'), '--shell'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('検証結果サマリー', result.stdout)


if __name__ == '__main__':
    unittest.main()
