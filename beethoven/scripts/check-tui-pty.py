"""実PTYで初回表示・設定取消・許可・送信前取消を検査する。実モデルは呼ばない。"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time
import atexit
import sqlite3

project = Path(__file__).resolve().parent.parent
launcher = Path(os.environ.get('BEETHOVEN_LAUNCHER') or Path.home() / '.local/bin/beethoven')


class Terminal:
    def __init__(self, root, cwd=None, theme='dark'):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        self.process = subprocess.Popen([str(launcher)], cwd=cwd or root, stdin=slave, stdout=slave, stderr=slave,
                                        start_new_session=True, env={**{key: value for key, value in os.environ.items() if key not in ('NO_COLOR', 'BEETHOVEN_THEME')}, 'TERM': 'xterm-256color', 'BEETHOVEN_THEME': theme,
                                        'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_STATE_HOME': str(root / 'state')})
        os.close(slave)
        self.output = b''
        self.all_output = b''
        atexit.register(self.cleanup)

    def cleanup(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)

    def expect(self, text):
        end = time.monotonic() + 15
        while text.encode() not in self.output:
            if time.monotonic() > end:
                raise AssertionError(f'TUI did not show: {text}; exit={self.process.poll()}; tail={self.output[-1800:]!r}')
            ready, _, _ = select.select([self.master], [], [], 0.1)
            if ready:
                data = os.read(self.master, 65536)
                self.output += data
                self.all_output += data

    def send(self, text):
        self.all_output += self.output
        self.output = b''
        os.write(self.master, text.encode())

    def finish(self, code=0):
        # 終了時の出力を読み続け、PTYの有限bufferで子の終了を詰まらせない。
        deadline = time.monotonic() + 10
        while self.process.poll() is None and time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], 0.05)
            if ready:
                try:
                    self.output += os.read(self.master, 65536)
                except OSError:
                    break
        assert self.process.wait(timeout=1) == code
        # raw modeとalternate screenの解除が出力されたことも確認する。
        end = time.monotonic() + 1
        while time.monotonic() < end:
            ready, _, _ = select.select([self.master], [], [], 0.05)
            if not ready:
                break
            try:
                data = os.read(self.master, 65536)
                if not data:
                    break
                self.output += data
            except OSError:
                break
        assert b'\x1b[?1049l' in self.output
        os.close(self.master)


with tempfile.TemporaryDirectory(prefix='beethoven-tui-pty-') as directory:
    root = Path(directory)
    subprocess.run(['git', '-c', 'init.templateDir=', 'init', '-q'], cwd=root, check=True)
    terminal = Terminal(root)
    terminal.expect('接続先を選んでください')
    terminal.send('\x03')
    terminal.finish()
    assert not (root / 'config').exists()
    assert not (root / 'state').exists()

    config = root / 'config/beethoven'
    config.mkdir(parents=True)
    profile = json.loads((project / 'connections.example.json').read_text())
    (config / 'connections.json').write_text(json.dumps(profile))
    terminal = Terminal(root)
    terminal.expect('はじめに')
    terminal.send('/allow codex-sub\r')
    terminal.expect('承認待ち')
    terminal.send('yes\r')
    terminal.expect('送信先を許可しました')
    settings = json.loads((config / 'config.json').read_text())
    assert settings['allowedConnections'] == ['codex-sub']
    assert settings['permission'] == 'read-only'
    assert not (config / 'auth').exists()
    terminal.send('/start\r')
    terminal.expect('/login codex-sub')
    terminal.send('/exit\r')
    terminal.finish()

    auth = config / 'auth/codex-sub'
    auth.mkdir(parents=True)
    (auth / 'credentials.json').write_text('{"type":"oauth","access":"not-used","refresh":"not-used","expires":0}')
    terminal = Terminal(root)
    terminal.expect('承認待ち')
    terminal.expect('gpt-6.1-sol')
    terminal.send('no\r')
    terminal.finish(code=3)
    assert not (root / 'state/beethoven/state.sqlite').exists()
    print(json.dumps({'pty': 'passed', 'cases': ['first launch', 'setup cancel', 'explicit allow', 'missing login', 'send cancel', 'terminal restore'], 'modelRequests': 0}))

# 登録済みの自分のcredentialで、provider/model/確認の3選択だけで接続できる。
with tempfile.TemporaryDirectory(prefix='beethoven-connect-pty-') as directory:
    root = Path(directory)
    repo = root / 'repo'
    repo.mkdir()
    subprocess.run(['git', '-c', 'init.templateDir=', 'init', '-q'], cwd=repo, check=True)
    config = root / 'config/beethoven'
    config.mkdir(parents=True)
    catalog = json.loads(subprocess.check_output([str(launcher), 'setup', '--catalog', '--json'], cwd=root))
    provider = next(p for p in catalog['providers'] if p['id'] == 'openrouter')
    model_id = next(m['id'] for m in provider['models'] if not m['id'].startswith(('openrouter/', '~')))
    profile = json.loads((project / 'connections.example.json').read_text())
    connection = profile['connections'][0]
    connection.update({'id': 'openrouter-api', 'provider': 'openrouter', 'model': model_id, 'auth': {'method': 'api_key', 'credentialRef': 'pi:openrouter-api'}, 'billing': {'kind': 'metered'}, 'quotaGroup': 'openrouter-metered'})
    connection['limits']['maxCostUsd'] = 0.5
    (config / 'connections.json').write_text(json.dumps({'schemaVersion': 1, 'defaultConnectionId': connection['id'], 'allowFallback': False, 'connections': [connection]}))
    auth = config / 'auth/openrouter-api'
    auth.mkdir(parents=True)
    credential = auth / 'credentials.json'
    saved_credential = '{"type":"api_key","key":"test-only-no-provider-request"}'
    credential.write_text(saved_credential)
    credential.chmod(0o600)
    terminal = Terminal(root, cwd=repo)
    terminal.expect('はじめに')
    terminal.send('/connect\r')
    terminal.expect('接続先を選んでください')
    terminal.send('OpenRouter')
    terminal.send('\x1b[B\r')
    terminal.expect('モデルを選んでください')
    terminal.send(model_id + '\r')
    terminal.expect('この内容で接続しますか')
    terminal.send('\r')
    terminal.expect('Session:')
    # 接続変更中も、元の入力待機列とSessionを失わない。
    terminal.send('/connect\r/help\r')
    terminal.expect('接続先を選んでください')
    terminal.send('OpenRouter')
    terminal.send('\x1b[B\r')
    terminal.expect('モデルを選んでください')
    terminal.send(model_id + '\r')
    terminal.expect('この内容で接続しますか')
    terminal.send('\r')
    terminal.expect('追加入力は実行後')
    assert b'\x1b[?1049l' not in terminal.all_output + terminal.output
    assert saved_credential.encode() not in terminal.all_output + terminal.output
    terminal.send('/exit\r')
    terminal.finish()
    settings = json.loads((config / 'config.json').read_text())
    assert settings['allowedConnections'] == ['openrouter-api']
    assert credential.read_text() == saved_credential
    with sqlite3.connect(root / 'state/beethoven/state.sqlite') as database:
        assert database.execute("SELECT count(*) FROM events WHERE type='provider_request'").fetchone()[0] == 0
        assert database.execute('SELECT count(*) FROM sessions').fetchone()[0] == 1
    print(json.dumps({'connect': 'passed', 'cases': ['search provider', 'search model', 'single confirmation', 'reuse own auth', 'no extra allow/start', 'session entry', 'queued input after connection change'], 'modelRequests': 0}))
    # API-key login itself stays in the same alternate screen; this fake key is never used for inference.
    credential.unlink()
    terminal = Terminal(root, cwd=repo, theme='light')
    terminal.expect('はじめに')
    terminal.send('/connect\r')
    terminal.expect('接続先を選んでください')
    terminal.send('OpenRouter')
    terminal.send('\x1b[B\r')
    terminal.expect('モデルを選んでください')
    terminal.send(model_id + '\r')
    terminal.expect('この内容で接続しますか')
    terminal.send('\r')
    terminal.expect('Enter OpenRouter API key')
    terminal.send('pty-private-key-never-send\r')
    terminal.expect('Session:')
    assert b'pty-private-key-never-send' not in terminal.all_output + terminal.output
    assert b'\x1b[?1049l' not in terminal.all_output + terminal.output
    terminal.send('/connect\r')
    terminal.expect('接続先を選んでください')
    terminal.send('\x1b')
    terminal.expect('同じ会話・使用量を引き継ぎました')
    assert b'\x1b[?1049l' not in terminal.all_output + terminal.output
    terminal.send('/exit\r')
    terminal.finish()
    with sqlite3.connect(root / 'state/beethoven/state.sqlite') as database:
        assert database.execute("SELECT count(*) FROM events WHERE type='provider_request'").fetchone()[0] == 0
    print(json.dumps({'authOverlay': 'passed', 'cases': ['native API-key login', 'secret not rendered', 'same screen through connect and cancel'], 'modelRequests': 0}))
