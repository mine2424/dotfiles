import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { schemaVersion } from "../src/store.js";
test("staged activation and rollback preserve old launcher and reject corrupt releases", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "beethoven-install-update-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = join(dir, "release"),
    bin = join(dir, "bin");
  mkdirSync(join(release, "dist/src"), { recursive: true });
  mkdirSync(bin);
  const records: [string, string][] = [
    ["dist/src/cli.js", 'console.log("fixture")'],
    ["package.json", "{}"],
    ["package-lock.json", "{}"],
  ];
  for (const [name, body] of records) writeFileSync(join(release, name), body);
  writeFileSync(
    join(release, "release.json"),
    JSON.stringify({
      schemaVersion: 1,
      pi: "1.4.0",
      databaseSchema: schemaVersion,
      files: records.map(([name, body]) => [
        name,
        createHash("sha256").update(body).digest("hex"),
      ]),
    }),
  );
  const launcher = join(bin, "beethoven"),
    old =
      "#!/bin/sh\n# Beethoven local launcher: /fixture/dist/src/cli.js\necho previous\n";
  writeFileSync(launcher, old);
  const script = join(process.cwd(), "scripts/manage-install.mjs");
  const run = (op: string) =>
    execFileSync(
      process.execPath,
      [
        script,
        op,
        "--from",
        release,
        "--bin-dir",
        bin,
        "--state",
        join(dir, "state"),
      ],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  assert.equal(JSON.parse(run("activate")).previousPreserved, true);
  assert.match(readFileSync(launcher, "utf8"), /managed launcher/);
  assert.equal(JSON.parse(run("rollback")).rolledBack, true);
  assert.equal(readFileSync(launcher, "utf8"), old);
  run("activate");
  const dbfile=join(dir,"state/state.sqlite"),db=new DatabaseSync(dbfile);db.exec(`PRAGMA user_version=${schemaVersion};CREATE TABLE owners(id TEXT);`);db.close();
  assert.throws(()=>run("rollback"));
  assert.match(readFileSync(launcher,"utf8"),/managed launcher/);
  rmSync(dbfile);run("rollback");
  writeFileSync(join(release, "dist/src/cli.js"), "corrupt");
  assert.throws(() => run("activate"));
  assert.equal(readFileSync(launcher, "utf8"), old);
});
