import { existsSync } from "node:fs";
import { acquireLock } from "./files.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SetupError } from "./connections.js";
/** 対話model枠もRun/手動Workerと同じstateで数える。process消失だけで自動回収しない。 */
export function reserveModel(stateDir: string, group: string, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4)
    throw new SetupError("model枠は1〜4で指定してください。");
  const db = new DatabaseSync(join(stateDir, "state.sqlite"), {
      timeout: 1000,
    }),
    token = randomUUID(),
    target = `model:${encodeURIComponent(group)}:${limit}:${token}`;
  try {
    db.exec("BEGIN IMMEDIATE");
    const models = db
        .prepare("SELECT target_id FROM owners WHERE target_id LIKE 'model:%'")
        .all(),
      runs = db.prepare("SELECT * FROM run_reservations").all(),
      workers = db
        .prepare(
          "SELECT payload FROM session_documents WHERE json_type(payload,'$.activeWorker')='object'",
        )
        .all()
        .map((row) => JSON.parse(String(row.payload)).activeWorker);
    const same = models.filter((row) =>
        String(row.target_id).startsWith(`model:${encodeURIComponent(group)}:`),
      ),
      sameRuns = runs.filter((row) => row.quota_group === group),
      sameWorkers = workers.filter(
        (worker) => !worker.quotaGroup || worker.quotaGroup === group,
      );
    const effective = Math.min(
      limit,
      ...same.map((row) => Number(String(row.target_id).split(":")[2]) || 1),
      ...sameRuns.map((row) => {
        const metadata = (JSON.parse(String(row.resources)) as string[]).find(
          (value) => value.startsWith("@quota/"),
        );
        return metadata ? Number(metadata.split("/").at(-1)) || 1 : 1;
      }),
      ...sameWorkers.map((worker) => worker.quotaLimit ?? 1),
    );
    if (
      models.length + runs.length + workers.length >= 4 ||
      same.length + sameRuns.length + sameWorkers.length >= effective
    )
      throw new SetupError(
        "共有のmodel枠を使用中です。実行中Session/Runを確認してから再送してください。",
        "quota_busy",
      );
    db.prepare("INSERT INTO owners VALUES(?,?,?,?,?)").run(
      target,
      token,
      Date.now(),
      process.pid,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  let released = false;
  return () => {
    if (released) return;
    const db = new DatabaseSync(join(stateDir, "state.sqlite"), {
      timeout: 1000,
    });
    try {
      const result = db
        .prepare("DELETE FROM owners WHERE target_id=? AND token=? AND pid=?")
        .run(target, token, process.pid);
      if (result.changes !== 1)
        throw new SetupError("model枠の所有権が一致しません。");
      released = true;
    } finally {
      db.close();
    }
  };
}

/** 同じtransactionで呼び、対話/Run/手動Workerの枠を一貫したsnapshotで判定する。 */
export function sharedCapacity(db: DatabaseSync, group: string, limit: number) {
  const models = db
      .prepare("SELECT target_id FROM owners WHERE target_id LIKE 'model:%'")
      .all(),
    reservations = db.prepare("SELECT * FROM run_reservations").all(),
    manual = db
      .prepare(
        "SELECT payload FROM session_documents WHERE json_type(payload,'$.activeWorker')='object'",
      )
      .all()
      .map((row) => JSON.parse(String(row.payload)).activeWorker);
  const sameModels = models.filter((row) =>
      String(row.target_id).startsWith(`model:${encodeURIComponent(group)}:`),
    ),
    sameRuns = reservations.filter((row) => row.quota_group === group),
    sameManual = manual.filter(
      (worker) => !worker.quotaGroup || worker.quotaGroup === group,
    );
  const effective = Math.min(
    limit,
    ...sameModels.map(
      (row) => Number(String(row.target_id).split(":")[2]) || 1,
    ),
    ...sameRuns.map((row) => {
      const metadata = (JSON.parse(String(row.resources)) as string[]).find(
        (value) => value.startsWith("@quota/"),
      );
      return metadata ? Number(metadata.split("/").at(-1)) || 1 : 1;
    }),
    ...sameManual.map((worker) => worker.quotaLimit ?? 1),
  );
  return {
    total: models.length + reservations.length + manual.length,
    groupUsed: sameModels.length + sameRuns.length + sameManual.length,
    limit: effective,
    reservations,
  };
}

export function recoverModelSlots(stateDir: string, confirmed = false) {
  if (!existsSync(join(stateDir, "state.sqlite")))
    throw new SetupError("状態DBがありません。");
  const release = acquireLock(stateDir),
    db = new DatabaseSync(join(stateDir, "state.sqlite"), { timeout: 1000 });
  try {
    const results = [];
    for (const row of db
      .prepare(
        "SELECT target_id,token,pid FROM owners WHERE target_id LIKE 'model:%'",
      )
      .all()) {
      const pid = Number(row.pid);
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new SetupError("model枠のPID記録が不正です。");
      let absent = false;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") absent = true;
        else throw error;
      }
      if (absent && confirmed)
        db.prepare("DELETE FROM owners WHERE target_id=? AND token=?").run(
          row.target_id!,
          row.token!,
        );
      results.push({
        pid,
        processAbsent: absent,
        recovered: absent && confirmed,
      });
    }
    return {
      slots: results,
      usage: "preserved; resume performs pending-request reconciliation",
    };
  } finally {
    db.close();
    release();
  }
}
