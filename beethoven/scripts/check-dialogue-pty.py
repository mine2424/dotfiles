"""Real PTY + real SDK, entirely scripted transport. No live provider calls."""
import atexit, fcntl, json, os, pty, select, shutil, sqlite3, struct, subprocess, tempfile, termios, time
from pathlib import Path
root = Path(__file__).resolve().parent.parent
pinned_node = Path.home() / '.local/share/mise/installs/node/24.21.0/bin/node'
node = Path(os.environ.get('BEETHOVEN_NODE') or (str(pinned_node) if pinned_node.exists() else shutil.which('node') or 'node'))
class Terminal:
    def __init__(self, directory, scenario, resume=None):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 100, 0, 0))
        self.child = subprocess.Popen([str(node), str(root / 'dist/tests/dialogue-child.js'), scenario, *([resume] if resume else [])], cwd=directory / 'repo', stdin=slave, stdout=slave, stderr=slave, start_new_session=True, env={**os.environ, 'TERM': 'xterm-256color', 'XDG_CONFIG_HOME': str(directory / 'config'), 'XDG_STATE_HOME': str(directory / 'state')})
        os.close(slave); self.output = b''; atexit.register(self.close)
    def close(self):
        if self.child.poll() is None:
            self.child.terminate()
            try: self.child.wait(timeout=2)
            except subprocess.TimeoutExpired: self.child.kill(); self.child.wait(timeout=2)
    def expect(self, text):
        end = time.monotonic() + 12
        while text.encode() not in self.output:
            if time.monotonic() > end: raise AssertionError(f'missing {text}; exit={self.child.poll()}; tail={self.output[-900:]!r}')
            ready, _, _ = select.select([self.master], [], [], .1)
            if ready:
                try: self.output += os.read(self.master, 65536)
                except OSError: raise AssertionError(f'exited before {text}; status={self.child.poll()}')
    def send(self, text): self.output = b''; os.write(self.master, text.encode())
    def alive(self):
        assert self.child.poll() is None, 'TUI process exited after a turn'
        assert b'\x1b[?1049l' not in self.output, 'TUI left alternate screen'
        assert b'DO_NOT_RENDER_PRIVATE_TRANSPORT_BODY' not in self.output
    def finish(self, expected=0, command='/exit\r'):
        self.send(command)
        end = time.monotonic() + 5
        while self.child.poll() is None and time.monotonic() < end:
            ready, _, _ = select.select([self.master], [], [], .1)
            if ready:
                try: self.output += os.read(self.master, 65536)
                except OSError: break
        assert self.child.wait(timeout=1) == expected
        assert b'\x1b[?1049l' in self.output
        os.close(self.master)

def fixture(directory, scenario):
    repo = directory / 'repo'; repo.mkdir()
    subprocess.run(['git', '-c', 'init.templateDir=', 'init', '-q'], cwd=repo, check=True)
    (repo / 'value.txt').write_text('one\n')
    if scenario in ('worker','orchestration'):
        if scenario == 'orchestration':
            (repo / '.beethoven').mkdir()
            (repo / '.beethoven/harness.json').write_text(json.dumps({'schemaVersion':1,'requirements':[{'id':'value','stage':'verify','required':True}],'checks':[{'id':'value','stage':'verify','argv':[str(node),'-e',"require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'two\\n')"],'cwd':'.','timeoutMs':3000,'requiredEnv':[],'acceptanceIds':['value']}]}))
        subprocess.run(['git','add','.'],cwd=repo,check=True)
        subprocess.run(['git','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],cwd=repo,check=True)
    config = directory / 'config/beethoven'; config.mkdir(parents=True)
    connection = {'id':'fixture', 'provider':'fixture', 'model':'fixture', 'auth':{'method':'api_key','credentialRef':'pi:fixture'},'billing':{'kind':'subscription'},'quotaGroup':'fixture','status':'configured','limits':{'maxTokens':100000,'maxDurationMs':20000,'maxCostUsd':None,'maxAttempts':1,'maxConcurrency':1}}
    (config / 'connections.json').write_text(json.dumps({'schemaVersion':1,'allowFallback':False,'defaultConnectionId':'fixture','connections':[connection]}))
    (config / 'config.json').write_text(json.dumps({'schemaVersion':1,'allowedConnections':['fixture'],'permission':'workspace-write' if scenario in ('worker','orchestration') else 'read-only','maxTokens':100000}))
    auth = config / 'auth/fixture'; auth.mkdir(parents=True); (auth / 'credentials.json').write_text('{"type":"api_key","key":"test-only"}')

scenarios = os.environ.get('BEETHOVEN_PTY_SCENARIOS', 'success,budget,runtime,opening,opening-private,opening-exit,opening-interrupt,worker,history,orchestration').split(',')
for scenario in scenarios:
    with tempfile.TemporaryDirectory(prefix='beethoven-dialogue-pty-') as name:
        directory = Path(name); fixture(directory, scenario); terminal = Terminal(directory, scenario)
        if scenario.startswith('opening'):
            terminal.expect('上記の接続・送信内容・上限で開始します'); terminal.send('yes\r')
            terminal.expect('/retry'); terminal.alive()
            if scenario in ('opening-exit', 'opening-interrupt'):
                terminal.finish(command='\x03' if scenario == 'opening-interrupt' else '/exit\r')
                assert not (directory / 'state/beethoven/state.sqlite').exists()
                print(json.dumps({'scenario':scenario,'status':'passed','liveProviderRequests':0}))
                continue
            terminal.send('依頼を勝手に再送しない\r'); terminal.expect('会話はまだ開始していません'); terminal.alive()
            terminal.send('/retry\r'); terminal.expect('Session:'); terminal.alive()
            terminal.send('明示的な最初の依頼\r'); terminal.expect('最初の応答です。'); terminal.expect('実行結果'); terminal.alive()
            terminal.finish()
            with sqlite3.connect(directory / 'state/beethoven/state.sqlite') as db:
                assert db.execute("SELECT count(*) FROM events WHERE type='provider_request'").fetchone()[0] == 1
                prompts = [json.loads(row[0])['text'] for row in db.execute("SELECT payload FROM events WHERE type='prompt_submitted'")]
                assert prompts == ['明示的な最初の依頼'], prompts
            print(json.dumps({'scenario':scenario,'status':'passed','liveProviderRequests':0}))
            continue
        terminal.expect('Session:')
        if scenario == 'orchestration':
            terminal.send('Workerに委譲してください\r'); terminal.expect('上記の計画を実行します'); terminal.send('yes\r')
            terminal.expect('Orchestration結果'); terminal.alive()
            terminal.send('/monitor\r'); terminal.expect('SESSIONS'); terminal.alive(); terminal.send('\x1b'); terminal.expect('入力待ち')
            terminal.finish()
            assert (directory / 'repo/value.txt').read_text() == 'one\n'
            with sqlite3.connect(directory / 'state/beethoven/state.sqlite') as db:
                run = json.loads(db.execute('SELECT document FROM runs LIMIT 1').fetchone()[0])
                assert run['status'] == 'awaiting_acceptance', (run['tasks'],run.get('verifications'),run['effects'])
                assert run['parentSession']
                accept = subprocess.run([str(node),str(root / 'dist/src/cli.js'),'run','accept',run['id'],'A','--sha',run['integrationSha'],'--json'],cwd=directory / 'repo',env={**os.environ,'XDG_CONFIG_HOME':str(directory / 'config'),'XDG_STATE_HOME':str(directory / 'state')},capture_output=True,text=True,check=True)
                assert json.loads(accept.stdout)['status'] == 'completed'
                assert (Path(run['integration']) / 'value.txt').read_text() == 'two\n'
            print(json.dumps({'scenario':scenario,'status':'passed','liveProviderRequests':0}))
            continue
        if scenario == 'worker':
            terminal.send('/worker ask\r'); terminal.expect('承認待ち'); terminal.send('yes\r')
            terminal.expect('回答待ち:'); terminal.alive()
            worker_id = next((directory / 'state/beethoven/workers').iterdir()).name
            terminal.send('/workers logs ' + worker_id + '\r'); terminal.expect('waiting_input'); terminal.alive()
            terminal.send('/worker resume ' + worker_id + ' two\r'); terminal.expect('承認待ち'); terminal.send('yes\r')
            terminal.expect('candidate'); terminal.alive()
            assert (directory / 'repo/value.txt').read_text() == 'one\n'
            assert (directory / 'state/beethoven/workers' / worker_id / 'worktree/value.txt').read_text() == 'two\n'
            terminal.finish()
            print(json.dumps({'scenario':scenario,'status':'passed','liveProviderRequests':0}))
            continue
        if scenario == 'history':
            terminal.send('保存する依頼\r'); terminal.expect('最初の応答です。'); terminal.expect('実行結果'); terminal.finish()
            database = directory / 'state/beethoven/state.sqlite'
            def requests():
                with sqlite3.connect(database) as db: return db.execute("SELECT count(*) FROM events WHERE type='provider_request'").fetchone()[0]
            with sqlite3.connect(database) as db: original_id = db.execute('SELECT id FROM sessions LIMIT 1').fetchone()[0]
            terminal = Terminal(directory, scenario); terminal.expect('Session:')
            terminal.send('\x1b[A'); terminal.expect('保存する依頼'); terminal.alive(); assert requests() == 1
            # Native Editor recalls but never submits until Enter.
            terminal.send('\r'); terminal.expect('最初の応答です。'); terminal.expect('実行結果'); assert requests() == 2
            terminal.send('\x12'); terminal.expect('プロンプト履歴 · 選択すると入力欄へ戻します')
            terminal.send('保存する依頼\r'); terminal.expect('履歴を入力欄に呼び出しました'); terminal.alive(); assert requests() == 2
            # Clear recalled input before the command; selected prompt has not run.
            terminal.send('\x15/sessions ' + original_id + '\r'); terminal.expect('会話を再開'); terminal.expect('最初の応答です。'); terminal.alive(); assert requests() == 2
            terminal.send('再開した会話への追記\r'); terminal.expect('追加の応答です。'); terminal.expect('実行結果'); terminal.finish()
            terminal = Terminal(directory, scenario, original_id); terminal.expect('追加の応答です。'); terminal.alive(); assert requests() == 3
            terminal.finish()
            with sqlite3.connect(database) as db:
                prompts = [json.loads(row[0])['text'] for row in db.execute("SELECT payload FROM events WHERE type='prompt_submitted'")]
                assert prompts == ['保存する依頼', '保存する依頼', '再開した会話への追記'], prompts
            print(json.dumps({'scenario':scenario,'status':'passed','liveProviderRequests':0}))
            continue
        terminal.send('最初の依頼\r')
        if scenario == 'success': terminal.expect('最初の応答です。'); terminal.expect('実行結果')
        elif scenario == 'budget': terminal.expect('試験用の予算停止です。')
        else: terminal.expect('実行を停止しました')
        terminal.alive(); terminal.send('/help\r'); terminal.expect('/status'); terminal.alive()
        if scenario == 'runtime':
            terminal.send('自動で再送しないでください\r'); terminal.expect('/resume'); terminal.alive()
            terminal.send('/resume\r'); terminal.expect('再開しました'); terminal.alive()
        terminal.send('追加の依頼\r'); terminal.expect('追加の応答です。' if scenario == 'success' else '最初の応答です。'); terminal.expect('実行結果'); terminal.alive()
        terminal.finish(command='\x03' if scenario == 'budget' else '/exit\r')
        with sqlite3.connect(directory / 'state/beethoven/state.sqlite') as db:
            assert db.execute('SELECT count(*) FROM sessions').fetchone()[0] == 1
            assert db.execute("SELECT count(*) FROM events WHERE type='provider_request'").fetchone()[0] == (2 if scenario == 'success' else 1)
            event = json.loads(db.execute("SELECT payload FROM events WHERE type='dialogue_exit'").fetchone()[0])
            assert event['reason'] == ('user_interrupt' if scenario == 'budget' else 'user_exit')
        print(json.dumps({'scenario':scenario,'status':'passed','liveProviderRequests':0}))
