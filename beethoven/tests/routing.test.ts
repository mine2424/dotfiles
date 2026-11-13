import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConnections } from '../src/connections.js';
import { connectionEvaluation, connectionFingerprint, enableConnection, routedConnection, saveEvaluation, validateRouting, type Evaluation } from '../src/routing.js';
import { saveArtifact } from '../src/files.js';

test('routing examples agree with declarations; unknown IDs, duplicate task mappings and implicit fallback fail', () => {
  const profile = parseConnections(readFileSync(new URL('../../connections.example.json', import.meta.url), 'utf8'));
  const routing = JSON.parse(readFileSync(new URL('../../routing.example.json', import.meta.url), 'utf8'));
  assert.equal(validateRouting(routing, profile).roles.reviewer, 'claude-sub');
  for (const value of [{ ...routing, allowFallback: true }, { ...routing, roles: { verifier: 'codex-sub' } },
    { ...routing, roles: { dialogue: 'absent' } }, { ...routing, tasks: [routing.tasks[0], routing.tasks[0]] }]) assert.throws(() => validateRouting(value, profile));
});

test('only current evaluated and explicitly enabled allowlisted connections can be routed', t => {
  const state = mkdtempSync(join(tmpdir(), 'beethoven-routing-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const profile = parseConnections(readFileSync(new URL('../../connections.example.json', import.meta.url), 'utf8'));
  const connection = profile.connections[0]!;
  const routing = validateRouting({ schemaVersion: 1, allowFallback: false, roles: { dialogue: connection.id }, tasks: [] }, profile);
  const select = (allowed = [connection.id]) => routedConnection(routing, 'dialogue', undefined, profile, allowed, state);
  assert.throws(() => select());
  const evidenceHash = saveArtifact(state, Buffer.from('{"fixture":"test-only"}')).hash;
  const evaluation: Evaluation = { schemaVersion: 1, connectionHash: connectionFingerprint(connection), piVersion: '1.4.0', observedAt: new Date().toISOString(), fixtureHash: 'a'.repeat(64), evidenceHash,
    pricing: { kind: 'subscription', basis: 'Explicit test subscription; amount unknown', observedAt: new Date().toISOString(), amountUsd: null },
    checks: { sdkSmoke: true, rpcSmoke: true, task: false, abort: false, resume: false, protectedFiles: true }, usage: { reportedTokens: 10, missingRequests: 1 }, outcome: 'supported' };
  assert.equal(saveEvaluation(state, connection, evaluation).status, 'smoke_passed');
  assert.throws(() => enableConnection(state, connection, connectionEvaluation(state, connection).evaluationHash!));
  evaluation.checks.task = evaluation.checks.abort = evaluation.checks.resume = true;
  const completed = saveEvaluation(state, connection, evaluation);
  assert.equal(completed.status, 'task_evaluated'); assert.throws(() => select());
  assert.throws(() => enableConnection(state, connection, 'b'.repeat(64)));
  enableConnection(state, connection, completed.evaluationHash!);
  assert.equal(select().id, connection.id); assert.throws(() => select([]));
  assert.throws(() => routedConnection(null, 'dialogue', undefined, profile, [connection.id], state));
  connection.limits.maxTokens++;
  assert.equal(connectionEvaluation(state, connection).status, 'configured'); assert.throws(() => select());
  connection.limits.maxTokens--;
  // A failed/new evaluation invalidates prior enablement.
  evaluation.outcome = 'unsupported';
  assert.equal(saveEvaluation(state, connection, evaluation).status, 'unsupported'); assert.throws(() => select());
  const receipt = join(state, 'evaluations', `${connection.id}.json`);
  writeFileSync(receipt, '{"secret":"must-not-leak"');
  assert.throws(() => connectionEvaluation(state, connection), e => e instanceof Error && !e.message.includes('must-not-leak'));
});

test('CLI connection and routing diagnostics are read-only and cannot enable an unevaluated connection', t => {
  const root = mkdtempSync(join(tmpdir(), 'beethoven-routing-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configRoot = join(root, 'config'), stateRoot = join(root, 'state');
  mkdirSync(join(configRoot, 'beethoven'), { recursive: true });
  writeFileSync(join(configRoot, 'beethoven', 'connections.json'), readFileSync(new URL('../../connections.example.json', import.meta.url)));
  const cli = (args: string[]) => spawnSync(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, ...args], {
    cwd: root, env: { ...process.env, XDG_CONFIG_HOME: configRoot, XDG_STATE_HOME: stateRoot }, encoding: 'utf8',
  });
  const connections = cli(['connections', '--json']);
  assert.equal(connections.status, 0); assert.ok(JSON.parse(connections.stdout).every((c: { status: string }) => c.status === 'configured'));
  const routing = cli(['routing', 'check', '--json']);
  assert.equal(routing.status, 0); assert.equal(JSON.parse(routing.stdout).configured, false);
  const enable = cli(['connections', 'enable', '--connection', 'codex-sub', '--yes', '--json']);
  assert.notEqual(enable.status, 0); assert.equal(JSON.parse(enable.stdout).error, 'evaluation_required');
  assert.equal(existsSync(stateRoot), false);
});
