import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { connectionCatalog, readConnections, validateConnections, SetupError } from '../src/connections.js';
import { connectionConsent, quickConnect, type ConnectUI } from '../src/connect.js';
import { authDirectory, ConnectionCredentials, selectedProvider, loginConnection } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { openRouterCost, openRouterPayload } from '../src/providers.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'beethoven-connect-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'); mkdirSync(cwd);
  return { cwd, configFile: join(root, 'config', 'config.json'), stateDir: join(root, 'state') };
}
function answers(values: string[]): ConnectUI {
  return { async select(_title, items) { const value = values.shift(); assert.ok(value); assert.ok(items.some(i => i.value === value), value); return value; }, async ask() { return values.shift() ?? null; }, message() {} };
}
function model(provider: string) { return connectionCatalog().find(p => p.id === provider)!.models.find(m => !m.id.startsWith('openrouter/'))!.id; }

test('catalog covers every pinned native provider without network; classifier-only entries remain explicit', () => {
  const fetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('network forbidden'); };
  try {
    assert.deepEqual(connectionCatalog().map(p => p.id).sort(), builtinProviders().map(p => p.id).sort());
    for (const p of connectionCatalog().filter(p => p.models.length)) {
      const method = p.methods.includes('api_key') ? 'api_key' : 'oauth';
      const billing = method === 'oauth' && p.subscriptionOAuth ? 'subscription' : 'metered';
      const profile = validateConnections({ schemaVersion: 1, defaultConnectionId: 'check', allowFallback: false, connections: [{ id: 'check', provider: p.id, model: p.models[0]!.id, auth: { method, credentialRef: 'pi:check' }, billing: { kind: billing }, quotaGroup: 'check', limits: { maxTokens: 1000, maxDurationMs: 1000, maxAttempts: 1, maxConcurrency: 1, maxCostUsd: billing === 'metered' ? 1 : null }, status: 'configured' }] });
      assert.equal(selectedProvider(profile.connections[0]!).id, p.id);
    }
    assert.equal(connectionCatalog().find(p => p.id === 'typesafe')?.models.length, 0);
  } finally { globalThis.fetch = fetch; }
});

test('one connection flow saves auth and explicit allow, auto-generates IDs, and reuses its own credential', async t => {
  const context = fixture(t), selectedModel = model('openrouter');
  let logins = 0;
  const authenticate = async (id: string) => {
    logins++;
    const connection = readConnections(join(context.configFile, '..', 'connections.json')).profile!.connections.find(c => c.id === id)!;
    await new ConnectionCredentials(authDirectory(context.configFile, connection), connection.provider).modify(connection.provider, async () => ({ type: 'oauth', access: 'test-only', refresh: '', expires: Number.MAX_SAFE_INTEGER }));
  };
  const first = await quickConnect(context, answers(['openrouter:oauth', selectedModel, 'connect']), authenticate);
  assert.equal(first.connection.billing.kind, 'metered'); assert.equal(first.connection.limits.maxCostUsd, 1);
  assert.deepEqual(loadConfig(context.cwd, context.configFile).settings.allowedConnections, [first.connection.id]);
  assert.equal(loadConfig(context.cwd, context.configFile).settings.permission, 'read-only');
  assert.equal(connectionConsent(context, first.connection), first.consent);
  const second = await quickConnect(context, answers(['openrouter:oauth', selectedModel, 'connect']), authenticate);
  assert.equal(logins, 1); assert.equal(second.connection.id, first.connection.id);
  assert.equal(readConnections(join(context.configFile, '..', 'connections.json')).profile!.connections.length, 1);
  assert.equal(existsSync(join(context.stateDir, 'state.sqlite')), false);
});

test('cancellation writes nothing; authentication failure retains only a resumable configured declaration', async t => {
  const context = fixture(t), selectedModel = model('openai');
  await assert.rejects(quickConnect(context, answers(['openai:oauth', selectedModel, 'cancel']), async () => { throw new Error('must not authenticate'); }));
  assert.equal(existsSync(context.configFile), false); assert.equal(existsSync(context.stateDir), false);
  await assert.rejects(quickConnect(context, answers(['openai:oauth', selectedModel, 'connect']), async () => { throw new Error('test authentication failed'); }));
  assert.equal(readConnections(join(context.configFile, '..', 'connections.json')).profile!.connections[0]!.status, 'configured');
  assert.deepEqual(loadConfig(context.cwd, context.configFile).settings.allowedConnections, []);
});

test('cloud credential environments are private provider-scoped data; ordinary APIs have no ambient-key fallback', async t => {
  const context = fixture(t);
  const storage = new ConnectionCredentials(join(context.cwd, 'auth'), 'amazon-bedrock');
  await storage.modify('amazon-bedrock', async () => ({ type: 'api_key', env: { AWS_PROFILE: 'fixture-profile' } }));
  assert.equal((await storage.read('amazon-bedrock'))?.type, 'api_key');
  const c = { id: 'example', provider: 'openrouter', model: model('openrouter'), auth: { method: 'api_key' as const, credentialRef: 'pi:example' }, billing: { kind: 'metered' as const }, quotaGroup: 'example', limits: { maxTokens: 1000, maxDurationMs: 1000, maxAttempts: 1, maxConcurrency: 1, maxCostUsd: 1 }, status: 'configured' as const };
  const provider = selectedProvider(c);
  const result = await provider.auth.apiKey!.resolve({ credential: undefined, ctx: { env: async () => 'ambient-must-not-be-used', fileExists: async () => true }, signal: new AbortController().signal });
  assert.equal(result, undefined);
});

test('OpenRouter routing policy and exact response costs do not infer missing charges as zero', () => {
  const payload = openRouterPayload({ model: 'fixture', provider: { allow_fallbacks: true, only: ['example'] } });
  assert.deepEqual(payload.provider, { only: ['example'], allow_fallbacks: false, require_parameters: true });
  assert.equal(openRouterCost({ usage: { cost: 0 } }), 0);
  assert.equal(openRouterCost({ usage: { cost: 0.0123 } }), 0.0123);
  assert.equal(openRouterCost({ usage: { total_tokens: 100 } }), null);
  assert.equal(openRouterCost({ usage: { cost: -1 } }), null);
  assert.throws(() => openRouterPayload(null));
});

test('Azure native login persists endpoint and deployment metadata without a model request', async t => {
  const context = fixture(t), p = connectionCatalog().find(p => p.id === 'azure')!;
  const connection = { id: 'azure-test', provider: p.id, model: p.models[0]!.id, auth: { method: 'api_key' as const, credentialRef: 'pi:azure-test' }, billing: { kind: 'metered' as const }, quotaGroup: 'azure', limits: { maxTokens: 1000, maxDurationMs: 1000, maxAttempts: 1, maxConcurrency: 1, maxCostUsd: 1 }, status: 'configured' as const };
  const responses = ['test-only-key', 'fixture-resource', 'fixture-deployment'];
  const fetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('network forbidden'); };
  try { await loginConnection(context.configFile, connection, { signal: new AbortController().signal, prompt: async () => responses.shift()!, notify() {} }); }
  finally { globalThis.fetch = fetch; }
  const credential = await new ConnectionCredentials(authDirectory(context.configFile, connection), p.id).read(p.id);
  assert.equal(credential?.type, 'api_key');
  if (credential?.type === 'api_key') {
    assert.equal(credential.env?.AZURE_OPENAI_RESOURCE_NAME, 'fixture-resource');
    assert.equal(JSON.parse(credential.env!.AZURE_OPENAI_DEPLOYMENT_NAME_MAP!)[connection.model], 'fixture-deployment');
  }
});
