import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openAgent, type AgentOptions } from '../src/agent.js';
import { runWorker } from '../src/worker.js';
import { SessionStore } from '../src/session.js';
import { scriptedRuntime } from './worker-child.js';

async function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'beethoven-worker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'repo'); mkdirSync(cwd); const configFile = join(directory, 'config/config.json'); mkdirSync(join(directory, 'config'));
  mkdirSync(join(cwd, '.beethoven'));
  writeFileSync(join(cwd, '.beethoven/harness.json'), JSON.stringify({ schemaVersion: 1, requirements: [{ id: 'value', stage: 'verify', required: true }], checks: [{ id: 'value', stage: 'verify', argv: [process.execPath, '-e', `require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'two\\n')`], cwd: '.', timeoutMs: 2000, requiredEnv: [], acceptanceIds: ['AC-WORKER'] }] }));
  writeFileSync(join(cwd, 'value.txt'), 'one\n'); writeFileSync(join(cwd, 'AGENTS.md'), 'Preserve existing work.');
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  writeFileSync(join(cwd, 'dirty.txt'), 'existing user change');
  writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, permission: 'workspace-write', allowedConnections: ['fixture'], maxTokens: 50000 }));
  const options: AgentOptions = { cwd, configFile, stateDir: join(directory, 'state'), send: true, runtime: await scriptedRuntime(),
    connection: { id: 'fixture', provider: 'fixture', model: 'fixture', auth: { method: 'api_key', credentialRef: 'pi:fixture' }, billing: { kind: 'subscription' }, quotaGroup: 'fixture', limits: { maxTokens: 50000, maxDurationMs: 10000, maxAttempts: 1, maxConcurrency: 1, maxCostUsd: null }, status: 'configured' },
    ask: async () => null, approve: async () => true };
  const agent = await openAgent(options); const id = agent.id; await agent.close();
  return { options, id, cwd, git };
}
const entry = fileURLToPath(new URL('./worker-child.js', import.meta.url));
test('real SDK child edits isolated dirty snapshot, records provenance, and reconciles into parent budget', async t => {
  const f = await fixture(t); const before = f.git('status', '--porcelain').toString(); const stages: string[] = [];
  const result = await runWorker({ parentId: f.id, task: 'oneをtwoに修正', agent: f.options, entry, onState: state => stages.push(state.stage), onEvent() {}, ask: async () => 'yes' });
  assert.equal(result.stage, 'candidate'); assert.notEqual(result.pid, process.pid);
  assert.equal(readFileSync(join(result.directory, 'value.txt'), 'utf8'), 'two\n');
  assert.equal(readFileSync(join(f.cwd, 'value.txt'), 'utf8'), 'one\n'); assert.equal(f.git('status', '--porcelain').toString(), before);
  assert.equal(readFileSync(join(result.directory, 'dirty.txt'), 'utf8'), 'existing user change');
  assert.ok(stages.includes('model')); assert.ok(stages.includes('tool_start')); assert.ok(stages.includes('verify'));
  assert.equal((result.report!.verification as any).status, 'pass');
  assert.deepEqual(result.report!.execution, { connectionId: 'fixture', provider: 'fixture', model: 'fixture', auth: 'api_key', billing: 'subscription' });
  const db = new SessionStore(f.options.stateDir); const parent = db.load(f.id); db.close();
  assert.ok(parent.tokens > 0); assert.equal(parent.tokens, result.report!.usage.tokens); assert.equal(parent.activeWorker, undefined);
  const resumed = await openAgent({ ...f.options, resume: f.id }); assert.equal(resumed.info().usage.tokens, parent.tokens); await resumed.close();
});
test('cancellation reaps actual SDK child and preserves unknown usage rather than resetting budget', async t => {
  const f = await fixture(t); const controller = new AbortController();
  const result = await runWorker({ parentId: f.id, task: 'slow', agent: f.options, entry, signal: controller.signal,
    onState: state => { if (state.stage === 'model') setTimeout(() => controller.abort(), 50); }, onEvent() {}, ask: async () => null });
  assert.notEqual(result.stage, 'candidate');
  assert.throws(() => process.kill(result.pid!, 0), (e: any) => e.code === 'ESRCH');
  const db = new SessionStore(f.options.stateDir); const parent = db.load(f.id); db.close();
  assert.equal(parent.activeWorker, undefined); assert.ok(parent.tokens > 0 || parent.reservedUnknownTokens! > 0);
  assert.equal(readFileSync(join(f.cwd, 'value.txt'), 'utf8'), 'one\n');
});

test('Worker inherits read-only permission and persists blocked mutation without changing either workspace', async t => {
  const f = await fixture(t);
  const db = new SessionStore(f.options.stateDir); const parent = db.load(f.id); parent.allowedPaths = ['dirty.txt']; db.save(parent, 'fixture_scope'); db.close();
  const result = await runWorker({ parentId: f.id, task: 'scope外の編集要求', agent: { ...f.options, overrides: { permission: 'read-only' } }, entry, onState() {}, onEvent() {}, ask: async () => 'yes' });
  assert.equal(readFileSync(join(result.directory, 'value.txt'), 'utf8'), 'one\n');
  assert.notEqual(result.stage, 'candidate');
  assert.equal(readFileSync(join(f.cwd, 'value.txt'), 'utf8'), 'one\n');
});

test('explicit recovery refuses a live worker and conservatively retains full unknown reservation after exit', async t => {
  const { recoverWorker } = await import('../src/worker.js');
  const { spawn } = await import('node:child_process');
  const f = await fixture(t); const id = '11111111-1111-4111-8111-111111111111';
  const directory = join(f.options.stateDir, 'workers', id); mkdirSync(directory, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { detached: true, stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  writeFileSync(join(directory, 'status.json'), JSON.stringify({ id, stage: 'model', pid: child.pid }));
  const db = new SessionStore(f.options.stateDir); const parent = db.load(f.id); parent.activeWorker = { id, directory, tokens: 1000, costUsd: 0, startedAt: Date.now() }; db.save(parent, 'fixture_reservation'); db.close();
  try {
    assert.throws(() => recoverWorker(f.options.stateDir, id, true), /消失/);
    await assert.rejects(openAgent({ ...f.options, resume: f.id }), /未精算/);
  } finally { process.kill(-child.pid!, 'SIGTERM'); await exited; }
  assert.equal(recoverWorker(f.options.stateDir, id).recovered, false);
  assert.equal(recoverWorker(f.options.stateDir, id, true).recovered, true);
  const check = new SessionStore(f.options.stateDir); const recovered = check.load(f.id); check.close();
  assert.equal(recovered.activeWorker, undefined); assert.equal(recovered.reservedUnknownTokens, 1000); assert.equal(recovered.usageUnknown, true);
});

test('abort received during Worker initialization prevents provider dispatch and candidate edits', async t => {
  const f = await fixture(t);
  const entryFile = join(f.cwd, '../abort-entry.mjs');
  const helper = new URL('./worker-child.js', import.meta.url).href;
  const worker = new URL('../src/worker-entry.js', import.meta.url).href;
  writeFileSync(entryFile, `import {readFileSync} from 'node:fs'; import {scriptedRuntime} from ${JSON.stringify(helper)}; import {workerMain} from ${JSON.stringify(worker)};
const manifest=JSON.parse(readFileSync(process.argv[2],'utf8'));const runtime=await scriptedRuntime();const original=runtime.getModel.bind(runtime);let sent=false;runtime.getModel=(...args)=>{if(!sent){sent=true;process.emit('message',{type:'abort',token:manifest.token});}return original(...args);};await workerMain(process.argv[2],runtime);`);
  const stages: string[] = [];
  const result = await runWorker({ parentId: f.id, task: 'oneをtwoへ修正', agent: f.options, entry: entryFile, onState: state => stages.push(state.stage), onEvent() {}, ask: async () => 'yes' });
  assert.equal(stages.includes('model'), false); assert.notEqual(result.stage, 'candidate');
  assert.equal(readFileSync(join(result.directory, 'value.txt'), 'utf8'), 'one\n');
});

test('Worker cleanup reaps a TERM-resistant descendant after its leader exits', async t => {
  const f = await fixture(t);
  const entryFile = join(f.cwd, '../hung-entry.mjs');
  writeFileSync(entryFile, `import {spawn} from 'node:child_process';process.on('message',()=>{});spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});setInterval(()=>{},1000);`);
  const cancellation = new AbortController(); let pid: number | undefined;
  try {
    const result = await runWorker({ parentId: f.id, task: 'local fixture', agent: f.options, entry: entryFile, signal: cancellation.signal,
      onState: state => { pid = state.pid ?? pid; if (state.stage === 'starting') setTimeout(() => cancellation.abort(), 100); }, onEvent() {}, ask: async () => null });
    assert.equal(result.stage, 'aborted');
    assert.throws(() => process.kill(-pid!, 0), (error: any) => error.code === 'ESRCH');
    const db = new SessionStore(f.options.stateDir); assert.equal(db.load(f.id).activeWorker, undefined); db.close();
  } finally { if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } }
});

test('unsettled Worker detection and recovery are independent of display pagination', async t => {
  const { randomUUID } = await import('node:crypto');
  const { spawn } = await import('node:child_process');
  const { recoverWorker } = await import('../src/worker.js');
  const f = await fixture(t), id = randomUUID();
  const directory = join(f.options.stateDir, 'workers', id); mkdirSync(directory, { recursive: true });
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  writeFileSync(join(directory, 'status.json'), JSON.stringify({ id, stage: 'model', pid: child.pid }));
  const db = new SessionStore(f.options.stateDir), parent = db.load(f.id);
  parent.activeWorker = { id, directory, tokens: 1000, costUsd: 0, startedAt: Date.now() }; db.save(parent, 'fixture_reservation');
  for (let i = 0; i < 100; i++) {
    const record = { ...parent, id: randomUUID(), createdAt: new Date(Date.UTC(2099, 0, 1) + i * 1000).toISOString() }; delete record.activeWorker;
    db.save(record, 'fixture_old_session');
  }
  assert.equal(db.list().some(row => row.id === f.id), false); db.close();
  await assert.rejects(openAgent({ ...f.options, resume: f.id }), /未精算/);
  assert.equal(recoverWorker(f.options.stateDir, id, true).recovered, true);
});

test('abort sent immediately after spawn is replayed at readiness before admitting the SDK', async t => {
  const f = await fixture(t), controller = new AbortController();
  const stages: string[] = [];
  const result = await runWorker({ parentId: f.id, task: 'oneをtwoに修正', agent: f.options, entry, signal: controller.signal,
    onState: state => { stages.push(state.stage); if (state.stage === 'starting') controller.abort(); }, onEvent() {}, ask: async () => 'yes' });
  assert.equal(stages.includes('model'), false); assert.equal(result.stage, 'aborted');
  assert.equal(readFileSync(join(result.directory, 'value.txt'), 'utf8'), 'one\n');
});

test('question parking closes the real child, releases the slot, and resumes the same conversation with delta usage', async t => {
  const f = await fixture(t);
  let asked = 0;
  const parked = await runWorker({ parentId: f.id, task: 'ask', agent: f.options, entry, parkQuestions: true, onState() {}, onEvent() {}, ask: async () => { asked++; return null; } });
  assert.equal(parked.stage, 'waiting_input'); assert.equal(asked, 0); assert.ok(parked.pending);
  assert.throws(() => process.kill(parked.pid!, 0), (error: any) => error.code === 'ESRCH');
  const store = new SessionStore(f.options.stateDir); const before = store.load(f.id); store.close();
  assert.equal(before.activeWorker, undefined); assert.ok(before.tokens > 0);
  const jobFile = join(parked.directory, '../job.json'); const jobBefore = JSON.parse(readFileSync(jobFile, 'utf8'));
  const parent = await openAgent({ ...f.options, resume: f.id }); await parent.close();
  await assert.rejects(runWorker({ parentId: f.id, task: 'two', resume: parked.id, replyTo: 'stale-question', agent: f.options, entry, onState() {}, onEvent() {}, ask: async () => 'yes' }), /回答先/);
  const resumed = await runWorker({ parentId: f.id, task: 'two', resume: parked.id, replyTo: parked.pending!.id, agent: f.options, entry, parkQuestions: true, onState() {}, onEvent() {}, ask: async () => 'yes' });
  assert.equal(resumed.id, parked.id); assert.equal(resumed.stage, 'candidate'); assert.equal(resumed.continuations, 1);
  assert.equal(JSON.parse(readFileSync(jobFile, 'utf8')).childSession, jobBefore.childSession);
  assert.equal(readFileSync(join(resumed.directory, 'value.txt'), 'utf8'), 'two\n');
  const afterStore = new SessionStore(f.options.stateDir); const after = afterStore.load(f.id); afterStore.close();
  assert.equal(after.tokens, resumed.report!.usage.tokens, 'previous child usage must not be charged twice');
  assert.ok(after.tokens > before.tokens); assert.equal(after.activeWorker, undefined);
});

test('pre-admission cancellation returns unused token reservation and observer failures still reap the owned child', async t => {
  const f = await fixture(t), cancellation = new AbortController();
  const result = await runWorker({ parentId: f.id, task: 'oneをtwoに修正', agent: f.options, entry, signal: cancellation.signal,
    onState: state => { if (state.stage === 'starting') cancellation.abort(); }, onEvent() {}, ask: async () => null });
  const store = new SessionStore(f.options.stateDir); const saved = store.load(f.id); store.close();
  assert.equal(saved.tokens, 0); assert.equal(saved.reservedUnknownTokens ?? 0, 0); assert.equal(saved.usageUnknown, false); assert.equal(saved.activeWorker, undefined);
  assert.equal(result.stage, 'aborted');
  const second = await runWorker({ parentId: f.id, task: 'oneをtwoに修正', agent: f.options, entry,
    onState: () => { throw new Error('local observer failed'); }, onEvent() {}, ask: async () => null });
  assert.equal(second.stage, 'failed');
  assert.throws(() => process.kill(-second.pid!, 0), (error: any) => error.code === 'ESRCH');
});

test('Worker snapshot preserves binary bytes and status/log diagnostics remain available after completion', async t => {
  const { workerStatus, workerLogs, listWorkers } = await import('../src/worker.js');
  const f = await fixture(t), bytes = Buffer.from([0, 255, 128, 1, 10, 13]); writeFileSync(join(f.cwd, 'binary.dat'), bytes);
  const result = await runWorker({ parentId: f.id, task: 'oneをtwoに修正', agent: f.options, entry, onState() {}, onEvent() {}, ask: async () => 'yes' });
  assert.deepEqual(readFileSync(join(result.directory, 'binary.dat')), bytes);
  assert.equal(workerStatus(f.options.stateDir, result.id).stage, 'candidate');
  assert.ok(workerLogs(f.options.stateDir, result.id).some(item => item.stage === 'model'));
  assert.equal(listWorkers(f.options.stateDir)[0]!.id, result.id);
});
