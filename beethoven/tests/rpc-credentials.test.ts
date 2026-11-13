import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authDirectory, ConnectionCredentials, withRpcCredentials } from '../src/auth.js';
import { parseConnections } from '../src/connections.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'beethoven-rpc-auth-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const connection = parseConnections(readFileSync(new URL('../../connections.example.json', import.meta.url), 'utf8')).connections[0]!;
  const configFile = join(root, 'config.json');
  const directory = authDirectory(configFile, connection);
  const credentials = new ConnectionCredentials(directory, connection.provider);
  return { root, connection, configFile, directory, credentials };
}
const credential = (access: string) => ({ type: 'oauth' as const, access, refresh: 'test-only-refresh', expires: 9999999999999 });

test('RPC holds the selected credential lock until confirmed exit and writes rotated OAuth credentials back', async t => {
  const f = fixture(t); await f.credentials.modify(f.connection.provider, async () => credential('original-test-only'));
  const result = await withRpcCredentials(f.configFile, f.connection, async agentDir => {
    assert.equal(existsSync(join(f.directory, 'maintenance.lock')), true);
    assert.equal(existsSync(join(agentDir, 'pending.json')), true);
    const data = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'));
    assert.deepEqual(Object.keys(data), [f.connection.provider]);
    data[f.connection.provider] = credential('rotated-test-only');
    writeFileSync(join(agentDir, 'auth.json'), JSON.stringify(data), { mode: 0o600 });
    await assert.rejects(f.credentials.modify(f.connection.provider, async value => value));
    return { value: 42, groupGone: true };
  });
  assert.equal(result, 42);
  assert.equal((await f.credentials.read(f.connection.provider))?.type, 'oauth');
  assert.equal((await f.credentials.read(f.connection.provider) as { access: string }).access, 'rotated-test-only');
  assert.equal(existsSync(join(f.directory, 'rpc', 'pending.json')), false);
});

test('unconfirmed RPC exit preserves original credential and recovery marker; a new launch is refused', async t => {
  const f = fixture(t); await f.credentials.modify(f.connection.provider, async () => credential('original-test-only'));
  await assert.rejects(withRpcCredentials(f.configFile, f.connection, async () => ({ value: null, groupGone: false })));
  assert.equal(existsSync(join(f.directory, 'rpc', 'pending.json')), true);
  assert.equal((await f.credentials.read(f.connection.provider) as { access: string }).access, 'original-test-only');
  let called = false;
  await assert.rejects(withRpcCredentials(f.configFile, f.connection, async () => { called = true; return { value: null, groupGone: true }; }));
  assert.equal(called, false);
});
