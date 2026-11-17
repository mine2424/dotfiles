"""Run the setup entry points with an isolated home and fake network commands."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


class PiSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pi setup ')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.bin = self.home / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ, HOME=str(self.home),
                        PATH=f'{self.bin}:/usr/bin:/bin')
        self.env.pop('PI_CODING_AGENT_DIR', None)
        self.env.pop('BASH_ENV', None)
        self.agent = self.home / '.pi/agent'
        self.fake('jq', 'exit 0\n')

    def run_setup(self, *args, main=False):
        script = SCRIPTS / ('setup.sh' if main else 'setup-pi.sh')
        return subprocess.run(['bash', str(script), *args], env=self.env,
                              text=True, capture_output=True, timeout=20)

    def fake(self, name, content):
        path = self.bin / name
        path.write_text('#!/bin/bash\nset -eu\n' + content)
        path.chmod(0o755)

    def test_dry_run_and_existing_settings_and_auth(self):
        result = self.run_setup('--install', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.agent.exists())
        result = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.agent / 'AGENTS.md').is_symlink())
        (self.agent / 'settings.json').write_text('{"theme":"custom"}')
        (self.agent / 'auth.json').write_text('local credential')
        (self.agent / 'AGENTS.md').unlink()
        (self.agent / 'AGENTS.md').write_text('existing rules')
        for _ in range(2):
            result = self.run_setup()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.agent / 'settings.json').read_text(), '{"theme":"custom"}')
        self.assertEqual((self.agent / 'auth.json').read_text(), 'local credential')
        self.assertEqual((self.agent / 'AGENTS.md').read_text(), 'existing rules')

    def test_prompt_links_preserve_existing_files_and_repeat_safely(self):
        prompts = self.agent / 'prompts'
        prompts.mkdir(parents=True)
        (prompts / 'review.md').write_text('personal review')
        other = self.home / 'custom-plan.md'
        other.write_text('personal plan')
        (prompts / 'plan.md').symlink_to(other)
        for _ in range(2):
            result = self.run_setup()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((prompts / 'review.md').read_text(), 'personal review')
        self.assertEqual((prompts / 'plan.md').resolve(), other.resolve())
        self.assertEqual((prompts / 'work.md').resolve(), SCRIPTS.parent / 'pi/prompts/work.md')
        self.assertTrue((prompts / 'handoff.md').is_symlink())

    def test_custom_agent_directory(self):
        custom = self.home / 'custom agent'
        self.env['PI_CODING_AGENT_DIR'] = str(custom)
        self.assertEqual(self.run_setup().returncode, 0)
        self.assertTrue((custom / 'AGENTS.md').is_symlink())
        self.assertFalse(self.agent.exists())

    def prepare_install(self):
        self.fake('node', 'exit 0\n')
        self.fake('git', 'exit 0\n')
        self.fake('mise', '''
printf '%s\\n' "$*" >> "$HOME/mise-calls"
[[ ! -e "$HOME/fail-mise" ]] || exit 8
case "$1" in
    install) exit 0 ;;
    where) printf '%s\\n' "$HOME" ;;
    *) exit 2 ;;
esac
''')
        self.fake('npm', '''
printf '%s\\n' "$*" >> "$HOME/npm-calls"
prefix="$4"
mkdir -p "$prefix/bin"
cat > "$prefix/bin/pi" <<'PI'
#!/bin/bash
set -eu
node --version >/dev/null
if [[ "${1:-}" == --check-child-pi ]]; then command -v pi; exit 0; fi
printf '%s\\n' "$*" >> "$HOME/pi-calls"
if [[ "$1" == install ]]; then
    [[ ! -e "$HOME/fail-install" ]] || exit 9
    printf '%s\\n' "$2" > "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/registered"
fi
PI
chmod +x "$prefix/bin/pi"
''')

    def test_install_retries_backup_and_failure_propagation(self):
        self.prepare_install()
        launcher = self.home / '.local/bin/pi'
        launcher.parent.mkdir(parents=True)
        launcher.write_text('previous launcher')
        for _ in range(2):
            result = self.run_setup('--install')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(launcher.is_symlink())
        backups = list((self.home / '.local/state/dotfiles/backups').glob('*/pi'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), 'previous launcher')
        self.assertIn('@earendil-works/pi-coding-agent@1.5.2', (self.home / 'npm-calls').read_text())
        self.assertIn('@e3ba2aa6', (self.home / 'pi-calls').read_text())
        self.assertIn('install npm:@zenspc/pi-pstack@0.9.0', (self.home / 'pi-calls').read_text())
        self.assertIn('install npm:pi-subagents@0.88.1', (self.home / 'pi-calls').read_text())
        self.assertIn('install npm:@plannotator/pi-extension@0.28.66', (self.home / 'pi-calls').read_text())
        self.assertEqual(json.loads((self.agent / 'settings.json').read_text()),
                         {'defaultProjectTrust': 'ask'})
        # The generated launcher must work with paths containing spaces.
        result = subprocess.run([str(launcher), '--version'], env=self.env,
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        (self.home / 'fail-install').touch()
        result = self.run_setup('--install')
        self.assertEqual(result.returncode, 9, result.stderr)
        result = self.run_setup('--pi', '--install', '--force', main=True)
        self.assertEqual(result.returncode, 9, result.stdout + result.stderr)
        self.assertNotIn('セットアップが完了しました', result.stdout)

    def test_bootstrap_mise_replaces_missing_or_old_node(self):
        self.prepare_install()
        managed_bin = self.home / 'managed node/bin'
        managed_bin.mkdir(parents=True)
        for name in ['node', 'npm']:
            (self.bin / name).rename(managed_bin / name)
        # mise is not yet installed; curl supplies a local installer fixture.
        installer = self.home / 'installer.sh'
        installer.write_text('''#!/bin/sh
mkdir -p "$(dirname "$MISE_INSTALL_PATH")"
cp "$HOME/mise-fixture" "$MISE_INSTALL_PATH"
chmod +x "$MISE_INSTALL_PATH"
''')
        fixture = self.home / 'mise-fixture'
        fixture.write_text((self.bin / 'mise').read_text().replace(
            '"$HOME" ;;', '"$HOME/managed node" ;;'))
        (self.bin / 'mise').unlink()
        self.fake('curl', '''
printf '%s\\n' "$*" >> "$HOME/curl-calls"
cat "$HOME/installer.sh"
''')
        # Both initial states must use the managed runtime, never the PATH node.
        for old_node in [False, True]:
            with self.subTest(old_node=old_node):
                if old_node:
                    self.fake('node', 'echo "old node invoked" >&2; exit 7\n')
                result = self.run_setup('--install')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn('old node invoked', result.stderr)
        self.assertEqual(len((self.home / 'curl-calls').read_text().splitlines()), 1)
        calls = (self.home / 'mise-calls').read_text()
        self.assertIn('install node@24.22.1', calls)
        self.assertIn('where node@24.22.1', calls)
        self.assertIn('managed\\ node/bin', (self.home / '.local/share/dotfiles/pi/launch-pi').read_text())
        self.assertFalse((self.home / '.config/mise/config.toml').exists())

    def test_launcher_prefers_managed_node_over_local_node(self):
        self.prepare_install()
        self.fake('pi', 'echo "wrong global Pi" >&2; exit 8\n')
        local_bin = self.home / '.local/bin'
        local_bin.mkdir(parents=True)
        old_node = local_bin / 'node'
        old_node.write_text('#!/bin/sh\necho "wrong local Node" >&2\nexit 7\n')
        old_node.chmod(0o755)
        result = self.run_setup('--install')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        child = subprocess.run([str(local_bin / 'pi'), '--check-child-pi'], env=self.env,
                               text=True, capture_output=True, timeout=10)
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(child.stdout.strip(), str(self.home / '.local/share/dotfiles/pi/bin/pi'))
        result = subprocess.run([str(local_bin / 'pi'), '--version'], env=self.env,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_mise_and_download_failures_stop_before_npm(self):
        self.prepare_install()
        (self.home / 'fail-mise').touch()
        result = self.run_setup('--install')
        self.assertEqual(result.returncode, 8, result.stdout + result.stderr)
        self.assertFalse((self.home / 'npm-calls').exists())
        (self.bin / 'mise').unlink()
        self.fake('curl', 'exit 22\n')
        result = self.run_setup('--install')
        self.assertEqual(result.returncode, 22, result.stdout + result.stderr)
        self.assertFalse(self.agent.exists())

    def test_incomplete_mise_runtime_does_not_fall_back_to_system_node(self):
        self.prepare_install()
        (self.bin / 'npm').unlink()
        result = self.run_setup('--install')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('node/npm', result.stderr)
        self.assertFalse(self.agent.exists())

    def test_main_entry_and_invalid_argument(self):
        result = self.run_setup('--pi', '--install', '--dry-run', main=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('pi install git:github.com/DietrichGebert/ponytail@', result.stdout)
        self.assertIn('pi install npm:@plannotator/pi-extension@0.28.66', result.stdout)
        self.assertFalse(self.agent.exists())
        self.assertNotEqual(self.run_setup('--unknown').returncode, 0)

    def test_diagnostic_reports_missing_install_without_exposing_settings(self):
        self.agent.mkdir(parents=True)
        (self.agent / 'settings.json').write_text('invalid-json private-value')
        (self.agent / 'auth.json').write_text('credential-must-not-appear')
        result = subprocess.run([sys.executable, str(SCRIPTS / 'check-pi.py'), '--smoke'],
                                env=self.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 1, result.stderr)
        report = json.loads(result.stdout)
        self.assertFalse(report['ok'])
        self.assertFalse(report['model_response_tested'])
        self.assertEqual(len(report['checks']), 21)
        checks = {item['name']: item['ok'] for item in report['checks']}
        self.assertFalse(checks['plannotator_registered'])
        self.assertFalse(checks['plannotator_version'])
        self.assertNotIn('private-value', result.stdout + result.stderr)
        self.assertNotIn('credential-must-not-appear', result.stdout + result.stderr)

    def test_local_skills_and_principles_preserve_user_resources(self):
        skills = self.agent / 'skills'
        skills.mkdir(parents=True)
        (self.agent / 'PRINCIPLES.md').write_text('personal principles')
        custom = skills / 'new-development'
        custom.mkdir()
        (custom / 'SKILL.md').write_text('personal skill')
        for _ in range(2):
            result = self.run_setup()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.agent / 'PRINCIPLES.md').read_text(), 'personal principles')
        self.assertEqual((custom / 'SKILL.md').read_text(), 'personal skill')
        self.assertTrue((skills / 'existing-change').is_symlink())
        self.assertTrue((skills / 'incident-fix').is_symlink())

    def test_hook_setup_preserves_custom_hook_and_hooks_path(self):
        self.fake('mise', 'echo invoked >> "$HOME/hook-mise-calls"\n')
        self.fake('git', '''
if [[ "$1" == config ]]; then
    [[ ! -f "$HOME/custom-hooks-path" ]] || cat "$HOME/custom-hooks-path"
elif [[ "$1" == rev-parse ]]; then
    printf '%s\\n' "$HOME/hooks"
else
    exit 2
fi
''')
        hooks = self.home / 'hooks'
        hooks.mkdir()
        hook = hooks / 'pre-push'
        hook.write_text('#!/bin/sh\n# personal hook; lefthook migration later\necho personal hook\n')
        command = ['bash', str(SCRIPTS / 'setup-hooks.sh')]
        result = subprocess.run(command, env=self.env, text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('personal hook', hook.read_text())
        self.assertFalse((self.home / 'hook-mise-calls').exists())
        (self.home / 'custom-hooks-path').write_text('custom-hook-dir')
        result = subprocess.run(command, env=self.env, text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('core.hooksPath', result.stderr)
        self.assertFalse((self.home / 'hook-mise-calls').exists())

    def test_ponytail_configuration_preserves_other_settings_and_is_idempotent(self):
        settings = self.home / 'settings.json'
        source = 'git:github.com/DietrichGebert/ponytail@fixed'
        before = {'defaultModel': 'personal-model', 'packages': [
            'npm:unrelated@1', {'source': source, 'skills': ['+skills/ponytail/SKILL.md']}],
            'subagents': {'defaultModel': 'personal-provider/model'}}
        settings.write_text(json.dumps(before))
        alias = self.home / 'linked-settings.json'
        alias.symlink_to(settings)
        command = ['node', str(SCRIPTS / 'configure-pi.mjs'), str(alias), source]
        for _ in range(2):
            result = subprocess.run(command, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
        after = json.loads(settings.read_text())
        self.assertEqual(after['defaultModel'], before['defaultModel'])
        self.assertEqual(after['subagents'], before['subagents'])
        self.assertEqual(after['packages'][0], before['packages'][0])
        self.assertEqual(after['packages'][1], {**before['packages'][1], 'extensions': []})
        self.assertTrue(alias.is_symlink())
        backups = list(self.home.glob('settings.json.before-pstack.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(json.loads(backups[0].read_text()), before)
        settings.write_text('invalid private setting')
        result = subprocess.run(command, text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(settings.read_text(), 'invalid private setting')
        self.assertNotIn('invalid private setting', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
