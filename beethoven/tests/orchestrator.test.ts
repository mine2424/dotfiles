import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validatePlan, createRun, executeRun } from "../src/orchestrator.js";
import { RunStore, type Plan } from "../src/run-store.js";
import { runWorker } from "../src/worker.js";
import { git } from "../src/workspace.js";
const plan = (): Plan => ({
  schemaVersion: 1,
  maxConcurrency: 2,
  maxTokens: 200000,
  maxCostUsd: 0,
  maxDurationMs: 60000,
  tasks: ["A", "B", "C"].map((id, i) => ({
    id,
    prompt: id,
    connection: "fixture",
    scope: [id.toLowerCase() + ".js"],
    dependsOn: id === "B" ? [{ task: "A", kind: "code" }] : [],
    resources: [],
    priority: 0,
    maxTokens: 50000,
    maxCostUsd: 0,
    maxAttempts: 1,
  })),
});
async function fixture(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "beethoven-run-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "repo");
  mkdirSync(join(cwd, ".beethoven"), { recursive: true });
  for (const name of ["a", "b", "c", "d", "e"])
    writeFileSync(join(cwd, name + ".js"), "export const value='one';\n");
  writeFileSync(
    join(cwd, ".beethoven/harness.json"),
    JSON.stringify({
      schemaVersion: 1,
      requirements: [{ id: "syntax", stage: "verify", required: true }],
      checks: [
        {
          id: "syntax",
          stage: "verify",
          argv: [process.execPath, "--check", "a.js"],
          cwd: ".",
          timeoutMs: 2000,
          requiredEnv: [],
          acceptanceIds: ["syntax"],
        },
      ],
    }),
  );
  git(cwd, ["-c", "init.templateDir=", "init", "-q"]);
  git(cwd, ["add", "."]);
  git(cwd, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const configFile = join(dir, "config/config.json");
  mkdirSync(join(dir, "config"));
  writeFileSync(
    configFile,
    JSON.stringify({
      schemaVersion: 1,
      permission: "workspace-write",
      allowedConnections: ["fixture"],
      maxTokens: 200000,
      maxDurationMs: 120000,
    }),
  );
  writeFileSync(
    join(dir, "config/connections.json"),
    JSON.stringify({
      schemaVersion: 1,
      allowFallback: false,
      defaultConnectionId: "fixture",
      connections: [
        {
          id: "fixture",
          provider: "fixture",
          model: "fixture",
          auth: { method: "api_key", credentialRef: "pi:fixture" },
          billing: { kind: "subscription" },
          quotaGroup: "fixture",
          limits: {
            maxTokens: 100000,
            maxDurationMs: 60000,
            maxCostUsd: null,
            maxAttempts: 1,
            maxConcurrency: 2,
          },
          status: "configured",
        },
      ],
    }),
  );
  return { dir, cwd, configFile, stateDir: join(dir, "state") };
}
test("plan rejects cycles, unknown fields and unsafe scopes", () => {
  assert.equal(validatePlan(plan()).tasks.length, 3);
  const cycle = plan();
  cycle.tasks[0]!.dependsOn = [{ task: "B", kind: "code" }];
  assert.throws(() => validatePlan(cycle));
  assert.throws(() => validatePlan({ ...plan(), allowPublish: true }));
  const scope = plan();
  scope.tasks[0]!.scope = ["../escape"];
  assert.throws(() => validatePlan(scope));
});
test("atomic reservations enforce shared quotas, path conflicts, command idempotency and stale epochs", async (t) => {
  const f = await fixture(t),
    r = await createRun(f.stateDir, f.configFile, f.cwd, plan()),
    store = new RunStore(f.stateDir);
  try {
    const run = store.acquireOwner(r.id);
    assert.equal(
      store.reserve(
        r.id,
        "A",
        run.epoch,
        "same",
        1,
        ["path:repo:src"],
        50000,
        0,
      ).admitted,
      true,
    );
    assert.equal(
      store.reserve(
        r.id,
        "C",
        run.epoch,
        "same",
        1,
        ["path:repo:other"],
        50000,
        0,
      ).admitted,
      false,
    );
    assert.equal(
      store.reserve(
        r.id,
        "C",
        run.epoch,
        "other",
        2,
        ["path:repo:src/file"],
        50000,
        0,
      ).admitted,
      false,
    );
    const current = store.get(r.id),
      id = randomUUID();
    const stop = store.command(r.id, id, current.version, { type: "stop" });
    assert.deepEqual(
      store.command(r.id, id, current.version, { type: "stop" }),
      stop,
    );
    assert.throws(() =>
      store.command(r.id, id, current.version, { type: "retry", taskId: "A" }),
    );
    assert.equal(
      store.reserve(r.id, "C", run.epoch, "other", 2, [], 50000, 0).admitted,
      false,
    );
    assert.throws(() => store.update(r.id, () => {}, run.epoch - 1));
  } finally {
    store.close();
  }
});
test("real SDK workers execute A and C concurrently, integrate serially, then B sees A code; original stays unchanged", async (t) => {
  const f = await fixture(t),
    run = await createRun(f.stateDir, f.configFile, f.cwd, plan());
  const starts: string[] = [],
    active = new Set<string>();
  let parallel = false;
  const result = await executeRun({
    stateDir: f.stateDir,
    id: run.id,
    approve: async () => true,
    onTask: (task, state) => {
      if (
        state.pid &&
        !["candidate", "failed", "waiting_input"].includes(state.stage)
      ) {
        active.add(task);
        if (active.size === 2) parallel = true;
      }
      if (state.stage === "candidate") active.delete(task);
      if (!starts.includes(task) && state.pid) starts.push(task);
    },
    worker: (options) =>
      runWorker({
        ...options,
        entry: fileURLToPath(new URL("./run-worker-child.js", import.meta.url)),
      }),
  });
  assert.equal(
    result.status,
    "awaiting_acceptance",
    JSON.stringify(result.tasks),
  );
  assert.equal(parallel, true);
  assert.equal(starts.at(-1), "B");
  for (const name of ["a", "b", "c"]) {
    assert.match(
      readFileSync(join(result.integration, name + ".js"), "utf8"),
      /two/,
    );
    assert.match(readFileSync(join(f.cwd, name + ".js"), "utf8"), /one/);
  }
  const store = new RunStore(f.stateDir);
  try {
    for (const id of ["A", "B", "C"]) {
      const current = store.get(run.id);
      store.command(run.id, randomUUID(), current.version, {
        type: "accept",
        taskId: id,
        sha: current.integrationSha,
      });
    }
    assert.equal(store.get(run.id).status, "completed");
  } finally {
    store.close();
  }
});

test("four real workers obey configured concurrency, and stop prevents downstream dispatch", async (t) => {
  const f = await fixture(t),
    file = join(f.dir, "config/connections.json"),
    profile = JSON.parse(readFileSync(file, "utf8"));
  profile.connections[0].limits.maxConcurrency = 4;
  writeFileSync(file, JSON.stringify(profile));
  const four = plan();
  four.maxConcurrency = 4;
  four.tasks = ["A", "C", "D", "E"].map((id) => ({
    ...four.tasks[0]!,
    id,
    prompt: id,
    scope: [id.toLowerCase() + ".js"],
    dependsOn: [],
  }));
  const run = await createRun(f.stateDir, f.configFile, f.cwd, four),
    active = new Set<string>();
  let maximum = 0;
  const result = await executeRun({
    stateDir: f.stateDir,
    id: run.id,
    approve: async () => true,
    onTask: (id, state) => {
      if (state.pid && !["candidate", "failed"].includes(state.stage)) {
        active.add(id);
        maximum = Math.max(maximum, active.size);
      }
      if (state.stage === "candidate") active.delete(id);
    },
    worker: (options) =>
      runWorker({
        ...options,
        entry: fileURLToPath(new URL("./run-worker-child.js", import.meta.url)),
      }),
  });
  assert.equal(maximum, 4);
  assert.equal(
    result.status,
    "awaiting_acceptance",
    JSON.stringify(result.tasks),
  );
  const stopRun = await createRun(f.stateDir, f.configFile, f.cwd, plan());
  let stopped = false;
  const started: string[] = [];
  const stoppedResult = await executeRun({
    stateDir: f.stateDir,
    id: stopRun.id,
    approve: async () => true,
    onTask: (id, state) => {
      if (state.pid && !started.includes(id)) started.push(id);
      if (state.pid && !stopped) {
        stopped = true;
        const store = new RunStore(f.stateDir);
        try {
          const current = store.get(stopRun.id);
          store.command(stopRun.id, randomUUID(), current.version, {
            type: "stop",
          });
        } finally {
          store.close();
        }
      }
    },
    worker: (options) =>
      runWorker({
        ...options,
        entry: fileURLToPath(new URL("./run-worker-child.js", import.meta.url)),
      }),
  });
  assert.equal(stoppedResult.status, "interrupted");
  assert.equal(started.includes("B"), false);
});

test("stopped plan revisions preserve spend and invalidate changed downstream tasks", async (t) => {
  const f = await fixture(t),
    run = await createRun(f.stateDir, f.configFile, f.cwd, plan()),
    store = new RunStore(f.stateDir);
  try {
    store.update(run.id, (r) => {
      r.tasks.A!.tokens = 123;
      r.tasks.A!.attempts = 1;
      r.tasks.A!.starts = 1;
      r.tasks.A!.status = "failed";
    });
  } finally {
    store.close();
  }
  const revised = plan();
  revised.tasks[0]!.prompt = "A revised";
  revised.tasks[0]!.maxAttempts = 2;
  const { reviseRun } = await import("../src/orchestrator.js");
  const next = reviseRun(f.stateDir, run.id, revised);
  assert.equal(next.tasks.A!.tokens, 123);
  assert.equal(next.tasks.A!.attempts, 1);
  assert.equal(next.tasks.A!.status, "pending");
  assert.equal(next.tasks.B!.reason, "plan_revised");
  assert.equal(next.revisions!.length, 1);
});

test("crash reconciliation observes real candidate commits and integration without repeating either effect", async (t) => {
  const f = await fixture(t),
    run = await createRun(f.stateDir, f.configFile, f.cwd, plan());
  const { prepareWorktree } = await import("../src/worker.js");
  const { commitSnapshot, reconcileRun } = await import(
    "../src/orchestrator.js"
  );
  await prepareWorktree(f.cwd, run.integration);
  const base = commitSnapshot(
      run.integration,
      `Beethoven Run ${run.id} baseline`,
    ),
    candidate = join(f.dir, "candidate");
  await prepareWorktree(run.integration, candidate);
  const stateDir = join(f.dir, "task-state"),
    workerId = randomUUID();
  mkdirSync(join(stateDir, "workers", workerId), { recursive: true });
  writeFileSync(
    join(stateDir, "workers", workerId, "status.json"),
    JSON.stringify({
      id: workerId,
      stage: "candidate",
      directory: candidate,
      model: "fixture",
      provider: "fixture",
      startedAt: 0,
    }),
  );
  const store = new RunStore(f.stateDir);
  let owner = store.acquireOwner(run.id);
  store.update(
    run.id,
    (r) => {
      r.integrationSha = base;
      r.tasks.A!.base = base;
      r.tasks.A!.stateDir = stateDir;
      r.tasks.A!.workerId = workerId;
      r.tasks.A!.status = "candidate";
    },
    owner.epoch,
  );
  store.effect(run.id, owner.epoch, {
    type: "commit",
    taskId: "A",
    status: "executing",
    before: base,
  });
  writeFileSync(join(candidate, "a.js"), "export const value='two';\n");
  const sha = commitSnapshot(candidate, `Beethoven ${run.id} A`);
  store.releaseOwner(run.id, owner.epoch);
  let reconciled = await reconcileRun(f.stateDir, run.id);
  assert.equal(reconciled.tasks.A!.candidate, sha);
  assert.equal(reconciled.effects[0]!.status, "succeeded");
  owner = store.acquireOwner(run.id);
  store.effect(run.id, owner.epoch, {
    type: "integrate",
    taskId: "A",
    status: "executing",
    before: base,
  });
  git(run.integration, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "cherry-pick",
    sha,
  ]);
  const count = git(run.integration, ["rev-list", "--count", "HEAD"]);
  store.releaseOwner(run.id, owner.epoch);
  reconciled = await reconcileRun(f.stateDir, run.id);
  assert.equal(reconciled.tasks.A!.status, "integrated");
  assert.equal(reconciled.tasks.A!.reason, "recovered_requires_verify");
  assert.equal(git(run.integration, ["rev-list", "--count", "HEAD"]), count);
  assert.equal(
    reconciled.effects.every((e) => e.status === "succeeded"),
    true,
  );
  store.close();
});

test("delegated Run inherits parent limits and charges actual usage back before reopening the conversation", async (t) => {
  const f = await fixture(t),
    { openAgent } = await import("../src/agent.js"),
    { scriptedRuntime } = await import("./worker-child.js");
  const connection = JSON.parse(
    readFileSync(join(f.dir, "config/connections.json"), "utf8"),
  ).connections[0];
  const parent = await openAgent({
    ...f,
    connection,
    runtime: await scriptedRuntime(),
    send: true,
    approve: async () => true,
    ask: async () => null,
  });
  const parentId = parent.id,
    limit = parent.info().limits.maxTokens;
  await parent.close();
  const run = await createRun(f.stateDir, f.configFile, f.cwd, plan()),
    store = new RunStore(f.stateDir);
  store.update(run.id, (r) => {
    r.parentSession = parentId;
  });
  store.close();
  const result = await executeRun({
    stateDir: f.stateDir,
    id: run.id,
    approve: async () => true,
    worker: (options) =>
      runWorker({
        ...options,
        entry: fileURLToPath(new URL("./run-worker-child.js", import.meta.url)),
      }),
  });
  assert.equal(
    result.status,
    "awaiting_acceptance",
    JSON.stringify(result.tasks),
  );
  assert.ok(result.plan.maxTokens <= limit);
  const { SessionStore } = await import("../src/session.js");
  const sessions = new SessionStore(f.stateDir);
  try {
    const saved = sessions.load(parentId);
    assert.equal(saved.activeRun, undefined);
    assert.equal(
      saved.tokens,
      Object.values(result.tasks).reduce((sum, t) => sum + t.tokens, 0),
    );
    assert.ok(saved.tokens > 0);
    assert.ok(saved.elapsedMs > 0);
  } finally {
    sessions.close();
  }
});

test("SIGKILL of a real Controller during spawn closes the orphan child and preserves unknown reservation on recovery", async (t) => {
  const f = await fixture(t),
    p = plan();
  p.maxConcurrency = 1;
  p.tasks = p.tasks.filter((t) => t.id === "A");
  const run = await createRun(f.stateDir, f.configFile, f.cwd, p),
    input = join(f.dir, "controller.json");
  writeFileSync(input, JSON.stringify({ stateDir: f.stateDir, id: run.id }));
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./run-controller-child.js", import.meta.url)),
      input,
    ],
    {
      cwd: f.cwd,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  let workerPid = 0;
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    if (workerPid) {
      try {
        process.kill(-workerPid, "SIGKILL");
      } catch {}
    }
  });
  const started = await new Promise<{ pid: number }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("fixture did not spawn")),
      15000,
    );
    child.on("message", (message: any) => {
      if (message.pid) {
        clearTimeout(timer);
        resolve(message);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("controller ended before spawn"));
    });
  });
  workerPid = started.pid;
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exit;
  let gone = false;
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(-workerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        gone = true;
        break;
      }
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(
    gone,
    true,
    "orphan child must exit on lost IPC, even before admission",
  );
  const { recoverRun, reconcileRun } = await import("../src/orchestrator.js");
  const recovered = await recoverRun(f.stateDir, run.id, true);
  assert.equal(recovered.recovered, true);
  const store = new RunStore(f.stateDir);
  try {
    assert.equal(store.get(run.id).tasks.A!.tokens, p.tasks[0]!.maxTokens);
    assert.equal(store.get(run.id).status, "interrupted");
  } finally {
    store.close();
  }
  const reconciled = await reconcileRun(f.stateDir, run.id);
  assert.equal(reconciled.tasks.A!.status, "blocked");
  assert.equal(reconciled.tasks.A!.reason, "unknown_usage_reserved_in_full");
});

test("saved candidate resumes without an extra commit and imports objects from an independent local clone", async (t) => {
  const f = await fixture(t),
    p = plan();
  p.tasks = p.tasks.slice(0, 1);
  const run = await createRun(f.stateDir, f.configFile, f.cwd, p);
  const { prepareWorktree } = await import("../src/worker.js");
  const { commitSnapshot } = await import("../src/orchestrator.js");
  await prepareWorktree(f.cwd, run.integration);
  const base = commitSnapshot(
      run.integration,
      `Beethoven Run ${run.id} baseline`,
    ),
    candidate = join(f.dir, "independent-candidate");
  git(f.dir, [
    "-c",
    "core.hooksPath=/dev/null",
    "clone",
    "--no-local",
    run.integration,
    candidate,
  ]);
  writeFileSync(join(candidate, "a.js"), "export const value='two';\n");
  const sha = commitSnapshot(candidate, `Beethoven ${run.id} A`),
    count = git(candidate, ["rev-list", "--count", "HEAD"]);
  const workerId = randomUUID(),
    stateDir = join(f.dir, "task-state");
  mkdirSync(join(stateDir, "workers", workerId), { recursive: true });
  writeFileSync(
    join(stateDir, "workers", workerId, "status.json"),
    JSON.stringify({
      id: workerId,
      stage: "candidate",
      directory: candidate,
      model: "fixture",
      provider: "fixture",
      startedAt: 0,
    }),
  );
  const store = new RunStore(f.stateDir);
  store.update(run.id, (r) => {
    r.integrationSha = base;
    r.tasks.A!.base = base;
    r.tasks.A!.stateDir = stateDir;
    r.tasks.A!.workerId = workerId;
    r.tasks.A!.candidate = sha;
    r.tasks.A!.status = "candidate";
  });
  store.close();
  const result = await executeRun({
    stateDir: f.stateDir,
    id: run.id,
    approve: async () => true,
    onEvent: () => {},
  });
  assert.equal(result.tasks.A!.status, "integrated");
  assert.equal(result.tasks.A!.candidate, sha);
  assert.equal(git(candidate, ["rev-list", "--count", "HEAD"]), count);
  assert.equal(result.effects.filter((e) => e.type === "commit").length, 0);
  assert.equal(
    readFileSync(join(run.integration, "a.js"), "utf8"),
    "export const value='two';\n",
  );
});

test("restored Run requires explicit replan and retains spend and invalidated acceptance", async (t) => {
  const f = await fixture(t),
    p = plan();
  p.tasks = p.tasks.slice(0, 1);
  const run = await createRun(f.stateDir, f.configFile, f.cwd, p);
  const { backupKeygen, createBackup, restoreBackup } = await import(
    "../src/backup.js"
  );
  const { reviseRun } = await import("../src/orchestrator.js");
  const store = new RunStore(f.stateDir);
  store.update(run.id, (r) => {
    r.tasks.A!.tokens = 123;
    r.humanAccepted = true;
  });
  store.close();
  const key = join(f.dir, "restore-key"),
    archive = join(f.dir, "restore.btb");
  backupKeygen(key);
  await createBackup(f.stateDir, f.configFile, key + ".pub", archive);
  const receipt = restoreBackup(archive, key, join(f.dir, "restored")),
    state = join(receipt.target, "state");
  let db = new RunStore(state),
    saved = db.get(run.id);
  db.close();
  assert.equal(saved.humanAccepted, false);
  assert.equal(saved.restoredFrom?.requiresReview, true);
  await assert.rejects(
    executeRun({
      stateDir: state,
      id: run.id,
      approve: async () => true,
      onEvent: () => {},
    }),
    /replan/,
  );
  const revised = reviseRun(state, run.id, p);
  assert.equal(revised.restoredFrom?.requiresReview, false);
  assert.equal(revised.tasks.A!.tokens, 123);
  assert.equal(revised.humanAccepted, false);
});
