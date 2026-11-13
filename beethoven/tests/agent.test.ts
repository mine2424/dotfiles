import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openAgent, type AgentOptions } from "../src/agent.js";
import { SessionStore } from "../src/session.js";
import { savedConversation } from "../src/history.js";

/** テスト専用repo。実モデルに渡す候補Taskと同じ受入条件をローカルで再現する。 */
async function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "beethoven-agent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "repo");
  mkdirSync(join(cwd, ".beethoven"), { recursive: true });
  writeFileSync(
    join(cwd, "cart.js"),
    "export const total = items => items.reduce((sum, item) => sum + item.price, 0);\n",
  );
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(cwd, "cart.test.js"),
    `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { total } from './cart.js';
test('empty', () => assert.equal(total([]), 0));
test('quantity', () => assert.equal(total([{price:100,quantity:3}]), 300));
test('multiple', () => assert.equal(total([{price:100,quantity:3},{price:20,quantity:2}]), 340));\n`,
  );
  writeFileSync(
    join(cwd, "AGENTS.md"),
    "このrepoの規約: cart.test.jsは変更しない。\n",
  );
  writeFileSync(
    join(cwd, ".beethoven/harness.json"),
    JSON.stringify({
      schemaVersion: 1,
      requirements: [{ id: "tests", stage: "verify", required: true }],
      checks: [
        {
          id: "tests",
          stage: "verify",
          argv: [process.execPath, "--test"],
          cwd: ".",
          timeoutMs: 3000,
          requiredEnv: [],
          acceptanceIds: ["AC-01"],
        },
      ],
    }),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const configFile = join(dir, "config/config.json");
  mkdirSync(join(dir, "config"));
  writeFileSync(
    configFile,
    JSON.stringify({
      schemaVersion: 1,
      permission: "workspace-write",
      allowedConnections: ["fixture"],
      maxTokens: 100000,
    }),
  );
  const faux = fauxProvider({
    provider: "fixture",
    models: [
      { id: "fixture", maxTokens: 4096 },
      { id: "fixture2", maxTokens: 4096 },
    ],
    tokensPerSecond: Infinity,
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Fixture",
        resolve: async () => ({ auth: { apiKey: "test-only" } }),
      },
    },
  });
  const options: AgentOptions = {
    cwd,
    configFile,
    stateDir: join(dir, "state"),
    send: true,
    runtime,
    connection: {
      id: "fixture",
      provider: "fixture",
      model: "fixture",
      auth: { method: "api_key", credentialRef: "pi:fixture" },
      billing: { kind: "subscription" },
      quotaGroup: "fixture",
      limits: {
        maxTokens: 100000,
        maxDurationMs: 20000,
        maxAttempts: 1,
        maxConcurrency: 1,
        maxCostUsd: null,
      },
      status: "configured",
    },
    approve: async () => true,
    ask: async () => "回答",
  };
  return { dir, cwd, faux, options, git };
}
const tool = (name: string, args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("OpenRouter uses reported charges including zero, rejects fallback, and blocks continuation on missing cost", async (t) => {
  for (const cost of [0.0123, 0, null]) {
    const f = await fixture(t);
    const faux = fauxProvider({
      provider: "openrouter",
      models: [
        {
          id: "fixed-model",
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      tokensPerSecond: Infinity,
    });
    faux.setResponses([fauxAssistantMessage("調査しました。")]);
    f.options.connection.provider = "openrouter";
    f.options.connection.model = "fixed-model";
    f.options.connection.billing.kind = "metered";
    f.options.connection.limits.maxCostUsd = 1;
    f.options.planOnly = true;
    f.options.runtime!.registerNativeProvider({
      ...faux.provider,
      auth: {
        apiKey: {
          name: "Fixture",
          resolve: async () => ({ auth: { apiKey: "test-only" } }),
        },
      },
      streamSimple(model, context, options) {
        const output = createAssistantMessageEventStream();
        void (async () => {
          const payload = (await options?.onPayload?.(
            { model: model.id, provider: { allow_fallbacks: true } },
            model,
          )) as { provider: { allow_fallbacks: boolean } };
          assert.equal(payload.provider.allow_fallbacks, false);
          await options?.onProviderStreamEvent?.(
            { usage: cost === null ? {} : { cost } },
            model,
          );
          const source = faux.provider.streamSimple(model, context, options);
          for await (const event of source) output.push(event);
          output.end(await source.result());
        })();
        return output;
      },
    });
    const agent = await openAgent(f.options);
    try {
      const result = await agent.run("調査のみ");
      assert.equal(result.result.status, "completed");
      assert.equal(result.usage.unknown, cost === null);
      assert.equal(result.usage.meteredCostUsd, cost ?? 0);
      if (cost === null)
        await assert.rejects(
          agent.run("追加調査"),
          (e) =>
            e instanceof Error && "code" in e && e.code === "budget_blocked",
        );
    } finally {
      await agent.close();
    }
  }
});

test("real SDK loop edits, observes a failed check, fixes it, verifies, and continues the same session", async (t) => {
  const f = await fixture(t);
  let sawFailedCheck = false;
  f.faux.setResponses([
    (context) => {
      assert.ok(JSON.stringify(context).includes("このrepoの規約"));
      return tool("read", { path: "cart.js" });
    },
    tool("edit", {
      path: "cart.js",
      oldText: "item.price,",
      newText: "item.price * 2,",
    }),
    tool("verify", {}),
    (context) => {
      sawFailedCheck = context.messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.content.some(
            (content) =>
              content.type === "text" &&
              content.text.includes('"status":"fail"'),
          ),
      );
      return tool("edit", {
        path: "cart.js",
        oldText: "item.price * 2",
        newText: "item.price * item.quantity",
      });
    },
    tool("verify", {}),
    fauxAssistantMessage(
      "数量を反映し、3件のテストに合格しました。受入は未確認です。",
    ),
  ]);
  const agent = await openAgent(f.options);
  const result = await agent.run(
    "数量を反映し既存テストを通してください。cart.test.jsは変更しないでください。",
  );
  assert.equal(result.status, "completed");
  assert.equal(sawFailedCheck, true);
  assert.deepEqual(result.changedFiles, ["cart.js"]);
  assert.equal((result.verification as { status: string }).status, "pass");
  assert.ok(result.usage.tokens > 0);
  assert.equal(result.usage.costUsd, null);
  f.faux.appendResponses([
    tool("read", { path: "cart.js" }),
    fauxAssistantMessage("追加確認しました。"),
  ]);
  assert.equal(
    (await agent.run("変更内容を追加確認してください")).status,
    "completed",
  );
  await agent.close();
  const store = new SessionStore(f.options.stateDir);
  const saved = store.load(agent.id);
  store.close();
  assert.ok(saved.piFile && existsSync(saved.piFile));
  assert.equal(saved.status, "closed");
  const transcript = savedConversation(f.options.stateDir, agent.id);
  assert.deepEqual(
    transcript.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text),
    [
      "数量を反映し、3件のテストに合格しました。受入は未確認です。",
      "追加確認しました。",
    ],
  );
  assert.equal(transcript.messages.at(-1)!.model, "fixture");
  assert.deepEqual(transcript.warnings, []);
  assert.match(readFileSync(join(f.cwd, "cart.js"), "utf8"), /item.quantity/);
});

test("plan-only blocks edits and arbitrary shell even if the model requests them", async (t) => {
  const f = await fixture(t);
  const before = readFileSync(join(f.cwd, "cart.js"), "utf8");
  f.faux.setResponses([
    tool("read", { path: "cart.js" }),
    tool("edit", { path: "cart.js", oldText: "item.price", newText: "0" }),
    tool("shell", { command: "touch should-not-exist" }),
    fauxAssistantMessage("計画を示します。"),
  ]);
  const agent = await openAgent(f.options);
  const result = await agent.run("計画のみ作ってください");
  assert.equal(result.status, "completed");
  assert.equal(readFileSync(join(f.cwd, "cart.js"), "utf8"), before);
  assert.equal(existsSync(join(f.cwd, "should-not-exist")), false);
  assert.ok(result.result.toolErrors >= 2);
  await agent.close();
});

test("resume reloads external edits and retains the same rules; noninteractive questions are saved as blocked", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("調査しました。")]);
  const first = await openAgent({ ...f.options, planOnly: true });
  await first.run("調査のみ");
  await first.close();
  writeFileSync(
    join(f.cwd, "cart.js"),
    "// 外部編集\n" + readFileSync(join(f.cwd, "cart.js"), "utf8"),
  );
  f.faux.appendResponses([
    tool("read", { path: "cart.js" }),
    (context) => {
      assert.ok(JSON.stringify(context).includes("外部編集"));
      return tool("ask_user", { question: "対象の数量は整数ですか？" });
    },
  ]);
  const resumed = await openAgent({
    ...f.options,
    resume: first.id,
    ask: async () => null,
  });
  assert.equal(resumed.info().changedSinceSave, true);
  const result = await resumed.run("現在のfileを確認してください");
  assert.equal(result.status, "blocked");
  assert.match(resumed.info().pending!.message, /数量/);
  await resumed.close();
});

test("dirty edits require approval and are preserved when noninteractive approval is unavailable", async (t) => {
  const f = await fixture(t);
  const file = join(f.cwd, "cart.js");
  const dirty = "// 本人の未commit変更\n" + readFileSync(file, "utf8");
  writeFileSync(file, dirty);
  f.faux.setResponses([
    tool("read", { path: "cart.js" }),
    tool("edit", { path: "cart.js", oldText: "item.price", newText: "0" }),
  ]);
  const agent = await openAgent({ ...f.options, approve: async () => false });
  const result = await agent.run("修正してください");
  assert.equal(result.status, "blocked");
  assert.equal(readFileSync(file, "utf8"), dirty);
  assert.equal(agent.info().pending?.type, "approval");
  await agent.close();
});

test("read-only policy and persisted edit scope cannot be bypassed by model requests or resume", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("shell", { command: "touch escape" }),
    tool("write", { path: "escape", content: "bad" }),
    fauxAssistantMessage("調査結果です。"),
  ]);
  const first = await openAgent({
    ...f.options,
    overrides: { permission: "read-only" },
    allowedPaths: ["cart.js"],
  });
  const result = await first.run("調査してください");
  assert.ok(result.result.toolErrors >= 2);
  assert.equal(existsSync(join(f.cwd, "escape")), false);
  await first.close();
  await assert.rejects(
    openAgent({
      ...f.options,
      resume: first.id,
      allowedPaths: ["cart.test.js"],
    }),
    /scope/,
  );
});

test("a rules change requires fresh resume approval and preflight failure prevents any model call", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("計画です。")]);
  const first = await openAgent({ ...f.options, planOnly: true });
  await first.run("計画のみ");
  await first.close();
  writeFileSync(join(f.cwd, "AGENTS.md"), "新版の規約\n");
  await assert.rejects(
    openAgent({ ...f.options, resume: first.id, approve: async () => false }),
    /snapshot/,
  );

  const second = await fixture(t);
  writeFileSync(
    join(second.cwd, ".beethoven/harness.json"),
    JSON.stringify({
      schemaVersion: 1,
      requirements: [{ id: "pre", stage: "preflight", required: true }],
      checks: [
        {
          id: "pre",
          stage: "preflight",
          argv: [process.execPath, "-e", "process.exit(1)"],
          cwd: ".",
          timeoutMs: 1000,
          requiredEnv: [],
          acceptanceIds: [],
        },
      ],
    }),
  );
  const agent = await openAgent(second.options);
  const report = await agent.run("実装してください");
  assert.equal(report.status, "blocked");
  assert.equal(second.faux.state.callCount, 0);
  await agent.close();
});

test("external edits after read are rejected without overwriting the new content", async (t) => {
  const f = await fixture(t);
  const file = join(f.cwd, "cart.js");
  f.faux.setResponses([
    tool("read", { path: "cart.js" }),
    () => {
      writeFileSync(file, "// 外部編集\n" + readFileSync(file, "utf8"));
      return tool("edit", {
        path: "cart.js",
        oldText: "item.price",
        newText: "0",
      });
    },
    fauxAssistantMessage("外部編集があるため再読込が必要です。"),
  ]);
  const agent = await openAgent(f.options);
  const result = await agent.run("修正してください");
  assert.ok(result.result.toolErrors > 0);
  assert.match(readFileSync(file, "utf8"), /外部編集/);
  assert.match(readFileSync(file, "utf8"), /item.price,/);
  await agent.close();
});

test("manual compaction retains rules and usage across the next turn", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage("長い調査記録です。".repeat(1600)),
    fauxAssistantMessage("次の長い調査記録です。".repeat(1600)),
    fauxAssistantMessage(
      "## Goal\n調査を継続する。\n## Constraints\n規約・既存変更・課金境界を維持する。\n## Progress\n調査済み。",
    ),
    fauxAssistantMessage(
      "## Original Request\n調査を継続する。\n## Progress So Far\n調査済み。\n## Context Needed to Continue\n既存規約と変更を維持する。",
    ),
  ]);
  const agent = await openAgent({ ...f.options, planOnly: true });
  assert.equal((await agent.run("/compact")).status, "completed");
  assert.equal(f.faux.state.callCount, 0, "小さい会話の圧縮はモデルを呼ばない");
  await agent.run("調査のみ");
  await agent.run("続けて調査のみ");
  const before = agent.info().usage.tokens;
  const compacted = await agent.run("/compact");
  assert.equal(compacted.status, "completed");
  assert.ok(agent.info().usage.tokens > before);
  f.faux.appendResponses([
    (context) => {
      assert.ok(JSON.stringify(context).includes("このrepoの規約"));
      return fauxAssistantMessage("圧縮後も同じ規約で継続します。");
    },
  ]);
  assert.equal((await agent.run("調査を再開")).status, "completed");
  await agent.close();
});

test("abort stops an owned shell, confirms settlement, and returns to the same conversation", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("shell", { command: "sleep 30" }),
    fauxAssistantMessage("中断後も会話を継続できました。"),
  ]);
  const agent = await openAgent(f.options);
  const result = await agent.run("待機コマンドを実行", {
    onEvent: (event) => {
      if (event.type === "tool_start" && event.name === "shell")
        setTimeout(() => agent.abort(), 50);
    },
  });
  assert.equal(result.status, "aborted");
  assert.equal(result.result.settled, true);
  const store = new SessionStore(f.options.stateDir);
  assert.deepEqual(store.pendingProcesses(agent.id), []);
  store.close();
  assert.equal(
    (await agent.run("調査のみで会話を継続してください")).status,
    "completed",
  );
  await agent.close();
});

test("verification evidence and harness approval expire after source changes", async (t) => {
  const f = await fixture(t);
  let allow = true;
  f.faux.setResponses([
    tool("read", { path: "cart.js" }),
    tool("edit", {
      path: "cart.js",
      oldText: "item.price,",
      newText: "item.price * item.quantity,",
    }),
    tool("verify", {}),
    fauxAssistantMessage("検証済みです。"),
  ]);
  const agent = await openAgent({ ...f.options, approve: async () => allow });
  const first = await agent.run("数量を反映して検証してください");
  assert.equal((first.verification as { status: string }).status, "pass");
  allow = false;
  f.faux.appendResponses([
    tool("read", { path: "cart.js" }),
    tool("edit", { path: "cart.js", oldText: "item.quantity", newText: "2" }),
    tool("verify", {}),
  ]);
  const second = await agent.run("実装を変更して再検証してください");
  assert.equal(second.status, "blocked");
  assert.equal(second.blockedReason, "harness_blocked");
  assert.notEqual(first.afterHash, second.afterHash);
  await agent.close();
});

test("an explicit model change preserves history, rules and prior usage without automatic fallback", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("変更前の調査結果です。")]);
  const first = await openAgent({ ...f.options, planOnly: true });
  const oldReport = await first.run("調査のみ");
  const previous = first.info();
  await first.close();
  const next = { ...f.options.connection, model: "fixture2" };
  await assert.rejects(
    openAgent({
      ...f.options,
      connection: next,
      resume: first.id,
      approve: async () => false,
    }),
    /接続・model/,
  );
  f.faux.appendResponses([
    (context) => {
      assert.ok(JSON.stringify(context).includes("変更前の調査結果"));
      assert.ok(JSON.stringify(context).includes("このrepoの規約"));
      return fauxAssistantMessage("同じ会話を別modelで継続しました。");
    },
  ]);
  const second = await openAgent({
    ...f.options,
    connection: next,
    resume: first.id,
    switchConnection: true,
  });
  assert.equal(second.info().model, "fixture2");
  assert.equal(second.info().rulesHash, previous.rulesHash);
  const result = await second.run("続けて調査してください");
  assert.equal(result.status, "completed");
  assert.equal(oldReport.execution.model, "fixture");
  assert.equal(result.execution.model, "fixture2");
  assert.ok(second.info().usage.tokens > previous.usage.tokens);
  await second.close();
});

test("a resumed conversation gets a fresh Turn deadline while preserving the Session total limit", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("調査結果です。")]);
  const first = await openAgent({ ...f.options, planOnly: true });
  await first.run("調査のみ");
  await first.close();
  let store = new SessionStore(f.options.stateDir);
  const saved = store.load(first.id);
  saved.elapsedMs = f.options.connection.limits.maxDurationMs + 1;
  store.save(saved, "fixture_elapsed");
  store.close();
  f.faux.appendResponses([
    fauxAssistantMessage("新しいTurnとして継続しました。"),
  ]);
  const resumed = await openAgent({ ...f.options, resume: first.id });
  assert.equal((await resumed.run("調査を続けてください")).status, "completed");
  await resumed.close();
  store = new SessionStore(f.options.stateDir);
  const exhausted = store.load(first.id);
  exhausted.elapsedMs = 600000;
  store.save(exhausted, "fixture_exhausted");
  store.close();
  const stopped = await openAgent({ ...f.options, resume: first.id });
  await assert.rejects(stopped.run("調査を続ける"), /予算/);
  await stopped.close();
});

test("search yields to cancellation and bounds rules checks while preserving its change gate", async (t) => {
  const { codingTools } = await import("../src/tools.js");
  const f = await fixture(t);
  for (let i = 0; i < 250; i++)
    writeFileSync(join(f.cwd, `search-${i}.txt`), "ordinary fixture\n");
  let checks = 0;
  const cancellation = new AbortController();
  const tools = codingTools({
    cwd: f.cwd,
    stateDir: f.options.stateDir,
    permission: "read-only",
    planOnly: () => true,
    assertCurrent: () => {
      checks++;
    },
    remainingMs: () => 20000,
    approve: async () => false,
    ask: async () => null,
    verify: async () => ({}),
    blocked() {},
    event() {},
  });
  const search = tools.find((tool) => tool.name === "search")!;
  setImmediate(() => cancellation.abort());
  const stopped = await search.execute(
    "search-cancel",
    { query: "missing" },
    cancellation.signal,
    undefined,
    {} as never,
  );
  assert.equal(stopped.isError, true);
  assert.ok(checks < 20);
  checks = 0;
  const done = await search.execute(
    "search-complete",
    { query: "ordinary" },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(done.isError, false);
  assert.ok(checks < 20);
  assert.ok(
    done.content.some(
      (content) =>
        content.type === "text" && content.text.includes("ordinary fixture"),
    ),
  );
});

test("context-window admission rejects oversized inputs before provider dispatch and exposes a distinct reason", async (t) => {
  const f = await fixture(t);
  const limited = fauxProvider({
    provider: "fixture",
    models: [{ id: "fixture", contextWindow: 256, maxTokens: 128 }],
    tokensPerSecond: Infinity,
  });
  limited.setResponses([fauxAssistantMessage("This must not be requested.")]);
  f.options.runtime!.registerNativeProvider({
    ...limited.provider,
    auth: {
      apiKey: {
        name: "Fixture",
        resolve: async () => ({ auth: { apiKey: "test-only" } }),
      },
    },
  });
  const agent = await openAgent({ ...f.options, planOnly: true });
  const result = await agent.run("調査のみ");
  assert.equal(result.status, "blocked");
  assert.equal(result.blockedReason, "context_limit");
  assert.equal(limited.state.callCount, 0);
  assert.equal(result.usage.tokens, 0);
  assert.equal(result.usage.unknown, false);
  assert.ok(agent.info().context.pressure! >= 1);
  await agent.close();
});

test("identical failed tools stop the model loop and a fresh user turn gets a fresh failure counter", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses(
    [0, 1, 2, 3].map(() => tool("read", { path: "does-not-exist.js" })),
  );
  const agent = await openAgent({ ...f.options, planOnly: true });
  const result = await agent.run("調査のみ");
  assert.equal(result.blockedReason, "tool_loop_detected");
  assert.equal(f.faux.state.callCount, 4);
  f.faux.setResponses([
    tool("read", { path: "does-not-exist.js" }),
    fauxAssistantMessage("不足を確認しました。"),
  ]);
  const next = await agent.run("不足しているfileを改めて確認してください");
  assert.equal(next.status, "completed");
  await agent.close();
});

test("natural-language delegation proposes a validated plan and settles without spawning or granting authority", async (t) => {
  const f = await fixture(t);
  f.options.allowDelegation = true;
  const plan = {
    schemaVersion: 1,
    maxConcurrency: 1,
    maxTokens: 10000,
    maxCostUsd: 0,
    maxDurationMs: 10000,
    tasks: [
      {
        id: "A",
        prompt: "数量計算を修正",
        connection: "fixture",
        scope: ["cart.js"],
        dependsOn: [],
        resources: [],
        priority: 0,
        maxTokens: 10000,
        maxCostUsd: 0,
        maxAttempts: 1,
      },
    ],
  };
  f.faux.setResponses([
    tool("propose_plan", { plan: JSON.stringify(plan) }),
    fauxAssistantMessage("この応答を要求してはいけない"),
  ]);
  const agent = await openAgent(f.options);
  try {
    const result = await agent.run("Workerに委譲する計画を作ってください");
    assert.equal(result.proposedPlan?.tasks[0]!.id, "A");
    assert.equal(result.proposalOnly, false);
    assert.equal(result.status, "completed");
    assert.match(readFileSync(join(f.cwd, "cart.js"), "utf8"), /item.price, 0/);
    const store = new SessionStore(f.options.stateDir);
    try {
      assert.equal(store.providerProgress(agent.id).requests, 1);
    } finally {
      store.close();
    }
  } finally {
    await agent.close();
  }
});

test("resume retains an interrupted native request as unknown reservation exactly once", async (t) => {
  const f = await fixture(t);
  f.options.planOnly = true;
  f.faux.setResponses([fauxAssistantMessage("読取結果")]);
  const agent = await openAgent(f.options);
  await agent.run("調査のみ");
  await agent.close();
  const db = new SessionStore(f.options.stateDir);
  let before: number;
  try {
    const saved = db.load(agent.id);
    before = saved.tokens;
    saved.pendingRequest = {
      id: "interrupted-request",
      tokens: 321,
      costUsd: 0,
    };
    db.save(saved, "provider_request", { requestId: "interrupted-request" });
  } finally {
    db.close();
  }
  for (let i = 0; i < 2; i++) {
    const resumed = await openAgent({ ...f.options, resume: agent.id });
    try {
      assert.equal(resumed.info().usage.tokens, before);
      assert.equal(resumed.info().usage.reservedUnknownTokens, 321);
      assert.equal(resumed.info().usage.unknown, true);
    } finally {
      await resumed.close();
    }
  }
});
