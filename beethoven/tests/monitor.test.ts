import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openAgent } from "../src/agent.js";
import { monitorSnapshot } from "../src/monitor.js";
import { scriptedRuntime } from "./worker-child.js";
import { git } from "../src/workspace.js";
import { SessionStore } from "../src/session.js";
import { initializeStore, schemaVersion } from "../src/store.js";
import { DatabaseSync } from "node:sqlite";
test("different repos run simultaneous SDK sessions, same repo is excluded and monitor distinguishes stale heartbeat", async (t) => {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "beethoven-monitor-test-")),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, "state"),
    configFile = join(dir, "config/config.json");
  mkdirSync(join(dir, "config"));
  writeFileSync(
    configFile,
    JSON.stringify({
      schemaVersion: 1,
      permission: "read-only",
      allowedConnections: ["fixture"],
    }),
  );
  const connection = {
    id: "fixture",
    provider: "fixture",
    model: "fixture",
    auth: { method: "api_key" as const, credentialRef: "pi:fixture" },
    billing: { kind: "subscription" as const },
    quotaGroup: "fixture",
    status: "configured" as const,
    limits: {
      maxTokens: 20000,
      maxDurationMs: 20000,
      maxCostUsd: null,
      maxAttempts: 1,
      maxConcurrency: 1,
    },
  };
  const runtime = await scriptedRuntime();
  const options = {
    stateDir,
    configFile,
    connection,
    runtime,
    send: true,
    approve: async () => true,
    ask: async () => null,
  };
  const repos = ["first", "second"].map((name) => {
    const cwd = join(dir, name);
    mkdirSync(cwd);
    git(cwd, ["init", "-q"]);
    return cwd;
  });
  const first = await openAgent({ ...options, cwd: repos[0]! }),
    second = await openAgent({ ...options, cwd: repos[1]! });
  try {
    const snapshot = monitorSnapshot(stateDir);
    assert.equal(
      snapshot.nodes.filter((n) => n.kind === "session" && n.live === "live")
        .length,
      2,
    );
    await assert.rejects(openAgent({ ...options, cwd: repos[0]! }));
    const db = new SessionStore(stateDir);
    try {
      const data = db.load(first.id);
      data.runtime!.updatedAt = "2000-01-01T00:00:00.000Z";
      db.touchRuntime(data);
    } finally {
      db.close();
    }
    assert.equal(
      monitorSnapshot(stateDir).nodes.find((n) => n.id === first.id)!.live,
      "unknown",
    );
  } finally {
    await first.close();
    await second.close();
  }
  assert.equal(
    monitorSnapshot(stateDir).nodes.filter((n) => n.live === "live").length,
    0,
  );
});
test("schema 2 upgrade preserves documents and snapshot; absent monitor never creates state", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "beethoven-upgrade-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(monitorSnapshot(join(dir, "missing")).nodes.length, 0);
  assert.equal(existsSync(join(dir, "missing")), false);
  await initializeStore(dir);
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  db.exec(
    "DROP TABLE run_reservations; DROP TABLE run_commands; DROP TABLE runs; PRAGMA user_version=2;",
  );
  db.close();
  await initializeStore(dir);
  const restored = new DatabaseSync(join(dir, "state.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    Number(restored.prepare("PRAGMA user_version").get()!.user_version),
    schemaVersion,
  );
  assert.equal(
    restored.prepare("PRAGMA integrity_check").get()!.integrity_check,
    "ok",
  );
  restored.close();
});
