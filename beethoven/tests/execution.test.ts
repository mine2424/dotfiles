import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ConnectionCredentials, selectedProvider } from '../src/auth.js';
import { runProcess } from '../src/process.js';
import { workspacePath, replaceFile, hash } from '../src/workspace.js';
import { initializeStore, schemaVersion } from '../src/store.js';
import type { Connection } from '../src/connections.js';

const connection: Connection = { id: 'codex', provider: 'openai', model: 'gpt-6.1-sol', auth: { method: 'oauth', credentialRef: 'pi:codex' },
  billing: { kind: 'subscription' }, quotaGroup: 'codex', limits: { maxTokens: 1000, maxDurationMs: 1000, maxAttempts: 1, maxConcurrency: 1, maxCostUsd: null }, status: 'configured' };
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'beethoven-execution-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}

test('OAuth has no API-key fallback; connection credentials are isolated, private, and locked during refresh', async t => {
  const dir = fixture(t);
  assert.equal(selectedProvider(connection).auth.apiKey, undefined);
  const first = new ConnectionCredentials(join(dir, 'a'), 'openai');
  const second = new ConnectionCredentials(join(dir, 'b'), 'openai');
  assert.equal(await first.read('openai'), undefined);
  await first.modify('openai', async () => ({ type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: 9999999999999 }));
  assert.equal((statSync(join(dir, 'a/credentials.json')).mode & 0o777), 0o600);
  assert.equal(await second.read('openai'), undefined);
  assert.equal(await first.read('anthropic'), undefined);
  await first.modify('openai', async current => {
    await assert.rejects(first.modify('openai', async () => current));
    return current;
  });
  assert.deepEqual(await first.list(), [{ providerId: 'openai', type: 'oauth' }]);
});

test('workspace file operations reject escape/symlink and do not overwrite an externally changed file', t => {
  const dir = fixture(t); const repo = join(dir, 'repo'); mkdirSync(repo);
  writeFileSync(join(dir, 'outside'), 'preserve'); symlinkSync(join(dir, 'outside'), join(repo, 'link'));
  assert.throws(() => workspacePath(repo, '../outside'), /workspace/);
  assert.throws(() => workspacePath(repo, 'link'), /symlink/);
  assert.throws(() => workspacePath(repo, '.git/config', true));
  const file = join(repo, 'file'); writeFileSync(file, 'initial');
  const expected = hash(readFileSync(file)); writeFileSync(file, 'external');
  assert.throws(() => replaceFile(file, 'agent', expected), /変更/);
  assert.equal(readFileSync(file, 'utf8'), 'external');
});

test('owned process group is recovered on timeout and when a shell leaves a background child', async t => {
  const dir = fixture(t);
  const timedOut = await runProcess(['/bin/bash', '-c', 'sleep 30 & wait'], dir, { timeoutMs: 50 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.groupGone, true);
  const child = await runProcess(['/bin/bash', '-c', 'sleep 30 & echo $!'], dir, { timeoutMs: 2000 });
  assert.equal(child.groupGone, true);
  const pid = Number(child.output.trim());
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH');
});

test('a transient denied probe can recover only after confirmed absence; persistent denial stays unconfirmed', async t => {
  const dir = fixture(t), original = process.kill;
  let denied = false;
  try {
    process.kill = (pid, signal) => {
      if (pid < 0 && signal === 0 && !denied) { denied = true; throw Object.assign(new Error('test probe denied'), { code: 'EPERM' }); }
      return original(pid, signal);
    };
    const recovered = await runProcess(['/bin/bash', '-c', 'exit 0'], dir, { timeoutMs: 2000 });
    assert.equal(recovered.signalDenied, true); assert.equal(recovered.groupGone, true);
    process.kill = (pid, signal) => {
      if (pid < 0 && signal === 0) throw Object.assign(new Error('test probe denied'), { code: 'EPERM' });
      return original(pid, signal);
    };
    const unconfirmed = await runProcess(['/bin/bash', '-c', 'exit 0'], dir, { timeoutMs: 2000 });
    assert.equal(unconfirmed.signalDenied, true); assert.equal(unconfirmed.groupGone, false);
  } finally { process.kill = original; }
});

test('schema 1 migrates forward with existing session data and a consistent snapshot', async t => {
  const dir = fixture(t); await initializeStore(dir);
  const file = join(dir, 'state.sqlite');
  let db = new DatabaseSync(file);
  db.exec("DROP TABLE run_reservations; DROP TABLE run_commands; DROP TABLE runs; DROP TABLE turn_documents; DROP TABLE session_documents; PRAGMA user_version=1; INSERT INTO sessions VALUES('old','/fixture','closed','now');"); db.close();
  await initializeStore(dir);
  db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, schemaVersion);
    assert.equal(db.prepare('SELECT id FROM sessions').get()!.id, 'old');
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_documents').get()!.n, 0);
  } finally { db.close(); }
});
