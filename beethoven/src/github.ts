import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { hash, replaceFile, git } from "./workspace.js";
import { privateDirectory } from "./files.js";
import { SetupError } from "./connections.js";
import { parseRecovery } from "./backup-key.js";
import { RunStore } from "./run-store.js";
export type GitHubTransport = (args: string[], input?: unknown) => unknown;
/** authはgh自身が管理する。失敗時にtokenやremote本文を利用者へそのまま出さない。 */
export const gh: GitHubTransport = (args, input) => {
  try {
    return JSON.parse(
      execFileSync("gh", args, {
        encoding: "utf8",
        input: input === undefined ? undefined : JSON.stringify(input),
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
        maxBuffer: 100 * 1024 * 1024,
      }),
    );
  } catch (error) {
    const e = error as { stderr?: Buffer | string };
    if (String(e.stderr ?? "").includes("HTTP 404")) throw new GitHubError(404);
    throw new GitHubError(0);
  }
};
export class GitHubError extends Error {
  constructor(public status: number) {
    super(
      "GitHub通信に失敗しました。ローカル成果は保持しています。認証・権限・接続と保存済みreceiptを確認してください。",
    );
  }
}
const repository = (value: string) => {
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value) ||
    value.split("/").some((p) => p === "." || p === "..")
  )
    throw new SetupError("GitHub repoはowner/repoで指定してください。");
  return value;
};
const save = (file: string, value: unknown) =>
  replaceFile(
    file,
    JSON.stringify(value, null, 2) + "\n",
    existsSync(file) ? hash(readFileSync(file)) : null,
    0o600,
  );
type Capabilities = {
  schemaVersion: 1;
  developmentRepos: string[];
  backupRepo?: string;
};
export function githubCapabilities(configFile: string): Capabilities {
  const file = join(dirname(configFile), "github.json");
  if (!existsSync(file)) return { schemaVersion: 1, developmentRepos: [] };
  const data = JSON.parse(readFileSync(file, "utf8")) as Capabilities;
  if (data.schemaVersion !== 1 || !Array.isArray(data.developmentRepos))
    throw new SetupError("GitHub capability設定が不正です。");
  data.developmentRepos.forEach(repository);
  if (data.backupRepo) repository(data.backupRepo);
  return data;
}
export function allowGitHub(
  configFile: string,
  repo: string,
  kind: "development" | "backup",
) {
  repository(repo);
  const data = githubCapabilities(configFile);
  if (kind === "backup") data.backupRepo = repo;
  else data.developmentRepos = [...new Set([...data.developmentRepos, repo])];
  privateDirectory(dirname(configFile));
  save(join(dirname(configFile), "github.json"), data);
  return data;
}
function allowed(
  configFile: string,
  repo: string,
  kind: "development" | "backup",
) {
  repository(repo);
  const c = githubCapabilities(configFile);
  if (
    kind === "backup"
      ? c.backupRepo !== repo
      : !c.developmentRepos.includes(repo)
  )
    throw new SetupError(
      "このrepoへの送信capabilityがありません。github allowまたはbackup allowで送信先を明示してください。",
    );
}
/** 全pageが揃ったsnapshotだけをcompleteとする。Projectはカーソルを進めて部分取得を成功にしない。 */
export function githubSnapshot(
  stateDir: string,
  repo: string,
  projectId?: string,
  transport: GitHubTransport = gh,
) {
  repository(repo);
  const id = randomUUID(),
    file = join(stateDir, "github-inputs", id + ".json");
  privateDirectory(dirname(file));
  const snapshot: {
    id: string;
    repo: string;
    fetchedAt: string;
    complete: boolean;
    repository?: unknown;
    issues?: unknown;
    project?: unknown;
    error?: string;
  } = { id, repo, fetchedAt: new Date().toISOString(), complete: false };
  try {
    snapshot.repository = transport(["api", `repos/${repo}`]);
    snapshot.issues = transport([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues?state=open&per_page=100`,
    ]);
    if (projectId) {
      if (!/^PVT_[A-Za-z0-9_]+$/.test(projectId))
        throw new SetupError("Project node IDが不正です。");
      const items: unknown[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const response = transport(["api", "graphql", "--input", "-"], {
          query:
            "query($id:ID!,$cursor:String){node(id:$id){... on ProjectV2{id title updatedAt items(first:100,after:$cursor){nodes{id updatedAt content{... on Issue{id number title body updatedAt repository{nameWithOwner}} ... on DraftIssue{title body}}}pageInfo{hasNextPage endCursor}}}}}",
          variables: { id: projectId, cursor },
        }) as any;
        if (response.errors || !response.data?.node?.items)
          throw new SetupError("Projectの部分失敗です。");
        const node = response.data.node;
        items.push(...node.items.nodes);
        snapshot.project = {
          id: node.id,
          title: node.title,
          updatedAt: node.updatedAt,
          items,
        };
        cursor = node.items.pageInfo.hasNextPage
          ? node.items.pageInfo.endCursor
          : null;
        if (cursor) {
          if (seen.has(cursor) || items.length > 20000)
            throw new SetupError("Project paginationを完了できません。");
          seen.add(cursor);
        }
      } while (cursor);
    }
    snapshot.complete = true;
    save(file, snapshot);
    return { ...snapshot, file, sha256: hash(readFileSync(file)) };
  } catch {
    snapshot.error = "github_fetch_incomplete";
    save(file, snapshot);
    throw new SetupError(
      "GitHub入力を完全取得できませんでした。部分snapshotを保持し、計画の自動実行は行いません。",
    );
  }
}
/** 開発repoのpublishだけを扱い、backup送信capabilityを流用しない。再送前にbranch/PRを照合する。 */
export function publishRun(
  stateDir: string,
  configFile: string,
  id: string,
  repo: string,
  expectedSha: string,
  title: string,
  body: string,
  transport: GitHubTransport = gh,
  push?: (cwd: string, repo: string, sha: string, branch: string) => void,
) {
  allowed(configFile, repo, "development");
  const store = new RunStore(stateDir);
  try {
    const run = store.get(id);
    if (
      run.ownerPid ||
      !run.humanAccepted ||
      run.status !== "completed" ||
      run.integrationSha !== expectedSha ||
      git(run.integration, ["rev-parse", "HEAD"]).trim() !== expectedSha ||
      git(run.integration, ["status", "--porcelain"]).trim()
    )
      throw new SetupError(
        "停止済み・受入済み・差分のない現在SHAだけをpublishできます。",
      );
    const info = transport(["api", `repos/${repo}`]) as any;
    if (
      String(info.full_name).toLowerCase() !== repo.toLowerCase() ||
      !info.default_branch
    )
      throw new SetupError("GitHub送信先を確認できません。");
    const branch = `beethoven/${id}/${expectedSha.slice(0, 12)}`,
      directory = join(stateDir, "publish", id);
    privateDirectory(directory);
    const file = join(directory, expectedSha + ".json");
    const receipt: any = {
      version: 1,
      runId: id,
      repo,
      sha: expectedSha,
      branch,
      status: "executing",
      updatedAt: new Date().toISOString(),
    };
    save(file, receipt);
    let ref: any;
    try {
      ref = transport(["api", `repos/${repo}/git/ref/heads/${branch}`]);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
    if (ref && ref.object?.sha !== expectedSha)
      throw new SetupError("送信先branchが異なるSHAです。上書きしません。");
    if (!ref) {
      if (push) push(run.integration, repo, expectedSha, branch);
      else
        git(run.integration, [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "push",
          `https://github.com/${repo}.git`,
          `${expectedSha}:refs/heads/${branch}`,
        ]);
    }
    ref = transport(["api", `repos/${repo}/git/ref/heads/${branch}`]) as any;
    if (ref.object?.sha !== expectedSha)
      throw new SetupError("remote SHAを確認できません。");
    receipt.remoteSha = ref.object.sha;
    save(file, receipt);
    const prs = transport([
      "api",
      `repos/${repo}/pulls?state=all&head=${repo.split("/")[0]}:${branch}&per_page=100`,
    ]) as any[];
    let pr = prs.find(
      (p) =>
        p.head?.sha === expectedSha &&
        p.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase(),
    );
    if (!pr)
      pr = transport(
        ["api", "--method", "POST", `repos/${repo}/pulls`, "--input", "-"],
        {
          title,
          body: `${body}\n\nBeethoven Run: ${id}\nHead: ${expectedSha}`,
          head: branch,
          base: info.default_branch,
          draft: true,
        },
      ) as any;
    if (pr.head?.sha !== expectedSha || !pr.html_url)
      throw new SetupError("Draft PRのSHAを照合できません。");
    Object.assign(receipt, {
      status: "succeeded",
      pr: pr.number,
      url: pr.html_url,
      draft: pr.draft,
      closed: pr.state === "closed",
    });
    save(file, receipt);
    return receipt;
  } finally {
    store.close();
  }
}
/** 必須名が未指定・欠落・別SHA・skippedなら合格しない。 */
export function githubCI(
  repo: string,
  sha: string,
  required: string[],
  transport: GitHubTransport = gh,
) {
  repository(repo);
  if (!/^[a-f0-9]{40,64}$/.test(sha))
    throw new SetupError("CIのhead SHAが不正です。");
  const pages = transport([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/commits/${sha}/check-runs?per_page=100`,
  ]) as any[];
  const checks = pages
    .flatMap((page) => page.check_runs ?? [])
    .filter((check) => check.head_sha === sha);
  const latest = required.map(
    (name) =>
      checks.filter((c) => c.name === name).sort((a, b) => b.id - a.id)[0],
  );
  return {
    repo,
    sha,
    required,
    checks,
    status:
      required.length &&
      latest.every(
        (c) => c?.status === "completed" && c.conclusion === "success",
      )
        ? "passed"
        : "pending_or_failed",
  };
}
/** 暗号文だけを専用private repoへ保存し、remote blobのhashを再取得してreceiptを残す。 */
export function uploadBackup(
  stateDir: string,
  configFile: string,
  file: string,
  repo: string,
  transport: GitHubTransport = gh,
) {
  allowed(configFile, repo, "backup");
  const metadata = transport(["api", `repos/${repo}`]) as any;
  if (
    metadata.private !== true ||
    String(metadata.full_name).toLowerCase() !== repo.toLowerCase()
  )
    throw new SetupError("backup先は指定したprivate repoが必要です。");
  const bytes = readFileSync(file),
    envelope = JSON.parse(bytes.toString("utf8"));
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "RSA-OAEP-SHA256+AES-256-GCM" ||
    !/^[a-f0-9-]{36}$/.test(envelope.id) ||
    bytes.length > 50 * 1024 * 1024
  )
    throw new SetupError("backup暗号文の形式・容量が不正です。");
  const path = `snapshots/${envelope.id}.btb`,
    directory = join(stateDir, "receipts");
  privateDirectory(directory);
  const receipt: any = {
    snapshotId: envelope.id,
    repo,
    path,
    sha256: hash(bytes),
    localCreated: true,
    remoteVerified: false,
  };
  const receiptFile = join(directory, envelope.id + ".json");
  save(receiptFile, receipt);
  let existing: any;
  try {
    existing = transport(["api", `repos/${repo}/contents/${path}`]);
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error;
  }
  let blobSha = existing?.sha;
  if (!existing) {
    const result = transport(
      [
        "api",
        "--method",
        "PUT",
        `repos/${repo}/contents/${path}`,
        "--input",
        "-",
      ],
      {
        message: `Beethoven snapshot ${envelope.id}`,
        content: bytes.toString("base64"),
      },
    ) as any;
    blobSha = result.content?.sha;
    receipt.commit = result.commit?.sha;
  }
  if (!blobSha)
    throw new SetupError("backup remote blobの識別子がありません。");
  const blob = transport(["api", `repos/${repo}/git/blobs/${blobSha}`]) as any;
  if (
    blob.encoding !== "base64" ||
    hash(Buffer.from(blob.content, "base64")) !== receipt.sha256
  )
    throw new SetupError("backupのremote hashが一致しません。");
  Object.assign(receipt, { remoteVerified: true, blobSha });
  save(receiptFile, receipt);
  return receipt;
}

/** Download only the selected private backup, with no overwrite or credential output. */
export function downloadBackup(
  configFile: string,
  id: string,
  repo: string,
  output: string,
  expectedSha?: string,
  transport: GitHubTransport = gh,
) {
  allowed(configFile, repo, "backup");
  if (
    !/^[a-f0-9-]{36}$/.test(id) ||
    (expectedSha !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha))
  )
    throw new SetupError("snapshot ID・SHA-256が不正です。");
  const target = resolve(output);
  if (existsSync(target))
    throw new SetupError("取得先の既存fileを上書きしません。");
  const metadata = transport(["api", `repos/${repo}`]) as any;
  if (
    metadata.private !== true ||
    String(metadata.full_name).toLowerCase() !== repo.toLowerCase()
  )
    throw new SetupError("指定したprivate backup repoが必要です。");
  const record = transport([
    "api",
    `repos/${repo}/contents/snapshots/${id}.btb`,
  ]) as any;
  if (
    !/^[a-f0-9]{40}$/.test(record.sha) ||
    record.type !== "file" ||
    !Number.isSafeInteger(record.size) ||
    record.size > 50 * 1024 * 1024
  )
    throw new SetupError("remote snapshotの識別子・容量が不正です。");
  const blob = transport([
    "api",
    `repos/${repo}/git/blobs/${record.sha}`,
  ]) as any;
  if (
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    blob.content.length > 72 * 1024 * 1024
  )
    throw new SetupError("remote snapshotの形式が不正です。");
  const bytes = Buffer.from(blob.content, "base64"),
    sha256 = hash(bytes),
    gitSha = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
  if (
    bytes.length !== record.size ||
    gitSha !== record.sha ||
    (expectedSha && sha256 !== expectedSha)
  )
    throw new SetupError("取得したbackupのhashが一致しません。");
  const envelope = JSON.parse(bytes.toString("utf8"));
  if (
    envelope.version !== 1 ||
    envelope.id !== id ||
    envelope.algorithm !== "RSA-OAEP-SHA256+AES-256-GCM"
  )
    throw new SetupError("snapshotの内容・IDが不正です。");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  return {
    snapshotId: id,
    repo,
    path: target,
    sha256,
    downloadVerified: true,
    restoreVerified: false,
  };
}

/** Recovery identity is encrypted independently by the code kept outside GitHub. */
export function uploadRecovery(
  configFile: string,
  file: string,
  repo: string,
  transport: GitHubTransport = gh,
) {
  const { fingerprint } = validateRecoveryFile(file),
    bytes = readFileSync(file);
  allowed(configFile, repo, "backup");
  const metadata = transport(["api", `repos/${repo}`]) as any;
  if (
    metadata.private !== true ||
    String(metadata.full_name).toLowerCase() !== repo.toLowerCase()
  )
    throw new SetupError("指定したprivate backup repoが必要です。");
  const path = `recovery/${fingerprint}.json`;
  let record: any;
  try {
    record = transport(["api", `repos/${repo}/contents/${path}`]);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 404)) throw e;
  }
  if (!record) {
    const result = transport(
      [
        "api",
        "--method",
        "PUT",
        `repos/${repo}/contents/${path}`,
        "--input",
        "-",
      ],
      {
        message: "Add encrypted Beethoven recovery identity",
        content: bytes.toString("base64"),
      },
    ) as any;
    record = result.content;
  }
  if (!/^[a-f0-9]{40}$/.test(record?.sha))
    throw new SetupError("復旧鍵のremote識別子が不正です。");
  const blob = transport([
    "api",
    `repos/${repo}/git/blobs/${record.sha}`,
  ]) as any;
  if (
    blob.encoding !== "base64" ||
    hash(Buffer.from(blob.content, "base64")) !== hash(bytes)
  )
    throw new SetupError(
      "remoteの復旧鍵が異なります。既存記録を上書きしません。",
    );
  return {
    fingerprint,
    repo,
    path,
    sha256: hash(bytes),
    remoteVerified: true,
    codeUploaded: false,
  };
}
function validateRecoveryFile(file: string) {
  const bytes = readFileSync(file);
  return parseRecovery(bytes);
}
export function downloadRecovery(
  configFile: string,
  fingerprint: string,
  repo: string,
  output: string,
  transport: GitHubTransport = gh,
) {
  allowed(configFile, repo, "backup");
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || existsSync(output))
    throw new SetupError("fingerprintと未作成の保存先を指定してください。");
  const metadata = transport(["api", `repos/${repo}`]) as any;
  if (
    metadata.private !== true ||
    String(metadata.full_name).toLowerCase() !== repo.toLowerCase()
  )
    throw new SetupError("指定したprivate repoが必要です。");
  const record = transport([
    "api",
    `repos/${repo}/contents/recovery/${fingerprint}.json`,
  ]) as any;
  if (
    !/^[a-f0-9]{40}$/.test(record.sha) ||
    record.type !== "file" ||
    record.size > 16384
  )
    throw new SetupError("remote復旧鍵の形式が不正です。");
  const blob = transport([
    "api",
    `repos/${repo}/git/blobs/${record.sha}`,
  ]) as any;
  if (
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    blob.content.length > 24000
  )
    throw new SetupError("復旧鍵が容量上限を越えています。");
  const bytes = Buffer.from(blob.content, "base64"),
    d = parseRecovery(bytes),
    sha = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
  if (
    sha !== record.sha ||
    record.size !== bytes.length ||
    d.fingerprint !== fingerprint
  )
    throw new SetupError("復旧鍵のhashが一致しません。");
  mkdirSync(dirname(resolve(output)), { recursive: true, mode: 0o700 });
  writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
  return { fingerprint, repo, file: resolve(output), downloadVerified: true };
}
