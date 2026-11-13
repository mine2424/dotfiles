import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hash } from "./workspace.js";
import { acquireLock } from "./files.js";
import { SetupError } from "./connections.js";
export type Task = {
  id: string;
  prompt: string;
  connection: string;
  scope: string[];
  dependsOn: { task: string; kind: "code" | "acceptance" }[];
  resources: string[];
  priority: number;
  maxTokens: number;
  maxCostUsd: number;
  maxAttempts: number;
  role?: "implementer" | "explorer" | "reviewer";
};
export type Plan = {
  schemaVersion: 1;
  maxConcurrency: number;
  maxTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
  tasks: Task[];
};
export type TaskState = {
  usageUnknown?: boolean;
  unknownTokens?: number;
  resume?: boolean;
  status:
    | "pending"
    | "running"
    | "waiting_input"
    | "candidate"
    | "integrated"
    | "accepted"
    | "failed"
    | "blocked"
    | "interrupted";
  attempts: number;
  starts: number;
  tokens: number;
  costUsd: number;
  reason?: string;
  workerId?: string;
  parentId?: string;
  stateDir?: string;
  candidate?: string;
  base?: string;
  integrated?: string;
  acceptedSha?: string;
  pendingId?: string;
  answer?: string;
};
export type Effect = {
  id: string;
  taskId?: string;
  type: "worktree" | "worker" | "commit" | "integrate";
  status: "planned" | "executing" | "succeeded" | "unknown";
  before?: string;
  after?: string;
  epoch: number;
};
export type Run = {
  id: string;
  cwd: string;
  repoId: string;
  integration: string;
  configFile: string;
  plan: Plan;
  rulesHash: string;
  version: number;
  epoch: number;
  ownerPid?: number;
  stop: boolean;
  status: string;
  createdAt: string;
  startedAt: number;
  elapsedMs?: number;
  tasks: Record<string, TaskState>;
  effects: Effect[];
  snapshot?: string;
  integrationSha?: string;
  parentSession?: string;
  parentPermission?: "read-only" | "workspace-write";
  parentPlanOnly?: boolean;
  humanAccepted: boolean;
  restoredFrom?: {
    snapshotId: string;
    requiresReview: boolean;
    workspaceHash: string;
    rulesHash?: string;
  };
  revisions?: {
    plan: Plan;
    tasks: Record<string, TaskState>;
    createdAt: string;
  }[];
  verifications?: {
    taskId: string;
    stage: string;
    sha: string;
    evidence: unknown;
    createdAt: string;
  }[];
};
/** 状態・commandの重複排除・資源予約をSQLite transactionで確定する。transaction中は外部処理をしない。 */
export class RunStore {
  private db: DatabaseSync;
  constructor(
    private stateDir: string,
    readOnly = false,
  ) {
    this.db = new DatabaseSync(join(stateDir, "state.sqlite"), {
      readOnly,
      timeout: 1000,
    });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
  }
  close() {
    this.db.close();
  }
  get(id: string): Run {
    const row = this.db.prepare("SELECT document FROM runs WHERE id=?").get(id);
    if (!row) throw new SetupError("Runがありません。");
    return JSON.parse(String(row.document));
  }
  list() {
    return this.db
      .prepare("SELECT document FROM runs ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(String(row.document)) as Run);
  }
  create(run: Run) {
    this.db
      .prepare("INSERT INTO runs VALUES(?,?)")
      .run(run.id, JSON.stringify(run));
  }
  update(id: string, change: (run: Run) => void, epoch?: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.get(id);
      if (epoch !== undefined && run.epoch !== epoch)
        throw new SetupError("旧ownerEpochです。");
      change(run);
      run.version++;
      this.db
        .prepare("UPDATE runs SET document=? WHERE id=?")
        .run(JSON.stringify(run), id);
      this.db.exec("COMMIT");
      return run;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  command(
    id: string,
    requestId: string,
    expectedVersion: number,
    command: Parameters<RunStore["applyCommand"]>[3],
  ) {
    const release = acquireLock(this.stateDir);
    try {
      return this.applyCommand(id, requestId, expectedVersion, command);
    } finally {
      release();
    }
  }
  private applyCommand(
    id: string,
    requestId: string,
    expectedVersion: number,
    command: {
      type: "stop" | "answer" | "accept" | "retry" | "continue";
      taskId?: string;
      answer?: string;
      pendingId?: string;
      sha?: string;
    },
  ) {
    const inputHash = hash(JSON.stringify({ id, expectedVersion, command }));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare("SELECT input_hash,result FROM run_commands WHERE id=?")
        .get(requestId);
      if (previous) {
        if (previous.input_hash !== inputHash)
          throw new SetupError("同じcommand IDの内容が変わっています。");
        this.db.exec("COMMIT");
        return JSON.parse(String(previous.result)) as Run;
      }
      const run = this.get(id);
      if (run.version !== expectedVersion)
        throw new SetupError(
          "Runの版が変わりました。statusを確認してください。",
        );
      const task = command.taskId ? run.tasks[command.taskId] : undefined;
      if (command.type === "stop") {
        run.stop = true;
        run.status = run.ownerPid ? "stopping" : "interrupted";
      } else if (command.type === "answer") {
        if (
          !task ||
          task.status !== "waiting_input" ||
          !command.answer?.trim() ||
          command.pendingId !== task.pendingId
        )
          throw new SetupError("質問・回答先が一致しません。");
        task.answer = command.answer;
        task.status = "pending";
        run.status = "paused";
      } else if (command.type === "continue") {
        if (
          !task ||
          task.status !== "interrupted" ||
          !task.workerId ||
          task.starts >= 10
        )
          throw new SetupError("保存された中断Taskだけを継続できます。");
        task.resume = true;
        task.status = "pending";
        task.reason = undefined;
        run.status = "paused";
      } else if (command.type === "retry") {
        const spec = run.plan.tasks.find((item) => item.id === command.taskId);
        if (
          !task ||
          !spec ||
          !["failed", "blocked", "interrupted"].includes(task.status) ||
          task.attempts >= spec.maxAttempts ||
          task.starts >= 10
        )
          throw new SetupError("retryできないTaskです。");
        task.status = "pending";
        task.reason = undefined;
        task.resume = undefined;
        task.answer = undefined;
        task.workerId = undefined;
        task.parentId = undefined;
        run.status = "paused";
      } else {
        if (
          !task ||
          task.status !== "integrated" ||
          run.restoredFrom?.requiresReview ||
          task.reason === "recovered_requires_verify" ||
          command.sha !== run.integrationSha
        )
          throw new SetupError("現在の統合SHAに対する受入が必要です。");
        const spec = run.plan.tasks.find((t) => t.id === command.taskId);
        if (!spec?.role || spec.role === "implementer") {
          const verified = run.verifications?.some(
            (v) =>
              v.stage === "integration" &&
              v.sha === run.integrationSha &&
              Array.isArray(v.evidence) &&
              v.evidence.length &&
              v.evidence.every((e: any) => e.status === "pass"),
          );
          if (!verified)
            throw new SetupError("現在の統合SHAの独立検証がありません。");
        }
        task.status = "accepted";
        task.acceptedSha = command.sha;
        run.humanAccepted = Object.values(run.tasks).every(
          (item) => item.status === "accepted",
        );
        if (run.humanAccepted) run.status = "completed";
      }
      run.version++;
      this.db
        .prepare("UPDATE runs SET document=? WHERE id=?")
        .run(JSON.stringify(run), id);
      this.db
        .prepare("INSERT INTO run_commands VALUES(?,?,?,?)")
        .run(requestId, id, inputHash, JSON.stringify(run));
      this.db
        .prepare(
          "INSERT INTO events(id,type,payload,created_at) VALUES(?,?,?,?)",
        )
        .run(
          requestId,
          "run_command",
          JSON.stringify({ runId: id, command, version: run.version }),
          new Date().toISOString(),
        );
      this.db.exec("COMMIT");
      return run;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  acquireOwner(id: string) {
    return this.update(id, (run) => {
      const owner = this.db
        .prepare("SELECT * FROM owners WHERE target_id=?")
        .get(run.repoId);
      if (owner)
        throw new SetupError(
          "repoのController所有権が残っています。停止・明示復旧を確認してください。",
        );
      run.epoch++;
      run.ownerPid = process.pid;
      run.stop = false;
      run.status = "running";
      this.db
        .prepare("INSERT INTO owners VALUES(?,?,?,?,?)")
        .run(
          run.repoId,
          run.id,
          run.epoch,
          process.pid,
          new Date().toISOString(),
        );
    });
  }
  heartbeat(id: string, epoch: number) {
    const run = this.get(id);
    const result = this.db
      .prepare(
        "UPDATE owners SET heartbeat_at=? WHERE target_id=? AND token=? AND epoch=? AND pid=?",
      )
      .run(new Date().toISOString(), run.repoId, id, epoch, process.pid);
    if (result.changes !== 1)
      throw new SetupError("Controller所有権を失いました。");
  }
  releaseOwner(id: string, epoch: number) {
    return this.update(
      id,
      (run) => {
        this.db
          .prepare(
            "DELETE FROM owners WHERE target_id=? AND token=? AND epoch=? AND pid=?",
          )
          .run(run.repoId, id, epoch, process.pid);
        delete run.ownerPid;
        run.epoch++;
      },
      epoch,
    );
  }
  reserve(
    id: string,
    taskId: string,
    epoch: number,
    group: string,
    groupLimit: number,
    resources: string[],
    tokens: number,
    cost: number,
  ) {
    if (
      !Number.isSafeInteger(tokens) ||
      tokens < 1 ||
      !Number.isFinite(cost) ||
      cost < 0 ||
      !Number.isSafeInteger(groupLimit) ||
      groupLimit < 1 ||
      groupLimit > 4
    )
      throw new SetupError("予約の上限が不正です。");
    let admitted = false;
    const run = this.update(
      id,
      (run) => {
        if (run.stop || run.tasks[taskId]!.status !== "pending") return;
        const reservations = this.db
          .prepare("SELECT * FROM run_reservations")
          .all();
        const models = this.db
          .prepare(
            "SELECT target_id FROM owners WHERE target_id LIKE 'model:%'",
          )
          .all();
        const manual = this.db
          .prepare(
            "SELECT payload FROM session_documents WHERE json_type(payload,'$.activeWorker')='object'",
          )
          .all()
          .map((row) => JSON.parse(String(row.payload)).activeWorker);
        if (reservations.length + models.length + manual.length >= 4) {
          run.tasks[taskId]!.reason = "host_capacity_wait";
          return;
        }
        const groupModels = models.filter((row) =>
            String(row.target_id).startsWith(
              `model:${encodeURIComponent(group)}:`,
            ),
          ),
          groupManual = manual.filter(
            (worker) => !worker.quotaGroup || worker.quotaGroup === group,
          );
        const shared = reservations.filter((row) => row.quota_group === group),
          effectiveLimit = Math.min(
            groupLimit,
            ...groupModels.map(
              (row) => Number(String(row.target_id).split(":")[2]) || 1,
            ),
            ...groupManual.map((worker) => worker.quotaLimit ?? 1),
            ...shared.map((row) => {
              const values = JSON.parse(String(row.resources)) as string[];
              const metadata = values.find((value) =>
                value.startsWith("@quota/"),
              );
              const limit = metadata ? Number(metadata.split("/").at(-1)) : 1;
              return Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
            }),
          );
        if (
          reservations.filter((row) => row.quota_group === group).length +
            groupModels.length +
            groupManual.length >=
            effectiveLimit ||
          reservations.some((row) =>
            (JSON.parse(String(row.resources)) as string[]).some((resource) =>
              resources.some(
                (wanted) =>
                  wanted === resource ||
                  (wanted.startsWith("path:") &&
                    resource.startsWith("path:") &&
                    (wanted.startsWith(resource + "/") ||
                      resource.startsWith(wanted + "/"))),
              ),
            ),
          )
        ) {
          run.tasks[taskId]!.reason = "quota_or_resource_wait";
          return;
        }
        const own = reservations.filter((row) => row.run_id === id),
          used = Object.values(run.tasks).reduce((sum, t) => sum + t.tokens, 0),
          spent = Object.values(run.tasks).reduce(
            (sum, t) => sum + t.costUsd,
            0,
          );
        if (
          own.length >= run.plan.maxConcurrency ||
          used + own.reduce((sum, r) => sum + Number(r.tokens), 0) + tokens >
            run.plan.maxTokens ||
          spent + own.reduce((sum, r) => sum + Number(r.cost_usd), 0) + cost >
            run.plan.maxCostUsd
        ) {
          run.tasks[taskId]!.reason = "concurrency_or_budget_wait";
          return;
        }
        this.db
          .prepare("INSERT INTO run_reservations VALUES(?,?,?,?,?,?)")
          .run(
            id,
            taskId,
            group,
            tokens,
            cost,
            JSON.stringify(
              [...resources]
                .sort()
                .concat(
                  "@quota/" + encodeURIComponent(group) + "/" + groupLimit,
                ),
            ),
          );
        const task = run.tasks[taskId]!;
        task.reason = undefined;
        task.status = "running";
        task.starts++;
        if (!task.answer && !task.resume) task.attempts++;
        admitted = true;
      },
      epoch,
    );
    return { admitted, run };
  }
  settle(
    id: string,
    taskId: string,
    epoch: number,
    change: (task: TaskState) => void,
  ) {
    return this.update(
      id,
      (run) => {
        change(run.tasks[taskId]!);
        this.db
          .prepare("DELETE FROM run_reservations WHERE run_id=? AND task_id=?")
          .run(id, taskId);
      },
      epoch,
    );
  }
  effect(id: string, epoch: number, effect: Omit<Effect, "id" | "epoch">) {
    const record = { ...effect, id: randomUUID(), epoch };
    this.update(id, (run) => run.effects.push(record), epoch);
    return record.id;
  }
  receipt(id: string, epoch: number, effectId: string, after?: string) {
    this.update(
      id,
      (run) => {
        const effect = run.effects.find((e) => e.id === effectId);
        if (!effect || effect.epoch !== epoch)
          throw new SetupError("effect世代が違います。");
        effect.status = "succeeded";
        effect.after = after;
      },
      epoch,
    );
  }
}
