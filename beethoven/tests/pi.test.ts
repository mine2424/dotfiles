import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  RpcClient,
  type AgentSessionEvent,
  type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  classifyPiFailure,
  rpcTurnAdapter,
  sdkTurnAdapter,
} from "../src/pi.js";

/** providerや認証を使わない確定message。SDK/RPCの型と同じ形でイベント順序を再現する。 */
function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    content: [{ type: "text", text: "日本語の応答" }],
    timestamp: 1,
    stopReason: "stop",
    usage: {
      input: 10,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

/** SDKの購読契約をfakeで検査する。Pi本体の推論・tool動作を確認したとは扱わない。 */
function sdkFixture(
  run: (emit: (event: AgentSessionEvent) => void) => Promise<void>,
  disposition: "started" | "handled" | "queued" = "started",
  intentionalToolStop?: () => boolean,
) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let aborts = 0;
  const adapter = sdkTurnAdapter(
    {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async prompt(_text, options) {
        options?.preflightResult?.(disposition);
        await run((event) => {
          for (const listener of listeners) listener(event);
        });
      },
      async abort() {
        aborts++;
      },
    },
    intentionalToolStop,
  );
  return {
    adapter,
    listeners,
    get aborts() {
      return aborts;
    },
  };
}

test("SDK adapter observes early settlement, ignores cumulative usage, and deduplicates final messages", async () => {
  const final = message();
  const fixture = sdkFixture(async (emit) => {
    emit({ type: "message_start", message: final });
    for (let i = 0; i < 3; i++)
      emit({
        type: "message_update",
        message: final,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "日",
          partial: final,
        },
      });
    emit({ type: "message_end", message: final });
    emit({ type: "message_end", message: final });
    emit({ type: "agent_end", messages: [final], willRetry: false });
    emit({ type: "agent_settled", aborted: false });
  });
  const deltas: string[] = [];
  const result = await fixture.adapter.run("fixture", {
    maxDurationMs: 1000,
    onEvent: (event) => {
      if (event.type === "text") deltas.push(event.delta);
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.settled, true);
  assert.deepEqual(result.usage, {
    input: 10,
    output: 3,
    cacheRead: 2,
    cacheWrite: 0,
  });
  assert.deepEqual(deltas, ["日", "日", "日"]);
  assert.equal(fixture.listeners.size, 0);
});

test("RPC acceptance and agent_end do not complete a turn before agent_settled", async () => {
  let listener!: (event: JsonAgentSessionEvent) => void;
  let unsubscribed = false;
  const adapter = rpcTurnAdapter({
    onEvent(fn) {
      listener = fn;
      return () => {
        unsubscribed = true;
      };
    },
    async prompt() {
      return "started";
    },
    async abort() {},
  });
  let done = false;
  const result = adapter.run("test", { maxDurationMs: 1000 }).then((value) => {
    done = true;
    return value;
  });
  const final = message({
    stopReason: "error",
    errorMessage: "429 rate limit secret-must-not-escape",
  });
  listener({ type: "message_start", message: final });
  listener({ type: "message_end", message: final });
  listener({ type: "agent_end", messages: [final], willRetry: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  listener({ type: "agent_settled", aborted: false });
  const report = await result;
  assert.equal(report.status, "error");
  assert.equal(report.failure, "rate_limit");
  assert.equal(
    JSON.stringify(report).includes("secret-must-not-escape"),
    false,
  );
  assert.equal(unsubscribed, true);
});

test("handled prompts need no settled event and permit another turn; queued prompts cannot be reused", async () => {
  const handled = sdkFixture(async () => {}, "handled");
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await handled.adapter.run("/fixture", { maxDurationMs: 1000 })).status,
      "handled",
    );
  const queued = sdkFixture(async () => {}, "queued");
  assert.equal(
    (await queued.adapter.run("fixture", { maxDurationMs: 1000 })).status,
    "queued",
  );
  await assert.rejects(
    queued.adapter.run("again", { maxDurationMs: 1000 }),
    /停止未確認/,
  );
});

test("deadline and cancellation request abort but do not claim confirmed process cleanup", async () => {
  const fixture = sdkFixture(async () => {
    await new Promise(() => {});
  });
  const running = fixture.adapter.run("fixture", { maxDurationMs: 10 });
  await assert.rejects(
    fixture.adapter.run("concurrent", { maxDurationMs: 10 }),
    /実行中/,
  );
  const timedOut = await running;
  assert.equal(timedOut.status, "timeout");
  assert.equal(timedOut.settled, false);
  assert.equal(fixture.aborts, 1);
  await assert.rejects(
    fixture.adapter.run("again", { maxDurationMs: 10 }),
    /停止未確認/,
  );
  assert.equal(fixture.listeners.size, 0);

  const controller = new AbortController();
  const cancelled = sdkFixture(async () => {
    controller.abort();
  });
  assert.equal(
    (
      await cancelled.adapter.run("test", {
        maxDurationMs: 1000,
        signal: controller.signal,
      })
    ).status,
    "aborted",
  );
  assert.equal(cancelled.aborts, 1);
  const beforeStart = sdkFixture(async () => {
    assert.fail("must not send");
  });
  assert.equal(
    (
      await beforeStart.adapter.run("test", {
        maxDurationMs: 1000,
        signal: controller.signal,
      })
    ).status,
    "aborted",
  );
});

test("missing usage and a tool error are distinct from a successful model response", async () => {
  const fixture = sdkFixture(async (emit) => {
    emit({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "read",
      result: {},
      isError: true,
    });
    emit({ type: "agent_settled", aborted: false });
  });
  const result = await fixture.adapter.run("test", { maxDurationMs: 1000 });
  assert.equal(result.status, "error");
  assert.equal(result.usage, null);
  assert.equal(result.toolErrors, 1);
  assert.equal(result.failure, "unknown");
  assert.equal(classifyPiFailure("401 invalid token"), "authentication");
  assert.equal(classifyPiFailure("request timed out"), "timeout");
});

test("cancellation before dispatch never sends a prompt; prompt rejection and settled abort are classified", async () => {
  const controller = new AbortController();
  const cancelled = sdkFixture(async () => {
    assert.fail("must not send after cancellation");
  });
  const waiting = cancelled.adapter.run("test", {
    maxDurationMs: 1000,
    signal: controller.signal,
  });
  controller.abort();
  assert.equal((await waiting).status, "aborted");

  const rejected = sdkFixture(async () => {
    throw new Error("401 secret-value");
  });
  const result = await rejected.adapter.run("test", { maxDurationMs: 1000 });
  assert.equal(result.failure, "authentication");
  assert.equal(result.settled, false);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);

  const aborted = sdkFixture(async (emit) => {
    emit({ type: "agent_settled", aborted: true });
  });
  const stopped = await aborted.adapter.run("test", { maxDurationMs: 1000 });
  assert.equal(stopped.status, "aborted");
  assert.equal(stopped.settled, true);
});

test("official Pi RpcClient carries Unicode JSONL and early events from a local fake process", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "beethoven-rpc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "fake-rpc.mjs");
  // 本番Piの代替ではなく、公式clientのwire契約だけを試す専用process。
  writeFileSync(
    file,
    `import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'prompt') {
    if (command.message !== '日本語の依頼') throw new Error('Unicode changed');
    const message = ${JSON.stringify(message())};
    send({ type: 'message_start', message });
    send({ type: 'future_event', value: 'unknown events are ignored' });
    send({ type: 'message_end', message });
    send({ type: 'agent_settled', aborted: false });
    send({ type: 'response', id: command.id, command: 'prompt', success: true, data: { disposition: 'started' } });
  }
});
`,
  );
  const client = new RpcClient({
    cliPath: file,
    cwd: dir,
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
  });
  try {
    await client.start();
    const result = await rpcTurnAdapter(client).run("日本語の依頼", {
      maxDurationMs: 1000,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.usage?.input, 10);
  } finally {
    await client.stop();
  }
});

test("toolUse settlement stays incomplete unless the Controller explicitly recognizes a validated proposal", async () => {
  for (const intentional of [false, true]) {
    const fixture = sdkFixture(
      async (emit) => {
        const final = message({ stopReason: "toolUse" });
        emit({ type: "message_end", message: final });
        emit({ type: "agent_settled", aborted: false });
      },
      "started",
      () => intentional,
    );
    const result = await fixture.adapter.run("fixture", {
      maxDurationMs: 1000,
    });
    assert.equal(result.status, intentional ? "completed" : "error");
    assert.equal(result.settled, true);
  }
});
