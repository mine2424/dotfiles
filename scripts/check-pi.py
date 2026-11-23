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
    parser.add_argument('--smoke', action='store_true', help='load pstack, subagents, Ponytail skills and local resources through Pi RPC')
    args = parser.parse_args()
    versions = dict(line.split('=', 1) for line in (ROOT / 'pi/versions.env').read_text().splitlines()
                    if line and not line.startswith('#'))
    home = Path.home()
    agent = Path(os.environ.get('PI_CODING_AGENT_DIR', home / '.pi/agent')).expanduser()
    launcher = home / '.local/bin/pi'
    package = agent / 'git/github.com/DietrichGebert/ponytail'
    npm_packages = {'pstack': agent / 'npm/node_modules/@zenspc/pi-pstack',
                    'subagents': agent / 'npm/node_modules/pi-subagents'}
    local_skills = ['new-development', 'existing-change', 'incident-fix']
    prompts = ['plan', 'work', 'review', 'handoff']
    checks = []
    smoke_report = {}

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
    path_pi = shutil.which('pi')
    check('pi_on_path', lambda: path_pi is not None and Path(path_pi).samefile(launcher))
    mise = shutil.which('mise') or str(home / '.local/bin/mise')

    def node_version():
        runtime = Path(run([mise, 'where', 'node@' + versions['PI_NODE_VERSION']]))
        return run([str(runtime / 'bin/node'), '--version']) == 'v' + versions['PI_NODE_VERSION']

    check('mise_node_version', node_version)
    check('ponytail_checkout', lambda: run(['git', '-C', str(package), 'rev-parse', 'HEAD'])
          == versions['PONYTAIL_SOURCE'].rsplit('@', 1)[1])

    def registered(source):
        settings = json.loads((agent / 'settings.json').read_text())
        return any((entry.get('source') if isinstance(entry, dict) else entry)
                   == source for entry in settings.get('packages', []))

    check('ponytail_registered', lambda: registered(versions['PONYTAIL_SOURCE']))
    for name, path in npm_packages.items():
        source = versions[name.upper() + '_SOURCE']
        check(name + '_registered', lambda source=source: registered(source))
        check(name + '_version', lambda path=path, source=source:
              json.loads((path / 'package.json').read_text())['version'] == source.rsplit('@', 1)[1])

    def ponytail_skills_only():
        settings = json.loads((agent / 'settings.json').read_text())
        return any(isinstance(entry, dict) and entry.get('source') == versions['PONYTAIL_SOURCE']
                   and entry.get('extensions') == [] for entry in settings.get('packages', []))

    check('ponytail_skills_only', ponytail_skills_only)
    check('global_instructions', lambda: (agent / 'AGENTS.md').is_file())
    check('shared_principles', lambda: (agent / 'PRINCIPLES.md').is_file())
    for name in local_skills:
        check('skill_' + name, lambda name=name: (agent / 'skills' / name / 'SKILL.md').is_file())
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
                (isolated / 'skills').mkdir()
                for filename in ['AGENTS.md', 'PRINCIPLES.md']:
                    (isolated / filename).symlink_to((agent / filename).resolve())
                for name in local_skills:
                    (isolated / 'skills' / name).symlink_to((agent / 'skills' / name).resolve())
                for name in prompts:
                    (isolated / 'prompts' / (name + '.md')).symlink_to(
                        (agent / 'prompts' / (name + '.md')).resolve())
                (isolated / 'settings.json').write_text(json.dumps({'packages': [
                    {'source': str(package.resolve()), 'extensions': []},
                    *(str(path.resolve()) for path in npm_packages.values())]}))
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
                expected.update({('poteto-mode', 'extension'), ('setup-pstack', 'extension'),
                                 ('pstack', 'extension'), ('subagents-doctor', 'extension')})
                expected.update({('skill:' + name, 'skill') for name in local_skills + [
                    'poteto-mode', 'how', 'why', 'architect', 'tdd', 'interrogate', 'arena',
                    'unslop', 'reflect', 'correct', 'ponytail', 'ponytail-review']})
                found = {(item['name'], item['source']) for item in commands}
                if not (response['success'] and expected.issubset(found)
                        and ('ponytail', 'extension') not in found):
                    return False
                runtime = Path(run([mise, 'where', 'node@' + versions['PI_NODE_VERSION']]))
                sdk_root = home / '.local/share/dotfiles/pi/lib/node_modules/@earendil-works/pi-coding-agent'
                result = run([str(runtime / 'bin/node'), str(ROOT / 'scripts/smoke-pstack.mjs'),
                              str(sdk_root), str(isolated), tmp], env=env, cwd=tmp)
                smoke_report.update(json.loads(result))
                return smoke_report['ok']

        check('rpc_resource_loading', smoke)

    report = {'checked_at': datetime.now(timezone.utc).isoformat(),
              'ok': all(item['ok'] for item in checks), 'checks': checks,
              'model_response_tested': False, 'child_model_execution_tested': False}
    if smoke_report:
        report['scripted_smoke'] = smoke_report
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
