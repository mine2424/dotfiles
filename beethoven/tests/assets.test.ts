import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetSources,
  addAssetSource,
  removeAssetSource,
  refreshAssets,
  searchAssets,
  readAsset,
} from "../src/assets.js";
import { git } from "../src/workspace.js";
import { connectionCatalog, type Connection } from "../src/connections.js";
import { codingTools } from "../src/tools.js";
function fixture(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "beethoven-assets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"),
    configFile = join(dir, "config/config.json"),
    stateDir = join(dir, "state");
  mkdirSync(repo);
  mkdirSync(join(dir, "config"), { mode: 0o700 });
  git(repo, ["-c", "init.templateDir=", "init", "-q"]);
  const code =
    "export function calculateTotal(items) { return items.reduce((sum, i) => sum + i.price * i.quantity, 0); }\n";
  for (const f of ["one.ts", "two.ts", ".env.ts"])
    writeFileSync(join(repo, f), code);
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ license: "MIT", dependencies: { example: "1" } }),
  );
  symlinkSync("one.ts", join(repo, "link.ts"));
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-qm",
    "assets",
  ]);
  const connection: Connection = {
    id: "fixture",
    provider: "openai",
    model: connectionCatalog().find((p) => p.id === "openai")!.models[0]!.id,
    auth: { method: "oauth", credentialRef: "pi:fixture" },
    billing: { kind: "subscription" },
    quotaGroup: "fixture",
    limits: {
      maxTokens: 10000,
      maxDurationMs: 10000,
      maxConcurrency: 1,
      maxAttempts: 1,
      maxCostUsd: null,
    },
    status: "configured",
  };
  writeFileSync(
    join(dir, "config/connections.json"),
    JSON.stringify({
      schemaVersion: 1,
      defaultConnectionId: "fixture",
      allowFallback: false,
      connections: [connection],
    }),
  );
  return { repo, configFile, stateDir, connection, code };
}
test("registered committed assets preserve provenance, ignore dirty files, exclude secrets/symlinks and pin destination", async (t) => {
  const f = fixture(t);
  assert.deepEqual(
    await searchAssets(f.configFile, f.stateDir, f.connection, "total"),
    [],
  );
  addAssetSource(f.configFile, "library", f.repo, ["fixture"]);
  const indexed = refreshAssets(f.configFile, f.stateDir, "library");
  assert.equal(indexed.symbols, 2);
  assert.equal(indexed.modelRequests, 0);
  writeFileSync(join(f.repo, "one.ts"), "dirty secret not sent");
  const hits = await searchAssets(
    f.configFile,
    f.stateDir,
    f.connection,
    "calculateTotal",
  );
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0]!.entry.id, hits[1]!.entry.id);
  const item = readAsset(
    f.configFile,
    f.stateDir,
    f.connection,
    hits[0]!.entry.id,
    hits[0]!.commit,
  );
  assert.match(item.excerpt, /price \* i.quantity/);
  assert.equal(item.license, "MIT");
  assert.deepEqual(item.dependencies, ["example"]);
  assert.equal(item.commit, indexed.commit);
  assert.throws(() =>
    readAsset(
      f.configFile,
      f.stateDir,
      { ...f.connection, provider: "anthropic" },
      hits[0]!.entry.id,
      hits[0]!.commit,
    ),
  );
  assert.throws(() =>
    readAsset(
      f.configFile,
      f.stateDir,
      f.connection,
      hits[0]!.entry.id,
      "0".repeat(40),
    ),
  );
  assert.deepEqual(
    await searchAssets(
      f.configFile,
      f.stateDir,
      { ...f.connection, id: "other" },
      "total",
    ),
    [],
  );
  assert.equal(
    readFileSync(join(f.repo, "one.ts"), "utf8"),
    "dirty secret not sent",
  );
  removeAssetSource(f.configFile, "library");
  assert.deepEqual(assetSources(f.configFile), []);
  assert.throws(() =>
    readAsset(
      f.configFile,
      f.stateDir,
      f.connection,
      hits[0]!.entry.id,
      hits[0]!.commit,
    ),
  );
});
test("asset tools search/read without source writes; index refresh shows stale revisions and redacts literal secrets", async (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.repo, "one.ts"),
    'export const apiKey = "private-value";\n',
  );
  git(f.repo, ["add", "one.ts"]);
  git(f.repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-qm",
    "revision",
  ]);
  addAssetSource(f.configFile, "library", f.repo, ["fixture"]);
  refreshAssets(f.configFile, f.stateDir, "library");
  const events: string[] = [],
    tools = codingTools({
      cwd: f.repo,
      stateDir: f.stateDir,
      assetAccess: { configFile: f.configFile, connection: f.connection },
      permission: "read-only",
      planOnly: () => true,
      assertCurrent: () => {},
      remainingMs: () => 1000,
      approve: async () => false,
      ask: async () => null,
      verify: async () => ({}),
      blocked: () => {},
      event: (type) => events.push(type),
    });
  const found = await tools
    .find((t) => t.name === "asset_search")!
    .execute("1", { query: "apiKey" }, undefined, undefined, {} as never);
  const hits = JSON.parse((found.content[0] as { text: string }).text);
  assert.equal(hits.length, 1);
  const read = await tools
    .find((t) => t.name === "asset_read")!
    .execute(
      "2",
      { id: hits[0].entry.id, commit: hits[0].commit },
      undefined,
      undefined,
      {} as never,
    );
  const text = (read.content[0] as { text: string }).text;
  assert.ok(!text.includes("private-value"));
  assert.ok(text.includes("credential omitted"));
  assert.deepEqual(events, ["asset_search", "asset_read"]);
  writeFileSync(join(f.repo, "new.ts"), "export function another() {}\n");
  git(f.repo, ["add", "new.ts"]);
  git(f.repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-qm",
    "new",
  ]);
  assert.equal(
    (await searchAssets(f.configFile, f.stateDir, f.connection, "apiKey"))[0]!
      .stale,
    true,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchAssets(
      f.configFile,
      f.stateDir,
      f.connection,
      "total",
      controller.signal,
    ),
  );
  chmodSync(join(f.configFile, "../assets.json"), 0o644);
  assert.throws(() => assetSources(f.configFile));
});
