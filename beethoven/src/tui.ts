import {
  Container,
  Editor,
  Input,
  SelectList,
  Markdown,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  CURSOR_MARKER,
  visibleWidth,
  isKeyRelease,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  type Component,
  type Terminal as PiTerminal,
} from "@earendil-works/pi-tui";
import {
  createTuiTheme,
  panelLines,
  splitRow,
  type TuiTheme,
} from "./tui-theme.js";
import { homedir } from "node:os";
import type { ExecutionActivity } from "./agent.js";
import type { WorkerState } from "./worker.js";
import type { MonitorSnapshot } from "./monitor.js";
import type { SavedMessage } from "./history.js";
import type { TurnEvent } from "./pi.js";

type SessionInfo = {
  sessionId?: string;
  connectionId?: string;
  provider?: string;
  model?: string;
  billing?: string;
  permission?: string;
  context?: {
    estimatedTokens: number | null;
    window: number;
    pressure: number | null;
  };
  limits?: { maxTokens: number };
  usage?: {
    tokens: number;
    reservedUnknownTokens?: number;
    unknown?: boolean;
    costUsd?: number | null;
  };
};
/** provider・tool・file名の制御文字を画面制御として実行させない。 */
export function screenText(text: string) {
  return stripTerminalSequences(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\t/g, "  ");
}
const stageLabel = (stage: string) =>
  (
    ({
      waiting_input: "回答待ち",
      waiting_approval: "承認待ち",
      context_pressure: "会話の容量注意",
      tool_loop_detected: "反復を停止",
      snapshot: "作業コピー準備",
      starting: "起動中",
      preflight: "事前検証",
      model: "モデル応答中",
      tool_start: "ツール実行中",
      tool_end: "ツール完了",
      verify: "検証中",
      interaction: "質問・承認待ち",
      process_started: "コマンド実行中",
      process_finished: "コマンド終了",
      provider_response: "使用量記録",
      completed: "応答完了",
      candidate: "候補確認待ち",
      verification_failed: "検証失敗",
      tool_failed: "ツール失敗",
      stopping: "停止処理中",
      aborted: "中断",
      failed: "失敗",
      blocked: "確認待ち",
      timeout: "期限切れ",
      stop_unconfirmed: "停止未確認",
      recovered_unknown: "復旧済・使用量欠測",
    }) as Record<string, string>
  )[stage] ?? stage;
class Chrome implements Component {
  constructor(
    private content: (width: number) => string[],
    private surface: (line: string) => string = (line) => line,
  ) {}
  invalidate() {}
  render(width: number) {
    return this.content(width).map((line) => {
      const fit = truncateToWidth(line, Math.max(1, width), "");
      return this.surface(
        fit + " ".repeat(Math.max(0, width - visibleWidth(fit))),
      );
    });
  }
}
class BrandedEditor extends Editor {
  constructor(
    tui: TuiAltScreen,
    private brand: TuiTheme,
    private label: () => string,
  ) {
    super(
      tui,
      {
        borderColor: brand.gold,
        selectList: {
          selectedPrefix: brand.gold,
          selectedText: brand.bold,
          description: brand.muted,
          scrollInfo: brand.muted,
          noMatch: brand.muted,
        },
      },
      { paddingX: 2 },
    );
  }
  protected override renderTopBorder(width: number, hidden: number) {
    if (hidden) return super.renderTopBorder(width, hidden);
    const label = truncateToWidth(
      ` ${this.label()} `,
      Math.max(0, width - 4),
      "",
    );
    return (this.focused ? this.brand.gold : this.brand.line)(
      `╭─${label}${"─".repeat(Math.max(0, width - visibleWidth(label) - 2))}`,
    );
  }
  protected override renderBottomBorder(width: number, hidden: number) {
    return hidden
      ? super.renderBottomBorder(width, hidden)
      : this.brand.line(`╰${"─".repeat(Math.max(0, width - 1))}`);
  }
  override render(width: number) {
    // Pi deliberately leaves fake cursors on unfocused editors. A modal owns focus here.
    return super
      .render(width)
      .map((line) =>
        this.brand.surface(
          this.focused ? line : line.replace(/\x1b_pi:\/?fc\x07/g, ""),
        ),
      );
  }
}

/** 入力はPiのEditorへ任せ、実行状態の正本はAgentから受け取る。
 * 通常入力のqueueと、表示後の回答だけを受け取る承認・質問を分離する。 */
export class TuiTerminal {
  readonly tui: TuiAltScreen;
  readonly editor: Editor;
  private readonly theme = createTuiTheme();
  private viewport: PiTerminal;
  private transcript = new Container();
  private queue: string[] = [];
  private waiter?: (text: string | null) => void;
  private closed = false;
  private info: SessionInfo = {};
  private turnInfo: SessionInfo = {};
  private actor = "Beethoven";
  private phase = "入力待ち";
  private executionPaused = false;
  private activityState = "制御: 入力待ち → Agent → ツール → 検証";
  private workerState?: WorkerState;
  private runId?: string;
  private taskStates = new Map<string, WorkerState>();
  private taskResponses = new Map<
    string,
    { text: string; component: Markdown }
  >();
  private question = "";
  private assistant?: Markdown;
  private response = "";
  private toolRows = new Map<string, Text>();
  private paste?: string[];
  private selectionCancel?: () => void;
  private secretCancel?: () => void;
  private stopped = false;
  onMonitor?: () => void;
  onInterrupt: () => void = () => this.cancel();
  constructor(
    private cwd: string,
    terminal: PiTerminal = new ProcessTerminal(),
  ) {
    this.tui = new TuiAltScreen(terminal, true, undefined, {
      mouse: true,
      copyOnSelect: false,
      scrollToEndIndicator: () => "最新の応答へ",
    });
    this.viewport = terminal;
    const t = this.theme;
    this.editor = new BrandedEditor(this.tui, t, () =>
      this.question
        ? "REPLY · 回答"
        : this.paste
          ? "MULTILINE · 複数行"
          : "MESSAGE · メッセージ",
    );
    const header = new Chrome((width) => {
      const home = homedir();
      const cwd =
        this.cwd === home || this.cwd.startsWith(home + "/")
          ? "~" + this.cwd.slice(home.length)
          : this.cwd;
      const wordmark = `  ${t.gold("✦")}  ${t.bold(t.ink("beethoven"))}`;
      const model = screenText(this.info.model ?? "接続を設定してください");
      const provider = this.info.provider
        ? ` · ${screenText(this.info.provider)}`
        : "";
      const permission =
        this.info.permission === "read-only"
          ? "読み取り専用"
          : this.info.permission === "workspace-write"
            ? "編集可"
            : "送信なし";
      const account = `${this.info.billing ?? "未接続"} · ${permission}`;
      const lines = [
        splitRow(
          wordmark,
          width >= 68 ? t.muted("AI DEVELOPS IN HARMONY  ") : "",
          width,
        ),
        splitRow(
          `     ${t.bold(model)}${t.muted(provider)}`,
          t.muted(account + "  "),
          width,
        ),
      ];
      if (terminal.rows >= 18)
        lines.push(
          splitRow(
            `     ${t.muted(screenText(cwd))}`,
            this.info.sessionId
              ? t.muted(`SESSION ${this.info.sessionId.slice(0, 8)}  `)
              : "",
            width,
          ),
        );
      lines.push(t.line("─".repeat(width)));
      return lines;
    }, t.surface);
    const status = new Chrome((width) => {
      const usage = this.info.usage;
      const tokens = `token ${usage?.tokens.toLocaleString() ?? "0"} / ${this.info.limits?.maxTokens.toLocaleString() ?? "未設定"}`;
      const reservation = usage?.reservedUnknownTokens
        ? ` + 留保 ${usage.reservedUnknownTokens}`
        : "";
      const missing = usage?.unknown ? " · 欠測あり" : "";
      const cost =
        typeof usage?.costUsd === "number"
          ? `USD ${usage.costUsd.toFixed(4)}`
          : "金額未確定";
      const state = ` ${t.gold("●")} ${t.bold(this.phase)}${this.queue.length ? t.muted(` · 待機中 ${this.queue.length}件`) : ""}`;
      const stateLabel = state + (missing ? t.gold(missing) : "");
      const context = this.info.context?.pressure;
      const details = t.muted(
        `${tokens}${reservation}${context !== null && context !== undefined && width >= 110 ? ` · 会話~${Math.round(context * 100)}%` : ""} · ${cost} `,
      );
      if (visibleWidth(stateLabel) + visibleWidth(details) + 3 <= width)
        return [splitRow(stateLabel, details, width)];
      if (terminal.rows >= 18)
        return [
          splitRow(stateLabel, t.muted(cost + " "), width),
          `   ${t.muted(tokens + reservation)}`,
        ];
      return [
        splitRow(
          stateLabel,
          t.muted(`${usage?.tokens.toLocaleString() ?? "0"} token `),
          width,
        ),
      ];
    });
    const execution = new Chrome((width) => {
      if (this.runId) {
        const states = [...this.taskStates.entries()];
        return [
          ` ${t.gold("◇")} Run ${this.runId.slice(0, 8)} · ${states.length} Task · Ctrl+O セッション`,
          ...states
            .slice(-4)
            .map(
              ([id, s]) =>
                `   ${t.bold(id)} · ${screenText(stageLabel(s.stage))} · ${screenText(s.provider)}/${screenText(s.model)}${s.pid ? " · PID " + s.pid : ""}`,
            ),
        ];
      }

      if (!this.workerState)
        return [
          splitRow(
            ` ${t.gold("◇")} ${screenText(this.activityState)}`,
            t.muted("Worker: 未起動 "),
            width,
          ),
        ];
      const w = this.workerState;
      return [
        ` ${t.gold("◇")} ${screenText(this.activityState)}`,
        `   ${t.bold(`Worker ${w.id.slice(0, 8)}`)} · ${t.gold(stageLabel(w.stage))} · ${screenText(w.provider)}/${screenText(w.model)}${w.pid ? t.muted(` · PID ${w.pid}`) : ""}`,
      ];
    });
    this.tui.setLayoutRoot(
      new VStack([
        {
          component: header,
          basis: "auto",
          shrink: 0,
          visible: (viewport) => viewport.height >= 12,
        },
        {
          component: new ScrollView(this.transcript, {
            follow: "end",
            primary: true,
            scrollbar: "auto",
          }),
          basis: 0,
          grow: 1,
          minSize: 1,
        },
        {
          component: execution,
          basis: "auto",
          shrink: 0,
          visible: (viewport) => viewport.height >= 18,
        },
        { component: status, basis: "auto", shrink: 0 },
        {
          component: new Chrome(() => [
            ` ${this.question ? t.gold(this.question) : t.muted(this.paste ? "複数行入力: 単独の . で送信" : "依頼を入力してください · /connect 接続 · Ctrl+O セッション")}`,
          ]),
          basis: 1,
          shrink: 0,
        },
        {
          component: this.editor,
          basis: "auto",
          minSize: 3,
          maxSize: 8,
          shrink: 1,
        },
        {
          component: new Chrome((width) => [
            width >= 72
              ? ` ${t.gold("Enter")} 送信   ${t.gold("Shift+Enter / Ctrl+J")} 改行   ${t.gold("Ctrl+C")} 中断   ${t.gold("Ctrl+R")} 履歴   ${t.gold("/help")} 操作一覧`
              : ` ${t.gold("Enter")} 送信 · ${t.gold("Ctrl+C")} 中断 · ${t.gold("/help")}`,
          ]),
          basis: 1,
          shrink: 0,
          visible: (viewport) => viewport.height >= 8,
        },
      ]),
    );
    this.editor.onSubmit = (text) => this.submit(text);
    this.tui.addInputListener((data) => {
      if (isKeyRelease(data)) return { consume: true };
      if (
        matchesKey(data, "ctrl+o") &&
        !this.question &&
        !this.selectionCancel &&
        !this.secretCancel &&
        !this.closed
      ) {
        this.onMonitor?.();
        return { consume: true };
      }
      if (
        matchesKey(data, "ctrl+r") &&
        !this.question &&
        !this.selectionCancel &&
        !this.secretCancel &&
        !this.closed
      ) {
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = undefined;
          waiter("/history");
        } else this.queue.push("/history");
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) {
        this.onInterrupt();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && !this.editor.getText()) {
        this.closed = true;
        this.cancel();
        this.onInterrupt();
        return { consume: true };
      }
      return undefined;
    });
    this.tui.setFocus(this.editor);
    this.tui.start();
  }
  private submit(text: string) {
    if (this.closed) return;
    if (Buffer.byteLength(text) > 1024 * 1024) {
      this.message("入力は1MiB以下にしてください。");
      return;
    }
    this.editor.setText("");
    if (!this.question && text === "/paste") {
      this.paste = [];
      this.tui.requestRender();
      return;
    }
    if (this.paste && !this.question) {
      if (text !== ".") {
        this.paste.push(text);
        return;
      }
      text = this.paste.join("\n");
      this.paste = undefined;
    }
    if (!this.question && !text.startsWith("/")) this.editor.addToHistory(text);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(text);
    } else {
      this.queue.push(text);
      this.tui.requestRender();
    }
  }
  private next(fresh = false) {
    if (this.closed) return Promise.resolve(null);
    if (!fresh && this.queue.length) {
      const text = this.queue.shift()!;
      this.tui.requestRender();
      return Promise.resolve(text);
    }
    if (this.waiter) throw new Error("入力要求が重複しました。");
    return new Promise<string | null>((resolve) => {
      this.waiter = resolve;
    });
  }
  prompt() {
    this.phase = this.executionPaused ? "実行停止中" : "入力待ち";
    this.tui.requestRender();
    return this.next();
  }
  async ask(message: string, approval = false) {
    if (this.selectionCancel) {
      this.selectionCancel();
      await Promise.resolve();
    }
    const draft = this.editor.getExpandedText();
    const phase = this.phase;
    this.editor.setText("");
    this.question = approval
      ? "承認待ち: yes で許可、それ以外で取消"
      : "質問への回答";
    this.phase = approval ? "承認待ち" : "回答待ち";
    this.message(message, approval ? "確認" : "質問");
    try {
      return await this.next(true);
    } finally {
      this.question = "";
      this.phase = phase;
      this.editor.setText(draft);
      this.tui.requestRender();
    }
  }
  async approve(message: string) {
    return (await this.ask(message, true)) === "yes";
  }
  /** 秘密値は別Inputで受け取り、renderer・会話・Editor履歴へ一度も渡さない。 */
  async secret(message: string): Promise<string | null> {
    if (this.selectionCancel) {
      this.selectionCancel();
      await Promise.resolve();
    }
    if (this.waiter || this.selectionCancel || this.secretCancel)
      throw new Error("入力要求が重複しました。");
    const input = new Input();
    let resolve!: (value: string | null) => void;
    const completion = new Promise<string | null>((done) => {
      resolve = done;
    });
    this.secretCancel = () => resolve(null);
    input.onSubmit = (value) => resolve(value);
    input.onEscape = () => resolve(null);
    const component = {
      focused: false,
      invalidate() {},
      render: (width: number) => {
        input.focused = component.focused;
        const size = Math.max(1, width - 6);
        // Pi Inputのcursor位置だけを参照し、元の行は返さない。
        const raw = input.render(size)[0] ?? "";
        const index = raw.indexOf(CURSOR_MARKER);
        const cursor =
          index < 0
            ? 0
            : visibleWidth(stripTerminalSequences(raw.slice(0, index)));
        const length = Math.min(
          visibleWidth(input.getValue()),
          Math.max(0, size - 1),
        );
        const before = Math.min(cursor, length);
        return panelLines(
          "PRIVATE · 認証",
          [
            "",
            ...new Text(screenText(message), 1, 0).render(
              Math.max(1, width - 4),
            ),
            "",
            ` ${"*".repeat(before)}${component.focused ? CURSOR_MARKER : ""}${"*".repeat(Math.max(0, length - before))}${" ".repeat(Math.max(0, size - length))}`,
            "",
            this.theme.muted(" 入力内容は表示・履歴保存しません。"),
            this.theme.muted(" Enter 決定 / Esc 取消"),
          ],
          width,
          this.theme,
        );
      },
      handleInput: (data: string) => {
        const previous = input.getValue();
        input.handleInput(data);
        if (Buffer.byteLength(input.getValue()) > 65536)
          input.setValue(previous);
        this.tui.requestRender();
      },
    };
    const overlay = this.tui.showOverlay(component, {
      width: "90%",
      anchor: "center",
      maxHeight: "90%",
    });
    try {
      return await completion;
    } finally {
      input.setValue("");
      input.onSubmit = undefined;
      this.secretCancel = undefined;
      overlay.hide();
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
    }
  }
  /** 検索と上下キーで選択できる共通picker。Enterだけで番号やIDの転記を不要にする。 */
  async select(
    title: string,
    items: { value: string; label: string; description?: string }[],
  ): Promise<string | null> {
    if (this.selectionCancel || this.waiter)
      throw new Error("入力要求が重複しました。");
    const draft = this.editor.getExpandedText();
    const filter = new Input({
      prompt: "検索: ",
      placeholder: "文字を入力して絞り込み",
    });
    const candidates = items.map((item) => ({
      ...item,
      label: screenText(item.label),
      description: item.description ? screenText(item.description) : undefined,
    }));
    const makeList = (query: string) =>
      new SelectList(
        candidates.filter((item) =>
          `${item.label} ${item.description ?? ""} ${item.value}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        ),
        Math.max(1, Math.min(7, this.viewport.rows - 10)),
        {
          selectedPrefix: this.theme.gold,
          selectedText: this.theme.bold,
          description: this.theme.muted,
          scrollInfo: this.theme.muted,
          noMatch: this.theme.muted,
        },
      );
    let list = makeList("");
    const container = new Container();
    container.addChild(filter);
    container.addChild(new Text("", 0, 0));
    container.addChild({
      render: (width) => list.render(width),
      invalidate: () => list.invalidate(),
    });
    container.addChild(
      new Text(this.theme.muted("↑↓ 選択 · Enter 決定 · Esc 取消"), 0, 1),
    );
    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>((done) => {
      resolve = done;
    });
    this.selectionCancel = () => resolve(null);
    list.onSelect = (item) => resolve(item.value);
    list.onCancel = () => resolve(null);
    const component = {
      focused: false,
      invalidate: () => container.invalidate(),
      render: (width: number) => {
        filter.focused = component.focused;
        return panelLines(
          screenText(title),
          container.render(Math.max(1, width - 4)),
          width,
          this.theme,
        );
      },
      handleInput: (data: string) => {
        if (matchesKey(data, "escape")) {
          resolve(null);
          return;
        }
        if (
          (["up", "down", "enter"] as const).some((key) =>
            matchesKey(data, key),
          )
        )
          list.handleInput(data);
        else {
          filter.handleInput(data);
          list = makeList(filter.getValue());
          list.onSelect = (item) => resolve(item.value);
          list.onCancel = () => resolve(null);
        }
        this.tui.requestRender();
      },
    };
    const overlay = this.tui.showOverlay(component, {
      width: "90%",
      maxHeight: "90%",
      anchor: "center",
    });
    try {
      return await promise;
    } finally {
      overlay.hide();
      this.selectionCancel = undefined;
      this.editor.setText(draft);
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
    }
  }
  async monitor(read: () => MonitorSnapshot): Promise<string | null> {
    if (this.selectionCancel || this.secretCancel || this.question)
      throw new Error("入力要求が重複しました。");
    const draft = this.editor.getExpandedText();
    let selected = 0,
      snapshot = read(),
      error = false,
      resolve!: (id: string | null) => void;
    const completion = new Promise<string | null>((done) => {
      resolve = done;
    });
    this.selectionCancel = () => resolve(null);
    const component = {
      focused: false,
      invalidate: () => {},
      render: (width: number) => {
        const nodes = snapshot.nodes,
          lines: string[] = [];
        const live = nodes.filter((n) => n.live === "live").length,
          waiting = nodes.filter((n) =>
            /waiting|blocked/.test(n.status),
          ).length;
        lines.push(
          this.theme.gold(
            `稼働 ${live} · 確認待ち ${waiting} · 全${nodes.length}ノード`,
          ),
          ...(this.viewport.rows < 12
            ? []
            : [
                this.theme.muted(
                  error
                    ? "更新失敗 · 最後に取得した状態を表示"
                    : `更新 ${new Date(snapshot.updatedAt).toLocaleTimeString()} · 1秒間隔`,
                ),
                "",
              ]),
        );
        const columns = width >= 94 ? 2 : 1,
          cardWidth = Math.floor((width - 4 - (columns - 1) * 2) / columns),
          perPage = Math.max(
            columns,
            Math.floor(
              (this.viewport.rows - 10) / (this.viewport.rows < 18 ? 3 : 6),
            ) * columns,
          ),
          start = Math.floor(selected / perPage) * perPage;
        if (!nodes.length)
          lines.push("保存済み・稼働中のセッションはありません。");
        for (
          let row = start;
          row < Math.min(nodes.length, start + perPage);
          row += columns
        ) {
          const cards = nodes
            .slice(row, row + columns)
            .map((n, col) =>
              panelLines(
                `${selected === row + col ? "› " : ""}${n.kind.toUpperCase()} ${n.id.slice(-14)}`,
                this.viewport.rows < 18
                  ? [
                      `${n.live === "live" ? "●" : "○"} ${n.status} · ${screenText(n.title)}`,
                    ]
                  : [
                      `${n.live === "live" ? "●" : n.live === "unknown" ? "?" : "○"} ${n.status} · ${n.live}${n.pid ? " · PID " + n.pid : ""}`,
                      screenText(n.title).replace(/\n/g, " "),
                      this.theme.muted(screenText(n.model ?? n.detail ?? "")),
                      this.theme.muted(screenText(n.cwd)),
                    ],
                cardWidth,
                this.theme,
              ).map((line) =>
                selected === row + col ? this.theme.gold(line) : line,
              ),
            );
          for (let line = 0; line < cards[0]!.length; line++)
            lines.push(
              cards
                .map((card) => card[line] ?? " ".repeat(cardWidth))
                .join("  "),
            );
        }
        const node = nodes[selected],
          dependencies = node
            ? snapshot.edges.filter(
                (e) => e.to === node.id && e.kind !== "owns",
              )
            : [];
        lines.push(
          ...(this.viewport.rows < 12
            ? []
            : [
                "",
                this.theme.muted(
                  dependencies.length
                    ? "依存: " +
                        dependencies
                          .map(
                            (e) =>
                              e.from.split(":").at(-1) +
                              " → " +
                              node!.id.split(":").at(-1) +
                              " (" +
                              e.kind +
                              ")",
                          )
                          .join(" / ")
                    : (node?.detail ?? ""),
                ),
              ]),
          this.theme.muted("Esc 戻る · ↑↓←→ 選択 · Enter 詳細"),
        );
        return panelLines(
          "SESSIONS · セッションマップ",
          lines,
          width,
          this.theme,
        );
      },
      handleInput: (data: string) => {
        if (matchesKey(data, "escape")) {
          resolve(null);
          return;
        }
        if (matchesKey(data, "enter")) {
          resolve(snapshot.nodes[selected]?.id ?? null);
          return;
        }
        const columns = Math.floor(this.viewport.columns * 0.98) >= 94 ? 2 : 1;
        const movement = matchesKey(data, "up")
          ? -columns
          : matchesKey(data, "down")
            ? columns
            : matchesKey(data, "left")
              ? -1
              : matchesKey(data, "right")
                ? 1
                : 0;
        selected = Math.max(
          0,
          Math.min(snapshot.nodes.length - 1, selected + movement),
        );
        this.tui.requestRender();
      },
    };
    const overlay = this.tui.showOverlay(component, {
      width: "98%",
      maxHeight: "96%",
      anchor: "center",
    });
    const timer = setInterval(() => {
      try {
        const id = snapshot.nodes[selected]?.id;
        snapshot = read();
        selected = Math.max(
          0,
          snapshot.nodes.findIndex((n) => n.id === id),
        );
        error = false;
      } catch {
        error = true;
      }
      this.tui.requestRender();
    }, 1000);
    timer.unref();
    try {
      return await completion;
    } finally {
      clearInterval(timer);
      overlay.hide();
      this.selectionCancel = undefined;
      this.editor.setText(draft);
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
    }
  }
  cancel() {
    this.secretCancel?.();
    this.selectionCancel?.();
    this.paste = undefined;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(null);
    }
  }
  activity(activity: ExecutionActivity) {
    this.activityState = `制御 → ${stageLabel(activity.stage)}${activity.detail ? ` · ${activity.detail}` : ""}`;
    this.tui.requestRender();
  }
  worker(state: WorkerState) {
    this.workerState = { ...state };
    this.activityState = `制御 → 作業コピー → Worker → ツール → 検証 → 候補確認`;
    this.tui.requestRender();
  }
  loadInputHistory(prompts: string[]) {
    for (const prompt of [...prompts].reverse())
      this.editor.addToHistory(prompt);
  }
  recallPrompt(text: string) {
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error("promptが入力上限を越えています。");
    this.editor.setText(text);
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }
  restoreConversation(messages: SavedMessage[], sessionId: string) {
    this.transcript.clear();
    this.assistant = undefined;
    this.toolRows.clear();
    this.message(
      `Session ${sessionId} · 保存済み会話の末尾を表示しています。`,
      "会話を復元",
    );
    for (const message of messages.slice(-100)) {
      if (message.role === "system")
        this.message(message.text, "保存したRun結果");
      else if (message.role === "user") this.message(message.text, "あなた");
      else {
        this.transcript.addChild(
          new Text(
            this.theme.gold(
              `✦ Beethoven · ${screenText(message.provider ? `${message.provider}/${message.model ?? "未確認"}` : (message.model ?? "モデル記録なし"))}${message.status ? ` · ${screenText(message.status)}` : ""}`,
            ),
            2,
            0,
          ),
        );
        this.transcript.addChild(
          new Markdown(
            screenText(message.text).slice(0, 64000),
            2,
            1,
            this.theme.markdown,
          ),
        );
      }
    }
    this.trim();
    this.tui.requestRender();
  }
  startRun(id: string) {
    this.runId = id;
    this.taskStates.clear();
    this.taskResponses.clear();
    this.phase = "Run実行中";
    this.tui.requestRender();
  }
  runTask(taskId: string, state: WorkerState) {
    this.taskStates.set(taskId, { ...state });
    this.tui.requestRender();
  }
  taskEvent(taskId: string, event: TurnEvent) {
    if (event.type !== "text") {
      this.event({
        ...event,
        id: taskId + ":" + event.id,
        name: taskId + "/" + event.name,
      });
      return;
    }
    const state = this.taskStates.get(taskId),
      key = taskId + ":" + state?.id + ":" + (state?.continuations ?? 0);
    let response = this.taskResponses.get(key);
    if (!response) {
      this.transcript.addChild(
        new Text(
          this.theme.gold(
            `✦ Worker ${screenText(taskId)} · ${state ? screenText(state.provider + "/" + state.model) : "モデル未確認"}`,
          ),
          2,
          0,
        ),
      );
      const component = new Markdown("", 2, 1, this.theme.markdown);
      this.transcript.addChild(component);
      response = { text: "", component };
      this.taskResponses.set(key, response);
    }
    response.text = (response.text + screenText(event.delta)).slice(0, 64000);
    response.component.setText(response.text);
    this.trim();
    this.tui.requestRender();
  }
  setInfo(info: SessionInfo) {
    this.info = info;
    this.tui.requestRender();
  }
  snapshotInput() {
    return { queue: [...this.queue], draft: this.editor.getExpandedText() };
  }
  restoreInput(input: { queue: string[]; draft: string }) {
    this.queue = [...input.queue];
    this.editor.setText(input.draft);
    this.tui.requestRender();
  }
  setExecutionPaused(paused: boolean) {
    this.executionPaused = paused;
    this.phase = paused ? "実行停止中" : "入力待ち";
    this.tui.requestRender();
  }
  setPhase(phase: string) {
    this.phase = phase;
    this.tui.requestRender();
  }
  message(text: string, label = "案内") {
    const t = this.theme;
    const heading =
      label === "あなた"
        ? t.muted("› あなた")
        : t.gold(`◇ ${screenText(label)}`);
    this.transcript.addChild(
      new Text(`${t.bold(heading)}\n${screenText(text).slice(0, 64000)}`, 2, 1),
    );
    this.trim();
    this.tui.requestRender();
  }
  beginTurn(prompt: string, actor = "Beethoven") {
    this.runId = undefined;
    this.taskStates.clear();
    this.taskResponses.clear();
    this.actor = actor;
    this.turnInfo = { ...this.info };
    this.phase = "実行中";
    this.message(prompt, "あなた");
    this.response = "";
    this.transcript.addChild(
      new Text(this.theme.gold(`✦ ${this.actorLabel()}`), 2, 0),
    );
    this.assistant = new Markdown("", 2, 1, this.theme.markdown);
    this.transcript.addChild(this.assistant);
    this.tui.requestRender();
  }
  event(event: TurnEvent) {
    if (event.type === "text") {
      if (!this.assistant) {
        this.response = "";
        this.transcript.addChild(
          new Text(this.theme.gold(`✦ ${this.actorLabel()}`), 2, 0),
        );
        this.assistant = new Markdown("", 2, 1, this.theme.markdown);
        this.transcript.addChild(this.assistant);
      }
      this.response = (this.response + event.delta).slice(0, 64000);
      this.assistant?.setText(screenText(this.response));
    } else {
      this.assistant = undefined;
      const text = `${event.type === "tool_start" ? "実行中" : event.isError ? "失敗" : "完了"}  ${screenText(event.name)}${event.target ? ` · ${screenText(event.target)}` : ""}`;
      let row = this.toolRows.get(event.id);
      if (!row) {
        row = new Text("", 2, 0);
        this.toolRows.set(event.id, row);
        this.transcript.addChild(row);
      }
      row.setText(
        event.type === "tool_end" && event.isError
          ? this.theme.error(`× ${text}`)
          : event.type === "tool_end"
            ? this.theme.success(`✓ ${text}`)
            : this.theme.gold(`› ${text}`),
      );
    }
    this.trim();
    this.tui.requestRender();
  }
  private actorLabel() {
    return `${this.actor} · ${this.turnInfo.provider ? `${this.turnInfo.provider}/` : ""}${this.turnInfo.model ?? "model未確認"}${this.turnInfo.connectionId ? ` · ${this.turnInfo.connectionId}` : ""}`;
  }
  finishTurn(report: {
    status: string;
    blockedReason?: string | null;
    changedFiles?: string[];
    verification?: unknown;
    turnId?: string;
    execution?: SessionInfo;
  }) {
    const verification =
      report.verification &&
      typeof report.verification === "object" &&
      "status" in report.verification
        ? String(report.verification.status)
        : "未確認";
    this.phase =
      report.status === "completed"
        ? "入力待ち"
        : report.status === "aborted"
          ? "中断しました"
          : report.status === "blocked"
            ? "確認待ち"
            : "実行失敗";
    const executed = report.execution ?? this.turnInfo;
    this.message(
      `モデル: ${executed.provider ? `${executed.provider}/` : ""}${executed.model ?? "未確認"}${executed.connectionId ? ` · 接続 ${executed.connectionId}` : ""}\n状態: ${report.status}${report.blockedReason ? ` (${report.blockedReason})` : ""}\n検証: ${verification} · 変更: ${report.changedFiles?.join(", ") || "なし"}\n本人受入: 未確認${report.turnId ? ` · Turn ${report.turnId}` : ""}`,
      "実行結果",
    );
    this.assistant = undefined;
    this.toolRows.clear();
  }
  private trim() {
    // 会話の正本はSession。画面内の保持量だけを制限する。
    while (this.transcript.children.length > 200)
      this.transcript.removeChild(this.transcript.children[0]!);
  }
  close() {
    if (this.stopped) return;
    this.cancel();
    this.closed = true;
    this.stopped = true;
    this.editor.onSubmit = undefined;
    this.tui.stop();
  }
}
