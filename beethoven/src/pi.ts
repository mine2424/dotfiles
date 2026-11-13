import type {
  AgentSession,
  AgentSessionEvent,
  JsonAgentSessionEvent,
  RpcClient,
} from "@earendil-works/pi-coding-agent";

// この段階では作成済みの評価sessionだけを受け取る。認証・起動・送信許可を暗黙に用意しない。
type PiEvent = AgentSessionEvent | JsonAgentSessionEvent;
type Disposition = "started" | "handled" | "queued";
type Failure =
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "provider_error"
  | "unknown";
export type TurnResult = {
  status: "completed" | "handled" | "queued" | "aborted" | "error" | "timeout";
  failure: Failure | null;
  settled: boolean;
  // Piが報告した値。subscriptionの実請求額やproviderの計測精度は保証しない。
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  usageSource: "pi_message_end" | "unavailable";
  toolErrors: number;
};
export type TurnEvent =
  | { type: "text"; delta: string }
  | {
      type: "tool_start" | "tool_end";
      id: string;
      name: string;
      target?: string;
      isError?: boolean;
    };

/** Piは文字列しか返さない場合があるため分類は推定。生のエラー本文は通常出力へ流さない。 */
export function classifyPiFailure(error: unknown): Failure {
  // 構造化されたHTTP status/codeを優先し、任意objectの本文を文字列化しない。
  if (error && typeof error === "object") {
    const data = error as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };
    const status = data.status ?? data.statusCode;
    if (status === 401 || status === 403) return "authentication";
    if (status === 429) return "rate_limit";
    if (
      status === 408 ||
      status === 504 ||
      data.code === "ETIMEDOUT" ||
      data.code === "UND_ERR_CONNECT_TIMEOUT"
    )
      return "timeout";
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (
    /\b(401|403)\b|unauthorized|authentication|invalid.*(?:key|token)|not authenticated|no api key/i.test(
      message,
    )
  )
    return "authentication";
  if (/\b429\b|rate.?limit|too many requests/i.test(message))
    return "rate_limit";
  if (/timeout|timed out|deadline/i.test(message)) return "timeout";
  return message ? "provider_error" : "unknown";
}

type TurnPort = {
  subscribe(listener: (event: PiEvent) => void): () => void;
  prompt(text: string): Promise<Disposition>;
  abort(): Promise<void>;
};

/** SDKはpromptがsettleまで待つ。preflightでhandled/queuedを区別してRPCと揃える。 */
export function sdkTurnAdapter(
  session: Pick<AgentSession, "subscribe" | "prompt" | "abort">,
  intentionalToolStop?: () => boolean,
) {
  return turnAdapter(
    {
      subscribe: (listener) => session.subscribe(listener),
      async prompt(text) {
        let disposition: Disposition = "started";
        await session.prompt(text, {
          expandPromptTemplates: false,
          preflightResult: (value) => {
            disposition = value;
          },
        });
        return disposition;
      },
      abort: () => session.abort(),
    },
    intentionalToolStop,
  );
}

/** 同版の公式RpcClientと、環境・process groupを所有するOwnedRpcClientで共通の契約。 */
export function rpcTurnAdapter(
  client: Pick<RpcClient, "onEvent" | "prompt" | "abort">,
) {
  return turnAdapter({
    subscribe: (listener) => client.onEvent(listener),
    prompt: (text) => client.prompt(text),
    abort: () => client.abort(),
  });
}

/** 1 adapterにつき1 turn。期限切れ後の停止が未確認なら再利用を拒否し、所有者の回収へ返す。 */
function turnAdapter(port: TurnPort, intentionalToolStop?: () => boolean) {
  let busy = false;
  let reusable = true;
  return {
    async run(
      text: string,
      options: {
        maxDurationMs: number;
        signal?: AbortSignal;
        onEvent?: (event: TurnEvent) => void;
      },
    ): Promise<TurnResult> {
      if (busy || !reusable)
        throw new Error("Pi adapterは実行中、または停止未確認です。");
      if (
        !Number.isSafeInteger(options.maxDurationMs) ||
        options.maxDurationMs < 1 ||
        options.maxDurationMs > 2_147_483_647
      ) {
        throw new Error("正の有限な実行期限を指定してください。");
      }
      if (options.signal?.aborted)
        return {
          status: "aborted",
          failure: null,
          settled: false,
          usage: null,
          usageSource: "unavailable",
          toolErrors: 0,
        };
      busy = true;
      let settled = false;
      let lastFailure: Failure | null = null;
      let lastStop = "";
      let messageIndex = 0;
      let assistantOpen = false;
      let accepted: Disposition | undefined;
      let settledStatus: TurnResult["status"] | undefined;
      let usageMissing = false;
      const usages = new Map<number, NonNullable<TurnResult["usage"]>>();
      const toolErrors = new Set<string>();
      let finish!: (status: TurnResult["status"]) => void;
      const completion = new Promise<TurnResult["status"]>((resolve) => {
        finish = resolve;
      });
      let requestedStop: "timeout" | "aborted" | undefined;
      const stop = (reason: "timeout" | "aborted") => {
        if (requestedStop) return;
        requestedStop = reason;
        // abort受付は停止の証明ではない。応答不能でも期限内に所有者へ制御を返す。
        void Promise.resolve()
          .then(() => port.abort())
          .catch(() => {});
        finish(reason);
      };
      const onAbort = () => stop("aborted");
      let unsubscribe = () => {};
      const timer = setTimeout(() => stop("timeout"), options.maxDurationMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        unsubscribe = port.subscribe((event) => {
          if (
            event.type === "message_start" &&
            event.message.role === "assistant"
          ) {
            messageIndex++;
            assistantOpen = true;
          }
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            options.onEvent?.({
              type: "text",
              delta: event.assistantMessageEvent.delta,
            });
          }
          if (
            event.type === "tool_execution_start" ||
            event.type === "tool_execution_end"
          ) {
            if (event.type === "tool_execution_end" && event.isError)
              toolErrors.add(event.toolCallId);
            const target =
              event.type === "tool_execution_start" &&
              event.args &&
              typeof event.args === "object"
                ? typeof event.args.path === "string"
                  ? event.args.path
                  : typeof event.args.command === "string"
                    ? event.args.command
                    : undefined
                : undefined;
            options.onEvent?.({
              type:
                event.type === "tool_execution_start"
                  ? "tool_start"
                  : "tool_end",
              id: event.toolCallId,
              name: event.toolName,
              ...(target ? { target: target.slice(0, 2000) } : {}),
              ...(event.type === "tool_execution_end"
                ? { isError: event.isError }
                : {}),
            });
          }
          if (
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            assistantOpen = false;
            const message = event.message;
            lastStop = message.stopReason;
            lastFailure =
              lastStop === "error"
                ? classifyPiFailure(message.errorMessage)
                : null;
            const usage = message.usage;
            // message_start単位で置換する。累積stream、agent_end、session統計は加算しない。
            if (
              messageIndex > 0 &&
              usage &&
              [
                usage.input,
                usage.output,
                usage.cacheRead,
                usage.cacheWrite,
              ].every((n) => Number.isFinite(n) && n >= 0) &&
              usage.input + usage.output + usage.cacheRead + usage.cacheWrite >
                0
            ) {
              usages.set(messageIndex, {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
              });
            } else usageMissing = true;
          }
          if (event.type === "agent_settled") {
            settled = true;
            settledStatus =
              requestedStop ??
              (event.aborted || lastStop === "aborted"
                ? "aborted"
                : lastFailure ||
                    !lastStop ||
                    lastStop === "length" ||
                    (lastStop === "toolUse" && !intentionalToolStop?.())
                  ? "error"
                  : "completed");
            if (accepted === "started") finish(settledStatus);
          }
        });
        // 購読を先に置き、受付応答より早い終了通知も取りこぼさない。
        void Promise.resolve()
          .then(() => (requestedStop ? undefined : port.prompt(text)))
          .then(
            (disposition) => {
              if (!disposition) return;
              accepted = disposition;
              if (disposition !== "started") finish(disposition);
              else if (settledStatus) finish(settledStatus);
            },
            (error) => {
              lastFailure = classifyPiFailure(error);
              finish("error");
            },
          );
        const status = await completion;
        reusable = settled || status === "handled";
        const usage =
          !usageMissing && !assistantOpen && usages.size > 0
            ? [...usages.values()].reduce(
                (total, item) => ({
                  input: total.input + item.input,
                  output: total.output + item.output,
                  cacheRead: total.cacheRead + item.cacheRead,
                  cacheWrite: total.cacheWrite + item.cacheWrite,
                }),
                { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              )
            : null;
        return {
          status,
          failure:
            status === "timeout"
              ? "timeout"
              : status === "error"
                ? (lastFailure ?? "unknown")
                : null,
          settled,
          usage,
          usageSource: usage ? "pi_message_end" : "unavailable",
          toolErrors: toolErrors.size,
        };
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        busy = false;
        // 購読やconsumerの例外でも、停止を確認していないadapterを再利用しない。
        if (!accepted && !settled) reusable = false;
      }
    },
  };
}
