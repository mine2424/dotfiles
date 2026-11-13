import { acquireRepoOwner, recoverRepoOwner } from "./ownership.js";
import { recoverModelSlots } from "./resources.js";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  readdirSync,
  appendFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentOptions, ExecutionActivity } from "./agent.js";
import type { TurnEvent } from "./pi.js";
import { acquireLock, privateDirectory, recoverLock } from "./files.js";
import { reapProcessGroup } from "./process.js";
import { SessionStore, type SessionData } from "./session.js";
import {
  git,
  hash,
  workspacePath,
  workspaceState,
  replaceFile,
} from "./workspace.js";
import { inspectRules } from "./rules.js";
import { SetupError } from "./connections.js";

type Usage = {
  tokens: number;
  costUsd: number;
  reservedUnknownTokens: number;
  elapsedMs: number;
  unknown: boolean;
};
export type WorkerManifest = {
  token: string;
  task: string;
  options: Omit<
    AgentOptions,
    "approve" | "ask" | "send" | "runtime" | "onActivity" | "cancelInput"
  >;
  parkQuestions?: boolean;
  expectedRulesHash?: string;
};
export type WorkerState = {
  id: string;
  stage: string;
  model: string;
  provider: string;
  directory: string;
  pid?: number;
  startedAt: number;
  updatedAt?: number;
  tokens?: number;
  detail?: string;
  continuations?: number;
  pending?: SessionData["pending"];
  liveness?: "live" | "process_absent" | "unknown";
};
type Job = {
  version: 1;
  id: string;
  parentId: string;
  connectionHash: string;
  sourceSnapshot: string;
  rulesContentHash: string;
  childSession?: string;
  continuations: number;
  permission: "read-only" | "workspace-write";
  createdAt: number;
};
type Report = Awaited<
  ReturnType<Awaited<ReturnType<typeof import("./agent.js").openAgent>>["run"]>
>;
export type WorkerOptions = {
  parentId: string;
  task: string;
  agent: Pick<
    AgentOptions,
    "cwd" | "stateDir" | "configFile" | "connection" | "trustRepo" | "overrides"
  >;
  resume?: string;
  replyTo?: string;
  parkQuestions?: boolean;
  onState: (state: WorkerState) => void;
  onEvent: (event: TurnEvent) => void;
  ask: (message: string, approval: boolean) => Promise<string | null>;
  signal?: AbortSignal;
  cancelInput?: () => void;
  /** Test-only child entry, never exposed by CLI. */ entry?: string;
};
const zeroUsage = (): Usage => ({
  tokens: 0,
  costUsd: 0,
  reservedUnknownTokens: 0,
  elapsedMs: 0,
  unknown: false,
});
const usageOf = (data: SessionData): Usage => ({
  tokens: data.tokens,
  costUsd: data.costUsd,
  reservedUnknownTokens: data.reservedUnknownTokens ?? 0,
  elapsedMs: data.elapsedMs,
  unknown: data.usageUnknown,
});
const save = (file: string, value: unknown) =>
  replaceFile(
    file,
    JSON.stringify(value, null, 2) + "\n",
    existsSync(file) ? hash(readFileSync(file)) : null,
    0o600,
  );
const gone = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};
const rulesContent = (cwd: string, options: WorkerOptions["agent"]) =>
  hash(
    JSON.stringify(
      inspectRules(
        cwd,
        options.configFile,
        options.trustRepo,
        options.overrides,
      ).snapshot.sources.map((s) => ({
        scope: s.scope,
        kind: s.kind,
        content: s.content,
      })),
    ),
  );
const workerId = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw new SetupError("Worker IDが不正です。");
  return id;
};

/** 元のdirty snapshotをコピーする。hook/filterやignored依存の自動bootstrapは実行しない。 */
export async function prepareWorktree(
  cwd: string,
  target: string,
  signal?: AbortSignal,
) {
  const snapshot = workspaceState(cwd);
  if (snapshot.root !== snapshot.repoRoot || !snapshot.head)
    throw new SetupError(
      "Workerはcommit済みHEADのあるrepo rootで起動してください。",
    );
  const contents = new Map<string, { bytes: Buffer; mode: number }>();
  let bytes = 0,
    count = 0;
  for (const [name, digest] of Object.entries(snapshot.files)) {
    signal?.throwIfAborted();
    if (++count % 32 === 0) {
      await new Promise<void>((done) => setImmediate(done));
      signal?.throwIfAborted();
    }
    if (digest === "deleted" || digest === "excluded") continue;
    if (digest.startsWith("large:"))
      throw new SetupError("Worker snapshotは各file 4MiBまでです。");
    const file = workspacePath(cwd, name),
      content = readFileSync(file);
    bytes += content.length;
    if (bytes > 64 * 1024 * 1024 || hash(content) !== digest)
      throw new SetupError("snapshotの上限超過または競合です。");
    contents.set(name, { bytes: content, mode: statSync(file).mode & 0o777 });
  }
  git(cwd, [
    "-c",
    "core.hooksPath=/dev/null",
    "worktree",
    "add",
    "--detach",
    "--no-checkout",
    target,
    snapshot.head,
  ]);
  git(target, ["read-tree", snapshot.head]);
  count = 0;
  for (const [name, content] of contents) {
    signal?.throwIfAborted();
    if (++count % 32 === 0)
      await new Promise<void>((done) => setImmediate(done));
    const file = join(target, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content.bytes, { mode: content.mode, flag: "wx" });
  }
  return { snapshot };
}

/** 単一Workerの所有権、待機の保存、再開の差分usage精算を一つのcontrollerで扱う。 */
export async function runWorker(options: WorkerOptions) {
  const a = options.agent,
    release = acquireRepoOwner(a.stateDir, a.cwd);
  let db: SessionStore | undefined,
    child: ChildProcess | undefined,
    reserved = false,
    safe = true;
  const id = options.resume ? workerId(options.resume) : randomUUID();
  const directory = join(a.stateDir, "workers", id),
    cwd = join(directory, "worktree");
  let state: WorkerState = {
    id,
    directory: cwd,
    stage: "snapshot",
    provider: a.connection.provider,
    model: a.connection.model,
    startedAt: Date.now(),
    continuations: 0,
  };
  let observerFailed = false,
    preventAdmission = false,
    admitted = false;
  let abortChild: (() => void) | undefined,
    abandonUnstarted: (() => void) | undefined,
    cleanupTransport: (() => void) | undefined;
  let childCompletion: Promise<number | null> | undefined;
  const notify = () => {
    try {
      options.onState({ ...state });
    } catch {
      observerFailed = true;
    }
  };
  const log = (stage: string, detail?: string) => {
    const file = join(directory, "events.jsonl");
    if (!existsSync(file) || statSync(file).size < 1024 * 1024)
      appendFileSync(
        file,
        JSON.stringify({
          time: Date.now(),
          stage,
          detail: detail?.slice(0, 2000),
        }) + "\n",
        { mode: 0o600 },
      );
  };
  const update = (stage: string, detail?: string) => {
    state = { ...state, stage, detail, updatedAt: Date.now() };
    save(join(directory, "status.json"), state);
    log(stage, detail);
    notify();
  };
  try {
    db = new SessionStore(a.stateDir);
    options.signal?.throwIfAborted();
    const parent = db.load(options.parentId);
    if (realpathSync(parent.cwd) !== realpathSync(a.cwd))
      throw new SetupError("親SessionとWorkerのworkspaceが一致しません。");
    if (db.unsettledWorkers().length)
      throw new SetupError("未精算のWorkerがあります。", "worker_pending");
    const config = inspectRules(a.cwd, a.configFile, a.trustRepo, a.overrides)
      .snapshot.config.settings;
    const tokens =
      Math.min(config.maxTokens, a.connection.limits.maxTokens) -
      parent.tokens -
      (parent.reservedUnknownTokens ?? 0);
    const duration = Math.min(
      config.maxDurationMs - parent.elapsedMs,
      a.connection.limits.maxDurationMs,
      2_147_483_647,
    );
    const cost =
      a.connection.billing.kind === "metered"
        ? Math.min(config.maxCostUsd, a.connection.limits.maxCostUsd!) -
          parent.costUsd
        : config.maxCostUsd;
    if (
      tokens < 1 ||
      duration < 1 ||
      cost <= 0 ||
      (parent.usageUnknown && a.connection.billing.kind === "metered")
    )
      throw new SetupError(
        "Workerへ割り当てるSession残予算がありません。",
        "budget_blocked",
      );
    privateDirectory(join(a.stateDir, "workers"));
    privateDirectory(directory);
    let job: Job,
      baseline = zeroUsage(),
      progressSequence = 0;
    if (options.resume) {
      job = JSON.parse(
        readFileSync(join(directory, "job.json"), "utf8"),
      ) as Job;
      const previous = workerStatus(a.stateDir, id);
      if (
        job.version !== 1 ||
        job.parentId !== parent.id ||
        job.connectionHash !== hash(JSON.stringify(a.connection)) ||
        !job.childSession
      )
        throw new SetupError(
          "Workerの所有Session・接続・再開記録が一致しません。",
        );
      if (
        ![
          "waiting_input",
          "waiting_approval",
          "blocked",
          "aborted",
          "timeout",
          "interrupted",
        ].includes(previous.stage)
      )
        throw new SetupError(
          "質問・承認待ち、または停止済み会話を持つWorkerだけを再開できます。",
        );
      if (job.continuations >= 24)
        throw new SetupError("Workerの継続回数上限に達しました。");
      if (
        rulesContent(cwd, a) !== job.rulesContentHash ||
        rulesContent(a.cwd, a) !== job.rulesContentHash
      )
        throw new SetupError(
          "Worker開始時から規約が変わりました。候補を保持して新しいTaskで確認してください。",
          "rules_changed",
        );
      const childDb = new SessionStore(join(directory, "state"));
      try {
        const saved = childDb.load(job.childSession);
        const continuing =
          !saved.pending &&
          ["aborted", "timeout", "interrupted"].includes(previous.stage) &&
          !options.replyTo;
        if (
          !continuing &&
          (!saved.pending ||
            (options.replyTo && options.replyTo !== saved.pending!.id))
        )
          throw new SetupError("回答先が保存中の質問と一致しません。");
        if (childDb.pendingProcesses().some((pid) => !gone(pid)))
          throw new SetupError(
            "Worker tool processが残っています。",
            "process_remaining",
          );
        baseline = usageOf(saved);
        progressSequence = childDb.providerProgress(saved.id).lastSeq;
      } finally {
        childDb.close();
      }
      job.continuations++;
      state.startedAt = job.createdAt;
      state.continuations = job.continuations;
    } else {
      const sourceRules = rulesContent(a.cwd, a);
      const { snapshot } = await prepareWorktree(a.cwd, cwd, options.signal);
      if (
        workspaceState(a.cwd).hash !== snapshot.hash ||
        rulesContent(cwd, a) !== sourceRules
      )
        throw new SetupError("Workerへの規約・workspace引継ぎが一致しません。");
      job = {
        version: 1,
        id,
        parentId: parent.id,
        connectionHash: hash(JSON.stringify(a.connection)),
        sourceSnapshot: snapshot.hash,
        rulesContentHash: sourceRules,
        continuations: 0,
        permission: config.permission,
        createdAt: state.startedAt,
      };
    }
    const permission =
      job.permission === "read-only" ? "read-only" : config.permission;
    const manifest: WorkerManifest = {
      token: randomUUID(),
      task: options.task,
      parkQuestions: options.parkQuestions,
      options: {
        configFile: a.configFile,
        connection: a.connection,
        trustRepo: a.trustRepo,
        cwd,
        stateDir: join(directory, "state"),
        resume: job.childSession,
        planOnly: parent.planOnly,
        allowedPaths: parent.allowedPaths,
        overrides: {
          ...a.overrides,
          permission,
          maxTokens: baseline.tokens + baseline.reservedUnknownTokens + tokens,
          maxDurationMs: baseline.elapsedMs + duration,
          maxCostUsd: baseline.costUsd + cost,
        },
      },
    };
    manifest.expectedRulesHash = inspectRules(
      cwd,
      a.configFile,
      a.trustRepo,
      manifest.options.overrides,
    ).hash;
    save(join(directory, "manifest.json"), manifest);
    save(join(directory, "job.json"), job);
    parent.activeWorker = {
      id,
      directory,
      tokens,
      costUsd: a.connection.billing.kind === "metered" ? cost : 0,
      startedAt: Date.now(),
      quotaGroup: a.connection.quotaGroup,
      quotaLimit: a.connection.limits.maxConcurrency,
    };
    db.save(parent, "worker_reserved", {
      ...parent.activeWorker,
      snapshotHash: job.sourceSnapshot,
      continuations: job.continuations,
    });
    reserved = true;
    abandonUnstarted = () => {
      delete parent.activeWorker;
      db!.save(parent, "worker_not_admitted", { id });
      reserved = false;
    };
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "AWS_PROFILE",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    child = spawn(
      process.execPath,
      [
        options.entry ??
          fileURLToPath(new URL("./worker-entry.js", import.meta.url)),
        join(directory, "manifest.json"),
      ],
      {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    childCompletion = new Promise<number | null>((done, reject) => {
      child!.once("error", () =>
        reject(new SetupError("Workerを起動できませんでした。")),
      );
      child!.once("exit", (code) => done(code));
    });
    void childCompletion.catch(() => {});
    let report: Report | undefined,
      failed = false,
      stopping = false,
      transportFailed = false;
    let forceTimer: NodeJS.Timeout | undefined,
      killTimer: NodeJS.Timeout | undefined,
      deadline: NodeJS.Timeout | undefined,
      heartbeat: NodeJS.Timeout | undefined;
    const send = (value: object) => {
      if (child?.connected)
        child.send({ ...value, token: manifest.token }, () => {});
    };
    const abort = () => {
      stopping = true;
      try {
        options.cancelInput?.();
        update("stopping");
      } catch {
        transportFailed = true;
      }
      send({ type: "abort" });
      forceTimer ??= setTimeout(() => {
        if (child?.pid && !gone(child.pid)) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {}
        }
        killTimer ??= setTimeout(() => {
          if (child?.pid && !gone(child.pid)) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
        }, 500);
      }, 1500);
    };
    abortChild = abort;
    cleanupTransport = () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      clearTimeout(forceTimer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      child?.removeAllListeners("message");
    };
    child.on("message", (message: any) => {
      if (message?.token !== manifest.token) return;
      try {
        if (message.type === "ready") {
          admitted = !(preventAdmission || stopping || options.signal?.aborted);
          send({ type: admitted ? "start" : "abort" });
        }
        if (message.type === "session") {
          job.childSession = message.id;
          save(join(directory, "job.json"), job);
        }
        if (message.type === "event") {
          try {
            options.onEvent(message.event);
          } catch {
            observerFailed = true;
          }
        }
        if (message.type === "activity") {
          const activity = message.activity as ExecutionActivity;
          update(activity.stage, activity.detail);
        }
        if (message.type === "result") report = message.report;
        if (message.type === "failure") failed = true;
        if (message.type === "question" && !stopping)
          void options
            .ask(message.message, message.approval)
            .then((answer) => send({ type: "answer", id: message.id, answer }))
            .catch(() =>
              send({ type: "answer", id: message.id, answer: null }),
            );
        if (observerFailed) abort();
      } catch {
        transportFailed = true;
        abort();
      }
    });
    if (child.pid) {
      state.pid = child.pid;
      db.event(parent.id, "worker_started", {
        id,
        pid: child.pid,
        continuations: job.continuations,
      });
    }
    update("starting");
    if (observerFailed) abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    deadline = setTimeout(abort, duration);
    heartbeat = setInterval(() => {
      try {
        state.updatedAt = Date.now();
        save(join(directory, "status.json"), state);
        notify();
        if (observerFailed) abort();
      } catch {
        transportFailed = true;
        abort();
      }
    }, 1000);
    if (options.signal?.aborted) abort();
    let exitCode: number | null;
    try {
      exitCode = await childCompletion;
      if (child.pid) safe = await reapProcessGroup(child.pid);
    } finally {
      cleanupTransport();
    }
    try {
      options.cancelInput?.();
    } catch {
      observerFailed = true;
    }
    safe &&= !child.pid || gone(child.pid);
    let current = baseline,
      pending: SessionData["pending"],
      unresolvedRequest = admitted;
    if (existsSync(join(directory, "state/state.sqlite"))) {
      const workerDb = new SessionStore(join(directory, "state"));
      try {
        for (const pid of workerDb.pendingProcesses())
          if (!gone(pid)) safe = false;
        const childId =
          job.childSession ?? String(workerDb.list()[0]?.id ?? "");
        if (childId) {
          const saved = workerDb.load(childId);
          job.childSession = saved.id;
          current = usageOf(saved);
          pending = saved.pending;
          const progress = workerDb.providerProgress(
            saved.id,
            progressSequence,
          );
          unresolvedRequest = progress.requests !== progress.responses;
        }
      } finally {
        workerDb.close();
      }
    }
    if (!safe) {
      update("stop_unconfirmed");
      throw new SetupError(
        "Workerまたはtool processの停止が未確認です。lockと予算予約を保持しました。",
        "process_remaining",
      );
    }
    const deltaTokens = Math.max(0, current.tokens - baseline.tokens),
      deltaCost = Math.max(0, current.costUsd - baseline.costUsd);
    parent.tokens += deltaTokens;
    parent.reservedUnknownTokens =
      (parent.reservedUnknownTokens ?? 0) +
      (unresolvedRequest
        ? Math.max(0, tokens - deltaTokens)
        : Math.max(
            0,
            current.reservedUnknownTokens - baseline.reservedUnknownTokens,
          ));
    parent.costUsd +=
      unresolvedRequest && a.connection.billing.kind === "metered"
        ? cost
        : deltaCost;
    parent.usageUnknown ||= current.unknown || unresolvedRequest;
    if (
      a.connection.billing.kind === "subscription" &&
      (deltaTokens || unresolvedRequest)
    )
      parent.hasSubscriptionUsage = true;
    const stage =
      transportFailed || observerFailed
        ? "failed"
        : pending
          ? pending.type === "question"
            ? "waiting_input"
            : "waiting_approval"
          : report
            ? report.status === "completed"
              ? (report.verification as { status?: string })?.status === "fail"
                ? "verification_failed"
                : report.result.toolErrors > 0 &&
                    (report.verification as { status?: string })?.status !==
                      "pass"
                  ? "tool_failed"
                  : "candidate"
              : report.status
            : options.signal?.aborted
              ? "aborted"
              : "failed";
    parent.elapsedMs += Date.now() - parent.activeWorker!.startedAt;
    parent.lastWorker = {
      id,
      directory: cwd,
      status: stage,
      pending,
      continuations: job.continuations,
      model: `${a.connection.provider}/${a.connection.model}`,
      changedFiles: report?.changedFiles ?? [],
      verification: report?.verification ?? { status: "unknown" },
      integrated: false,
    };
    delete parent.activeWorker;
    db.save(parent, "worker_reconciled", {
      id,
      childSession: job.childSession,
      report,
      exitCode,
      deltaTokens,
      deltaCost,
      unresolvedRequest,
    });
    reserved = false;
    state.tokens = current.tokens;
    state.pending = pending;
    save(join(directory, "job.json"), job);
    update(stage);
    const result = {
      ...state,
      report,
      exitCode,
      failed,
      sourceSnapshot: job.sourceSnapshot,
      integrated: false,
    };
    save(join(directory, "result.json"), result);
    return result;
  } catch (error) {
    preventAdmission = true;
    abortChild?.();
    if (child?.pid && !gone(child.pid))
      safe = await reapProcessGroup(child.pid);
    if (reserved && safe && !admitted) {
      try {
        abandonUnstarted?.();
      } catch {}
    }
    if (reserved) {
      safe = false;
      try {
        update("stop_unconfirmed");
      } catch {}
    }
    throw error;
  } finally {
    cleanupTransport?.();
    db?.close();
    if (safe) release();
  }
}

/** 状態・ログは読取専用。stale PIDを停止操作の根拠にはしない。 */
export function workerStatus(stateDir: string, id: string): WorkerState {
  const directory = join(stateDir, "workers", workerId(id));
  const state = JSON.parse(
    readFileSync(join(directory, "status.json"), "utf8"),
  ) as WorkerState;
  const running = ![
    "candidate",
    "waiting_input",
    "waiting_approval",
    "blocked",
    "aborted",
    "failed",
    "error",
    "timeout",
    "verification_failed",
    "tool_failed",
    "recovered_unknown",
  ].includes(state.stage);
  return {
    ...state,
    id,
    liveness: running
      ? state.pid
        ? gone(state.pid)
          ? "process_absent"
          : state.updatedAt && Date.now() - state.updatedAt < 3500
            ? "live"
            : "unknown"
        : "unknown"
      : undefined,
  };
}
export function workerLogs(stateDir: string, id: string) {
  const file = join(stateDir, "workers", workerId(id), "events.jsonl");
  if (!existsSync(file)) return [];
  if (statSync(file).size > 2 * 1024 * 1024)
    throw new SetupError("Worker logが読取上限を越えています。");
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-200)
    .map((line) => JSON.parse(line));
}
export function listWorkers(stateDir: string) {
  const root = join(stateDir, "workers");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((id) => /^[a-f0-9-]{36}$/.test(id))
    .map((id) => {
      try {
        return workerStatus(stateDir, id);
      } catch {
        return {
          id,
          stage: "preparation_incomplete",
          directory: join(root, id, "worktree"),
          startedAt: 0,
        } as WorkerState;
      }
    })
    .sort(
      (a, b) =>
        (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0),
    )
    .slice(0, 100);
}
/** Explicit conservative recovery after controller-lock recovery; never signals a stale PID. */
export function recoverWorker(stateDir: string, id: string, confirmed = false) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Worker IDが不正です。");
  const release = acquireLock(stateDir);
  const db = new SessionStore(stateDir);
  try {
    const parent = db
      .unsettledWorkers()
      .find((session) => session.activeWorker?.id === id);
    if (!parent?.activeWorker)
      throw new Error("未精算のWorker予約が見つかりません。");
    const directory = join(stateDir, "workers", id);
    const status = JSON.parse(
      readFileSync(join(directory, "status.json"), "utf8"),
    ) as WorkerState;
    if (
      !Number.isSafeInteger(status.pid) ||
      status.pid! < 1 ||
      !gone(status.pid!)
    )
      throw new Error("Worker processの消失を確認できません。");
    const childState = join(directory, "state");
    if (existsSync(join(childState, "state.sqlite"))) {
      const childDb = new SessionStore(childState);
      try {
        if (childDb.pendingProcesses().some((pid) => !gone(pid)))
          throw new Error("Worker tool processが残っています。");
      } finally {
        childDb.close();
      }
    }
    if (confirmed && existsSync(join(childState, "state.sqlite"))) {
      if (existsSync(join(childState, "maintenance.lock")))
        recoverLock(childState, true);
      recoverModelSlots(childState, true);
      recoverRepoOwner(childState, join(directory, "worktree"), true);
    }
    const reservation = parent.activeWorker;
    if (confirmed) {
      parent.reservedUnknownTokens =
        (parent.reservedUnknownTokens ?? 0) + reservation.tokens;
      parent.costUsd += reservation.costUsd;
      parent.usageUnknown = true;
      parent.elapsedMs += Math.max(0, Date.now() - reservation.startedAt);
      delete parent.activeWorker;
      db.save(parent, "worker_recovered_unknown", { id, reservation });
      save(join(directory, "status.json"), {
        ...status,
        stage: "recovered_unknown",
      });
    }
    return {
      id,
      processAbsent: true,
      recovered: confirmed,
      usage: "unknown; full reservation retained",
    };
  } finally {
    db.close();
    release();
  }
}
