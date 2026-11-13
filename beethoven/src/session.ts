import { sharedCapacity } from "./resources.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { schemaVersion } from "./store.js";
import type { TurnResult } from "./pi.js";

export type PromptHistoryItem = {
  id: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  preview: string;
  model: string | null;
};
// 既存Turnも履歴へ含め、新しい入力eventと紐付いたTurnは二重表示しない。
const historyInputs = `WITH inputs AS (
 SELECT e.id,e.session_id,json_extract(e.payload,'$.text') AS prompt,e.created_at,e.seq AS ordering,
 json_extract(e.payload,'$.execution.model') AS model FROM events e WHERE e.type='prompt_submitted'
 UNION ALL
 SELECT t.id,t.session_id,json_extract(d.payload,'$.prompt'),t.created_at,t.rowid,
 COALESCE(json_extract(d.payload,'$.execution.model'),json_extract(d.payload,'$.outcome.execution.model'))
 FROM turns t JOIN turn_documents d ON d.turn_id=t.id
 WHERE json_type(d.payload,'$.prompt')='text' AND NOT EXISTS(
 SELECT 1 FROM events e WHERE e.id=json_extract(d.payload,'$.inputId') AND e.type='prompt_submitted')
)`;
export type SessionData = {
  id: string;
  cwd: string;
  connectionId: string;
  connectionHash: string;
  piFile: string | null;
  rulesHash: string;
  snapshotHash: string;
  workspaceHash: string;
  status:
    | "idle"
    | "responding"
    | "waiting_input"
    | "waiting_approval"
    | "interrupted"
    | "closed";
  createdAt: string;
  tokens: number;
  costUsd: number;
  usageUnknown: boolean;
  elapsedMs: number;
  hasSubscriptionUsage?: boolean;
  reservedUnknownTokens?: number;
  lastWorker?: {
    id: string;
    directory: string;
    status: string;
    model: string;
    changedFiles: string[];
    verification: unknown;
    integrated: false;
    pending?: { id: string; type: "question" | "approval"; message: string };
    continuations?: number;
  };
  lastRun?: { id: string; status: string; directory: string; sha?: string };
  activeRun?: {
    id: string;
    tokens: number;
    cost: number;
    elapsed: number;
    unknownTokens?: number;
  };
  activeWorker?: {
    id: string;
    directory: string;
    tokens: number;
    costUsd: number;
    startedAt: number;
    quotaGroup?: string;
    quotaLimit?: number;
  };
  planOnly: boolean;
  allowedPaths?: string[];
  approvals: Record<string, true>;
  pendingRequest?: { id: string; tokens: number; costUsd: number };
  runtime?: {
    pid: number;
    updatedAt: string;
    stage: string;
    provider: string;
    model: string;
  };
  pending?: { id: string; type: "question" | "approval"; message: string };
};

/** SQLiteが対話状態の正本。Pi会話fileとは参照で結び、会話本文から実行状態を推測しない。 */
export class SessionStore {
  private db: DatabaseSync;
  constructor(stateDir: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(join(stateDir, "state.sqlite"), {
      timeout: 1000,
      readOnly: options.readOnly ?? false,
    });
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
    if (
      Number(this.db.prepare("PRAGMA user_version").get()!.user_version) !==
      schemaVersion
    ) {
      this.db.close();
      throw new Error("DB schemaが一致しません。");
    }
  }
  close() {
    this.db.close();
  }
  load(id: string): SessionData {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Session IDが不正です。");
    const row = this.db
      .prepare("SELECT payload FROM session_documents WHERE session_id=?")
      .get(id);
    if (!row) throw new Error("Sessionが見つかりません。");
    return JSON.parse(String(row.payload)) as SessionData;
  }
  list() {
    return this.db
      .prepare(
        "SELECT id,cwd,status,created_at FROM sessions ORDER BY created_at DESC LIMIT 100",
      )
      .all();
  }
  recordPrompt(
    sessionId: string,
    text: string,
    execution: { model?: string; provider?: string; connectionId?: string },
  ) {
    if (
      !text.trim() ||
      text.startsWith("/") ||
      Buffer.byteLength(text) > 1024 * 1024
    )
      throw new Error("保存対象は1MiB以下のモデル向けpromptです。");
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO events(id,session_id,type,payload,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        sessionId,
        "prompt_submitted",
        JSON.stringify({ text, execution }),
        new Date().toISOString(),
      );
    return id;
  }
  promptHistory(
    cwd: string | null,
    query = "",
    limit = 200,
  ): PromptHistoryItem[] {
    const rows = this.db
      .prepare(
        historyInputs +
          ` SELECT i.id,i.session_id,s.cwd,i.created_at,substr(i.prompt,1,240) AS preview,i.model
      FROM inputs i JOIN sessions s ON s.id=i.session_id WHERE (? IS NULL OR s.cwd=?) AND instr(lower(i.prompt),lower(?))>0
      AND substr(i.prompt,1,1)!='/' ORDER BY i.created_at DESC,i.ordering DESC LIMIT ?`,
      )
      .all(cwd, cwd, query, Math.max(1, Math.min(200, limit)));
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      cwd: String(row.cwd),
      createdAt: String(row.created_at),
      preview: String(row.preview),
      model: row.model === null ? null : String(row.model),
    }));
  }
  historyPrompt(id: string, cwd: string | null) {
    const row = this.db
      .prepare(
        historyInputs +
          ` SELECT i.prompt FROM inputs i JOIN sessions s ON s.id=i.session_id WHERE i.id=? AND (? IS NULL OR s.cwd=?) LIMIT 1`,
      )
      .get(id, cwd, cwd);
    if (!row) throw new Error("prompt履歴が見つかりません。");
    return String(row.prompt);
  }
  editorHistory(cwd: string) {
    const rows = this.db
      .prepare(
        historyInputs +
          ` SELECT i.prompt FROM inputs i JOIN sessions s ON s.id=i.session_id
      WHERE s.cwd=? AND substr(i.prompt,1,1)!='/' AND length(i.prompt)<=65536 ORDER BY i.created_at DESC,i.ordering DESC LIMIT 100`,
      )
      .iterate(cwd);
    const prompts: string[] = [];
    let bytes = 0;
    for (const row of rows) {
      const text = String(row.prompt);
      bytes += Buffer.byteLength(text);
      if (bytes > 2 * 1024 * 1024) break;
      prompts.push(text);
    }
    return prompts;
  }
  recentSessions(cwd: string | null = null) {
    return this.db
      .prepare(
        `SELECT s.id,s.cwd,s.status,s.created_at,
      COALESCE((SELECT MAX(created_at) FROM events WHERE session_id=s.id),s.created_at) AS updated_at,
      (SELECT substr(json_extract(d.payload,'$.prompt'),1,160) FROM turns t JOIN turn_documents d ON d.turn_id=t.id WHERE t.session_id=s.id AND substr(json_extract(d.payload,'$.prompt'),1,1)!='/' ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) AS title,
      (SELECT COALESCE(json_extract(d.payload,'$.outcome.execution.model'),json_extract(d.payload,'$.execution.model')) FROM turns t JOIN turn_documents d ON d.turn_id=t.id WHERE t.session_id=s.id ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) AS model,
      (SELECT COALESCE(json_extract(d.payload,'$.outcome.execution.provider'),json_extract(d.payload,'$.execution.provider')) FROM turns t JOIN turn_documents d ON d.turn_id=t.id WHERE t.session_id=s.id ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) AS provider
      FROM sessions s WHERE (? IS NULL OR s.cwd=?) ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(cwd, cwd);
  }
  conversationTurns(id: string) {
    this.load(id);
    return this.db
      .prepare(
        `SELECT t.id,t.status,t.created_at,json_extract(d.payload,'$.prompt') AS prompt,
      json_extract(d.payload,'$.before.hash') AS before_hash,json_extract(d.payload,'$.planOnly') AS plan_only,
      json_extract(d.payload,'$.outcome.response') AS response,json_extract(d.payload,'$.outcome.responseTruncated') AS response_truncated,
      json_extract(d.payload,'$.outcome.execution') AS execution FROM turns t JOIN turn_documents d ON d.turn_id=t.id
      WHERE t.session_id=? ORDER BY t.created_at DESC,t.rowid DESC LIMIT 100`,
      )
      .all(id)
      .reverse();
  }
  unsettledRuns() {
    return this.db
      .prepare(
        "SELECT payload FROM session_documents WHERE json_type(payload,'$.activeRun')='object'",
      )
      .all()
      .map((row) => JSON.parse(String(row.payload)) as SessionData);
  }
  unsettledWorkers() {
    return this.db
      .prepare(
        "SELECT payload FROM session_documents WHERE json_type(payload, '$.activeWorker')='object'",
      )
      .all()
      .map((row) => JSON.parse(String(row.payload)) as SessionData);
  }
  hasProviderRequests(id: string) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM events WHERE session_id=? AND type='provider_request' LIMIT 1",
        )
        .get(id),
    );
  }
  providerProgress(id: string, afterSeq = 0) {
    const rows = this.db
      .prepare(
        "SELECT seq,type FROM events WHERE session_id=? AND seq>? AND type IN ('provider_request','provider_response') ORDER BY seq",
      )
      .all(id, afterSeq);
    return {
      requests: rows.filter((row) => row.type === "provider_request").length,
      responses: rows.filter((row) => row.type === "provider_response").length,
      lastSeq: rows.length ? Number(rows.at(-1)!.seq) : afterSeq,
    };
  }
  touchRuntime(session: SessionData) {
    this.db
      .prepare("UPDATE session_documents SET payload=? WHERE session_id=?")
      .run(JSON.stringify(session), session.id);
  }
  runtimeSessions() {
    return this.db
      .prepare(
        "SELECT payload FROM session_documents WHERE json_type(payload,'$.runtime')='object' OR rowid IN (SELECT rowid FROM session_documents ORDER BY rowid DESC LIMIT 100) ORDER BY rowid DESC",
      )
      .all()
      .map((row) => JSON.parse(String(row.payload)) as SessionData);
  }
  pendingWorkspaceProcesses(cwd: string) {
    const sessions = this.db
      .prepare("SELECT id FROM sessions WHERE cwd=?")
      .all(cwd);
    return sessions.flatMap((row) => this.pendingProcesses(String(row.id)));
  }
  pendingProcesses(id?: string) {
    const pending = new Set<number>();
    const query = `SELECT type,payload FROM events WHERE ${id ? "session_id=? AND " : ""}type IN ('process_started','process_finished') ORDER BY seq`;
    for (const row of this.db.prepare(query).all(...(id ? [id] : []))) {
      const payload = JSON.parse(String(row.payload)) as {
        pid: number;
        groupGone?: boolean;
      };
      if (row.type === "process_started") pending.add(payload.pid);
      else if (payload.groupGone) pending.delete(payload.pid);
    }
    return [...pending];
  }
  /** 状態とeventを同じtransactionで保存する。保存に失敗すれば呼出し側は実行を止める。 */
  save(session: SessionData, event: string, payload: unknown = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (event === "worker_reserved") {
        const worker = session.activeWorker!,
          capacity = sharedCapacity(
            this.db,
            worker.quotaGroup ?? "unknown",
            worker.quotaLimit ?? 1,
          );
        if (capacity.total >= 4 || capacity.groupUsed >= capacity.limit)
          throw new Error(
            "共有model予算枠が使用中です。実行中Session/Runを確認してください。",
          );
      }
      this.db
        .prepare(
          "INSERT INTO sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status",
        )
        .run(session.id, session.cwd, session.status, session.createdAt);
      this.db
        .prepare(
          "INSERT INTO session_documents VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload",
        )
        .run(session.id, JSON.stringify(session));
      this.event(session.id, event, payload);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  event(sessionId: string, type: string, payload: unknown) {
    this.db
      .prepare(
        "INSERT INTO events(id,session_id,type,payload,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        sessionId,
        type,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }
  beginTurn(session: SessionData, payload: unknown) {
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO turns VALUES(?,?,?,?)")
        .run(id, session.id, "responding", new Date().toISOString());
      this.db
        .prepare("INSERT INTO turn_documents VALUES(?,?)")
        .run(id, JSON.stringify(payload));
      session.status = "responding";
      this.saveInTransaction(session);
      this.event(session.id, "turn_started", { id });
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  finishTurn(
    session: SessionData,
    id: string,
    result: TurnResult,
    payload: unknown,
    status: string = result.status,
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE turns SET status=? WHERE id=? AND session_id=?")
        .run(status, id, session.id);
      const original = this.db
        .prepare("SELECT payload FROM turn_documents WHERE turn_id=?")
        .get(id);
      this.db
        .prepare("UPDATE turn_documents SET payload=? WHERE turn_id=?")
        .run(
          JSON.stringify({
            ...JSON.parse(String(original!.payload)),
            outcome: payload,
          }),
          id,
        );
      const tokens = result.usage
        ? result.usage.input +
          result.usage.output +
          result.usage.cacheRead +
          result.usage.cacheWrite
        : null;
      this.db
        .prepare("INSERT INTO usage_records VALUES(?,?,?,?,?)")
        .run(randomUUID(), id, tokens, null, result.usageSource);
      this.saveInTransaction(session);
      this.event(session.id, "turn_finished", { id, result });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** 異常終了したturnを成功へ変えない。再開前に中断状態を明示して保持する。 */
  interrupt(session: SessionData) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE turns SET status='interrupted' WHERE session_id=? AND status='responding'",
        )
        .run(session.id);
      session.status = "interrupted";
      this.saveInTransaction(session);
      this.event(session.id, "recovered_interrupted", {});
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private saveInTransaction(session: SessionData) {
    this.db
      .prepare("UPDATE sessions SET status=? WHERE id=?")
      .run(session.status, session.id);
    this.db
      .prepare("UPDATE session_documents SET payload=? WHERE session_id=?")
      .run(JSON.stringify(session), session.id);
  }
}
