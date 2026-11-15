#!/usr/bin/env python3
"""Check the installed Pi environment without reading credentials or calling a model."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--smoke', action='store_true', help='load Ponytail and prompts through real Pi RPC')
    args = parser.parse_args()
    versions = dict(line.split('=', 1) for line in (ROOT / 'pi/versions.env').read_text().splitlines()
                    if line and not line.startswith('#'))
    home = Path.home()
    agent = Path(os.environ.get('PI_CODING_AGENT_DIR', home / '.pi/agent')).expanduser()
    launcher = home / '.local/bin/pi'
    package = agent / 'git/github.com/DietrichGebert/ponytail'
    prompts = ['plan', 'work', 'review', 'handoff']
    checks = []

    def check(name, action):
        try:
            passed = bool(action())
            checks.append({'name': name, 'ok': passed})
        except (OSError, ValueError, TypeError, AttributeError, KeyError, StopIteration, subprocess.SubprocessError) as exc:
            # Do not print command output: third-party diagnostics may contain local data.
            checks.append({'name': name, 'ok': False, 'error': type(exc).__name__})

    def run(command, **kwargs):
        return subprocess.run(command, capture_output=True, text=True, check=True,
                              timeout=45, **kwargs).stdout.strip()

    check('pi_version', lambda: run([str(launcher), '--version']) == versions['PI_VERSION'])
    mise = shutil.which('mise') or str(home / '.local/bin/mise')

    def node_version():
        runtime = Path(run([mise, 'where', 'node@' + versions['PI_NODE_VERSION']]))
        return run([str(runtime / 'bin/node'), '--version']) == 'v' + versions['PI_NODE_VERSION']

    check('mise_node_version', node_version)
    check('ponytail_checkout', lambda: run(['git', '-C', str(package), 'rev-parse', 'HEAD'])
          == versions['PONYTAIL_SOURCE'].rsplit('@', 1)[1])

    def registered():
        settings = json.loads((agent / 'settings.json').read_text())
        return any((entry.get('source') if isinstance(entry, dict) else entry)
                   == versions['PONYTAIL_SOURCE'] for entry in settings.get('packages', []))

    check('ponytail_registered', registered)
    check('global_instructions', lambda: (agent / 'AGENTS.md').is_file())
    for name in prompts:
        check('prompt_' + name, lambda name=name: (agent / 'prompts' / (name + '.md')).is_file())

    if args.smoke:
        def smoke():
            # Load only this configuration's resources, never unrelated user extensions.
            with tempfile.TemporaryDirectory(prefix='pi-smoke-') as tmp:
                base = Path(tmp)
                isolated = base / 'agent'
                isolated.mkdir()
                (isolated / 'prompts').mkdir()
                for name in prompts:
                    (isolated / 'prompts' / (name + '.md')).symlink_to(
                        (agent / 'prompts' / (name + '.md')).resolve())
                (isolated / 'settings.json').write_text(json.dumps({'packages': [str(package.resolve())]}))
                env = dict(os.environ, HOME=tmp, PI_CODING_AGENT_DIR=str(isolated),
                           XDG_CONFIG_HOME=str(base / 'config'), XDG_CACHE_HOME=str(base / 'cache'),
                           XDG_DATA_HOME=str(base / 'data'), XDG_STATE_HOME=str(base / 'state'))
                request = json.dumps({'id': 'commands', 'type': 'get_commands'}) + '\n'
                output = run([str(launcher), '--mode', 'rpc', '--no-session', '--no-context-files'],
                             input=request, env=env, cwd=tmp)
                responses = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
                response = next(item for item in responses if item.get('id') == 'commands'
                                and item.get('type') == 'response')
                commands = response['data']['commands']
                expected = {(name, 'prompt') for name in prompts}
                expected.update({('ponytail', 'extension'), ('ponytail-review', 'extension'),
                                 ('skill:ponytail-review', 'skill')})
                return response['success'] and expected.issubset(
                    {(item['name'], item['source']) for item in commands})

        check('rpc_resource_loading', smoke)

    report = {'checked_at': datetime.now(timezone.utc).isoformat(),
              'ok': all(item['ok'] for item in checks), 'checks': checks,
              'model_response_tested': False}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
