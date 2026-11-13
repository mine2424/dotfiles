import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connectionCatalog, parseConnections, readConnections, saveConnections, SetupError, validateConnections, type Connections } from '../src/connections.js';
import { promptConnections } from '../src/setup.js';

/** 本人の個人設定を触らず、利用者ごとのconfig/stateを分離する。 */
function fixture(t: { after: (cleanup: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'beethoven-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'config', 'beethoven', 'connections.json'), state: join(dir, 'state', 'beethoven') };
}

function profile(id = 'test'): Connections {
  const provider = connectionCatalog().find(p => p.id === 'openai')!;
  return { schemaVersion: 1, defaultConnectionId: id, allowFallback: false, connections: [{
    id, provider: provider.id, model: provider.models[0]!.id,
    auth: { method: 'oauth', credentialRef: `pi:${id}` }, billing: { kind: 'subscription' }, quotaGroup: 'shared-contract',
    limits: { maxTokens: 1000, maxDurationMs: 10000, maxAttempts: 2, maxConcurrency: 1, maxCostUsd: null }, status: 'configured',
  }] };
}

test('catalog is local metadata and reading it does not invoke OAuth or fetch', () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network must not be used'); };
  try {
    const catalog = connectionCatalog();
    assert.ok(['openai', 'anthropic', 'kimi-coding', 'openrouter', 'amazon-bedrock', 'google-vertex'].every(id => catalog.some(p => p.id === id)));
    assert.ok(catalog.every(p => p.methods.length > 0));
    assert.ok(catalog.find(p => p.id === 'openrouter')?.methods.includes('oauth'));
    assert.equal(catalog.find(p => p.id === 'openrouter')?.subscriptionOAuth, false);
  } finally { globalThis.fetch = previous; }
});

test('declarations reject unknown secrets, duplicate/default IDs, unsupported models and false readiness', () => {
  const base = profile();
  const bad: unknown[] = [
    { ...base, apiKey: 'never-print-this' }, { ...base, defaultConnectionId: 'missing' },
    { ...base, connections: [base.connections[0], base.connections[0]] },
    { ...base, allowFallback: true },
    { ...base, connections: [{ ...base.connections[0], model: 'not-in-catalog' }] },
    { ...base, connections: [{ ...base.connections[0], status: 'enabled' }] },
    { ...base, connections: [{ ...base.connections[0], auth: { method: 'oauth', credentialRef: 'secret-value', token: 'never-print-this' } }] },
    { ...base, connections: [{ ...base.connections[0], limits: { ...base.connections[0]!.limits, maxConcurrency: 5 } }] },
    { ...base, connections: [{ ...base.connections[0], limits: { ...base.connections[0]!.limits, maxCostUsd: 0 } }] },
  ];
  for (const value of bad) assert.throws(() => validateConnections(value), error => error instanceof SetupError && !error.message.includes('never-print-this'));
  assert.throws(() => parseConnections('{"secret":"never-print-this"'), error => error instanceof SetupError && !error.message.includes('never-print-this'));
});

test('API-key auth can represent a subscription but metered billing requires a positive cost limit', () => {
  const data = profile();
  data.connections[0]!.auth.method = 'api_key';
  assert.equal(validateConnections(data).connections[0]!.billing.kind, 'subscription');
  data.connections[0]!.billing.kind = 'metered';
  assert.throws(() => validateConnections(data));
  data.connections[0]!.limits.maxCostUsd = 0.5;
  assert.equal(validateConnections(data).connections[0]!.limits.maxCostUsd, 0.5);
  data.connections[0]!.auth.method = 'oauth';
  assert.throws(() => validateConnections(data));
});

test('users remain isolated and save refuses concurrent edits instead of overwriting them', t => {
  const first = fixture(t);
  const second = fixture(t);
  saveConnections(first.file, profile('userA'), null, first.state);
  saveConnections(second.file, profile('userB'), null, second.state);
  assert.equal(readConnections(first.file).profile!.defaultConnectionId, 'userA');
  assert.equal(readConnections(second.file).profile!.defaultConnectionId, 'userB');
  assert.equal(statSync(first.file).mode & 0o777, 0o600);
  const old = readConnections(first.file);
  writeFileSync(first.file, JSON.stringify(profile('manual-edit')));
  assert.throws(() => saveConnections(first.file, profile('overwrite'), old.hash, first.state), error => error instanceof SetupError && error.code === 'settings_changed');
  assert.equal(readConnections(first.file).profile!.defaultConnectionId, 'manual-edit');
  assert.equal(existsSync(join(first.state, 'maintenance.lock')), false);
  assert.deepEqual(readdirSync(dirname(first.file)), ['connections.json']);
});

test('corrupt/symlink profiles are not treated as missing; retired models can be replaced', t => {
  const { dir, file, state } = fixture(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'broken');
  assert.throws(() => saveConnections(file, profile(), null, state));
  assert.equal(readFileSync(file, 'utf8'), 'broken');
  const old = profile(); old.connections[0]!.model = 'retired-model';
  writeFileSync(file, JSON.stringify(old));
  assert.throws(() => readConnections(file));
  const previous = readConnections(file, false);
  saveConnections(file, profile(), previous.hash, state);
  assert.equal(readConnections(file).profile!.connections[0]!.model, profile().connections[0]!.model);
  symlinkSync(file, join(dir, 'symlink.json'));
  assert.throws(() => readConnections(join(dir, 'symlink.json')));
});

test('wizard selects three subscriptions and a user-selected default without hardcoding a model', async t => {
  const { dir } = fixture(t);
  const settings = loadConfig(dir, join(dir, 'absent.json')).settings;
  const answers: string[] = [];
  for (const p of connectionCatalog().filter(p => ['openai', 'anthropic', 'kimi-coding'].includes(p.id))) answers.push('add', `conn-${p.id}`, p.id, 'oauth', p.models[0]!.id, '', '', '', '', '');
  answers.push('save', 'conn-anthropic', 'yes');
  const output: string[] = [];
  const result = await promptConnections(null, settings, async () => {
    assert.ok(answers.length, 'unexpected question'); return answers.shift()!;
  }, text => output.push(text));
  assert.equal(answers.length, 0);
  assert.equal(result!.connections.length, 3);
  assert.equal(result!.defaultConnectionId, 'conn-anthropic');
  assert.ok(result!.connections.every(c => c.billing.kind === 'subscription' && c.limits.maxCostUsd === null && c.status === 'configured'));
  assert.equal(settings.allowedConnections.length, 0);
  assert.ok(output.some(text => text.includes('認証・モデル利用可否は未確認')));
});

test('wizard edits/removes existing connections and cancellation leaves the original draft untouched', async t => {
  const { dir } = fixture(t);
  const settings = loadConfig(dir, join(dir, 'absent.json')).settings;
  const existing = profile('old');
  existing.connections.push(profile('keep').connections[0]!);
  const original = structuredClone(existing);
  const provider = connectionCatalog().find(p => p.id === 'openai')!;
  const answers = ['remove', 'old', 'edit', 'keep', provider.id, 'api_key', 'metered', provider.models[0]!.id, '', '', '', '', '', '0.25', 'save', 'keep', 'yes'];
  const result = await promptConnections(existing, settings, async () => { assert.ok(answers.length); return answers.shift()!; }, () => {});
  assert.equal(result!.defaultConnectionId, 'keep');
  assert.equal(result!.connections[0]!.billing.kind, 'metered');
  assert.equal(result!.connections[0]!.limits.maxCostUsd, 0.25);
  assert.deepEqual(existing, original);
  await assert.rejects(promptConnections(existing, settings, async () => '/cancel', () => {}), error => error instanceof SetupError && error.code === 'setup_cancelled');
  assert.deepEqual(existing, original);
});

test('non-TTY setup requires explicit input and confirmation; save preserves policy and never authenticates', t => {
  const { dir, file, state } = fixture(t);
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: dirname(state) };
  const cli = resolve('dist/src/cli.js');
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'setup', ...args, '--json'], { env, cwd: dir, encoding: 'utf8' });
  const missing = run();
  assert.equal(missing.status, 3);
  assert.equal(JSON.parse(missing.stdout).code, 'setup_requires_input');
  const catalog = run('--catalog');
  assert.equal(catalog.status, 0);
  assert.equal(JSON.parse(catalog.stdout).authenticated, false);
  assert.equal(existsSync(dirname(file)), false);
  const input = join(dir, 'input.json');
  writeFileSync(input, JSON.stringify(profile()));
  assert.equal(run('--from', input).status, 3);
  assert.equal(existsSync(file), false);
  mkdirSync(dirname(file), { recursive: true });
  const policy = join(dirname(file), 'config.json');
  writeFileSync(policy, '{"schemaVersion":1,"permission":"read-only","allowedConnections":[]}');
  const before = readFileSync(policy, 'utf8');
  const saved = run('--from', input, '--yes');
  assert.equal(saved.status, 0, saved.stderr);
  const output = JSON.parse(saved.stdout);
  assert.equal(output.status, 'saved');
  assert.equal(output.authentication, 'not_checked');
  assert.equal(output.executionReady, false);
  assert.deepEqual(output.notAllowedConnectionIds, ['test']);
  assert.equal(readFileSync(policy, 'utf8'), before);
  assert.equal(existsSync(join(state, 'auth.json')), false);
  assert.equal(existsSync(join(state, 'state.sqlite')), false);
  const doctor = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--json'], { env, cwd: dir, encoding: 'utf8' }));
  assert.equal(doctor.connections.configured, true);
  assert.equal(doctor.connections.authentication, 'not_checked');
  assert.equal(doctor.capabilities.models, true);
  assert.equal(doctor.connections.executionReady, false);
});
