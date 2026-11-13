import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore } from "../src/store.js";
import { reserveModel, recoverModelSlots } from "../src/resources.js";
import { DatabaseSync } from "node:sqlite";
test("interactive model requests share quota and the global four-slot capacity", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "beethoven-resources-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  await initializeStore(state);
  const release = reserveModel(state, "same", 1);
  assert.throws(() => reserveModel(state, "same", 4));
  release();
  const releases = ["A", "B", "C", "D"].map((group) =>
    reserveModel(state, group, 4),
  );
  assert.throws(() => reserveModel(state, "E", 4));
  for (const done of releases) done();
  const again = reserveModel(state, "same", 1);
  again();
  const db = new DatabaseSync(join(state, "state.sqlite"));
  db.prepare("INSERT INTO owners VALUES(?,?,?,?,?)").run(
    "model:orphan:1:id",
    "orphan-token",
    0,
    2147483647,
    "old",
  );
  db.close();
  assert.equal(recoverModelSlots(state).slots[0]!.recovered, false);
  assert.equal(recoverModelSlots(state, true).slots[0]!.recovered, true);
});
