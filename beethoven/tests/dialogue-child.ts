/** PTY-only fixture: actual SDK, scripted model, no real provider credentials or requests. */
import { paths } from "../src/config.js";
import { runDialogue } from "../src/dialogue.js";
import { executeRun } from "../src/orchestrator.js";
import { openAgent } from "../src/agent.js";
import { runWorker } from "../src/worker.js";
import { fileURLToPath } from "node:url";
import { SetupError } from "../src/connections.js";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const scenario = process.argv[2] ?? "success";
const faux = fauxProvider({
  provider: "fixture",
  models: [{ id: "fixture", maxTokens: 4096 }],
  tokensPerSecond: Infinity,
});
faux.setResponses([
  fauxAssistantMessage("最初の応答です。"),
  fauxAssistantMessage("追加の応答です。"),
]);
if (scenario === "orchestration")
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("propose_plan", {
        plan: JSON.stringify({
          schemaVersion: 1,
          maxConcurrency: 1,
          maxTokens: 40000,
          maxCostUsd: 0,
          maxDurationMs: 20000,
          tasks: [
            {
              id: "A",
              prompt: "valueを変更",
              connection: "fixture",
              scope: ["value.txt"],
              dependsOn: [],
              resources: [],
              priority: 0,
              maxTokens: 30000,
              maxCostUsd: 0,
              maxAttempts: 1,
            },
          ],
        }),
      }),
      { stopReason: "toolUse" },
    ),
  ]);
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
let attempts = 0;
let openings = 0;
const openingFailure = scenario.startsWith("opening");
await runDialogue(
  paths(),
  openingFailure ? "開始失敗後に自動送信しない依頼" : "",
  { send: !openingFailure, resume: process.argv[3] },
  {},
  {
    executeRun: (options) =>
      executeRun({
        ...options,
        approve: async () => true,
        worker: (worker) =>
          runWorker({
            ...worker,
            entry: fileURLToPath(new URL("./worker-child.js", import.meta.url)),
          }),
      }),
    runWorker: (options) =>
      runWorker({
        ...options,
        entry: fileURLToPath(new URL("./worker-child.js", import.meta.url)),
      }),
    openAgent: async (options) => {
      if (openingFailure && openings++ === 0) {
        if (scenario === "opening-private")
          throw new Error("DO_NOT_RENDER_PRIVATE_TRANSPORT_BODY");
        throw new SetupError("試験用の会話開始エラーです。", "authentication_required");
      }
      const agent = await openAgent({ ...options, runtime });
      return {
        ...agent,
        run: async (...args) => {
          if (attempts++ === 0 && scenario === "budget")
            throw new SetupError("試験用の予算停止です。", "budget_blocked");
          if (attempts === 1 && scenario === "runtime")
            throw new Error("DO_NOT_RENDER_PRIVATE_TRANSPORT_BODY");
          return agent.run(...args);
        },
      };
    },
  },
);
