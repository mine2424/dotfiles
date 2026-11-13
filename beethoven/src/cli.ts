#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, paths } from "./config.js";
import {
  initializeStore,
  readDatabaseVersion,
  schemaVersion,
} from "./store.js";
import { inspectRules } from "./rules.js";
import { acquireLock, saveArtifact } from "./files.js";
import {
  connectionCatalog,
  readConnections,
  SetupError,
} from "./connections.js";
import { runSetup } from "./setup.js";

// dist/src/cli.jsを入口として、自分のpackageの版・固定依存を読む。起動cwdには依存しない。
const packageFile = fileURLToPath(
  new URL("../../package.json", import.meta.url),
);
const packageInfo = JSON.parse(readFileSync(packageFile, "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};

/** CLIの入口。読取診断と、本人が明示する初期化・snapshot保存を分けて処理する。 */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      include: { type: "string" },
      copy: { type: "boolean" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      "trust-repo-config": { type: "boolean" },
      permission: { type: "string" },
      "max-tokens": { type: "string" },
      "max-duration-ms": { type: "string" },
      "max-cost-usd": { type: "string" },
      from: { type: "string" },
      yes: { type: "boolean" },
      catalog: { type: "boolean" },
      print: { type: "boolean" },
      plain: { type: "boolean" },
      resume: { type: "string" },
      connection: { type: "string" },
      send: { type: "boolean" },
      models: { type: "boolean" },
      ownership: { type: "boolean" },
      "bin-dir": { type: "string" },
      repo: { type: "string" },
      "project-id": { type: "string" },
      sha: { type: "string" },
      "request-id": { type: "string" },
      "expected-version": { type: "string" },
      "required-check": { type: "string", multiple: true },
      out: { type: "string" },
      recipient: { type: "string" },
      identity: { type: "string" },
      to: { type: "string" },
      plan: { type: "boolean" },
      scope: { type: "string", multiple: true },
    },
  });
  if (values.version) {
    console.log(packageInfo.version);
    return;
  }
  if (values.help) {
    console.log(
      "Beethoven\n\nbeethoven [prompt] [--connection ID] [--resume ID] [--plan] [--plain]\nbeethoven --print <prompt> --send [--json]\nbeethoven connect\nbeethoven run create --from PLAN\nbeethoven run start ID --send [--yes]\nbeethoven run status|logs|stop|answer|accept|retry|continue|recover|reconcile|replan ID [TASK]\nbeethoven runs\nbeethoven monitor [--json]\nbeethoven assets list|add|refresh|search|show|remove [NAME] [PATH] [--connection ID]\nbeethoven self stage --from CHECKOUT --out RELEASE\nbeethoven self activate --from RELEASE --bin-dir DIR\nbeethoven self rollback --bin-dir DIR\nbeethoven github allow|snapshot|ci|publish --repo owner/repo\nbeethoven backup allow --repo owner/repo --yes\nbeethoven backup upload FILE --repo owner/repo --yes\nbeethoven backup download ID --repo owner/repo --out NEW_FILE [--sha SHA256]\nbeethoven backup setup --repo owner/repo --yes\nbeethoven backup status\nbeethoven backup recovery --copy\nbeethoven backup recovery-download --repo owner/repo --sha FINGERPRINT --out FILE\nbeethoven backup unlock --from FILE\nbeethoven backup keygen --out KEY\nbeethoven backup create --recipient KEY.pub --out FILE\nbeethoven restore FILE --identity KEY --to NEW_DIRECTORY\nbeethoven setup [--catalog | --from <file> [--yes]] [--json]\nbeethoven login [--connection ID]\nbeethoven connections [--json]\nbeethoven connections enable --connection ID --yes\nbeethoven routing check [--json]\nbeethoven sessions [--json]\nbeethoven sessions show ID [--json]\nbeethoven history [検索] [--all] [--json]\nbeethoven history show ID [--all] [--json]\nbeethoven workers [ID] [--json]\nbeethoven workers logs ID\nbeethoven workers recover ID [--yes]\nbeethoven doctor [--json] [--trust-repo-config]\nbeethoven init\nbeethoven rules show|check|snapshot [--json]\nbeethoven harness trust [--yes] [--json]\nbeethoven recover [--yes] [--json]\n\n設定上書き: --permission read-only|workspace-write\n  --max-tokens N --max-duration-ms N --max-cost-usd N\n編集scope: --scope <fileまたはdirectory>（複数可）\n明示済みのPolicy制約を越える上書きは拒否します。\nsetup保存・login・モデル送信・ハーネス実行はそれぞれ別操作です。\n--sendは選択したproviderへのprompt・規約・会話・tool読取内容の送信確認です。",
    );
    return;
  }
  const command = positionals[0];
  if (values.all && command !== "history")
    throw new SetupError("--allはhistory専用です。");
  const rulesCommand = command === "rules" ? positionals[1] : undefined;
  if (
    command === "rules" &&
    (positionals.length !== 2 ||
      !["show", "check", "snapshot"].includes(rulesCommand ?? ""))
  ) {
    throw new Error("未対応のコマンドです。--helpを確認してください。");
  }
  const locations = paths();
  // 引数は文字列で受け、設定loaderへ渡す前に数値へ変換する。範囲の検証はloaderで共通化。
  const overrides: Record<string, unknown> = {};
  if (values.permission !== undefined) overrides.permission = values.permission;
  for (const [flag, key] of [
    ["max-tokens", "maxTokens"],
    ["max-duration-ms", "maxDurationMs"],
    ["max-cost-usd", "maxCostUsd"],
  ] as const) {
    if (values[flag] !== undefined) overrides[key] = Number(values[flag]);
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeSupported = major === 24 && minor !== undefined && minor >= 21;
  const administrative = [
    "assets",
    "monitor",
    "self",
    "run",
    "runs",
    "github",
    "backup",
    "restore",
    "doctor",
    "init",
    "setup",
    "connect",
    "rules",
    "login",
    "sessions",
    "history",
    "workers",
    "harness",
    "recover",
    "connections",
    "routing",
  ].includes(command ?? "");
  if (!administrative) {
    if (!nodeSupported)
      throw new SetupError("Node 24.21.0以降の24系で起動してください。");
    if (values.from || values.yes || values.catalog)
      throw new SetupError(
        "--from/--yes/--catalogは対話実行では使用しません。",
      );
    const { runDialogue } = await import("./dialogue.js");
    await runDialogue(locations, positionals.join(" "), values, overrides);
    return;
  }
  if (
    values.print ||
    values.plain ||
    values.resume ||
    (values.send && command !== "run") ||
    values.plan ||
    values.scope
  )
    throw new SetupError("対話実行用optionと管理commandは併用できません。");
  if (command === "assets") {
    const {
      assetSources,
      addAssetSource,
      removeAssetSource,
      refreshAssets,
      searchAssets,
      readAsset,
    } = await import("./assets.js");
    const op = positionals[1],
      name = positionals[2];
    let result: unknown;
    if (op === "list" && positionals.length === 2)
      result = assetSources(locations.configFile);
    else if (
      op === "add" &&
      name &&
      positionals[3] &&
      positionals.length === 4 &&
      values.yes &&
      values.connection
    ) {
      result = addAssetSource(
        locations.configFile,
        name,
        positionals[3],
        values.connection.split(","),
        values.include ?? ".",
      );
    } else if (
      op === "remove" &&
      name &&
      positionals.length === 3 &&
      values.yes
    )
      result = removeAssetSource(locations.configFile, name);
    else if (op === "refresh" && name && positionals.length === 3)
      result = refreshAssets(locations.configFile, locations.stateDir, name);
    else if ((op === "search" || op === "show") && name && values.connection) {
      const { selectedConnection } = await import("./dialogue.js");
      const connection = selectedConnection(
        locations.configFile,
        values.connection,
      );
      if (op === "show" && !values.sha)
        throw new SetupError("assets showは--sha COMMITが必要です。");
      result =
        op === "search"
          ? await searchAssets(
              locations.configFile,
              locations.stateDir,
              connection,
              positionals.slice(2).join(" "),
            )
          : readAsset(
              locations.configFile,
              locations.stateDir,
              connection,
              name,
              values.sha!,
            );
    } else
      throw new SetupError(
        "assets list / add NAME PATH --connection ID --yes / refresh NAME / search QUERY --connection ID / show ID --sha COMMIT --connection ID / remove NAME --yes を指定してください。",
      );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "monitor") {
    const { monitorSnapshot } = await import("./monitor.js");
    if (values.json || !process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(JSON.stringify(monitorSnapshot(locations.stateDir), null, 2));
      return;
    }
    const { TuiTerminal } = await import("./tui.js");
    const ui = new TuiTerminal(process.cwd());
    ui.onInterrupt = () => ui.cancel();
    try {
      const id = await ui.monitor(() => monitorSnapshot(locations.stateDir));
      if (id)
        ui.message(
          JSON.stringify(
            monitorSnapshot(locations.stateDir).nodes.find(
              (node) => node.id === id,
            ),
            null,
            2,
          ),
        );
    } finally {
      ui.close();
    }
    return;
  }
  if (command === "self") {
    const { execFileSync } = await import("node:child_process");
    const operation = positionals[1];
    if (!["stage", "activate", "rollback"].includes(operation ?? ""))
      throw new SetupError(
        "self stage --from CHECKOUT --out NEW_DIRECTORY、self activate --from RELEASE --bin-dir DIR、self rollback --bin-dir DIRを指定してください。",
      );
    const args = [
      fileURLToPath(
        new URL("../../scripts/manage-install.mjs", import.meta.url),
      ),
      operation!,
    ];
    for (const [name, value] of Object.entries({
      from: values.from,
      out: values.out,
      "bin-dir": values["bin-dir"],
    }))
      if (value) args.push("--" + name, value);
    if (operation !== "stage") args.push("--state", locations.stateDir);
    process.stdout.write(
      execFileSync(process.execPath, args, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 180000,
      }),
    );
    return;
  }
  if (command === "run" || command === "runs") {
    const { RunStore } = await import("./run-store.js");
    const { createRun, executeRun, recoverRun, reconcileRun } = await import(
      "./orchestrator.js"
    );
    if (command === "run" && positionals[1] === "create" && values.from) {
      console.log(
        JSON.stringify(
          await createRun(
            locations.stateDir,
            locations.configFile,
            process.cwd(),
            JSON.parse(readFileSync(values.from, "utf8")),
          ),
          null,
          2,
        ),
      );
      return;
    }
    if (!existsSync(join(locations.stateDir, "state.sqlite"))) {
      console.log("[]");
      return;
    }
    const store = new RunStore(locations.stateDir);
    try {
      if (command === "runs") {
        console.log(JSON.stringify(store.list(), null, 2));
        return;
      }
      const operation = positionals[1],
        id = positionals[2];
      if (!id)
        throw new SetupError(
          "run create --from PLAN、run status|start|stop|answer|accept|retry IDを指定してください。",
        );
      const run = store.get(id);
      if (operation === "replan" && values.from && values.yes) {
        const { reviseRun } = await import("./orchestrator.js");
        console.log(
          JSON.stringify(
            reviseRun(
              locations.stateDir,
              id,
              JSON.parse(readFileSync(values.from, "utf8")),
            ),
            null,
            2,
          ),
        );
        return;
      }
      if (operation === "reconcile") {
        console.log(
          JSON.stringify(await reconcileRun(locations.stateDir, id), null, 2),
        );
        return;
      }
      if (operation === "recover") {
        console.log(
          JSON.stringify(
            await recoverRun(locations.stateDir, id, values.yes === true),
            null,
            2,
          ),
        );
        return;
      }
      if (operation === "logs") {
        const { workerLogs } = await import("./worker.js");
        const taskId = positionals[3];
        const tasks = Object.entries(run.tasks).filter(
          ([id]) => !taskId || id === taskId,
        );
        console.log(
          JSON.stringify(
            tasks.map(([taskId, state]) => ({
              taskId,
              events:
                state.stateDir && state.workerId
                  ? workerLogs(state.stateDir, state.workerId)
                  : [],
            })),
            null,
            2,
          ),
        );
        return;
      }
      if (operation === "status") {
        console.log(JSON.stringify(run, null, 2));
        return;
      }
      if (operation === "start") {
        if (!values.send)
          throw new SetupError(
            "run start ID --sendで計画に記録された接続・上限での送信を指定してください。",
            "send_approval_required",
          );
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.on("SIGINT", stop);
        try {
          console.log(
            JSON.stringify(
              await executeRun({
                stateDir: locations.stateDir,
                id,
                signal: abort.signal,
                approve: async () => values.yes === true,
                onTask: (taskId, state) => {
                  if (values.json)
                    console.log(
                      JSON.stringify({ type: "worker", taskId, ...state }),
                    );
                },
              }),
              null,
              2,
            ),
          );
        } finally {
          process.removeListener("SIGINT", stop);
        }
        return;
      }
      const taskId = positionals[3];
      if (operation === "continue") {
        const state = taskId ? run.tasks[taskId] : undefined;
        if (
          !state?.stateDir ||
          !state.workerId ||
          !JSON.parse(
            readFileSync(
              join(state.stateDir, "workers", state.workerId, "job.json"),
              "utf8",
            ),
          ).childSession
        )
          throw new SetupError(
            "継続する子会話がありません。停止記録と予算を確認し、新しい計画を作成してください。",
          );
      }
      if (
        !["stop", "answer", "accept", "retry", "continue"].includes(
          operation ?? "",
        )
      )
        throw new SetupError("未対応のRun操作です。");
      console.log(
        JSON.stringify(
          store.command(
            id,
            values["request-id"] ?? randomUUID(),
            values["expected-version"] === undefined
              ? run.version
              : Number(values["expected-version"]),
            {
              type: operation as
                | "stop"
                | "answer"
                | "accept"
                | "retry"
                | "continue",
              taskId,
              answer: positionals.slice(4).join(" "),
              pendingId: taskId ? run.tasks[taskId]?.pendingId : undefined,
              sha: values.sha,
            },
          ),
          null,
          2,
        ),
      );
      return;
    } finally {
      store.close();
    }
  }
  if (command === "github") {
    const { allowGitHub, githubSnapshot, publishRun, githubCI } = await import(
      "./github.js"
    );
    if (!values.repo)
      throw new SetupError("GitHub操作には--repo owner/repoが必要です。");
    const operation = positionals[1];
    let result: unknown;
    if (operation === "allow" && values.yes)
      result = allowGitHub(locations.configFile, values.repo, "development");
    else if (operation === "snapshot")
      result = githubSnapshot(
        locations.stateDir,
        values.repo,
        values["project-id"],
      );
    else if (operation === "ci" && values.sha)
      result = githubCI(
        values.repo,
        values.sha,
        values["required-check"] ?? [],
      );
    else if (
      operation === "publish" &&
      positionals[2] &&
      values.sha &&
      values.from &&
      values.yes
    ) {
      const description = JSON.parse(readFileSync(values.from, "utf8"));
      if (
        typeof description.title !== "string" ||
        typeof description.body !== "string"
      )
        throw new SetupError(
          "publishの--fromにはtitle/body JSONを指定してください。",
        );
      result = publishRun(
        locations.stateDir,
        locations.configFile,
        positionals[2],
        values.repo,
        values.sha,
        description.title,
        description.body,
      );
    } else
      throw new SetupError(
        "github allow --repo R --yes、snapshot --repo R、ci --repo R --sha SHA --required-check NAME、publish RUN --repo R --sha SHA --from DESCRIPTION --yesを指定してください。",
      );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "backup" || command === "restore") {
    const { backupKeygen, createBackup, restoreBackup, listBackups } =
      await import("./backup.js");
    let result: unknown;
    if (
      command === "backup" &&
      positionals[1] === "setup" &&
      values.repo &&
      values.yes
    ) {
      const { gh, allowGitHub, uploadRecovery, GitHubError } = await import(
        "./github.js"
      );
      const metadata = gh(["api", `repos/${values.repo}`]) as any;
      if (
        metadata.private !== true ||
        String(metadata.full_name).toLowerCase() !== values.repo.toLowerCase()
      )
        throw new SetupError("指定したprivate backup repoが必要です。");
      const { setupBackupKey, backupKeyFiles } = await import(
        "./backup-key.js"
      );
      if (!existsSync(backupKeyFiles(locations.configFile).descriptor)) {
        let remote: any;
        try {
          remote = gh(["api", `repos/${values.repo}/contents/recovery`]);
        } catch (e) {
          if (!(e instanceof GitHubError && e.status === 404)) throw e;
        }
        if (Array.isArray(remote) && remote.length)
          throw new SetupError(
            "remoteに既存の復旧鍵があります。recovery-downloadとunlockで戻してください。新しい鍵は作成しません。",
          );
      }
      const key = setupBackupKey(locations.configFile);
      allowGitHub(locations.configFile, values.repo, "backup");
      result = {
        ...key,
        recovery: uploadRecovery(
          locations.configFile,
          key.recoveryFile,
          values.repo,
        ),
        next: "beethoven backup recovery --copy を自分のterminalで実行し、Apple「パスワード」へ保存してください。",
      };
    } else if (command === "backup" && positionals[1] === "status") {
      result = (await import("./backup-key.js")).backupKeyStatus(
        locations.configFile,
      );
    } else if (
      command === "backup" &&
      positionals[1] === "recovery" &&
      values.copy
    ) {
      if (!process.stdout.isTTY)
        throw new SetupError(
          "復旧コードのコピーは本人のterminalで実行してください。",
        );
      const { execFileSync } = await import("node:child_process");
      (await import("./backup-key.js")).withRecoveryCode(
        locations.configFile,
        (code) =>
          execFileSync("/usr/bin/pbcopy", [], {
            input: code,
            stdio: "pipe",
            timeout: 5000,
          }),
      );
      result = {
        copied: true,
        instruction:
          "Apple「パスワード」に専用項目を作り、password欄へ貼り付けて保存してください。保存後はclipboardを別の文字列へ更新してください。",
        offDeviceVerified: false,
      };
    } else if (
      command === "backup" &&
      positionals[1] === "recovery-download" &&
      values.repo &&
      values.sha &&
      values.out
    ) {
      result = (await import("./github.js")).downloadRecovery(
        locations.configFile,
        values.sha,
        values.repo,
        values.out,
      );
    } else if (
      command === "backup" &&
      positionals[1] === "unlock" &&
      values.from
    ) {
      if (!process.stdin.isTTY)
        throw new SetupError("本人のterminalで復旧コードを入力してください。");
      const { Terminal } = await import("./terminal.js"),
        terminal = new Terminal();
      try {
        const code = await terminal.secret(
          "Apple「パスワード」のBeethoven復旧コードを貼り付けてください。",
        );
        if (code === null) throw new SetupError("復旧を取り消しました。");
        result = (await import("./backup-key.js")).unlockBackupKey(
          locations.configFile,
          readFileSync(values.from),
          code,
        );
      } finally {
        terminal.close();
      }
    } else if (command === "backup" && positionals[1] === "list")
      result = listBackups(locations.stateDir);
    else if (
      command === "backup" &&
      positionals[1] === "allow" &&
      values.repo &&
      values.yes
    ) {
      const { allowGitHub } = await import("./github.js");
      result = allowGitHub(locations.configFile, values.repo, "backup");
    } else if (
      command === "backup" &&
      positionals[1] === "download" &&
      positionals[2] &&
      values.repo &&
      values.out
    ) {
      const { downloadBackup } = await import("./github.js");
      result = downloadBackup(
        locations.configFile,
        positionals[2],
        values.repo,
        values.out,
        values.sha,
      );
    } else if (
      command === "backup" &&
      positionals[1] === "upload" &&
      positionals[2] &&
      values.repo &&
      values.yes
    ) {
      const { uploadBackup } = await import("./github.js");
      result = uploadBackup(
        locations.stateDir,
        locations.configFile,
        positionals[2],
        values.repo,
      );
    } else if (
      command === "backup" &&
      positionals[1] === "keygen" &&
      positionals.length === 2 &&
      values.out
    )
      result = backupKeygen(values.out);
    else if (
      command === "backup" &&
      positionals[1] === "create" &&
      positionals.length === 2 &&
      values.out
    )
      result = await createBackup(
        locations.stateDir,
        locations.configFile,
        values.recipient ??
          (await import("./backup-key.js")).backupPublicKey(
            locations.configFile,
          ),
        values.out,
      );
    else if (command === "restore" && positionals.length === 2 && values.to)
      result = values.identity
        ? restoreBackup(positionals[1]!, values.identity, values.to)
        : (await import("./backup-key.js")).withBackupIdentity(
            locations.configFile,
            (key) => restoreBackup(positionals[1]!, key, values.to!),
          );
    else
      throw new SetupError(
        "backup keygen --out KEY、backup create --recipient KEY.pub --out FILE、restore FILE --identity KEY --to NEW_DIRECTORYを指定してください。",
      );
    console.log(JSON.stringify(result, null, values.json ? undefined : 2));
    return;
  }
  if (
    command === "connect" ||
    (command === "setup" &&
      !values.from &&
      !values.catalog &&
      !values.json &&
      process.stdin.isTTY &&
      process.stdout.isTTY)
  ) {
    if (!nodeSupported)
      throw new SetupError("Node 24.21.0以降の24系で起動してください。");
    if (
      !process.stdin.isTTY ||
      !process.stdout.isTTY ||
      !process.stderr.isTTY ||
      values.json ||
      values.yes ||
      values.from ||
      values.catalog ||
      positionals.length !== 1
    )
      throw new SetupError(
        "connectはローカル端末で実行してください。非TTYはsetup --fromを使用できます。",
        "terminal_required",
      );
    const { welcome } = await import("./welcome.js");
    const { runLogin } = await import("./dialogue.js");
    const result = await welcome(
      locations,
      (id, tui) => runLogin(locations.configFile, id, tui),
      values.connection,
      { forceConnect: true },
    );
    if (result)
      console.log(
        `接続 ${result.connectionId} を登録しました。beethovenで開始できます。`,
      );
    return;
  }
  if (command === "connections" || command === "routing") {
    const { connectionEvaluation, enableConnection, readRouting } =
      await import("./routing.js");
    const profile = readConnections(
      join(dirname(locations.configFile), "connections.json"),
      false,
    ).profile;
    if (!profile)
      throw new SetupError("初回設定が必要です。", "setup_required");
    if (command === "routing") {
      if (
        positionals.length !== 2 ||
        positionals[1] !== "check" ||
        values.yes ||
        values.from ||
        values.connection ||
        values.catalog
      )
        throw new SetupError("routing checkを指定してください。");
      const routing = readRouting(
        join(dirname(locations.configFile), "routing.json"),
        profile,
      );
      console.log(
        JSON.stringify({
          configured: routing !== null,
          routing,
          connections: profile.connections.map((c) => ({
            id: c.id,
            status: connectionEvaluation(locations.stateDir, c).status,
          })),
        }),
      );
      return;
    }
    if (values.from || values.catalog)
      throw new SetupError("connectionsには--from/--catalogを指定できません。");
    if (
      positionals.length === 2 &&
      positionals[1] === "enable" &&
      values.connection &&
      values.yes
    ) {
      const connection = profile.connections.find(
        (c) => c.id === values.connection,
      );
      if (!connection) throw new SetupError("接続IDがありません。");
      const evaluation = connectionEvaluation(locations.stateDir, connection);
      if (!evaluation.evaluationHash)
        throw new SetupError(
          "現在の接続の評価が必要です。",
          "evaluation_required",
        );
      enableConnection(
        locations.stateDir,
        connection,
        evaluation.evaluationHash,
      );
      console.log(JSON.stringify({ id: connection.id, status: "enabled" }));
      return;
    }
    if (positionals.length !== 1 || values.yes || values.connection)
      throw new SetupError(
        "connections、またはconnections enable --connection ID --yesを指定してください。",
      );
    console.log(
      JSON.stringify(
        profile.connections.map((c) => ({
          id: c.id,
          ...connectionEvaluation(locations.stateDir, c),
        })),
      ),
    );
    return;
  }
  if (command === "login") {
    if (
      positionals.length !== 1 ||
      values.json ||
      values.yes ||
      values.from ||
      values.catalog
    )
      throw new SetupError("loginは端末で--connectionだけを指定してください。");
    const { runLogin } = await import("./dialogue.js");
    console.log(
      JSON.stringify(await runLogin(locations.configFile, values.connection)),
    );
    return;
  }
  if (values.connection)
    throw new SetupError("--connectionは対話とlogin専用です。");
  if (command === "workers") {
    const { listWorkers, recoverWorker, workerStatus, workerLogs } =
      await import("./worker.js");
    if (positionals.length === 3 && positionals[1] === "recover") {
      const result = recoverWorker(
        locations.stateDir,
        positionals[2]!,
        values.yes === true,
      );
      console.log(JSON.stringify(result));
      if (!result.recovered) process.exitCode = 3;
      return;
    }
    if (positionals.length === 3 && positionals[1] === "logs" && !values.yes) {
      console.log(
        JSON.stringify(
          workerLogs(locations.stateDir, positionals[2]!),
          null,
          2,
        ),
      );
      return;
    }
    if (positionals.length === 2 && !values.yes) {
      console.log(
        JSON.stringify(
          workerStatus(locations.stateDir, positionals[1]!),
          null,
          2,
        ),
      );
      return;
    }
    if (positionals.length !== 1 || values.yes)
      throw new SetupError(
        "workers [ID]、workers logs ID、workers recover ID [--yes]を指定してください。",
      );
    console.log(
      JSON.stringify(
        listWorkers(locations.stateDir),
        null,
        values.json ? undefined : 2,
      ),
    );
    return;
  }
  if (command === "history" || command === "sessions") {
    if (values.yes || values.from || values.catalog)
      throw new SetupError("履歴の閲覧には保存用optionを指定できません。");
    const show = positionals[1] === "show";
    if (
      (show && positionals.length !== 3) ||
      (command === "sessions" && !show && positionals.length !== 1)
    )
      throw new SetupError(
        "history [検索]、history show ID、sessions [show ID]を指定してください。",
      );
    if (!existsSync(join(locations.stateDir, "state.sqlite"))) {
      if (show) throw new SetupError("保存済み履歴はありません。");
      console.log("[]");
      return;
    }
    const { SessionStore } = await import("./session.js");
    if (command === "sessions" && show) {
      const { savedConversation } = await import("./history.js");
      console.log(
        JSON.stringify(
          savedConversation(locations.stateDir, positionals[2]!),
          null,
          values.json ? undefined : 2,
        ),
      );
      return;
    }
    const store = new SessionStore(locations.stateDir, { readOnly: true });
    try {
      const cwd = values.all ? null : realpathSync(process.cwd());
      const result =
        command === "sessions"
          ? store.recentSessions()
          : show
            ? store.historyPrompt(positionals[2]!, cwd)
            : store.promptHistory(cwd, positionals.slice(1).join(" "));
      console.log(
        typeof result === "string" && !values.json
          ? result
          : JSON.stringify(result, null, values.json ? undefined : 2),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (command === "recover" && values.models) {
    const { recoverModelSlots } = await import("./resources.js");
    console.log(
      JSON.stringify(
        recoverModelSlots(locations.stateDir, values.yes === true),
      ),
    );
    return;
  }
  if (command === "recover" && values.ownership) {
    const { recoverRepoOwner } = await import("./ownership.js");
    console.log(
      JSON.stringify(
        recoverRepoOwner(
          locations.stateDir,
          process.cwd(),
          values.yes === true,
        ),
      ),
    );
    return;
  }
  if (command === "recover") {
    const { recoverLock } = await import("./files.js");
    const result = recoverLock(locations.stateDir, values.yes === true);
    console.log(JSON.stringify(result));
    if (!result.recovered) process.exitCode = 3;
    return;
  }
  if (command === "harness") {
    if (positionals.length !== 2 || positionals[1] !== "trust")
      throw new SetupError("harness trustを指定してください。");
    const { harnessTrust, saveHarnessTrust } = await import("./harness.js");
    const rules = inspectRules(
      process.cwd(),
      locations.configFile,
      values["trust-repo-config"],
      overrides,
    );
    if (
      !rules.snapshot.declarationsValid ||
      rules.snapshot.config.settings.permission === "read-only"
    )
      throw new SetupError(
        "宣言を修正しworkspace-writeの許可を確認してください。",
      );
    const trust = harnessTrust(rules, process.cwd());
    if (values.yes) {
      const release = acquireLock(locations.stateDir);
      try {
        saveHarnessTrust(locations.stateDir, process.cwd(), trust);
      } finally {
        release();
      }
    }
    console.log(
      JSON.stringify(
        {
          ...trust,
          approved: values.yes === true,
          execution: "host / OS隔離なし。workspace変更後は再確認が必要",
        },
        null,
        values.json ? undefined : 2,
      ),
    );
    if (!values.yes) process.exitCode = 3;
    return;
  }
  if (positionals.length !== (command === "rules" ? 2 : 1))
    throw new SetupError("余分な引数があります。--helpを確認してください。");
  if (command === "setup") {
    if (!nodeSupported)
      throw new SetupError("Node 24.21.0以降の24系で起動してください。");
    if (
      values.permission ||
      values["trust-repo-config"] ||
      values["max-tokens"] ||
      values["max-duration-ms"] ||
      values["max-cost-usd"]
    ) {
      throw new SetupError(
        "setupの接続上限は対話または--fromの宣言で指定してください。既存Policyは変更しません。",
      );
    }
    if (values.catalog) {
      if (values.from || values.yes)
        throw new SetupError("--catalogは保存のoptionと同時指定できません。");
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            source: "bundled-pi",
            authenticated: false,
            providers: connectionCatalog(),
          },
          null,
          values.json ? undefined : 2,
        ),
      );
    } else {
      const result = await runSetup(
        locations.configFile,
        locations.stateDir,
        values,
      );
      console.log(
        JSON.stringify(
          { schemaVersion: 1, ...result },
          null,
          values.json ? undefined : 2,
        ),
      );
      process.exitCode = result.exitCode;
    }
    return;
  }
  if (values.from || values.yes || values.catalog)
    throw new SetupError("--from/--yes/--catalogはsetup専用です。");
  if (command === "init") {
    // DBの作成は本人の明示操作。doctor/show/checkのためだけにstateを作らない。
    if (!nodeSupported)
      throw new Error("Node 24.21.0以降の24系で起動してください。");
    loadConfig(
      process.cwd(),
      locations.configFile,
      values["trust-repo-config"],
      overrides,
    );
    await initializeStore(locations.stateDir);
    console.log(
      values.json
        ? JSON.stringify({
            schemaVersion: 1,
            state: "initialized",
            stateDir: locations.stateDir,
          })
        : `状態DBを初期化しました: ${locations.stateDir}`,
    );
    return;
  }
  const rules = inspectRules(
    process.cwd(),
    locations.configFile,
    values["trust-repo-config"],
    overrides,
  );
  const config = rules.snapshot.config;
  if (command === "rules") {
    if (rulesCommand === "snapshot" && rules.snapshot.declarationsValid) {
      if (!nodeSupported)
        throw new Error("Node 24.21.0以降の24系で起動してください。");
      // 原本を含むsnapshotは本人専用artifactへ保存。show/checkはこの書込経路を通らない。
      const release = acquireLock(locations.stateDir);
      try {
        // 読込後に原本が変わった場合は、見た内容と異なる条件で保存したことにしない。
        if (
          inspectRules(
            process.cwd(),
            locations.configFile,
            values["trust-repo-config"],
            overrides,
          ).hash !== rules.hash
        ) {
          throw new Error("適用元が変わりました。再診断してください。");
        }
        const saved = saveArtifact(
          locations.stateDir,
          Buffer.from(JSON.stringify(rules.snapshot)),
        );
        console.log(
          JSON.stringify({ schemaVersion: 1, status: "saved", ...saved }),
        );
      } finally {
        release();
      }
    } else {
      console.log(JSON.stringify(rules, null, values.json ? undefined : 2));
    }
    if (!rules.snapshot.declarationsValid) process.exitCode = 3;
    return;
  }
  const expected = packageInfo.dependencies["@earendil-works/pi-coding-agent"];
  let piVersion: string | null = null;
  let rpcEntryExists = false;
  try {
    // Coding Agent SDK/RPCは起動せず配置だけを調べる。catalogの静的読込とは別の確認。
    // PATH上の別Piや本人の認証設定は利用しない。
    // import条件のexportを持つpackageなので、require.resolveではなくimport.meta.resolveを使う。
    const entry = fileURLToPath(
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const root = dirname(dirname(entry));
    const info = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { version: string; bin: { pi: string } };
    piVersion = info.version;
    rpcEntryExists =
      existsSync(
        fileURLToPath(
          import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
        ),
      ) && existsSync(join(root, info.bin.pi));
  } catch {
    /* 未導入を利用可能と表示しない */
  }
  const database = join(locations.stateDir, "state.sqlite");
  const version = existsSync(database) ? readDatabaseVersion(database) : null;
  const connections = readConnections(
    join(dirname(locations.configFile), "connections.json"),
    false,
  ).profile;
  const catalog = connectionCatalog();
  const report = {
    schemaVersion: 1,
    stage: "P3-implementation",
    node: { version: process.versions.node, supported: nodeSupported },
    pi: {
      expected,
      installed: piVersion,
      rpcEntryExists,
      connectionTested: false,
    },
    config,
    paths: locations,
    // 保存済みでも未認証。credentialの実体を調べず、選択内容と許可IDの対応だけを表示する。
    connections: {
      configured: connections !== null,
      defaultConnectionId: connections?.defaultConnectionId ?? null,
      items:
        connections?.connections.map((item) => ({
          id: item.id,
          provider: item.provider,
          model: item.model,
          method: item.auth.method,
          billing: item.billing.kind,
          status: item.status,
          listedInCatalog: catalog.some(
            (provider) =>
              provider.id === item.provider &&
              provider.models.some((model) => model.id === item.model),
          ),
        })) ?? [],
      authentication: "not_checked",
      executionReady: false,
      notAllowedConnectionIds:
        connections?.connections
          .filter(
            (item) => !config.settings.allowedConnections.includes(item.id),
          )
          .map((item) => item.id) ?? [],
    },
    // doctorは内容本文を繰り返し出さず、適用元・hash・不足を要約する。原本確認はrules show。
    rules: {
      hash: rules.hash,
      repository: rules.snapshot.repository,
      sources: rules.snapshot.sources.map(({ content, ...source }) => source),
      diagnostics: rules.snapshot.diagnostics,
      declarationsValid: rules.snapshot.declarationsValid,
      executionReady: false,
    },
    database: {
      version,
      supported: version === null || version === schemaVersion,
    },
    maintenanceLocked: existsSync(join(locations.stateDir, "maintenance.lock")),
    // 宣言の診断とハーネスの実行は別機能。packageの存在をモデル疎通とも混同しない。
    capabilitiesMeaning:
      "実装済み機能。本人の認証・接続の利用可能性はnot_checkedで、doctorは実行を開始しない。",
    capabilities: {
      connectionSetup: true,
      rulesInspection: true,
      harnessExecution: true,
      interactive: true,
      tui: true,
      models: true,
      workers: true,
      workerConcurrency: 4,
      workerResume: true,
      orchestration: true,
      dag: true,
      sessionMonitor: true,
      encryptedBackup: true,
      backup: true,
      githubPublish: true,
      stagedUpdate: true,
    },
    networkRequests: 0,
  };
  console.log(
    values.json ? JSON.stringify(report) : JSON.stringify(report, null, 2),
  );
  // 未初期化DBは正常な診断結果。導入版の不一致等はreportを出した上で終了code 1にする。
  if (
    !nodeSupported ||
    piVersion !== expected ||
    !rpcEntryExists ||
    !report.database.supported
  )
    process.exitCode = 1;
  else if (!rules.snapshot.declarationsValid) process.exitCode = 3;
}

main().catch((error) => {
  // 生の例外には設定値・認証値が含まれる可能性があるため出力しない。
  const message =
    error instanceof SetupError
      ? error.message
      : "Beethovenの起動に失敗しました。コマンド、設定形式、保存先の権限・lock、DB schemaを確認してください。";
  // parseArgs自体が失敗しても、--json指定時は機械が読めるエラー形式に揃える。
  if (process.argv.includes("--json"))
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        error: error instanceof SetupError ? error.code : "startup_failed",
        message,
      }),
    );
  else console.error(message);
  process.exitCode =
    error instanceof SetupError &&
    [
      "settings_changed",
      "send_approval_required",
      "setup_required",
      "prompt_required",
      "authentication_required",
      "connection_not_allowed",
      "connection_changed",
      "rules_changed",
      "budget_blocked",
      "terminal_required",
      "process_remaining",
    ].includes(error.code)
      ? 3
      : 2;
});
