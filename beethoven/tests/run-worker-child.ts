import { readFileSync } from "node:fs";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { workerMain } from "../src/worker-entry.js";
const manifest = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const task = String(manifest.task).split("\n")[0]!,
  path = task.toLowerCase() + ".js";
const faux = fauxProvider({
  provider: "fixture",
  models: [{ id: "fixture", maxTokens: 4096 }],
  tokensPerSecond: Infinity,
});
faux.setResponses([
  (context) => {
    if (task === "B" && !readFileSync("a.js", "utf8").includes("two"))
      throw new Error("dependency not integrated");
    return fauxAssistantMessage(fauxToolCall("read", { path }), {
      stopReason: "toolUse",
    });
  },
  fauxAssistantMessage(
    fauxToolCall("edit", { path, oldText: "one", newText: "two" }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("実装しました。"),
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
await workerMain(process.argv[2]!, runtime);
