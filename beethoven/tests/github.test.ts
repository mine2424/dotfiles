import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initializeStore } from "../src/store.js";
import { RunStore, type Run } from "../src/run-store.js";
import {
  allowGitHub,
  githubSnapshot,
  githubCI,
  publishRun,
  GitHubError,
  uploadBackup,
  type GitHubTransport,
} from "../src/github.js";
import { git } from "../src/workspace.js";
import { backupKeygen, createBackup } from "../src/backup.js";
const temporary = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "beethoven-github-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
test("GitHub input paginates Project data and records partial failures without complete status", (t) => {
  const dir = temporary(t);
  let pages = 0;
  const transport: GitHubTransport = (args, input) =>
    args[1] === "graphql"
      ? {
          data: {
            node: {
              id: "PVT_test",
              title: "Test",
              updatedAt: "now",
              items: {
                nodes: [{ id: ++pages }],
                pageInfo: { hasNextPage: pages === 1, endCursor: "second" },
              },
            },
          },
        }
      : args.includes("--slurp")
        ? [[{ number: 1 }], [{ number: 2 }]]
        : { full_name: "mine2424/beethoven" };
  const snapshot = githubSnapshot(
    dir,
    "mine2424/beethoven",
    "PVT_test",
    transport,
  );
  assert.equal(snapshot.complete, true);
  assert.equal((snapshot.project as any).items.length, 2);
  assert.throws(() =>
    githubSnapshot(dir, "mine2424/beethoven", "PVT_test", () => {
      throw new GitHubError(0);
    }),
  );
});
test("CI requires named checks on the exact head, never skipped or unconfigured", () => {
  const sha = "a".repeat(40);
  const response = (checks: unknown[]) => () => [{ check_runs: checks }];
  const success = {
    id: 1,
    name: "tests",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
  };
  assert.equal(
    githubCI("mine2424/beethoven", sha, ["tests"], response([success])).status,
    "passed",
  );
  for (const checks of [
    [{ ...success, head_sha: "b".repeat(40) }],
    [{ ...success, conclusion: "skipped" }],
    [],
  ])
    assert.equal(
      githubCI("mine2424/beethoven", sha, ["tests"], response(checks)).status,
      "pending_or_failed",
    );
  assert.equal(
    githubCI("mine2424/beethoven", sha, [], response([success])).status,
    "pending_or_failed",
  );
});
test("publish reconciles existing refs/PRs after a lost response and never creates a duplicate", async (t) => {
  const dir = temporary(t),
    repo = join(dir, "repo"),
    state = join(dir, "state"),
    config = join(dir, "config/config.json");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "file"), "one");
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const sha = git(repo, ["rev-parse", "HEAD"]).trim();
  await initializeStore(state);
  allowGitHub(config, "mine2424/beethoven", "development");
  const id = randomUUID(),
    run = {
      id,
      cwd: repo,
      repoId: repo,
      integration: repo,
      configFile: config,
      plan: { tasks: [] },
      rulesHash: "",
      version: 1,
      epoch: 1,
      stop: false,
      status: "completed",
      createdAt: new Date().toISOString(),
      startedAt: 0,
      tasks: {},
      effects: [],
      integrationSha: sha,
      humanAccepted: true,
    } as unknown as Run;
  const store = new RunStore(state);
  store.create(run);
  store.close();
  let pushed = false,
    created = 0,
    pr: any;
  const transport: GitHubTransport = (args, input) => {
    const endpoint = args.find((arg) => arg.startsWith("repos/"))!;
    if (endpoint.endsWith("/pulls") && input) {
      created++;
      pr = {
        number: 1,
        html_url: "https://github.com/mine2424/beethoven/pull/1",
        draft: true,
        state: "open",
        head: { sha, repo: { full_name: "mine2424/beethoven" } },
      };
      throw new GitHubError(0);
    }
    if (endpoint.includes("/git/ref/")) {
      if (!pushed) throw new GitHubError(404);
      return { object: { sha } };
    }
    if (endpoint.includes("/pulls?")) return pr ? [pr] : [];
    return { full_name: "mine2424/beethoven", default_branch: "main" };
  };
  assert.throws(() =>
    publishRun(
      state,
      config,
      id,
      "mine2424/beethoven",
      sha,
      "title",
      "body",
      transport,
      () => {
        pushed = true;
      },
    ),
  );
  const receipt = publishRun(
    state,
    config,
    id,
    "mine2424/beethoven",
    sha,
    "title",
    "body",
    transport,
    () => {
      throw new Error("must not push twice");
    },
  );
  assert.equal(receipt.status, "succeeded");
  assert.equal(created, 1);
  assert.equal(receipt.draft, true);
  assert.throws(() =>
    publishRun(
      state,
      config,
      id,
      "other/repo",
      sha,
      "title",
      "body",
      transport,
    ),
  );
});
test("backup upload requires its own capability and rejects public storage", (t) => {
  const dir = temporary(t),
    config = join(dir, "config/config.json");
  allowGitHub(config, "mine2424/beethoven", "development");
  assert.throws(() =>
    uploadBackup(dir, config, "absent", "mine2424/beethoven", () => ({
      private: true,
    })),
  );
  allowGitHub(config, "mine2424/beethoven-backup", "backup");
  assert.throws(() =>
    uploadBackup(dir, config, "absent", "mine2424/beethoven-backup", () => ({
      private: false,
      full_name: "mine2424/beethoven-backup",
    })),
  );
});

test("backup download pins private repository, snapshot ID and both hashes without overwriting a destination", async (t) => {
  const { downloadBackup } = await import("../src/github.js");
  const { createHash } = await import("node:crypto");
  const dir = temporary(t),
    config = join(dir, "config/config.json"),
    repo = "mine2424/beethoven-backup",
    id = randomUUID();
  allowGitHub(config, repo, "backup");
  const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        id,
        algorithm: "RSA-OAEP-SHA256+AES-256-GCM",
        data: "encrypted fixture",
      }),
    ),
    sha256 = createHash("sha256").update(bytes).digest("hex"),
    blobSha = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
  const transport: GitHubTransport = (args) =>
    args[1] === `repos/${repo}`
      ? { private: true, full_name: repo }
      : args[1]!.includes("/contents/")
        ? { type: "file", sha: blobSha, size: bytes.length }
        : { encoding: "base64", content: bytes.toString("base64") };
  const out = join(dir, "snapshot.btb");
  assert.equal(
    downloadBackup(config, id, repo, out, sha256, transport).downloadVerified,
    true,
  );
  assert.deepEqual(readFileSync(out), bytes);
  assert.throws(() => downloadBackup(config, id, repo, out, sha256, transport));
  assert.throws(() =>
    downloadBackup(
      config,
      id,
      repo,
      join(dir, "bad.btb"),
      "0".repeat(64),
      transport,
    ),
  );
  assert.throws(() =>
    downloadBackup(config, id, repo, join(dir, "public.btb"), sha256, () => ({
      private: false,
      full_name: repo,
    })),
  );
  assert.throws(() =>
    downloadBackup(
      config,
      "../invalid",
      repo,
      join(dir, "unsafe.btb"),
      sha256,
      transport,
    ),
  );
});

test("encrypted recovery upload is idempotent and download preserves the exact encrypted identity", async (t) => {
  const { setupBackupKey } = await import("../src/backup-key.js"),
    { uploadRecovery, downloadRecovery } = await import("../src/github.js"),
    { createHash } = await import("node:crypto");
  const dir = temporary(t),
    config = join(dir, "config/config.json"),
    repo = "mine2424/beethoven-backup",
    items = new Map<string, Buffer>();
  const managed = setupBackupKey(config, (op, account, data) =>
    op === "status"
      ? Buffer.from(items.has(account) ? "present" : "missing")
      : op === "save"
        ? (items.set(account, Buffer.from(data!)), Buffer.from("stored"))
        : Buffer.from(items.get(account)!),
  );
  t.after(() => {
    for (const b of items.values()) b.fill(0);
  });
  allowGitHub(config, repo, "backup");
  let bytes: Buffer | undefined,
    puts = 0;
  const blobSha = () =>
    createHash("sha1")
      .update(Buffer.from(`blob ${bytes!.length}\0`))
      .update(bytes!)
      .digest("hex");
  const transport: GitHubTransport = (args, input) => {
    if (args[1] === `repos/${repo}`) return { private: true, full_name: repo };
    if (args.includes("PUT")) {
      bytes = Buffer.from((input as any).content, "base64");
      puts++;
      return { content: { sha: blobSha() } };
    }
    if (args[1]!.includes("/contents/")) {
      if (!bytes) throw new GitHubError(404);
      return { type: "file", sha: blobSha(), size: bytes.length };
    }
    return { encoding: "base64", content: bytes!.toString("base64") };
  };
  assert.equal(
    uploadRecovery(config, managed.recoveryFile, repo, transport).codeUploaded,
    false,
  );
  assert.equal(
    uploadRecovery(config, managed.recoveryFile, repo, transport)
      .remoteVerified,
    true,
  );
  assert.equal(puts, 1);
  const file = join(dir, "retrieved.json");
  assert.equal(
    downloadRecovery(config, managed.fingerprint, repo, file, transport)
      .downloadVerified,
    true,
  );
  assert.deepEqual(readFileSync(file), readFileSync(managed.recoveryFile));
  assert.throws(() =>
    downloadRecovery(config, managed.fingerprint, repo, file, transport),
  );
});
test("recovery upload rejects plaintext key and download rejects malformed metadata before writing", async (t) => {
  const { uploadRecovery, downloadRecovery } = await import("../src/github.js");
  const dir = temporary(t),
    config = join(dir, "config/config.json"),
    file = join(dir, "key.pem"),
    repo = "mine2424/beethoven-backup";
  writeFileSync(file, "PRIVATE KEY must never upload");
  allowGitHub(config, repo, "backup");
  let calls = 0;
  assert.throws(() =>
    uploadRecovery(config, file, repo, () => {
      calls++;
      return {};
    }),
  );
  assert.equal(calls, 0);
  assert.throws(() =>
    downloadRecovery(
      config,
      "a".repeat(64),
      repo,
      join(dir, "bad.json"),
      () => ({
        private: true,
        full_name: repo,
        sha: "a".repeat(40),
        type: "file",
        size: 16385,
      }),
    ),
  );
});
