import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnedRpcClient } from '../src/rpc.js';
import { classifyPiFailure } from '../src/pi.js';

test('actual pinned bundled RPC starts offline and confirms process-group removal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'beethoven-rpc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, 'agent'); mkdirSync(agentDir);
  const client = new OwnedRpcClient({ cwd: root, home: root, agentDir,
    args: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp', '--offline', '--no-tools', '--no-session'] });
  try {
    const state = await client.start(); assert.equal(state.isStreaming, false);
    const stats = await client.request('get_session_stats'); assert.equal(stats.userMessages, 0);
  } finally { assert.equal((await client.stop()).groupGone, true); }
  await assert.rejects(client.request('get_state'));
});

test('structured failure classification does not depend on or disclose response bodies', () => {
  assert.equal(classifyPiFailure({ status: 401, body: 'sensitive' }), 'authentication');
  assert.equal(classifyPiFailure({ statusCode: 429 }), 'rate_limit');
  assert.equal(classifyPiFailure({ status: 504 }), 'timeout');
  assert.equal(classifyPiFailure({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(classifyPiFailure({ body: 'secret' }), 'unknown');
});

test('RPC environment excludes ambient credentials and timeout confirms child removal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'beethoven-rpc-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const extension = join(root, 'check.mjs');
  writeFileSync(extension, `export default function () { if (process.env.BEETHOVEN_TEST_SECRET || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) throw new Error('ambient credentials inherited'); }`);
  const previous = process.env.BEETHOVEN_TEST_SECRET; process.env.BEETHOVEN_TEST_SECRET = 'test-only';
  const client = new OwnedRpcClient({ cwd: root, home: root, agentDir: root,
    args: ['--no-extensions', '--no-mcp', '--no-context-files', '--offline', '--no-tools', '--no-session', '-e', extension] });
  try { await client.start(); } finally {
    if (previous === undefined) delete process.env.BEETHOVEN_TEST_SECRET; else process.env.BEETHOVEN_TEST_SECRET = previous;
    assert.equal((await client.stop()).groupGone, true);
  }
  const timed = new OwnedRpcClient({ cwd: root, home: root, agentDir: root, requestTimeoutMs: 1,
    args: ['--no-extensions', '--offline', '--no-tools', '--no-session'] });
  await assert.rejects(timed.start());
  assert.equal((await timed.stop()).groupGone, true);
});

test('a delayed local RPC command produces a structured timeout without a provider request', async t => {
  const root = mkdtempSync(join(tmpdir(), 'beethoven-rpc-deadline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const extension = join(root, 'wait.mjs');
  writeFileSync(extension, `export default function (pi) { pi.registerCommand('wait', { description: 'local test', handler: async () => { await new Promise(resolve => setTimeout(resolve, 200)); } }); }`);
  const options = { cwd: root, home: root, agentDir: root, requestTimeoutMs: 30000,
    args: ['--no-extensions', '--no-mcp', '--no-context-files', '--offline', '--no-tools', '--no-session', '-e', extension] };
  const client = new OwnedRpcClient(options);
  try {
    await client.start(); options.requestTimeoutMs = 20;
    await assert.rejects(client.prompt('/wait'), error => classifyPiFailure(error) === 'timeout');
  } finally { assert.equal((await client.stop()).groupGone, true); }
});
