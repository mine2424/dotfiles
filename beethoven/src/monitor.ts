import { existsSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "./session.js";
import { RunStore } from "./run-store.js";
import { listWorkers } from "./worker.js";
export type MonitorNode = {
  id: string;
  kind: "session" | "run" | "task" | "worker";
  title: string;
  cwd: string;
  status: string;
  model?: string;
  pid?: number;
  live: "live" | "unknown" | "stopped" | "saved";
  parent?: string;
  detail?: string;
};
export type MonitorSnapshot = {
  nodes: MonitorNode[];
  edges: { from: string; to: string; kind: string }[];
  updatedAt: string;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
  }
};
/** 保存状態とprocess/heartbeatを分けて表示する。PIDだけで稼働中・復旧可能と断定しない。 */
export function monitorSnapshot(stateDir: string): MonitorSnapshot {
  const snapshot: MonitorSnapshot = {
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
  };
  if (!existsSync(join(stateDir, "state.sqlite"))) return snapshot;
  const store = new SessionStore(stateDir, { readOnly: true });
  try {
    const titles = new Map(
      store
        .recentSessions()
        .map((row) => [String(row.id), String(row.title ?? "対話セッション")]),
    );
    const executions = new Map(
      store.recentSessions().map((row) => [String(row.id), row]),
    );
    for (const data of store.runtimeSessions()) {
      const runtime = data.runtime,
        process = runtime ? alive(runtime.pid) : false,
        fresh = runtime && Date.now() - Date.parse(runtime.updatedAt) < 6000;
      snapshot.nodes.push({
        id: data.id,
        kind: "session",
        title: titles.get(data.id) ?? "対話セッション",
        cwd: data.cwd,
        status: data.activeRun
          ? "delegated"
          : runtime && data.status === "responding"
            ? runtime.stage
            : data.status,
        model: runtime
          ? `${runtime.provider}/${runtime.model}`
          : executions.get(data.id)?.model
            ? `${executions.get(data.id)!.provider}/${executions.get(data.id)!.model}`
            : `接続: ${data.connectionId}`,
        pid: runtime?.pid,
        live: runtime
          ? process === true && fresh
            ? "live"
            : process === false
              ? "stopped"
              : "unknown"
          : "saved",
        detail: `${data.tokens} token${data.usageUnknown ? " · 欠測あり" : ""}`,
      });
    }
  } finally {
    store.close();
  }
  const runs = new RunStore(stateDir, true);
  try {
    for (const run of runs.list()) {
      const process = run.ownerPid ? alive(run.ownerPid) : false;
      snapshot.nodes.push({
        id: run.id,
        kind: "run",
        title: `Run ${run.id.slice(0, 8)}`,
        cwd: run.cwd,
        status: run.status,
        pid: run.ownerPid,
        live: run.ownerPid
          ? process === true
            ? "live"
            : process === false
              ? "stopped"
              : "unknown"
          : "saved",
        detail: `${run.plan.tasks.length} tasks · 並列上限 ${run.plan.maxConcurrency}`,
      });
      if (run.parentSession)
        snapshot.edges.push({
          from: run.parentSession,
          to: run.id,
          kind: "delegates",
        });
      for (const task of run.plan.tasks) {
        const state = run.tasks[task.id]!;
        const id = run.id + ":" + task.id;
        let worker =
          state.stateDir && state.workerId
            ? listWorkers(state.stateDir).find((w) => w.id === state.workerId)
            : undefined;
        snapshot.nodes.push({
          id,
          kind: "task",
          title: task.prompt.slice(0, 160),
          cwd: run.integration,
          status: state.status,
          model: worker
            ? `${worker.provider}/${worker.model}`
            : `接続: ${task.connection}`,
          pid: worker?.pid,
          live:
            state.status === "running"
              ? worker?.liveness === "live"
                ? "live"
                : "unknown"
              : "saved",
          parent: run.id,
          detail: `${task.id} · ${state.tokens}/${task.maxTokens} token${state.reason ? " · " + state.reason : ""}`,
        });
        snapshot.edges.push({ from: run.id, to: id, kind: "owns" });
        for (const dep of task.dependsOn)
          snapshot.edges.push({
            from: run.id + ":" + dep.task,
            to: id,
            kind: dep.kind,
          });
      }
    }
  } finally {
    runs.close();
  }
  for (const worker of listWorkers(stateDir))
    snapshot.nodes.push({
      id: worker.id,
      kind: "worker",
      title: worker.detail ?? `Worker ${worker.id.slice(0, 8)}`,
      cwd: worker.directory,
      status: worker.stage,
      model: `${worker.provider}/${worker.model}`,
      pid: worker.pid,
      live:
        worker.liveness === "live"
          ? "live"
          : worker.liveness === "process_absent"
            ? "stopped"
            : worker.liveness
              ? "unknown"
              : "saved",
    });
  return snapshot;
}
