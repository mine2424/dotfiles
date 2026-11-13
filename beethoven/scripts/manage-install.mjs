import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  cpSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireLock, privateDirectory } from "../dist/src/files.js";
import { readDatabaseVersion, schemaVersion } from "../dist/src/store.js";
// stageは依存導入・smokeまで完了してから確定する。activateに失敗しても旧launcherを保持する。
const [operation, ...args] = process.argv.slice(2),
  flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith("--") || !args[i + 1])
    throw new Error("optionは--name valueで指定してください。");
  flags[args[i].slice(2)] = args[i + 1];
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`,
  digest = (value) => createHash("sha256").update(value).digest("hex");
function atomic(file, value, mode = 0o600) {
  const temporary = join(dirname(file), ".beethoven-" + randomUUID());
  try {
    writeFileSync(temporary, value, { flag: "wx", mode, flush: true });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function previousSchema(launcher) {
  const entry=launcher?.match(/^# Beethoven (?:managed|local) launcher: (.+)\n/m)?.[1];
  if(!entry?.endsWith('/dist/src/cli.js'))return null;
  const store=join(dirname(entry),'store.js');if(!existsSync(store))return null;
  try {const value=Number(execFileSync(process.execPath,['--input-type=module','-e',"const {schemaVersion}=await import(process.argv[1]);process.stdout.write(String(schemaVersion));",pathToFileURL(store).href],{encoding:'utf8',stdio:'pipe',timeout:10000}));return Number.isSafeInteger(value)&&value>0?value:null;}catch{return null;}
}
function manifest(root) {
  const files = [];
  const walk = (dir) => {
    for (const item of readdirSync(join(root, dir), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = dir + "/" + item.name;
      if (item.isDirectory()) walk(name);
      else if (item.isFile())
        files.push([name, digest(readFileSync(join(root, name)))]);
      else throw new Error("releaseの実行codeにsymlinkがあります。");
    }
  };
  walk("dist/src");
  if (existsSync(join(root,"scripts"))) walk("scripts");
  for (const name of ["package.json", "package-lock.json"])
    files.push([name, digest(readFileSync(join(root, name)))]);
  return files;
}
let result;
if (operation === "stage") {
  const source = realpathSync(
      flags.from ?? fileURLToPath(new URL("..", import.meta.url)),
    ),
    out = resolve(flags.out ?? "");
  if (!flags.out || existsSync(out))
    throw new Error(
      "stage --from CHECKOUT --out NEW_DIRECTORYを指定してください。",
    );
  const temporary = out + ".staging-" + randomUUID();
  privateDirectory(temporary);
  try {
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    if (
      pkg.name !== "beethoven-cli-local" ||
      pkg.dependencies?.["@earendil-works/pi-coding-agent"] !== "1.4.0"
    )
      throw new Error("対応するBeethoven packageを指定してください。");
    for (const file of [
      "package.json",
      "package-lock.json",
      "README.md",
      "docs",
      "milestone.md",
      "dist/src",
      "scripts",
    ])
      if (existsSync(join(source, file)))
        cpSync(join(source, file), join(temporary, file), {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        });
    execFileSync(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--omit=dev",
        "--cache",
        join(temporary, ".npm-cache"),
      ],
      {
        cwd: temporary,
        stdio: "pipe",
        timeout: 120000,
        env: {
          ...process.env,
          PATH: dirname(process.execPath) + ":" + process.env.PATH,
        },
      },
    );
    rmSync(join(temporary, ".npm-cache"), { recursive: true, force: true });
    const output = execFileSync(
      process.execPath,
      [join(temporary, "dist/src/cli.js"), "--version"],
      { encoding: "utf8", timeout: 10000, stdio: "pipe" },
    ).trim();
    if (output !== pkg.version)
      throw new Error("新しいreleaseのsmokeに失敗しました。");
    const targetSchema = Number(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const {schemaVersion}=await import(process.argv[1]);process.stdout.write(String(schemaVersion));",
          pathToFileURL(join(temporary, "dist/src/store.js")).href,
        ],
        { encoding: "utf8", stdio: "pipe", timeout: 10000 },
      ),
    );
    if (!Number.isSafeInteger(targetSchema) || targetSchema < 1)
      throw new Error("target releaseのDB対応版が不明です。");
    writeFileSync(
      join(temporary, "release.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: pkg.version,
        node: process.version,
        pi: "1.4.0",
        databaseSchema: targetSchema,
        files: manifest(temporary),
      }),
      { flag: "wx", mode: 0o600 },
    );
    mkdirSync(dirname(out), { recursive: true });
    renameSync(temporary, out);
    result = { staged: out, version: pkg.version, activated: false };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
} else if (operation === "activate" || operation === "rollback") {
  if (!flags["bin-dir"] || !flags.state)
    throw new Error(
      "activate/rollbackには--bin-dir DIR --state DIRが必要です。",
    );
  const bin = resolve(flags["bin-dir"]);
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, "beethoven"),
    receiptFile = join(bin, ".beethoven-install.json"),
    release = acquireLock(resolve(flags.state));
  try {
    if (existsSync(join(flags.state, "state.sqlite"))) {
      const db = new DatabaseSync(join(flags.state, "state.sqlite"), {
        readOnly: true,
      });
      try {
        if (db.prepare("SELECT 1 FROM owners LIMIT 1").get())
          throw new Error("全Session/Runを停止してから更新してください。");
      } finally {
        db.close();
      }
    }
    const current = existsSync(launcher)
      ? readFileSync(launcher, "utf8")
      : null;
    if (
      current &&
      (!lstatSync(launcher).isFile() ||
        lstatSync(launcher).isSymbolicLink() ||
        !/^#!\/bin\/sh\n# Beethoven (?:managed|local) launcher:/m.test(current))
    )
      throw new Error("別のbeethovenを上書きしません。");
    if (operation === "activate") {
      const root = realpathSync(flags.from ?? ""),
        metadata = JSON.parse(readFileSync(join(root, "release.json"), "utf8"));
      if (
        metadata.schemaVersion !== 1 ||
        metadata.pi !== "1.4.0" ||
        JSON.stringify(metadata.files) !== JSON.stringify(manifest(root))
      )
        throw new Error("releaseのhash・版が一致しません。");
      if (
        existsSync(join(flags.state, "state.sqlite")) &&
        readDatabaseVersion(join(flags.state, "state.sqlite")) >
          metadata.databaseSchema
      )
        throw new Error(
          "新しいDBを旧releaseで開けません。backup restoreで別領域へ戻してください。",
        );
      const entry = join(root, "dist/src/cli.js"),
        next = `#!/bin/sh\n# Beethoven managed launcher: ${entry}\nexec ${quote(realpathSync(process.execPath))} ${quote(entry)} "$@"\n`;
      if (current === next) result = { activated: root, changed: false };
      else {
        atomic(
          receiptFile,
          JSON.stringify({
            current: next,
            previous: current,
            previousSchema: previousSchema(current),
            root,
          }),
        );
        atomic(launcher, next, 0o755);
        result = { activated: root, changed: true, previousPreserved: true };
      }
    } else {
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
      if (current !== receipt.current || !receipt.previous)
        throw new Error("rollbackできる一致したlauncherがありません。");
      if (
        existsSync(join(flags.state, "state.sqlite")) &&
        (receipt.previousSchema===null || !Number.isSafeInteger(receipt.previousSchema) || readDatabaseVersion(join(flags.state, "state.sqlite")) >
          receipt.previousSchema)
      )
        throw new Error(
          "DB版が進んでいるためrollbackを拒否します。別領域restoreを使ってください。",
        );
      atomic(launcher, receipt.previous, 0o755);
      result = { rolledBack: true, stateRewritten: false };
    }
  } finally {
    release();
  }
} else throw new Error("stage|activate|rollbackを指定してください。");
console.log(JSON.stringify(result));
