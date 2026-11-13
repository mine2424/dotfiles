import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./files.js";

// DBの構造の版。CLI/設定JSONのschemaVersionとは別に管理する。
export const schemaVersion = 3;

export const runSchemaMigration = `BEGIN IMMEDIATE;
      CREATE TABLE runs (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE run_commands (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), input_hash TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE run_reservations (run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT NOT NULL, quota_group TEXT NOT NULL, tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, resources TEXT NOT NULL, PRIMARY KEY(run_id,task_id));
      CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id,created_at);
      CREATE INDEX IF NOT EXISTS events_by_session_time ON events(session_id,created_at);
      PRAGMA user_version = 3;
      COMMIT;`;

/** doctor向けの読取処理。未作成DBを新しく作らないようreadOnlyで開く。 */
export function readDatabaseVersion(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare("PRAGMA user_version").get()!.user_version);
  } finally {
    db.close();
  }
}

/**
 * 明示的なinitからだけ呼ぶ初期化・migrationの入口。
 * lock取得 → 既存版確認 → snapshot → transactionで構造変更、の順で処理する。
 */
export async function initializeStore(stateDir: string) {
  const release = acquireLock(stateDir);
  let db: DatabaseSync | undefined;
  try {
    const file = join(stateDir, "state.sqlite");
    // 保存先のリンクをたどって、別DBを意図せず変更することを避ける。
    if (
      existsSync(file) &&
      (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
    ) {
      throw new Error("DB保存先は通常のファイルが必要です。");
    }
    db = new DatabaseSync(file, { timeout: 1000 });
    chmodSync(file, 0o600);
    const version = Number(
      db.prepare("PRAGMA user_version").get()!.user_version,
    );
    // 古いCLIが新しい構造を壊さないよう拒否する。同じ版ならmigrationを繰り返さない。
    if (version > schemaVersion)
      throw new Error("このCLIより新しいDB schemaです。");
    // 外部キー検査は接続単位の設定。同期書込と合わせて、この接続で有効化する。
    db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    if (version === schemaVersion) return;
    // 既存migrationは変更せず順方向に追加する。SQLite backupで整合したsnapshotを作る。
    const snapshot = join(
      stateDir,
      `before-schema-${schemaVersion}-${Date.now()}.sqlite`,
    );
    await backup(db, snapshot);
    chmodSync(snapshot, 0o600);
    // 各tableは保存の土台。Agent実行・lease更新・Command処理そのものはまだ未実装。
    // 構造とuser_versionを同じtransactionで更新し、途中の版を残さない。
    if (version === 0)
      db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, session_id TEXT REFERENCES sessions(id), type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE control_requests (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE owners (target_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL, pid INTEGER NOT NULL, heartbeat_at TEXT NOT NULL);
      CREATE TABLE usage_records (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id), tokens INTEGER CHECK(tokens >= 0), cost_usd REAL CHECK(cost_usd >= 0), precision TEXT NOT NULL);
      CREATE TABLE artifacts (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes >= 0));
      PRAGMA user_version = 1;
      COMMIT;`);
    if (version < 2)
      db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE session_documents (session_id TEXT PRIMARY KEY REFERENCES sessions(id), payload TEXT NOT NULL);
      CREATE TABLE turn_documents (turn_id TEXT PRIMARY KEY REFERENCES turns(id), payload TEXT NOT NULL);
      PRAGMA user_version = 2;
      COMMIT;`);
    db.exec(runSchemaMigration);
    db.exec("PRAGMA journal_mode = WAL;");
    // migration後のDBを検査する。製品全体のbackup/restore検証とは別の確認。
    const result = db.prepare("PRAGMA integrity_check").get();
    if (result?.integrity_check !== "ok")
      throw new Error("DB整合性検査に失敗しました。");
  } finally {
    db?.close();
    release();
  } // 例外・同版での早期returnでも接続とlockを解放する。
}
