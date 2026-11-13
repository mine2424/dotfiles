import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionController } from "./controller.js";
import { openAgent } from "./agent.js";
import { Terminal, loginInteraction } from "./terminal.js";
import { readConnections, SetupError } from "./connections.js";
import { findRepository, inspectRules } from "./rules.js";
import { workspaceState, git } from "./workspace.js";
import type { Settings } from "./config.js";
import { authDirectory, loginConnection } from "./auth.js";
import { TuiTerminal } from "./tui.js";
import { loadConfig } from "./config.js";
import { connectionConsent } from "./connect.js";
import { savedConversation } from "./history.js";
import { SessionStore } from "./session.js";
import { tuiLoginInteraction } from "./auth-ui.js";
import { runWorker, listWorkers, workerStatus, workerLogs } from "./worker.js";

export type DialogueOptions = {
  json?: boolean;
  print?: boolean;
  plain?: boolean;
  resume?: string;
  connection?: string;
  send?: boolean;
  plan?: boolean;
  scope?: string[];
  "trust-repo-config"?: boolean;
};

export function selectedConnection(configFile: string, id?: string) {
  const profile = readConnections(
    join(dirname(configFile), "connections.json"),
    false,
  ).profile;
  if (!profile)
    throw new SetupError(
      "初回設定が必要です。beethoven setupで接続・model・上限を登録してください。",
      "setup_required",
    );
  const connection = profile.connections.find(
    (connection) => connection.id === (id ?? profile.defaultConnectionId),
  );
  if (!connection)
    throw new SetupError("接続IDが見つかりません。setupを確認してください。");
  return connection;
}

export async function runLogin(
  configFile: string,
  id?: string,
  shared?: TuiTerminal,
) {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new SetupError(
      "loginはローカル端末で実行してください。認証値を引数へ書かないでください。",
      "terminal_required",
    );
  const connection = selectedConnection(configFile, id);
  const terminal = shared ?? new Terminal();
  const previousInterrupt = terminal.onInterrupt;
  const controller = new AbortController();
  terminal.onInterrupt = () => {
    controller.abort();
    terminal.cancel();
  };
  const timer = setTimeout(() => {
    controller.abort();
    terminal.cancel();
  }, 5 * 60_000);
  try {
    const message = `${connection.id}: ${connection.provider}/${connection.model} (${connection.auth.method}, ${connection.billing.kind}) のloginを開始します。`;
    if (shared) shared.message(message, "接続認証");
    else process.stderr.write(message + "\n");
    return await loginConnection(
      configFile,
      connection,
      shared
        ? tuiLoginInteraction(shared, controller.signal)
        : loginInteraction(terminal as Terminal, controller.signal),
    );
  } finally {
    clearTimeout(timer);
    terminal.onInterrupt = previousInterrupt;
    if (!shared) terminal.close();
  }
}

/** TTYと--printで同じSessionを使い、非TTYの承認不足は保存してblockedへ戻す。 */
export async function runDialogue(
  locations: { configFile: string; stateDir: string },
  prompt: string,
  values: DialogueOptions,
  overrides: Partial<Settings>,
  dependencies: {
    openAgent?: typeof openAgent;
    runWorker?: typeof runWorker;
    executeRun?: typeof import("./orchestrator.js").executeRun;
  } = {},
) {
  const createAgent = (options: Parameters<typeof openAgent>[0]) =>
    SessionController.open(
      { ...options, allowDelegation: useTui },
      dependencies.openAgent ?? openAgent,
    );
  const tty = Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      process.stderr.isTTY &&
      !values.print &&
      !values.json,
  );
  const useTui = tty && !values.plain && process.env.TERM !== "dumb";
  let consent: string | undefined;
  if (!tty && !prompt.trim()) {
    if (!process.stdin.isTTY) prompt = readFileSync(0, "utf8");
    if (!prompt.trim())
      throw new SetupError(
        "非対話では--printとprompt、または標準入力を指定してください。",
        "prompt_required",
      );
  }
  if (Buffer.byteLength(prompt) > 1024 * 1024)
    throw new SetupError("promptが1MiBを越えています。");
  if (values.resume && !values.connection) {
    if (!existsSync(join(locations.stateDir, "state.sqlite")))
      throw new SetupError("保存済みSessionがありません。");
    const stored = new SessionStore(locations.stateDir, { readOnly: true });
    try {
      values = {
        ...values,
        connection: stored.load(values.resume).connectionId,
      };
    } finally {
      stored.close();
    }
  }
  const shared = useTui ? new TuiTerminal(process.cwd()) : undefined;
  try {
    if (useTui) {
      const profile = readConnections(
        join(dirname(locations.configFile), "connections.json"),
        false,
      ).profile;
      const selected = profile?.connections.find(
        (c) => c.id === (values.connection ?? profile.defaultConnectionId),
      );
      if (
        !profile ||
        (selected &&
          (!loadConfig(
            process.cwd(),
            locations.configFile,
          ).settings.allowedConnections.includes(selected.id) ||
            !existsSync(
              join(
                authDirectory(locations.configFile, selected),
                "credentials.json",
              ),
            )))
      ) {
        const { welcome } = await import("./welcome.js");
        const result = await welcome(
          locations,
          (id, tui) => runLogin(locations.configFile, id, tui),
          values.connection,
          {
            trustRepo: values["trust-repo-config"],
            overrides,
            terminal: shared,
          },
        );
        if (!result) return;
        values = { ...values, connection: result.connectionId };
        consent = result.consent;
      }
    }
    let connection = selectedConnection(
      locations.configFile,
      values.connection,
    );
    if (!findRepository(process.cwd()))
      throw new SetupError(
        "作業するGit repoのdirectoryへ移動してbeethovenを起動してください。",
        "workspace_required",
      );
    const rules = inspectRules(
      process.cwd(),
      locations.configFile,
      values["trust-repo-config"],
      overrides,
    );
    const workspace = workspaceState(process.cwd());
    let terminal = tty ? (shared ?? new Terminal()) : undefined;
    const display = (text: string, label?: string) =>
      terminal instanceof TuiTerminal
        ? terminal.message(text, label)
        : process.stderr.write(text + "\n");
    const approve = async (message: string) =>
      terminal ? terminal.approve(message) : false;
    let agent: SessionController | undefined;
    const onActivity = (activity: import("./agent.js").ExecutionActivity) => {
      if (terminal instanceof TuiTerminal) terminal.activity(activity);
    };
    try {
      const disclosure = {
        cwd: workspace.root,
        head: workspace.head,
        dirty: Boolean(workspace.status),
        connection: connection.id,
        provider: connection.provider,
        model: connection.model,
        auth: connection.auth.method,
        billing: connection.billing.kind,
        permission: rules.snapshot.config.settings.permission,
        rules: rules.snapshot.sources.map((source) => ({
          scope: source.scope,
          path: source.path,
          hash: source.hash,
        })),
        limits: {
          maxTokens: Math.min(
            connection.limits.maxTokens,
            rules.snapshot.config.settings.maxTokens,
          ),
          maxDurationMs: Math.min(
            connection.limits.maxDurationMs,
            rules.snapshot.config.settings.maxDurationMs,
          ),
          maxSessionDurationMs: rules.snapshot.config.settings.maxDurationMs,
        },
        transmission:
          "prompt・規約・会話と、toolで読むworkspace内容を選択したproviderへ送信",
        sandbox: "host / OS隔離なし",
      };
      if (terminal instanceof TuiTerminal) {
        terminal.setInfo({
          model: connection.model,
          billing: connection.billing.kind,
          permission: disclosure.permission,
          limits: disclosure.limits,
        });
        terminal.message(
          `接続: ${connection.id} · ${connection.provider}/${connection.model}\n認証: ${connection.auth.method} · 課金: ${connection.billing.kind}\n権限: ${disclosure.permission} · ${disclosure.sandbox}\n上限: ${disclosure.limits.maxTokens} token、Turn ${disclosure.limits.maxDurationMs / 1000}秒、Session ${disclosure.limits.maxSessionDurationMs / 1000}秒\n送信内容: ${disclosure.transmission}\n適用規約:\n${disclosure.rules.map((r) => `${r.scope}: ${r.path}`).join("\n")}\nHEAD: ${disclosure.head ?? "なし"} · 既存変更: ${disclosure.dirty ? "あり" : "なし"}`,
          "開始前の確認",
        );
      } else if (terminal) display(JSON.stringify(disclosure, null, 2));
      const confirmed =
        consent ===
        connectionConsent(
          {
            ...locations,
            cwd: process.cwd(),
            trustRepo: values["trust-repo-config"],
            overrides,
          },
          connection,
        );
      if (
        !values.send &&
        !confirmed &&
        !(await approve("上記の接続・送信内容・上限で開始します。"))
      )
        throw new SetupError(
          "モデル送信の確認待ちです。",
          "send_approval_required",
        );
      while (!agent) {
        try {
          agent = await createAgent({
            onActivity,
            ...locations,
            cwd: process.cwd(),
            connection,
            send: true,
            trustRepo: values["trust-repo-config"],
            overrides,
            resume: values.resume,
            planOnly: values.plan,
            allowedPaths: values.scope,
            approve: async (message) => approve(message),
            ask: async (question) => (terminal ? terminal.ask(question) : null),
            cancelInput: () => terminal?.cancel(),
          });
        } catch (error) {
          if (!terminal) throw error;
          // Opening can fail after the send confirmation (credentials, locks,
          // saved state). Keep the input owner alive, just as for turn failures.
          // Retrying initialization must never resend an initial CLI prompt.
          prompt = "";
          display(
            `${error instanceof SetupError ? error.message : "会話を開始できませんでした。接続・保存先の状態を確認してください。"}\n/retry で開始を再試行 · /connect で接続を変更 · /exit で終了`,
            "開始の確認",
          );
          while (true) {
            const action = await terminal.prompt();
            if (action === null || action.trim() === "/exit") return;
            if (action.trim() === "/retry") break;
            if (action.trim() === "/connect" && terminal instanceof TuiTerminal) {
              const { welcome } = await import("./welcome.js");
              const result = await welcome(
                locations,
                (id, tui) => runLogin(locations.configFile, id, tui),
                undefined,
                {
                  forceConnect: true,
                  trustRepo: values["trust-repo-config"],
                  overrides,
                  terminal,
                },
              );
              if (result) {
                connection = selectedConnection(
                  locations.configFile,
                  result.connectionId,
                );
                break;
              }
            }
            display("会話はまだ開始していません。/retry · /connect · /exit を入力してください。");
          }
        }
      }
      let active = agent;
      if (terminal instanceof TuiTerminal) {
        const ui = terminal;
        ui.onMonitor = () => {
          void import("./monitor.js")
            .then(async ({ monitorSnapshot }) => {
              const id = await ui.monitor(() =>
                monitorSnapshot(locations.stateDir),
              );
              if (id) {
                const node = monitorSnapshot(locations.stateDir).nodes.find(
                  (n) => n.id === id,
                );
                if (node)
                  ui.message(JSON.stringify(node, null, 2), "セッション詳細");
              }
            })
            .catch(() =>
              ui.message(
                "セッション一覧を取得できませんでした。保存先の版・状態を確認してください。",
              ),
            );
        };
      }
      const withHistory = <T>(read: (store: SessionStore) => T) => {
        const store = new SessionStore(locations.stateDir, { readOnly: true });
        try {
          return read(store);
        } finally {
          store.close();
        }
      };
      const restoreConversation = () => {
        if (!(terminal instanceof TuiTerminal)) return;
        const history = savedConversation(locations.stateDir, active.id);
        terminal.restoreConversation(history.messages, active.id);
        for (const warning of history.warnings)
          terminal.message(warning, "履歴の表示");
      };
      if (terminal instanceof TuiTerminal) {
        terminal.loadInputHistory(
          withHistory((store) => store.editorHistory(active.info().cwd)),
        );
        if (values.resume) restoreConversation();
      }
      let executionPaused = false;
      const closeActive = async () => {
        const owned = agent;
        agent = undefined;
        await owned?.close();
      };
      const onSigint = () => active.abort();
      let running = false;
      let workerAbort: AbortController | undefined;
      let exitRequested = false;
      let exitReason = "unknown";
      const interrupt = () => {
        if (!terminal) return;
        if (running) {
          workerAbort?.abort();
          active.abort();
          terminal.cancel();
          if (terminal instanceof TuiTerminal)
            terminal.setPhase("中断しています…");
          else process.stderr.write("\n中断しています…\n");
        } else {
          exitRequested = true;
          exitReason = "user_interrupt";
          terminal.cancel();
        }
      };
      if (terminal) terminal.onInterrupt = interrupt;
      else process.on("SIGINT", onSigint);
      if (values.json)
        console.log(
          JSON.stringify({
            schemaVersion: 1,
            type: "session",
            ...active.info(),
          }),
        );
      else {
        if (terminal instanceof TuiTerminal) terminal.setInfo(active.info());
        display(
          `Session: ${active.id}\n${terminal ? "/help で操作一覧。Ctrl-Cで中断します。" : ""}`,
        );
      }
      try {
        while (!exitRequested) {
          let input = prompt || (terminal ? await terminal.prompt() : null);
          prompt = "";
          if (input === null) {
            if (exitReason === "unknown") exitReason = "input_closed";
            break;
          }
          if (!input.trim()) continue;
          if (input === "/exit") {
            exitReason = "user_exit";
            break;
          }
          let turnStarted = false;
          try {
            if (input === "/help") {
              display(
                "/connect /help /status /model [接続ID] /permissions /diff /sessions /monitor /run PLAN_FILE /orchestrate 依頼 /history [検索] /compact /context /resume /worker <依頼> /worker resume ID [回答] /workers [ID] /workers logs ID /paste /exit\nShift+EnterまたはCtrl+Jで改行。PageUp/PageDownで履歴スクロール。\n計画のみ: 起動時--plan、または依頼へ「計画のみ」と明記。追加入力は実行後に順番に扱います。",
              );
              continue;
            }
            if (input === "/connect" && terminal instanceof TuiTerminal) {
              const id = active.id;
              const pendingInput = terminal.snapshotInput();
              const previous = selectedConnection(
                locations.configFile,
                active.info().connectionId,
              );
              await closeActive();
              const { welcome } = await import("./welcome.js");
              const result = await welcome(
                locations,
                (id, tui) => runLogin(locations.configFile, id, tui),
                undefined,
                {
                  forceConnect: true,
                  trustRepo: values["trust-repo-config"],
                  overrides,
                  terminal,
                },
              );
              terminal.onInterrupt = interrupt;
              terminal.restoreInput(pendingInput);
              const next = result
                ? selectedConnection(locations.configFile, result.connectionId)
                : previous;
              const valid =
                result &&
                result.consent ===
                  connectionConsent(
                    {
                      ...locations,
                      cwd: process.cwd(),
                      trustRepo: values["trust-repo-config"],
                      overrides,
                    },
                    next,
                  );
              active = await createAgent({
                onActivity,
                ...locations,
                cwd: process.cwd(),
                connection: next,
                send: true,
                trustRepo: values["trust-repo-config"],
                overrides,
                resume: id,
                switchConnection: Boolean(valid),
                approve: (message, key) =>
                  valid && key.startsWith("resume-rules:")
                    ? Promise.resolve(true)
                    : approve(message),
                ask: (question) => terminal!.ask(question),
                cancelInput: () => terminal?.cancel(),
              });
              agent = active;
              executionPaused = false;
              terminal.setExecutionPaused(false);
              terminal.setInfo(active.info());
              display(
                "同じ会話・使用量を引き継ぎました。次の依頼を入力してください。",
              );
              continue;
            }
            if (["/status", "/model", "/permissions"].includes(input)) {
              if (terminal instanceof TuiTerminal)
                terminal.setInfo(active.info());
              display(JSON.stringify(active.info(), null, 2));
              continue;
            }
            if (input.startsWith("/model ")) {
              const next = selectedConnection(
                locations.configFile,
                input.slice(7).trim(),
              );
              if (
                !terminal ||
                !(await terminal.approve(
                  `接続を${next.id}: ${next.provider}/${next.model} (${next.auth.method}, ${next.billing.kind})へ変更します。旧使用量・支出は保持します。`,
                ))
              ) {
                display("接続変更を取り消しました。");
                continue;
              }
              const id = active.id;
              await closeActive();
              active = await createAgent({
                onActivity,
                ...locations,
                cwd: process.cwd(),
                connection: next,
                send: true,
                trustRepo: values["trust-repo-config"],
                overrides,
                resume: id,
                switchConnection: true,
                approve: async (message) => approve(message),
                ask: (question) => terminal!.ask(question),
                cancelInput: () => terminal?.cancel(),
              });
              agent = active;
              executionPaused = false;
              if (terminal instanceof TuiTerminal)
                terminal.setExecutionPaused(false);
              if (terminal instanceof TuiTerminal)
                terminal.setInfo(active.info());
              display(JSON.stringify(active.info(), null, 2));
              continue;
            }
            if (input === "/resume") {
              if (running) {
                display("停止が完了してから再開してください。");
                continue;
              }
              const id = active.id;
              const connection = selectedConnection(
                locations.configFile,
                active.info().connectionId,
              );
              await closeActive();
              active = await createAgent({
                onActivity,
                ...locations,
                cwd: process.cwd(),
                connection,
                send: true,
                trustRepo: values["trust-repo-config"],
                overrides,
                resume: id,
                approve: (message) => approve(message),
                ask: (message) =>
                  terminal ? terminal.ask(message) : Promise.resolve(null),
                cancelInput: () => terminal?.cancel(),
              });
              agent = active;
              executionPaused = false;
              if (terminal instanceof TuiTerminal) {
                terminal.setExecutionPaused(false);
                terminal.setInfo(active.info());
              }
              display(
                "同じSessionを再開しました。失敗した依頼は自動再送していません。",
                "再開",
              );
              continue;
            }
            if (
              input.startsWith("/run ") ||
              input.startsWith("/orchestrate ")
            ) {
              if (
                !(terminal instanceof TuiTerminal) ||
                executionPaused ||
                !agent
              ) {
                display(
                  "実行可能な対話TUIで/run PLAN_FILEまたは/orchestrate 依頼を使ってください。",
                );
                continue;
              }
              const { validatePlan, createRun, executeRun } = await import(
                "./orchestrator.js"
              );
              let plan: ReturnType<typeof validatePlan>;
              if (input.startsWith("/orchestrate ")) {
                const goal = input.slice(13).trim();
                const current = active.info();
                running = true;
                turnStarted = true;
                terminal.beginTurn(goal, "Planner");
                const proposal = await active.run(
                  `計画のみ。編集・shell実行はしない。次の依頼をDAGへ分割し、JSONだけで返してください。依頼: ${goal}\n形式: {"schemaVersion":1,"maxConcurrency":1,"maxTokens":${current.limits.maxTokens},"maxCostUsd":0,"maxDurationMs":60000,"tasks":[{"id":"A","prompt":"具体的な作業","connection":"${current.connectionId}","scope":["対象fileまたはdirectory"],"dependsOn":[],"resources":[],"priority":0,"maxTokens":10000,"maxCostUsd":0,"maxAttempts":1}]}。scopeはrepo相対path、依存は{task:"A",kind:"code"または"acceptance"}。必要な場合だけrole explorer/reviewerを設定。接続は現在の接続に固定。実行は利用者が計画を確認してから。`,
                  {
                    onEvent: (event) => {
                      if (terminal instanceof TuiTerminal)
                        terminal.event(event);
                    },
                  },
                );
                running = false;
                terminal.finishTurn(proposal);
                plan = validatePlan(
                  JSON.parse(
                    proposal.response
                      .replace(/^```(?:json)?\s*/, "")
                      .replace(/\s*```$/, ""),
                  ),
                );
              } else
                plan = validatePlan(
                  JSON.parse(readFileSync(input.slice(5).trim(), "utf8")),
                );
              const remaining = active.info();
              plan.maxTokens = Math.min(
                plan.maxTokens,
                remaining.limits.maxTokens -
                  remaining.usage.tokens -
                  remaining.usage.reservedUnknownTokens,
              );
              plan.maxDurationMs = Math.min(
                plan.maxDurationMs,
                remaining.limits.maxSessionDurationMs -
                  remaining.usage.elapsedMs,
              );
              for (const task of plan.tasks)
                task.maxTokens = Math.min(
                  task.maxTokens,
                  Math.floor(plan.maxTokens / plan.maxConcurrency),
                );
              plan = validatePlan(plan);
              display(JSON.stringify(plan, null, 2), "実行する計画");
              if (
                !(await terminal.approve(
                  `上記の計画を実行します。最大${plan.maxConcurrency}並列、${plan.maxTokens} token、${plan.maxDurationMs / 1000}秒。元workspaceは変更せず専用統合worktreeに候補を保持します。`,
                ))
              )
                continue;
              const parentId = active.id,
                connection = selectedConnection(
                  locations.configFile,
                  active.info().connectionId,
                );
              await closeActive();
              const run = await createRun(
                locations.stateDir,
                locations.configFile,
                process.cwd(),
                plan,
              );
              const { RunStore } = await import("./run-store.js");
              const runStore = new RunStore(locations.stateDir);
              try {
                runStore.update(run.id, (r) => {
                  r.parentSession = parentId;
                });
              } finally {
                runStore.close();
              }
              running = true;
              workerAbort = new AbortController();
              terminal.startRun(run.id);
              let approvals = Promise.resolve();
              const approveSequentially = (message: string) => {
                const previous = approvals;
                let release!: () => void;
                approvals = new Promise<void>((done) => {
                  release = done;
                });
                return previous.then(() => approve(message)).finally(release);
              };
              try {
                const result = await (dependencies.executeRun ?? executeRun)({
                  stateDir: locations.stateDir,
                  id: run.id,
                  signal: workerAbort.signal,
                  approve: approveSequentially,
                  onTask: (taskId, state) => {
                    if (terminal instanceof TuiTerminal)
                      terminal.runTask(taskId, state);
                  },
                  onEvent: (taskId, event) => {
                    if (terminal instanceof TuiTerminal)
                      terminal.taskEvent(taskId, event);
                  },
                });
                display(
                  `Run ${result.id} · ${result.status}\n統合候補: ${result.integration}\nSHA: ${result.integrationSha ?? "未確定"}\nCtrl+Oまたは/monitorで各Taskを確認できます。受入はbeethoven run accept ID TASK --sha SHA。`,
                  "Orchestration結果",
                );
              } finally {
                running = false;
                workerAbort = undefined;
              }
              active = await createAgent({
                onActivity,
                ...locations,
                cwd: process.cwd(),
                connection,
                send: true,
                trustRepo: values["trust-repo-config"],
                overrides,
                resume: parentId,
                approve: (message) => approve(message),
                ask: (question) => terminal!.ask(question),
                cancelInput: () => terminal?.cancel(),
              });
              agent = active;
              terminal.setInfo(active.info());
              continue;
            }
            if (input === "/monitor" && terminal instanceof TuiTerminal) {
              const { monitorSnapshot } = await import("./monitor.js");
              const selected = await terminal.monitor(() =>
                monitorSnapshot(locations.stateDir),
              );
              if (selected) {
                const snapshot = monitorSnapshot(locations.stateDir),
                  node = snapshot.nodes.find((n) => n.id === selected);
                if (node?.kind === "session") {
                  const history = savedConversation(
                    locations.stateDir,
                    node.id,
                  );
                  display(
                    history.messages
                      .slice(-6)
                      .map((m) => `${m.role}: ${m.text}`)
                      .join("\n\n"),
                    "会話の閲覧 · 実行は切り替えません",
                  );
                } else if (node)
                  display(JSON.stringify(node, null, 2), "セッション詳細");
              }
              continue;
            }
            if (
              (input === "/history" || input.startsWith("/history ")) &&
              terminal instanceof TuiTerminal
            ) {
              const argument = input.slice(8).trim(),
                all = argument === "--all" || argument.startsWith("--all ");
              const query = all ? argument.slice(5).trim() : argument;
              const cwd = all ? null : active.info().cwd;
              const items = withHistory((store) =>
                store.promptHistory(cwd, query),
              );
              if (!items.length) {
                display("一致するprompt履歴はありません。", "プロンプト履歴");
                continue;
              }
              const selected = await terminal.select(
                "プロンプト履歴 · 選択すると入力欄へ戻します",
                items.map((item) => ({
                  value: item.id,
                  label: item.preview.replace(/\s+/g, " "),
                  description: `${new Date(item.createdAt).toLocaleString()} · ${item.model ?? "モデル未記録"}${all ? ` · ${item.cwd}` : ""}`,
                })),
              );
              if (selected) {
                terminal.recallPrompt(
                  withHistory((store) => store.historyPrompt(selected, cwd)),
                );
                display(
                  "履歴を入力欄に呼び出しました。編集し、Enterで送信してください。",
                  "プロンプト履歴",
                );
              }
              continue;
            }
            if (input === "/context") {
              display(
                JSON.stringify(active.info().context, null, 2),
                "会話の容量（推定）",
              );
              continue;
            }
            if (input === "/workers") {
              const records = listWorkers(locations.stateDir);
              display(
                records.length
                  ? JSON.stringify(records, null, 2)
                  : "Worker未起動。/worker <依頼> で起動します。",
                "Worker一覧",
              );
              continue;
            }
            if (input.startsWith("/workers logs ")) {
              display(
                workerLogs(locations.stateDir, input.slice(14).trim())
                  .map(
                    (item) =>
                      `${new Date(item.time).toLocaleTimeString()}  ${item.stage}${item.detail ? ` · ${item.detail}` : ""}`,
                  )
                  .join("\n") || "記録なし",
                "Workerログ",
              );
              continue;
            }
            if (input.startsWith("/workers ")) {
              display(
                JSON.stringify(
                  workerStatus(locations.stateDir, input.slice(9).trim()),
                  null,
                  2,
                ),
                "Worker状態",
              );
              continue;
            }
            if (input.startsWith("/worker ") && (executionPaused || !agent)) {
              display(
                "実行を停止しています。/resumeで保存状態を確認して再開してください。",
              );
              continue;
            }
            if (input.startsWith("/worker ")) {
              let task = input.slice(8).trim();
              let resumeWorker: string | undefined, replyTo: string | undefined;
              if (task.startsWith("resume ")) {
                const [id, ...answer] = task.slice(7).trim().split(/\s+/);
                const saved = workerStatus(locations.stateDir, id!);
                if (!saved.pending)
                  throw new SetupError("このWorkerは回答待ちではありません。");
                resumeWorker = saved.id;
                replyTo = saved.pending.id;
                task =
                  answer.join(" ") ||
                  (terminal
                    ? await terminal.ask(saved.pending.message)
                    : null) ||
                  "";
                if (!task) continue;
              }
              if (!task || !terminal) {
                display("対話端末で /worker <依頼> を指定してください。");
                continue;
              }
              const info = active.info();
              const connection = selectedConnection(
                locations.configFile,
                info.connectionId,
              );
              if (
                !(await terminal.approve(
                  `${resumeWorker ? "保存したWorkerを同じworktree・会話で再開します。" : "1 Workerを専用worktreeで起動します。"}\nモデル: ${connection.provider}/${connection.model}\n親Sessionの残予算・権限・scopeを継承します。候補差分は自動統合しません。\n依頼: ${task}`,
                ))
              )
                continue;
              const id = active.id;
              await closeActive();
              running = true;
              workerAbort = new AbortController();
              if (terminal instanceof TuiTerminal)
                terminal.beginTurn(`Workerへの依頼: ${task}`, "Worker");
              try {
                const result = await (dependencies.runWorker ?? runWorker)({
                  parentId: id,
                  task,
                  resume: resumeWorker,
                  replyTo,
                  parkQuestions: true,
                  agent: {
                    ...locations,
                    cwd: process.cwd(),
                    connection,
                    trustRepo: values["trust-repo-config"],
                    overrides,
                  },
                  signal: workerAbort.signal,
                  cancelInput: () => terminal?.cancel(),
                  onState: (state) => {
                    if (terminal instanceof TuiTerminal) terminal.worker(state);
                  },
                  onEvent: (event) => {
                    if (terminal instanceof TuiTerminal) terminal.event(event);
                  },
                  ask: (message, approval) =>
                    approval
                      ? terminal!
                          .approve(message)
                          .then((ok) => (ok ? "yes" : null))
                      : terminal!.ask(message),
                });
                if (terminal instanceof TuiTerminal && result.report)
                  terminal.finishTurn(result.report);
                display(
                  `Worker: ${result.id} · ${result.stage}\n候補worktree: ${result.directory}\n元のworkspaceへの統合: 未実施。/workersで記録を確認できます。${result.pending ? `\n回答待ち: ${result.pending.message}\n再開: /worker resume ${result.id}` : ""}${result.report?.diff ? `\n${result.report.diff}` : ""}`,
                  "Worker結果",
                );
              } catch (error) {
                display(
                  error instanceof SetupError
                    ? error.message
                    : "Worker処理を停止しました。/workersで保存記録と停止状態を確認してください。",
                  "Worker",
                );
              } finally {
                running = false;
                workerAbort = undefined;
              }
              active = await createAgent({
                onActivity,
                ...locations,
                cwd: process.cwd(),
                connection,
                send: true,
                trustRepo: values["trust-repo-config"],
                overrides,
                resume: id,
                approve: (message) => approve(message),
                ask: (message) => terminal!.ask(message),
                cancelInput: () => terminal?.cancel(),
              });
              agent = active;
              executionPaused = false;
              if (terminal instanceof TuiTerminal) {
                terminal.setExecutionPaused(false);
                terminal.setInfo(active.info());
              }
              continue;
            }
            if (input === "/diff") {
              display(
                git(process.cwd(), [
                  "diff",
                  "--no-ext-diff",
                  "--no-textconv",
                  "HEAD",
                  "--",
                  ".",
                ]),
                "差分",
              );
              continue;
            }
            if (input === "/sessions" || input.startsWith("/sessions ")) {
              if (!(terminal instanceof TuiTerminal)) {
                display(
                  JSON.stringify(
                    withHistory((store) => store.recentSessions()),
                    null,
                    2,
                  ),
                  "保存済みSession",
                );
                continue;
              }
              const sessions = withHistory((store) =>
                store.recentSessions(active.info().cwd),
              );
              if (!sessions.length) {
                display("保存済み会話はありません。");
                continue;
              }
              const id =
                input.slice(9).trim() ||
                (await terminal.select(
                  "保存済み会話 · 選択して開く",
                  sessions.map((session) => ({
                    value: String(session.id),
                    label: String(session.title ?? "新しい会話").replace(
                      /\s+/g,
                      " ",
                    ),
                    description: `${new Date(String(session.updated_at)).toLocaleString()} · ${String(session.id).slice(0, 8)} · ${session.status}`,
                  })),
                ));
              if (!id) continue;
              if (id === active.id) {
                display(
                  "この会話を開いています。/history またはCtrl+Rでpromptを呼び出せます。",
                );
                continue;
              }
              const saved = withHistory((store) => store.load(id));
              if (saved.cwd !== active.info().cwd)
                throw new SetupError(
                  "別のworkspaceの会話です。そのdirectoryでbeethoven --resume IDを使ってください。",
                );
              const connection = selectedConnection(
                locations.configFile,
                saved.connectionId,
              );
              await closeActive();
              active = await createAgent({
                onActivity,
                ...locations,
                cwd: process.cwd(),
                connection,
                send: true,
                trustRepo: values["trust-repo-config"],
                overrides,
                resume: id,
                planOnly: values.plan,
                allowedPaths: values.scope,
                approve: (message) => approve(message),
                ask: (message) => terminal!.ask(message),
                cancelInput: () => terminal?.cancel(),
              });
              agent = active;
              executionPaused = false;
              terminal.setExecutionPaused(false);
              terminal.setInfo(active.info());
              restoreConversation();
              display(
                "保存した会話を開きました。次の依頼を入力してください。",
                "会話を再開",
              );
              continue;
            }
            if (input.startsWith("/") && input !== "/compact") {
              display("未対応の操作です。/helpを確認してください。");
              if (!terminal) throw new SetupError("未対応の操作です。");
              continue;
            }
            if (executionPaused || !agent) {
              display(
                "実行を停止しています。/resumeで保存状態を確認して再開してください。失敗した依頼は自動再送しません。",
              );
              continue;
            }
            const inputStore = new SessionStore(locations.stateDir);
            let inputId: string | undefined;
            try {
              if (!input.startsWith("/"))
                inputId = inputStore.recordPrompt(
                  active.id,
                  input,
                  active.info(),
                );
            } finally {
              inputStore.close();
            }
            running = true;
            turnStarted = true;
            if (terminal instanceof TuiTerminal) terminal.beginTurn(input);
            let response = "";
            const report = await active.run(input, {
              inputId,
              onEvent: (event) => {
                if (event.type === "text") response += event.delta;
                if (values.json)
                  console.log(JSON.stringify({ schemaVersion: 1, ...event }));
                else if (terminal instanceof TuiTerminal) terminal.event(event);
                else if (event.type === "text")
                  process.stdout.write(event.delta);
                else
                  process.stderr.write(
                    `\n[${event.type}] ${event.name} (${event.id})${event.target ? ` ${event.target}` : ""}${event.isError ? " 失敗" : ""}\n`,
                  );
              },
            });
            running = false;
            if (values.json)
              console.log(
                JSON.stringify({
                  schemaVersion: 1,
                  type: "result",
                  ...report,
                  response,
                }),
              );
            else if (terminal instanceof TuiTerminal) {
              terminal.setInfo(active.info());
              terminal.finishTurn(report);
              if (report.blockedReason === "context_limit")
                display(
                  "会話の容量が不足しています。/contextで確認し、/compact・/model、または規約の量を調整してから続けてください。",
                  "会話の容量",
                );
            } else
              process.stderr.write(`\n${JSON.stringify(report, null, 2)}\n`);
            if (report.proposedPlan && terminal instanceof TuiTerminal) {
              const { saveArtifact } = await import("./files.js");
              const proposal = saveArtifact(
                locations.stateDir,
                Buffer.from(JSON.stringify(report.proposedPlan)),
              );
              display(
                `委譲計画を保存しました。/run ${proposal.file} で確認・実行できます。`,
                "Orchestration計画",
              );
              if (!report.proposalOnly) prompt = "/run " + proposal.file;
            }
            if (report.status === "blocked") process.exitCode = 3;
            else if (
              report.status !== "completed" ||
              (report.verification as { status: string }).status === "fail"
            )
              process.exitCode = 1;
            if (!terminal) break;
          } catch (error) {
            if (!terminal) throw error;
            running = false;
            // Runtime bodies may contain credentials. Only our own structured setup messages are safe to display.
            const known = error instanceof SetupError;
            executionPaused ||= !known || !agent || active.state === "paused";
            if (terminal instanceof TuiTerminal) {
              if (turnStarted)
                terminal.finishTurn({
                  status: known ? "blocked" : "error",
                  blockedReason: known ? error.code : "execution_failed",
                  verification: { status: "not_run" },
                });
              terminal.setExecutionPaused(executionPaused);
            }
            display(
              `${known ? error.message : "実行を停止しました。保存状態または接続処理を確認してください。"}\nSession: ${active.id}\n${executionPaused ? "/resume で状態を確認して再開できます。依頼は自動再送しません。" : "送信を完了できませんでした。上限・接続を確認してから次の操作を入力してください。"}\n/status · /connect · /sessions · /exit`,
              "実行の確認",
            );
          } finally {
            running = false;
          }
        }
      } finally {
        if (!terminal) process.removeListener("SIGINT", onSigint);
        else {
          // Only structured lifecycle metadata; never prompts or raw provider failures.
          let audit: SessionStore | undefined;
          try {
            audit = new SessionStore(locations.stateDir);
            audit.event(active.id, "dialogue_exit", {
              reason: exitReason,
              tui: terminal instanceof TuiTerminal,
              executionPaused,
            });
          } catch {
            /* teardown must still release the owned SDK and terminal */
          } finally {
            audit?.close();
          }
        }
      }
    } finally {
      try {
        await agent?.close();
      } finally {
        terminal?.close();
      }
      if (terminal instanceof TuiTerminal && agent)
        process.stderr.write(
          `Session: ${agent.id}\n再開: beethoven --resume ${agent.id}\n`,
        );
    }
  } finally {
    shared?.close();
  }
}
