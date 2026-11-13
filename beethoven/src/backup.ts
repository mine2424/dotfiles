import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { acquireLock, privateDirectory } from "./files.js";
import {
  canonicalTarget,
  git,
  hash,
  within,
  workspaceState,
} from "./workspace.js";
import { schemaVersion, runSchemaMigration } from "./store.js";
import { SetupError } from "./connections.js";

type File = { path: string; data: string; sha256: string; mode: number };
type Repo = {
  id: string;
  original: string;
  target: string;
  head: string;
  bundle: string;
  files: File[];
  links: { path: string; target: string }[];
  status: string;
};
type Archive = {
  version: 1;
  id: string;
  createdAt: string;
  originalState: string;
  originalConfig: string;
  aliases?: { from: string; to: "state" | "config" }[];
  piVersion: string;
  schemaVersion: number;
  files: File[];
  repos: Repo[];
  exclusions: string[];
};
const maxArchive = 50 * 1024 * 1024,
  maxExpanded = 256 * 1024 * 1024;
const excluded = (name: string) =>
  name
    .split("/")
    .some(
      (part) =>
        [
          "auth",
          "harness-trust",
          "credentials.json",
          "auth.json",
          ".git",
          "node_modules",
          "maintenance.lock",
          "backups",
          "receipts",
        ].includes(part) || /^\.env(?:\.|$)|\.pem$|\.key$|\.lock$/.test(part),
    );
const safe = (path: string) => {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new SetupError("archive内のpathが不正です。");
  return path;
};
const checkSize = (bytes: number) => {
  if (bytes > maxExpanded)
    throw new SetupError(
      "backupの展開容量が256MiBを越えています。対象を明示的に整理してください。",
    );
};
function writeNew(file: string, bytes: Uint8Array | string, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, bytes, { flag: "wx", mode });
}
/** 秘密鍵はstate/開発repoから分離して本人が保管する。CLI引数へ秘密鍵本文は受け取らない。 */
export function backupKeygen(file: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  if (existsSync(file) || existsSync(file + ".pub"))
    throw new SetupError("鍵の保存先は未作成fileを指定してください。");
  writeNew(file, privateKey);
  writeNew(file + ".pub", publicKey);
  return {
    identity: resolve(file),
    recipient: resolve(file + ".pub"),
    instruction:
      "秘密鍵は別端末またはpassword managerへ保管してください。鍵を失うと復元できません。",
  };
}
/** 停止中のstateだけを整合snapshot化する。収集した通常fileは暗号化直前に再照合する。 */
export async function createBackup(
  stateDir: string,
  configFile: string,
  recipient: string | Buffer,
  output: string,
) {
  const state = realpathSync(stateDir),
    config = canonicalTarget(dirname(configFile)),
    out = canonicalTarget(output);
  if (within(state, out) || within(config, out))
    throw new SetupError("backup出力は設定・stateの外へ指定してください。");
  if (existsSync(out)) throw new SetupError("既存backupを上書きしません。");
  const release = acquireLock(state),
    temp = mkdtempSync(join(tmpdir(), "beethoven-backup-"));
  chmodSync(temp, 0o700);
  const checks: (() => void)[] = [],
    files: File[] = [],
    exclusions: string[] = [];
  let bytes = 0;
  const capture = (source: string, path: string, root: string = state) => {
    if (
      !within(realpathSync(root), realpathSync(source)) ||
      excluded(relative(realpathSync(root), realpathSync(source)))
    )
      throw new SetupError("snapshotのpath境界・除外範囲が変わりました。");
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new SetupError("snapshotには通常fileが必要です。");
    checkSize(bytes + stat.size);
    const content = readFileSync(source);
    bytes += content.length;
    checkSize(bytes);
    const sha256 = hash(content);
    checks.push(() => {
      const current = lstatSync(source);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.mode !== stat.mode ||
        hash(readFileSync(source)) !== sha256
      )
        throw new SetupError("backup収集中にfileが変更されました。");
    });
    return {
      path: safe(path),
      data: content.toString("base64"),
      sha256,
      mode: stat.mode & 0o777,
    };
  };
  try {
    const db = new DatabaseSync(join(state, "state.sqlite"), {
      readOnly: true,
    });
    let roots: string[];
    try {
      if (db.prepare("SELECT 1 FROM owners LIMIT 1").get())
        throw new SetupError(
          "Controller所有権が残っています。全Runを停止・照合してください。",
        );
      if (
        db
          .prepare(
            "SELECT 1 FROM session_documents WHERE (json_type(payload,'$.activeWorker')='object' OR json_type(payload,'$.activeRun')='object') LIMIT 1",
          )
          .get()
      )
        throw new SetupError("未精算Workerを復旧してからbackupしてください。");
      for (const row of db
        .prepare("SELECT payload FROM events WHERE type='process_started'")
        .all()) {
        const pid = JSON.parse(String(row.payload)).pid;
        if (!Number.isSafeInteger(pid) || pid < 1)
          throw new SetupError("process記録が不正です。");
        try {
          process.kill(-pid, 0);
          throw new SetupError("tool processが残っています。");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (db.prepare("SELECT 1 FROM run_reservations LIMIT 1").get())
        throw new SetupError(
          "未精算のRun予約が残っています。recover/reconcileを確認してください。",
        );
      roots = [
        ...db
          .prepare("SELECT DISTINCT cwd FROM sessions")
          .all()
          .map((row) => String(row.cwd)),
        ...db
          .prepare("SELECT document FROM runs")
          .all()
          .map((row) => String(JSON.parse(String(row.document)).cwd)),
      ];
    } finally {
      db.close();
    }
    const walk = async (source: string, prefix: string, record: File[]) => {
      if (!existsSync(source)) return;
      const listing = () =>
        readdirSync(source)
          .filter(
            (name) =>
              name !== "maintenance.lock" && !/(?:-wal|-shm)$/.test(name),
          )
          .sort()
          .join("\0");
      const initialListing = listing();
      checks.push(() => {
        if (listing() !== initialListing)
          throw new SetupError(
            "backup収集中にdirectoryの対象が変更されました。",
          );
      });
      for (const entry of readdirSync(source, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        const path = prefix + "/" + entry.name,
          file = join(source, entry.name);
        if (excluded(path) || /(?:-wal|-shm)$/.test(path)) {
          exclusions.push(path);
          continue;
        }
        if (entry.isSymbolicLink()) {
          exclusions.push(path);
          continue;
        }
        if (entry.isDirectory()) {
          // worktreeはGit bundleと別repo snapshotで収集する。
          if (entry.name === "worktree" || existsSync(join(file, ".git"))) {
            roots.push(file);
            continue;
          }
          checks.push(() => {
            if (readdirSync(file).sort().join("\0") !== names)
              throw new SetupError("backup収集中にdirectoryが変更されました。");
          });
          const names = readdirSync(file).sort().join("\0");
          await walk(file, path, record);
        } else if (entry.isFile() && entry.name.endsWith(".sqlite")) {
          const sourceDb = new DatabaseSync(file, { readOnly: true }),
            copy = join(temp, randomUUID() + ".sqlite");
          try {
            if (
              entry.name === "state.sqlite" &&
              sourceDb.prepare("SELECT 1 FROM owners LIMIT 1").get()
            )
              throw new SetupError("子Controllerの所有権が残っています。");
            if (
              entry.name === "state.sqlite" &&
              sourceDb
                .prepare(
                  "SELECT 1 FROM session_documents WHERE (json_type(payload,'$.activeWorker')='object' OR json_type(payload,'$.activeRun')='object') LIMIT 1",
                )
                .get()
            )
              throw new SetupError("子stateのWorker予約が未精算です。");
            await backup(sourceDb, copy);
          } finally {
            sourceDb.close();
          }
          record.push(capture(copy, path, temp));
        } else if (entry.isFile()) record.push(capture(file, path));
      }
    };
    await walk(state, "state", files);
    for (const name of [
      "backup-key.json",
      "backup-recovery.json",
      "config.json",
      "connections.json",
      "routing.json",
      "rules.md",
      "harness.json",
    ])
      if (existsSync(join(config, name)))
        files.push(capture(join(config, name), "config/" + name, config));
    const repos: Repo[] = [];
    for (const root of [...new Set(roots)].sort()) {
      if (!existsSync(root))
        throw new SetupError(
          "Sessionが参照するrepoがありません。backupを確定しません。",
        );
      const original = realpathSync(root),
        head = git(original, ["rev-parse", "HEAD"]).trim(),
        status = git(original, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]);
      const names = git(original, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ])
        .split("\0")
        .filter(Boolean);
      const id = randomUUID(),
        bundle = join(temp, id + ".bundle");
      git(original, ["bundle", "create", bundle, "--all", "HEAD"]);
      git(original, ["bundle", "verify", bundle]);
      const repo: Repo = {
        id,
        original,
        target: within(state, original)
          ? "state/" + relative(state, original)
          : "repos/" + id,
        head,
        status,
        bundle: readFileSync(bundle).toString("base64"),
        files: [],
        links: [],
      };
      bytes += Buffer.byteLength(repo.bundle, "base64");
      checkSize(bytes);
      for (const name of [...new Set(names)].sort()) {
        safe(name);
        if (excluded(name)) {
          exclusions.push(repo.target + "/" + name);
          continue;
        }
        const file = join(original, name);
        if (!existsSync(file)) continue;
        const info = lstatSync(file);
        if (info.isSymbolicLink()) {
          exclusions.push(repo.target + "/" + name);
          continue;
        }
        if (info.isFile()) repo.files.push(capture(file, name, original));
      }
      checks.push(() => {
        if (
          git(original, ["rev-parse", "HEAD"]).trim() !== head ||
          git(original, [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ]) !== status
        )
          throw new SetupError("backup収集中にrepoが変更されました。");
      });
      repos.push(repo);
    }
    for (const check of checks) check();
    const archive: Archive = {
      version: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      originalState: state,
      originalConfig: config,
      aliases: [
        { from: resolve(stateDir), to: "state" },
        { from: resolve(dirname(configFile)), to: "config" },
      ],
      piVersion: "1.4.0",
      schemaVersion,
      files,
      repos,
      exclusions,
    };
    const compressed = gzipSync(JSON.stringify(archive));
    if (compressed.length > maxArchive)
      throw new SetupError("暗号化前snapshotが50MiBを越えています。");
    const key = randomBytes(32),
      iv = randomBytes(12),
      aad = Buffer.from("beethoven-backup-v1");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([
      cipher.update(compressed),
      cipher.final(),
    ]);
    const wrapped = publicEncrypt(
      {
        key: Buffer.isBuffer(recipient) ? recipient : readFileSync(recipient),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      key,
    );
    key.fill(0);
    const envelope = JSON.stringify({
      version: 1,
      algorithm: "RSA-OAEP-SHA256+AES-256-GCM",
      id: archive.id,
      iv: iv.toString("base64"),
      key: wrapped.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    });
    if (Buffer.byteLength(envelope) > maxArchive)
      throw new SetupError("暗号化archiveが50MiBを越えています。");
    writeNew(out, envelope);
    const receipt = {
      id: archive.id,
      file: out,
      sha256: hash(envelope),
      bytes: Buffer.byteLength(envelope),
      repos: repos.length,
      exclusions,
      localCreated: true,
      remoteVerified: false,
      restoreVerified: false,
    };
    privateDirectory(join(state, "backups"));
    writeNew(
      join(state, "backups", archive.id + ".json"),
      JSON.stringify(receipt, null, 2),
    );
    return receipt;
  } finally {
    rmSync(temp, { recursive: true, force: true });
    release();
  }
}
/** 新規directoryだけへ復元する。archive内のpath・hashを全検証してから展開する。 */
export function restoreBackup(
  input: string,
  identity: string | Buffer,
  destination: string,
) {
  const target = canonicalTarget(destination);
  if (existsSync(target))
    throw new SetupError("復元先は未作成directoryを指定してください。");
  if (lstatSync(input).size > maxArchive)
    throw new SetupError("archiveが容量上限を越えています。");
  const envelope = JSON.parse(readFileSync(input, "utf8"));
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "RSA-OAEP-SHA256+AES-256-GCM"
  )
    throw new SetupError("未対応のbackup形式です。");
  const key = privateDecrypt(
    {
      key: Buffer.isBuffer(identity) ? identity : readFileSync(identity),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(envelope.key, "base64"),
  );
  let archive: Archive;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(Buffer.from("beethoven-backup-v1"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const compressed = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]);
    archive = JSON.parse(
      gunzipSync(compressed, { maxOutputLength: maxExpanded * 2 }).toString(
        "utf8",
      ),
    ) as Archive;
  } finally {
    key.fill(0);
  }
  if (
    archive.version !== 1 ||
    archive.schemaVersion !== schemaVersion ||
    archive.piVersion !== "1.4.0" ||
    !Array.isArray(archive.files) ||
    !Array.isArray(archive.repos)
  )
    throw new SetupError("backupの版・構造を確認してください。");
  const destinations = new Set<string>();
  let bytes = 0;
  for (const repo of archive.repos) {
    safe(repo.target);
    if (
      !/^[a-f0-9-]{36}$/.test(repo.id) ||
      !/^[a-f0-9]{40,64}$/.test(repo.head)
    )
      throw new SetupError("repo識別子が不正です。");
    if (!/^(repos\/[^/]+|state\/(?:workers|runs)\/.+)$/.test(repo.target))
      throw new SetupError("repo復元pathが不正です。");
    if (repo.links.length)
      throw new SetupError("未対応のsymlink snapshotです。");
  }
  for (const record of [
    ...archive.files,
    ...archive.repos.flatMap((repo) =>
      repo.files.map((file) => ({
        ...file,
        path: repo.target + "/" + file.path,
      })),
    ),
  ]) {
    safe(record.path);
    if (
      !record.path.startsWith("state/") &&
      !record.path.startsWith("config/") &&
      !record.path.startsWith("repos/")
    )
      throw new SetupError("archiveの保存範囲が不正です。");
    if (destinations.has(record.path) || excluded(record.path))
      throw new SetupError("archiveに重複・認証・管理pathがあります。");
    destinations.add(record.path);
    const content = Buffer.from(record.data, "base64");
    bytes += content.length;
    checkSize(bytes);
    if (hash(content) !== record.sha256 || !Number.isSafeInteger(record.mode))
      throw new SetupError("archiveのfile検査に失敗しました。");
  }
  privateDirectory(target);
  try {
    for (const repo of archive.repos) {
      const bundle = join(target, repo.id + ".bundle");
      writeNew(bundle, Buffer.from(repo.bundle, "base64"));
      const cwd = join(target, repo.target);
      mkdirSync(dirname(cwd), { recursive: true });
      git(target, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "init.templateDir=",
        "clone",
        "--no-checkout",
        "--no-local",
        bundle,
        cwd,
      ]);
      git(cwd, ["update-ref", "--no-deref", "HEAD", repo.head]);
      git(cwd, ["read-tree", repo.head]);
      git(cwd, ["remote", "remove", "origin"]);
      // checkoutはfilterを実行し得るので、実体を展開しないread-treeでindexだけを復元する。
      // 下でsnapshotのfileを上書きせず書くため、cloneはno-checkoutのまま使う。
      rmSync(bundle);
    }
    for (const record of archive.files)
      writeNew(
        join(target, record.path),
        Buffer.from(record.data, "base64"),
        record.mode & 0o777,
      );
    for (const repo of archive.repos)
      for (const record of repo.files)
        writeNew(
          join(target, repo.target, record.path),
          Buffer.from(record.data, "base64"),
          record.mode & 0o777,
        );
    if (
      archive.aliases &&
      (!Array.isArray(archive.aliases) ||
        archive.aliases.length > 2 ||
        archive.aliases.some(
          (a) =>
            !a || !isAbsolute(a.from) || !["state", "config"].includes(a.to),
        ))
    )
      throw new SetupError("backup path aliasが不正です。");
    const mappings = [
      ...(archive.aliases ?? []).map((a) => ({
        from: a.from,
        to: join(target, a.to),
      })),
      { from: archive.originalState, to: join(target, "state") },
      { from: archive.originalConfig, to: join(target, "config") },
      ...archive.repos.map((repo) => ({
        from: repo.original,
        to: join(target, repo.target),
      })),
    ].sort((a, b) => b.from.length - a.from.length);
    const relocate = (value: unknown): unknown => {
      if (typeof value === "string") {
        let candidate = value;
        let mapping = mappings.find(
          (item) =>
            candidate === item.from || candidate.startsWith(item.from + "/"),
        );
        // macOS /var and /private/var aliases can be saved by the SDK before
        // stateDir is canonicalized. Resolve only path-shaped absolute values;
        // the original leaf may already be unavailable during offline restore.
        if (!mapping && value.startsWith("/") && !/[\n\r\0]/.test(value)) {
          try {
            candidate = canonicalTarget(value);
            mapping = mappings.find(
              (item) =>
                candidate === item.from ||
                candidate.startsWith(item.from + "/"),
            );
          } catch {
            /* Non-path text retains its original value. */
          }
        }
        return mapping
          ? mapping.to + candidate.slice(mapping.from.length)
          : value;
      }
      if (Array.isArray(value)) return value.map(relocate);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, relocate(v)]),
        );
      return value;
    };
    // 子processの起動token・PID・旧hostの操作許可は生きた権限として復元しない。
    for (const file of archive.files.filter((record) =>
      /^state\/(?:.+\/)?workers\/[^/]+\/(manifest|status|job)\.json$/.test(
        record.path,
      ),
    )) {
      const path = join(target, file.path),
        data = relocate(JSON.parse(readFileSync(path, "utf8"))) as Record<
          string,
          unknown
        >;
      if (file.path.endsWith("/manifest.json")) data.token = randomUUID();
      if (file.path.endsWith("/status.json")) {
        delete data.pid;
        data.stage = "restored";
        data.liveness = "process_absent";
      }
      writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    }
    for (const file of archive.files.filter((record) =>
      record.path.endsWith("/state.sqlite"),
    )) {
      const db = new DatabaseSync(join(target, file.path));
      try {
        const version = Number(
          db.prepare("PRAGMA user_version").get()!.user_version,
        );
        if (
          db.prepare("PRAGMA integrity_check").get()!.integrity_check !==
            "ok" ||
          version < 2 ||
          version > schemaVersion
        )
          throw new SetupError("復元DBの整合性・版検査に失敗しました。");
        if (version === 2) db.exec(runSchemaMigration);
        db.exec("BEGIN IMMEDIATE");
        for (const row of db
          .prepare("SELECT session_id,payload FROM session_documents")
          .all()) {
          const data = relocate(JSON.parse(String(row.payload))) as Record<
            string,
            unknown
          >;
          delete data.runtime;
          data.approvals = {};
          data.status = "interrupted";
          delete data.activeWorker;
          delete data.activeRun;
          db.prepare(
            "UPDATE session_documents SET payload=? WHERE session_id=?",
          ).run(JSON.stringify(data), row.session_id!);
          db.prepare(
            "UPDATE sessions SET cwd=?,status='interrupted' WHERE id=?",
          ).run(String(data.cwd), row.session_id!);
          db.prepare(
            "INSERT INTO events(id,session_id,type,payload,created_at) VALUES(?,?,?,?,?)",
          ).run(
            randomUUID(),
            row.session_id!,
            "restored",
            JSON.stringify({
              snapshotId: archive.id,
              approvalsInvalidated: true,
              reauthenticate: true,
            }),
            new Date().toISOString(),
          );
          for (const process of db
            .prepare(
              "SELECT payload FROM events WHERE session_id=? AND type='process_started'",
            )
            .all(row.session_id!))
            db.prepare(
              "INSERT INTO events(id,session_id,type,payload,created_at) VALUES(?,?,?,?,?)",
            ).run(
              randomUUID(),
              row.session_id!,
              "process_finished",
              JSON.stringify({
                pid: JSON.parse(String(process.payload)).pid,
                groupGone: true,
                source: "restore_invalidated_old_host",
              }),
              new Date().toISOString(),
            );
        }
        for (const row of db.prepare("SELECT id,document FROM runs").all()) {
          const run = relocate(JSON.parse(String(row.document))) as Record<
            string,
            any
          >;
          delete run.ownerPid;
          run.epoch++;
          run.status = "interrupted";
          run.stop = true;
          run.humanAccepted = false;
          run.restoredFrom = {
            snapshotId: archive.id,
            requiresReview: true,
            workspaceHash: workspaceState(run.cwd).hash,
          };
          for (const task of Object.values(run.tasks) as Record<
            string,
            any
          >[]) {
            delete task.acceptedSha;
            if (task.status === "accepted" || task.status === "integrated") {
              task.status = "integrated";
              task.reason = "recovered_requires_verify";
            }
          }
          for (const task of Object.values(run.tasks) as Record<string, any>[])
            if (task.status === "running") {
              task.status = "interrupted";
              task.reason = "restored_requires_reconciliation";
            }
          for (const effect of run.effects)
            if (effect.status !== "succeeded") effect.status = "unknown";
          db.prepare("UPDATE runs SET document=? WHERE id=?").run(
            JSON.stringify(run),
            row.id!,
          );
        }
        db.exec(
          "DELETE FROM owners; DELETE FROM control_requests; UPDATE turns SET status='interrupted' WHERE status='responding'; COMMIT;",
        );
      } finally {
        db.close();
      }
    }
    for (const repo of archive.repos)
      if (
        git(join(target, repo.target), ["rev-parse", "HEAD"]).trim() !==
        repo.head
      )
        throw new SetupError("復元commitが一致しません。");
    const receipt = {
      snapshotId: archive.id,
      target,
      mappings,
      restoreVerified: true,
      reauthenticate: true,
      approvalsInvalidated: true,
      exclusions: archive.exclusions,
      complete: archive.exclusions.length === 0,
    };
    writeNew(
      join(target, "restore-receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    return receipt;
  } catch (error) {
    writeFileSync(
      join(target, "RESTORE_FAILED"),
      "復元は未完了です。このdirectoryから実行しないでください。\n",
      { mode: 0o600 },
    );
    throw error;
  }
}

/** local作成とremote照合を統合表示する。履歴の閲覧だけでstateを作成しない。 */
export function listBackups(stateDir: string) {
  const receipts = new Map<string, Record<string, unknown>>();
  for (const kind of ["backups", "receipts"]) {
    const directory = join(stateDir, kind);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter((name) =>
      /^[a-f0-9-]{36}\.json$/.test(name),
    )) {
      const data = JSON.parse(readFileSync(join(directory, name), "utf8"));
      const id = name.slice(0, -5);
      receipts.set(id, { ...receipts.get(id), ...data, id });
    }
  }
  return [...receipts.values()];
}
