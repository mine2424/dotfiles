import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initializeStore } from '../src/store.js';
import { SessionStore, type SessionData } from '../src/session.js';
import { savedConversation } from '../src/history.js';
const session = (cwd: string): SessionData => ({ id: randomUUID(), cwd, connectionId: 'fixture', connectionHash: '', piFile: null, rulesHash: '', snapshotHash: '', workspaceHash: '', status: 'idle', createdAt: new Date().toISOString(), tokens: 0, costUsd: 0, usageUnknown: false, elapsedMs: 0, planOnly: false, approvals: {} });
async function fixture(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'beethoven-history-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, 'state'); await initializeStore(state);
  const store = new SessionStore(state); t.after(() => store.close());
  const data = session(dir); store.save(data, 'session_opened'); return { dir, state, store, data };
}
test('prompt history preserves multiline, failed submissions, repeats and legacy turns without linked duplicates', async t => {
  const f = await fixture(t), text = '  前回の依頼\n数量を直す  ';
  const id = f.store.recordPrompt(f.data.id, text, { model: 'fixture' });
  f.store.beginTurn(f.data, { prompt: text, inputId: id });
  f.store.recordPrompt(f.data.id, text, {});
  const legacy = f.store.beginTurn(f.data, { prompt: 'legacy input' });
  f.store.beginTurn(f.data, { prompt: '/compact' });
  assert.equal(f.store.promptHistory(f.dir).length, 3);
  assert.equal(f.store.historyPrompt(id, f.dir), text);
  assert.equal(f.store.historyPrompt(legacy, f.dir), 'legacy input');
  assert.equal(f.store.promptHistory(f.dir, '数量').length, 2);
  assert.equal(f.store.promptHistory(f.dir, "%' OR 1=1 --").length, 0);
  assert.equal(f.store.editorHistory(f.dir).length, 3);
  assert.throws(() => f.store.recordPrompt(f.data.id, '/connect', {}));
  const other = session('/another/workspace'); f.store.save(other, 'session_opened');
  const hidden = f.store.recordPrompt(other.id, 'other workspace', {});
  assert.equal(f.store.promptHistory(f.dir).length, 3);
  assert.equal(f.store.promptHistory(null).length, 4);
  assert.throws(() => f.store.historyPrompt(hidden, f.dir));
});
test('conversation viewer restores legacy public text and rejects symlink archives without rewriting files', async t => {
  const f = await fixture(t), folder = join(f.state, 'sessions', f.data.id); mkdirSync(folder, { recursive: true });
  const file = join(folder, 'session.jsonl'); f.data.piFile = file; f.store.save(f.data, 'session_opened');
  f.store.beginTurn(f.data, { prompt: 'old prompt', before: { hash: 'abc' }, planOnly: false });
  const original = [
    { type: 'session', version: 3, id: f.data.id, cwd: f.dir, timestamp: new Date().toISOString() },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'old prompt\n\n[現在のworkspace: abc。以前の会話とfileが違う可能性があるため編集前にreadする]' } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', model: 'recorded-model', provider: 'fixture', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: '保存済みの回答' }] } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  writeFileSync(file, original);
  const saved = savedConversation(f.state, f.data.id);
  assert.deepEqual(saved.messages.map(m => m.text), ['old prompt', '保存済みの回答']);
  assert.equal(saved.messages[1]!.model, 'recorded-model'); assert.deepEqual(saved.warnings, []);
  assert.equal(readFileSync(file, 'utf8'), original);
  const link = join(folder, 'link.jsonl'); symlinkSync(file, link); f.data.piFile = link; f.store.save(f.data, 'changed');
  const rejected = savedConversation(f.state, f.data.id); assert.equal(rejected.messages.length, 1); assert.equal(rejected.warnings.length, 1);
});
test('readonly history CLI does not create state and searches only current workspace by default', async t => {
  const f = await fixture(t), stateHome = join(f.dir, 'xdg');
  const cli = join(process.cwd(), 'dist/src/cli.js');
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: f.dir, env: { ...process.env, XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: join(f.dir, 'config') }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(run('history', '--json').trim(), '[]'); assert.equal(existsSync(stateHome), false);
  const actual = join(stateHome, 'beethoven'); await initializeStore(actual);
  const db = new SessionStore(actual);
  try {
    const current = session(f.dir); db.save(current, 'opened'); const id = db.recordPrompt(current.id, '再実行\nしたい', {});
    const other = session('/other'); db.save(other, 'opened'); db.recordPrompt(other.id, 'other', {});
    assert.equal(JSON.parse(run('history', '--json')).length, 1);
    assert.equal(JSON.parse(run('history', '--all', '--json')).length, 2);
    assert.equal(run('history', 'show', id).trim(), '再実行\nしたい');
    assert.equal(JSON.parse(run('sessions', 'show', current.id, '--json')).sessionId, current.id);
  } finally { db.close(); }
});
