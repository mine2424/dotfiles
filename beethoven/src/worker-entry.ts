import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openAgent, type AgentOptions } from "./agent.js";
import type { WorkerManifest } from "./worker.js";

/** Private child entry; tests inject a scripted runtime, production always uses the selected connection. */
export async function workerMain(
  file: string,
  runtime?: AgentOptions["runtime"],
) {
  const manifest = JSON.parse(readFileSync(file, "utf8")) as WorkerManifest;
  const cancellation = new AbortController();
  let start!: () => void;
  const admission = new Promise<void>((resolve) => {
    start = resolve;
  });
  let sequence = 0;
  const pending = new Map<number, (answer: string | null) => void>();
  const send = (value: object) => {
    if (process.connected) process.send?.({ ...value, token: manifest.token });
  };
  let agent: Awaited<ReturnType<typeof openAgent>> | undefined;
  const cancel = () => {
    cancellation.abort();
    start();
    agent?.abort();
    for (const answer of pending.values()) answer(null);
    pending.clear();
  };
  process.on("disconnect", cancel);
  process.on("message", (message: any) => {
    if (message?.token !== manifest.token) return;
    if (message.type === "abort") cancel();
    if (message.type === "start") start();
    if (message.type === "answer") {
      pending.get(message.id)?.(
        typeof message.answer === "string" ? message.answer : null,
      );
      pending.delete(message.id);
    }
  });
  // import中に親が終了するとdisconnect eventを取り逃すため、現在のIPC状態も検査する。
  if (!process.connected) cancel();
  const question = (message: string, approval: boolean) =>
    manifest.parkQuestions && !approval
      ? Promise.resolve(null)
      : new Promise<string | null>((resolve) => {
          const id = ++sequence;
          pending.set(id, resolve);
          send({ type: "question", id, message, approval });
        });
  try {
    send({ type: "ready" });
    await admission;
    cancellation.signal.throwIfAborted();
    agent = await openAgent({
      ...manifest.options,
      runtime,
      send: true,
      approve: async (message, key) =>
        manifest.options.resume &&
        key === `resume-rules:${manifest.expectedRulesHash}`
          ? true
          : (await question(message, true)) === "yes",
      ask: (message) => question(message, false),
      cancelInput: cancel,
      onActivity: (activity) => send({ type: "activity", activity }),
    });
    cancellation.signal.throwIfAborted();
    send({ type: "session", id: agent.id });
    const report = await agent.run(manifest.task, {
      signal: cancellation.signal,
      onEvent: (event) => send({ type: "event", event }),
    });
    await agent.close();
    agent = undefined;
    send({ type: "result", report });
  } catch {
    try {
      await agent?.close();
    } catch {
      /* unresolved child lock remains evidence */
    }
    send({
      type: "failure",
      message: "Workerを完了できませんでした。保存記録を確認してください。",
    });
  } finally {
    if (process.connected) process.disconnect();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await workerMain(process.argv[2]!);
