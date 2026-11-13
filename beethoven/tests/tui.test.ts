import assert from "node:assert/strict";
import { test } from "node:test";
import {
  visibleWidth,
  type ProgramStatus,
  type Terminal,
} from "@earendil-works/pi-tui";
import { screenText, TuiTerminal } from "../src/tui.js";
import {
  loginInteraction,
  Terminal as LoginTerminal,
} from "../src/terminal.js";

class TestTerminal implements Terminal {
  columns = 90;
  rows = 26;
  kittyProtocolActive = false;
  stopped = false;
  input = (_text: string) => {};
  resize = () => {};
  output = "";
  start(input: (text: string) => void, resize: () => void) {
    this.input = input;
    this.resize = resize;
  }
  stop() {
    this.stopped = true;
  }
  write(text: string) {
    this.output += text;
  }
  async drainInput() {}
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_text: string) {}
  setProgress(_active: boolean) {}
  setProgramStatus(_status: ProgramStatus) {}
}
const enter = (terminal: TestTerminal, text: string) => {
  terminal.input(text);
  terminal.input("\r");
};
const screen = (ui: TuiTerminal) => {
  ui.tui.renderNow(true);
  return ui.tui.getScreenLines().map(screenText).join("\n");
};

test("Japanese multiline input, queued instructions and approval drafts stay separate", async () => {
  const terminal = new TestTerminal(),
    ui = new TuiTerminal("/fixture/日本語", terminal);
  try {
    const prompt = ui.prompt();
    terminal.input("数量を");
    terminal.input("\n");
    terminal.input("直す");
    terminal.input("\r");
    assert.equal(await prompt, "数量を\n直す");
    ui.beginTurn("修正する");
    enter(terminal, "次の依頼");
    terminal.input("承認前に編集中");
    const approval = ui.approve("host commandを実行しますか？");
    assert.equal(ui.editor.getText(), "");
    assert.match(screen(ui), /承認待ち/);
    enter(terminal, "yes");
    assert.equal(await approval, true);
    assert.equal(ui.editor.getText(), "承認前に編集中");
    assert.equal(await ui.prompt(), "次の依頼");
  } finally {
    ui.close();
  }
  assert.equal(terminal.stopped, true);
});

test("stream, tool failure, blocked verification and unknown usage remain visible through resize", () => {
  const terminal = new TestTerminal(),
    ui = new TuiTerminal("/fixture", terminal);
  try {
    ui.setInfo({
      model: "fixture-model",
      billing: "subscription",
      permission: "read-only",
      limits: { maxTokens: 20000 },
      usage: {
        tokens: 120,
        reservedUnknownTokens: 800,
        unknown: true,
        costUsd: null,
      },
    });
    ui.beginTurn("日本語の調査");
    ui.event({ type: "text", delta: "確認しています。\n" });
    ui.event({
      type: "tool_start",
      id: "read-1",
      name: "read",
      target: "cart.js",
    });
    ui.event({ type: "tool_end", id: "read-1", name: "read", isError: true });
    ui.event({ type: "text", delta: "承認が必要です。" });
    ui.finishTurn({
      status: "blocked",
      blockedReason: "approval_required",
      verification: { status: "blocked" },
      changedFiles: [],
    });
    const wide = screen(ui);
    assert.match(wide, /fixture-model/);
    assert.match(wide, /欠測あり/);
    assert.match(wide, /金額未確定/);
    assert.match(wide, /失敗.*read/);
    assert.match(wide, /検証: blocked/);
    terminal.columns = 32;
    terminal.rows = 12;
    terminal.resize();
    const narrow = screen(ui);
    assert.match(narrow, /確認待ち/);
    assert.match(narrow, /Enter/);
    assert.equal(ui.tui.getScreenLines().length, 12);
  } finally {
    ui.close();
  }
});

test("Ctrl-C cancels a question without consuming queued prompts; Ctrl-D restores terminal", async () => {
  const terminal = new TestTerminal(),
    ui = new TuiTerminal("/fixture", terminal);
  try {
    let interrupted = 0;
    ui.onInterrupt = () => {
      interrupted++;
      ui.cancel();
    };
    enter(terminal, "保存する追加指示");
    const answer = ui.ask("判断が必要です");
    terminal.input("\x03");
    assert.equal(await answer, null);
    assert.equal(interrupted, 1);
    assert.equal(await ui.prompt(), "保存する追加指示");
    const prompt = ui.prompt();
    terminal.input("\x04");
    assert.equal(await prompt, null);
  } finally {
    ui.close();
  }
  assert.ok(terminal.output.includes("\x1b[?1049l"));
});

test("untrusted terminal control sequences are removed from model and tool content", () => {
  assert.equal(
    screenText("日本語\x1b]52;c;c2VjcmV0\x07\x1b[2J\x1b[31m表示\x1b[0m\r\x00"),
    "日本語表示",
  );
});

test("connection picker filters providers and models, supports Escape, and preserves the input draft", async () => {
  const terminal = new TestTerminal(),
    ui = new TuiTerminal("/fixture", terminal);
  try {
    terminal.input("編集中の依頼");
    const selected = ui.select("接続先を選択", [
      { value: "openai", label: "Codex subscription" },
      { value: "openrouter", label: "OpenRouter API" },
    ]);
    terminal.input("OpenRouter");
    terminal.input("\r");
    assert.equal(await selected, "openrouter");
    assert.equal(ui.editor.getText(), "編集中の依頼");
    const cancelled = ui.select("モデルを選択", [
      { value: "fixture", label: "Fixture model" },
    ]);
    terminal.input("\x1b");
    assert.equal(await cancelled, null);
  } finally {
    ui.close();
  }
});

test("manual OAuth codes stay hidden and native auth choices accept numbers instead of internal IDs", async () => {
  const calls: string[] = [];
  const terminal = {
    secret: async () => {
      calls.push("hidden");
      return "test-only-code";
    },
    ask: async () => {
      calls.push("visible");
      return "2";
    },
    cancel() {},
  } as unknown as LoginTerminal;
  const interaction = loginInteraction(terminal, new AbortController().signal);
  await interaction.prompt({
    type: "manual_code",
    message: "Authorization code",
  });
  assert.deepEqual(calls, ["hidden"]);
  assert.equal(
    await interaction.prompt({
      type: "select",
      message: "Auth method",
      options: [
        { id: "browser", label: "Browser" },
        { id: "adc", label: "ADC" },
      ],
    }),
    "adc",
  );
});

test("TUI authentication masks secrets and retains conversation and renderer", async () => {
  const { tuiLoginInteraction } = await import("../src/auth-ui.js");
  const terminal = new TestTerminal(),
    ui = new TuiTerminal("/fixture", terminal);
  try {
    ui.message("保存される会話");
    terminal.input("編集中");
    const auth = tuiLoginInteraction(
      ui,
      new AbortController().signal,
      () => {},
    );
    const answer = auth.prompt({ type: "manual_code", message: "認証コード" });
    terminal.input("private-code-unique");
    assert.match(screen(ui), /\*{5}/);
    assert.ok(!terminal.output.includes("private-code-unique"));
    assert.equal(ui.editor.focused, false);
    assert.ok(
      ui.tui.getScreenLines().every((line) => !line.includes("\x1b[7m")),
    );
    terminal.input("\r");
    assert.equal(await answer, "private-code-unique");
    assert.equal(ui.editor.getText(), "編集中");
    assert.match(screen(ui), /保存される会話/);
    assert.ok(!terminal.output.includes("\x1b[?1049l"));
    const abort = new AbortController();
    const second = tuiLoginInteraction(ui, abort.signal, () => {}).prompt({
      type: "secret",
      message: "API key",
    });
    abort.abort();
    await assert.rejects(second);
    assert.equal(ui.editor.getText(), "編集中");
  } finally {
    ui.close();
  }
});
test("turn model stays attributed after changing selected model and worker status uses actual events", () => {
  const terminal = new TestTerminal(),
    ui = new TuiTerminal("/fixture", terminal);
  try {
    ui.setInfo({
      provider: "provider-A",
      model: "model-A",
      connectionId: "old",
    });
    ui.beginTurn("依頼");
    ui.setInfo({ provider: "provider-B", model: "model-B" });
    ui.event({ type: "text", delta: "回答" });
    ui.finishTurn({ status: "completed" });
    assert.match(screen(ui), /provider-A\/model-A/);
    ui.worker({
      id: "12345678",
      stage: "model",
      provider: "provider-B",
      model: "model-B",
      directory: "/private",
      startedAt: Date.now(),
      pid: 4321,
    });
    assert.match(screen(ui), /Worker 12345678.*model/);
    assert.match(screen(ui), /PID 4321/);
  } finally {
    ui.close();
  }
});

test("brand themes preserve keyboard focus, content, and width through compact Japanese layouts", () => {
  const previous = process.env.BEETHOVEN_THEME,
    previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    for (const mode of ["dark", "light", "mono"]) {
      process.env.BEETHOVEN_THEME = mode;
      const terminal = new TestTerminal(),
        ui = new TuiTerminal("/日本語/長いディレクトリ名/beethoven", terminal);
      try {
        ui.setInfo({
          model: "gpt-6.1-sol",
          provider: "openai-codex",
          billing: "subscription",
          permission: "workspace-write",
        });
        terminal.input("続けて確認");
        for (const [columns, rows] of [
          [120, 40],
          [80, 24],
          [32, 12],
          [20, 8],
        ]) {
          terminal.columns = columns!;
          terminal.rows = rows!;
          terminal.resize();
          const rendered = screen(ui);
          assert.match(rendered, /続けて確認/);
          assert.match(rendered, /Enter/);
          assert.equal(ui.tui.getScreenLines().length, rows);
          for (const line of ui.tui.getScreenLines())
            assert.ok(
              visibleWidth(line) <= columns!,
              `overflow ${mode} ${columns}x${rows}`,
            );
          if (columns! >= 80) {
            assert.match(rendered, /beethoven/);
            assert.match(rendered, /AI DEVELOPS IN HARMONY/);
          }
        }
        if (mode === "mono")
          assert.doesNotMatch(
            terminal.output,
            /\x1b\[(?:38|48);(?:2|5);[0-9;]+m/,
          );
        else assert.match(terminal.output, /\x1b\[38;2;/);
      } finally {
        ui.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.BEETHOVEN_THEME;
    else process.env.BEETHOVEN_THEME = previous;
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test("brand palettes maintain text and keyboard-accent contrast on dark and light panels", async () => {
  const { brandPalettes, createTuiTheme } = await import("../src/tui-theme.js");
  const luminance = (hex: string) =>
    [1, 3, 5]
      .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
      .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
  for (const palette of Object.values(brandPalettes)) {
    for (const token of ["ink", "muted", "gold", "success", "error"] as const) {
      const a = luminance(palette[token]),
        b = luminance(palette.surface);
      assert.ok(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5,
        `contrast ${token}`,
      );
    }
  }
  assert.equal(createTuiTheme({ COLORFGBG: "0;15" }).mode, "light");
  assert.equal(createTuiTheme({ COLORFGBG: "15;0" }).mode, "dark");
  assert.equal(createTuiTheme({ NO_COLOR: "1" }).gold("accent"), "accent");
});

test("persistent input history, Ctrl-R and recall preserve drafts and never auto-send", async () => {
  const terminal = new TestTerminal(),
    ui = new TuiTerminal("/fixture", terminal);
  try {
    ui.loadInputHistory(["最新の依頼", "古い依頼"]);
    terminal.input("\x1b[A");
    assert.equal(ui.editor.getText(), "最新の依頼");
    terminal.input("\x1b[A");
    assert.equal(ui.editor.getText(), "古い依頼");
    ui.recallPrompt("編集中\nの依頼");
    const prompt = ui.prompt();
    terminal.input("\x12");
    assert.equal(await prompt, "/history");
    assert.equal(ui.editor.getText(), "編集中\nの依頼");
    const picker = ui.select("履歴", [{ label: "保存した依頼", value: "id" }]);
    terminal.input("\x1b");
    assert.equal(await picker, null);
    assert.equal(ui.editor.getText(), "編集中\nの依頼");
    const search = ui.select("履歴", [
      { label: "保存した依頼", value: "opaque-uuid" },
    ]);
    terminal.input("した依頼");
    terminal.input("\r");
    assert.equal(await search, "opaque-uuid");
    ui.recallPrompt("  保存した依頼\n修正する  ");
    assert.equal(ui.editor.getText(), "  保存した依頼\n修正する  ");
    assert.deepEqual(ui.snapshotInput().queue, []);
    ui.restoreConversation(
      [
        { role: "user", text: "以前の質問" },
        {
          role: "assistant",
          text: "以前の回答",
          provider: "fixture",
          model: "old-model",
        },
      ],
      "saved-id",
    );
    assert.match(screen(ui), /以前の回答/);
    assert.match(screen(ui), /old-model/);
    terminal.input("\r");
    assert.equal(await ui.prompt(), "保存した依頼\n修正する");
  } finally {
    ui.close();
  }
});

test("live session map shows distinct states, dependency edges and models while preserving active input", async () => {
  const terminal = new TestTerminal(),
    ui = new TuiTerminal("/fixture", terminal);
  try {
    terminal.input("編集中の依頼");
    const prompt = ui.prompt();
    let opened = false;
    ui.onMonitor = () => {
      opened = true;
    };
    terminal.input("\x0f");
    assert.equal(opened, true);
    const selected = ui.monitor(() => ({
      updatedAt: new Date().toISOString(),
      nodes: [
        {
          id: "run",
          kind: "run",
          title: "機能追加",
          cwd: "/repo",
          status: "running",
          live: "live",
          pid: process.pid,
        },
        {
          id: "A",
          kind: "task",
          title: "API実装",
          cwd: "/repo",
          status: "waiting_input",
          live: "saved",
          model: "fixture/model",
          detail: "回答待ち",
        },
      ],
      edges: [{ from: "run", to: "A", kind: "code" }],
    }));
    assert.match(screen(ui), /SESSIONS/);
    assert.match(screen(ui), /waiting_input/);
    assert.match(screen(ui), /fixture\/model/);
    terminal.columns = 32;
    terminal.rows = 12;
    terminal.resize();
    assert.match(screen(ui), /Esc/);
    terminal.columns = 90;
    terminal.rows = 26;
    terminal.resize();
    terminal.input("\x1b[C");
    assert.match(screen(ui), /code/);
    terminal.input("\x1b");
    assert.equal(await selected, null);
    assert.equal(ui.editor.getText(), "編集中の依頼");
    terminal.input("\r");
    assert.equal(await prompt, "編集中の依頼");
  } finally {
    ui.close();
  }
});

test("parallel Worker streams keep their own model labels and opening a question closes monitor before accepting fresh input", async () => {
  const terminal = new TestTerminal(),
    ui = new TuiTerminal("/fixture", terminal);
  try {
    ui.startRun("run-id");
    ui.runTask("A", {
      id: "worker-A",
      stage: "model",
      model: "model-A",
      provider: "provider-A",
      directory: "/a",
      startedAt: 0,
    });
    ui.runTask("B", {
      id: "worker-B",
      stage: "model",
      model: "model-B",
      provider: "provider-B",
      directory: "/b",
      startedAt: 0,
    });
    ui.taskEvent("A", { type: "text", delta: "Aの応答" });
    ui.taskEvent("B", { type: "text", delta: "Bの応答" });
    const rendered = screen(ui);
    assert.match(rendered, /provider-A\/model-A/);
    assert.match(rendered, /provider-B\/model-B/);
    assert.match(rendered, /Aの応答/);
    assert.match(rendered, /Bの応答/);
    ui.editor.setText("編集中");
    const monitor = ui.monitor(() => ({
      nodes: [],
      edges: [],
      updatedAt: new Date().toISOString(),
    }));
    const approval = ui.approve("host実行");
    assert.equal(await monitor, null);
    await Promise.resolve();
    assert.equal(ui.editor.getText(), "");
    enter(terminal, "yes");
    assert.equal(await approval, true);
    assert.equal(ui.editor.getText(), "編集中");
  } finally {
    ui.close();
  }
});
