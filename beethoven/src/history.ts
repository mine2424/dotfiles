import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { SessionStore } from "./session.js";
import { within } from "./workspace.js";

export type SavedMessage = {
  role: "user" | "assistant" | "system";
  text: string;
  model?: string;
  provider?: string;
  status?: string;
};
/** 履歴閲覧はmodelを起動せず、保存fileもrewrite/migrateしない。旧Pi会話は不足する応答の補完に使う。 */
export function savedConversation(stateDir: string, id: string) {
  const store = new SessionStore(stateDir, { readOnly: true });
  try {
    const data = store.load(id),
      turns = store.conversationTurns(id);
    const legacy = new Map<
      string,
      { text: string; model?: string; provider?: string }
    >();
    const warnings: string[] = [];
    if (turns.some((turn) => turn.response === null) && data.piFile) {
      try {
        const folder = join(stateDir, "sessions", id),
          file = data.piFile;
        if (
          !existsSync(file) ||
          !lstatSync(file).isFile() ||
          !within(realpathSync(stateDir), realpathSync(folder)) ||
          !within(realpathSync(folder), realpathSync(file)) ||
          statSync(file).size > 16 * 1024 * 1024
        )
          throw new Error("archive unavailable");
        const entries = parseSessionEntries(readFileSync(file, "utf8")).filter(
          (entry) => entry.type !== "session",
        );
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const branch = [];
        let current = entries.at(-1);
        const seen = new Set<string>();
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          branch.push(current);
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        const prompts = new Map<string, string[]>();
        for (const turn of turns) {
          const text = `${turn.plan_only ? "[このturnは計画・調査のみ。編集・shell・検証実行は禁止]\n" : ""}${turn.prompt}\n\n[現在のworkspace: ${turn.before_hash}。以前の会話とfileが違う可能性があるため編集前にreadする]`;
          prompts.set(text, [...(prompts.get(text) ?? []), String(turn.id)]);
        }
        let turnId: string | undefined;
        for (const entry of branch.reverse()) {
          if (entry.type !== "message") continue;
          const message = entry.message;
          if (message.role !== "user" && message.role !== "assistant") continue;
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n");
          if (message.role === "user") turnId = prompts.get(text)?.shift();
          else if (turnId && text) {
            const previous = legacy.get(turnId);
            legacy.set(turnId, {
              text: [previous?.text, text]
                .filter(Boolean)
                .join("\n\n")
                .slice(0, 256000),
              model: message.model,
              provider: message.provider,
            });
          }
        }
      } catch {
        warnings.push(
          "旧会話の応答を読み込めませんでした。保存済みpromptと結果は表示します。原本は変更していません。",
        );
      }
    }
    const messages: SavedMessage[] = [];
    for (const turn of turns) {
      if (typeof turn.prompt !== "string" || turn.prompt.startsWith("/"))
        continue;
      messages.push({ role: "user", text: turn.prompt });
      const fallback = legacy.get(String(turn.id));
      const response =
        typeof turn.response === "string" ? turn.response : fallback?.text;
      const execution =
        typeof turn.execution === "string" ? JSON.parse(turn.execution) : {};
      if (response)
        messages.push({
          role: "assistant",
          text: response,
          model: execution.model ?? fallback?.model,
          provider: execution.provider ?? fallback?.provider,
          status: String(turn.status),
        });
      if (turn.response_truncated)
        warnings.push(
          "長い応答は履歴表示用の保存上限で省略されています。Pi会話原本は保持しています。",
        );
    }
    if (data.lastRun)
      messages.push({
        role: "system",
        text: `前回の委譲Run: ${data.lastRun.id} · ${data.lastRun.status}\n統合候補: ${data.lastRun.directory}\nSHA: ${data.lastRun.sha ?? "未確定"}\n元workspaceへの適用・本人受入とは別の記録です。`,
      });
    return {
      sessionId: id,
      cwd: data.cwd,
      messages,
      warnings: [...new Set(warnings)],
    };
  } finally {
    store.close();
  }
}
