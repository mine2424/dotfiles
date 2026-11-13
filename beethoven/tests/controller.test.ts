import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionController } from '../src/controller.js';
import { SetupError } from '../src/connections.js';
import type { openAgent, AgentOptions } from '../src/agent.js';

const options = {} as AgentOptions;
function fixture() {
  let release!: () => void, fail = false, closed = 0, stale!: () => void;
  const factory = (async (options: AgentOptions) => ({
    id: 'fixture', info: () => ({ sessionId: 'fixture', usage: { tokens: 7 } }),
    run: async (_text: string, request: any) => {
      stale = () => { request.onEvent?.({ type: 'text', delta: 'late' }); options.onActivity?.({ stage: 'model' }); };
      if (fail) throw new Error('runtime failed');
      await new Promise<void>(done => { release = done; }); return { status: 'completed' };
    }, abort() { release?.(); }, async close() { closed++; },
  })) as unknown as typeof openAgent;
  return { factory, release: () => release(), fail: () => { fail = true; }, closed: () => closed, stale: () => stale() };
}
test('controller owns one run, refuses release while busy, and filters late events after close', async () => {
  const f = fixture(); let observed = 0;
  const owner = await SessionController.open({ ...options, onActivity: () => { observed++; } }, f.factory);
  const run = owner.run('one', { onEvent: () => { observed++; } });
  assert.equal(owner.state, 'running');
  await assert.rejects(owner.run('two'), (error: any) => error.code === 'controller_not_ready');
  await assert.rejects(owner.close(), (error: any) => error.code === 'controller_busy');
  owner.abort(); await run; assert.equal(owner.state, 'idle');
  await Promise.all([owner.close(), owner.close()]); assert.equal(f.closed(), 1);
  f.stale(); assert.equal(observed, 0); assert.equal(owner.info().usage.tokens, 7);
});
test('unexpected failures pause execution and preserve the owner until explicit release', async () => {
  const f = fixture(); f.fail(); const owner = await SessionController.open(options, f.factory);
  await assert.rejects(owner.run('one'), /runtime/); assert.equal(owner.state, 'paused');
  await assert.rejects(owner.run('automatic retry'), SetupError);
  assert.equal(f.closed(), 0); await owner.close(); assert.equal(f.closed(), 1);
});
