import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executeRun } from "../src/orchestrator.js";
import { runWorker } from "../src/worker.js";
const options = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
await executeRun({
  ...options,
  approve: async () => true,
  onTask: (taskId: string, state: any) => {
    if (state.pid)
      process.send?.({ taskId, pid: state.pid, stage: state.stage });
  },
  worker: (workerOptions: any) =>
    runWorker({
      ...workerOptions,
      entry: fileURLToPath(new URL("./run-worker-child.js", import.meta.url)),
    }),
});
if (process.connected) process.disconnect();
