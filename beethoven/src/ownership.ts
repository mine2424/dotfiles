import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { acquireLock } from "./files.js";
import { git } from "./workspace.js";
import { SetupError } from "./connections.js";
/** repo単位で所有し、別repoの対話は同時実行できる。backup/migrationとは短いmaintenance lockで排他する。 */
export function acquireRepoOwner(stateDir: string, cwd: string) {
  const release = acquireLock(stateDir),
    db = new DatabaseSync(join(stateDir, "state.sqlite"), { timeout: 1000 });
  const target = realpathSync(
      resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()),
    ),
    token = randomUUID(),
    epoch = Date.now();
  try {
    db.exec("BEGIN IMMEDIATE");
    if (db.prepare("SELECT 1 FROM owners WHERE target_id=?").get(target))
      throw new SetupError(
        "このrepoを別のSession/Runが所有しています。停止・明示復旧を確認してください。",
      );
    db.prepare("INSERT INTO owners VALUES(?,?,?,?,?)").run(
      target,
      token,
      epoch,
      process.pid,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
    release();
  }
  let released = false;
  return () => {
    if (released) return;
    const lock = acquireLock(stateDir),
      db = new DatabaseSync(join(stateDir, "state.sqlite"), { timeout: 1000 });
    try {
      const result = db
        .prepare(
          "DELETE FROM owners WHERE target_id=? AND token=? AND epoch=? AND pid=?",
        )
        .run(target, token, epoch, process.pid);
      if (result.changes !== 1)
        throw new SetupError("repo所有権が変わりました。");
      released = true;
    } finally {
      db.close();
      lock();
    }
  };
}
export function recoverRepoOwner(
  stateDir: string,
  cwd: string,
  confirmed = false,
) {
  const release = acquireLock(stateDir),
    db = new DatabaseSync(join(stateDir, "state.sqlite"), { timeout: 1000 });
  try {
    const target = realpathSync(
        resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()),
      ),
      owner = db.prepare("SELECT * FROM owners WHERE target_id=?").get(target);
    if (!owner)
      return { target, processAbsent: null, recovered: false, notFound: true };
    const pid = Number(owner.pid);
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw new SetupError("owner PIDが不正です。");
    try {
      process.kill(pid, 0);
      throw new SetupError("owner processが生存しています。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    // Worker/Runの未精算情報はこの操作では消さない。停止照合は各Run/Workerのrecoverで行う。
    if (confirmed)
      db.prepare(
        "DELETE FROM owners WHERE pid=? AND target_id LIKE 'model:%'",
      ).run(pid);
    if (confirmed)
      db.prepare("DELETE FROM owners WHERE target_id=? AND token=?").run(
        target,
        owner.token!,
      );
    return {
      target,
      processAbsent: true,
      recovered: confirmed,
      unsettledReservationsPreserved: true,
    };
  } finally {
    db.close();
    release();
  }
}
