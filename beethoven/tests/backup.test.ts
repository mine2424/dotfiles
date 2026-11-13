import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  backupKeygen,
  createBackup,
  restoreBackup,
  listBackups,
} from "../src/backup.js";
import { initializeStore } from "../src/store.js";
import { SessionStore, type SessionData } from "../src/session.js";
import { git } from "../src/workspace.js";
import { acquireLock } from "../src/files.js";
async function fixture(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "beethoven-backup-test-")),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, ["-c", "init.templateDir=", "init", "-q"]);
  writeFileSync(join(repo, "source.txt"), "original\n");
  writeFileSync(join(repo, "remove.txt"), "remove\n");
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "initial",
  ]);
  writeFileSync(join(repo, "source.txt"), "dirty\n");
  rmSync(join(repo, "remove.txt"));
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 255, 1]));
  writeFileSync(join(repo, ".env"), "DO_NOT_BACK_UP");
  const state = join(dir, "state"),
    config = join(dir, "config");
  mkdirSync(config);
  await initializeStore(state);
  writeFileSync(
    join(config, "config.json"),
    '{"schemaVersion":1,"permission":"read-only"}',
  );
  mkdirSync(join(config, "auth"));
  writeFileSync(join(config, "auth", "credentials.json"), "DO_NOT_BACK_UP");
  const data: SessionData = {
    id: randomUUID(),
    cwd: repo,
    connectionId: "fixture",
    connectionHash: "old",
    piFile: null,
    rulesHash: "old",
    snapshotHash: "old",
    workspaceHash: "old",
    status: "closed",
    createdAt: new Date().toISOString(),
    tokens: 123,
    costUsd: 0,
    usageUnknown: false,
    elapsedMs: 10,
    planOnly: false,
    approvals: { old: true },
  };
  const db = new SessionStore(state);
  db.save(data, "opened");
  db.recordPrompt(data.id, "以前の質問", {});
  db.close();
  const key = join(dir, "external-key");
  backupKeygen(key);
  return {
    dir,
    repo,
    state,
    config,
    key,
    data,
    out: join(dir, "snapshot.btb"),
  };
}
test("encrypted backup restores DB, commits, binary/untracked/deleted files without original paths or credentials", async (t) => {
  const f = await fixture(t);
  const head = git(f.repo, ["rev-parse", "HEAD"]).trim();
  const created = await createBackup(
    f.state,
    join(f.config, "config.json"),
    f.key + ".pub",
    f.out,
  );
  assert.equal(created.localCreated, true);
  assert.equal(created.remoteVerified, false);
  assert.equal(readFileSync(f.out, "utf8").includes("以前の質問"), false);
  renameSync(f.repo, f.repo + "-unavailable");
  renameSync(f.state, f.state + "-unavailable");
  renameSync(f.config, f.config + "-unavailable");
  const receipt = restoreBackup(f.out, f.key, join(f.dir, "restored"));
  assert.equal(receipt.restoreVerified, true);
  const repo = receipt.mappings.find((item) => item.from === f.repo)!.to;
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), head);
  assert.equal(readFileSync(join(repo, "source.txt"), "utf8"), "dirty\n");
  assert.equal(existsSync(join(repo, "remove.txt")), false);
  assert.deepEqual(
    readFileSync(join(repo, "binary.bin")),
    Buffer.from([0, 255, 1]),
  );
  assert.equal(existsSync(join(repo, ".env")), false);
  assert.equal(existsSync(join(f.dir, "restored/config/auth")), false);
  const db = new SessionStore(join(f.dir, "restored/state"));
  try {
    const data = db.load(f.data.id);
    assert.equal(data.cwd, repo);
    assert.deepEqual(data.approvals, {});
    assert.equal(data.tokens, 123);
    assert.equal(data.status, "interrupted");
    assert.equal(db.promptHistory(repo)[0]!.preview, "以前の質問");
  } finally {
    db.close();
  }
  const inspection = new DatabaseSync(
    join(f.dir, "restored/state/state.sqlite"),
    { readOnly: true },
  );
  assert.equal(
    inspection.prepare("PRAGMA integrity_check").get()!.integrity_check,
    "ok",
  );
  inspection.close();
});
test("backup refuses active maintenance and restore refuses tampering and existing directories", async (t) => {
  const f = await fixture(t),
    release = acquireLock(f.state);
  try {
    await assert.rejects(
      createBackup(
        f.state,
        join(f.config, "config.json"),
        f.key + ".pub",
        f.out,
      ),
    );
  } finally {
    release();
  }
  await createBackup(
    f.state,
    join(f.config, "config.json"),
    f.key + ".pub",
    f.out,
  );
  assert.throws(() => restoreBackup(f.out, f.key, f.repo));
  const envelope = JSON.parse(readFileSync(f.out, "utf8"));
  envelope.tag = Buffer.alloc(16).toString("base64");
  const bad = join(f.dir, "bad.btb");
  writeFileSync(bad, JSON.stringify(envelope));
  assert.throws(() => restoreBackup(bad, f.key, join(f.dir, "bad-restore")));
  assert.equal(existsSync(join(f.dir, "bad-restore")), false);
});

test("offline restore relocates SDK transcript saved through a directory alias", async (t) => {
  const f = await fixture(t),
    alias = join(f.dir, "alias");
  symlinkSync(f.state, alias);
  mkdirSync(join(f.state, "sessions", f.data.id), { recursive: true });
  const transcript = join(alias, "sessions", f.data.id, "transcript.jsonl");
  writeFileSync(transcript, "{}\n");
  const store = new SessionStore(f.state);
  store.save({ ...f.data, piFile: transcript }, "alias_fixture");
  store.close();
  await createBackup(
    alias,
    join(f.config, "config.json"),
    f.key + ".pub",
    f.out,
  );
  renameSync(f.state, f.state + "-offline");
  const restored = restoreBackup(f.out, f.key, join(f.dir, "restored"));
  const db = new SessionStore(join(restored.target, "state"));
  try {
    const saved = db.load(f.data.id);
    assert.equal(
      saved.piFile,
      join(restored.target, "state/sessions", f.data.id, "transcript.jsonl"),
    );
    assert.equal(existsSync(saved.piFile!), true);
  } finally {
    db.close();
  }
});
