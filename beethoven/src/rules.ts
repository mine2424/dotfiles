import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig, type Settings } from './config.js';

type Stage = 'preflight' | 'verify';
type Requirement = { id: string; required: boolean; stage: Stage };
type Check = {
  id: string; stage: Stage; argv: string[]; cwd: string; timeoutMs: number;
  acceptanceIds: string[]; requiredEnv: string[];
};
type Source = { scope: 'common' | 'repo'; kind: 'rules' | 'harness'; path: string; realPath: string; hash: string; content: string };
type Diagnostic = { code: string; path: string; message: string; checkId?: string };

/** repoの同一性は共通Git directoryで判断し、規約の実体は現在のworktreeから読む。 */
export function findRepository(cwd: string) {
  // GIT_DIR等を引き継ぐと、呼出し元の環境により別repoを診断してしまう。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const run = (...args: string[]) => spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, 'rev-parse', ...args], {
    env: { ...env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
  });
  const root = run('--show-toplevel');
  if (root.status !== 0) {
    if (!root.error && root.stderr.includes('not a git repository')) return null;
    throw new Error('Git repoを確認できません。Gitの導入・cwd・所有権を確認してください。');
  }
  const common = run('--path-format=absolute', '--git-common-dir');
  if (common.status !== 0) throw new Error('Git common directoryを確認できません。');
  const head = run('--verify', 'HEAD');
  return { root: realpathSync(root.stdout.trim()), commonDir: realpathSync(common.stdout.trim()), head: head.status === 0 ? head.stdout.trim() : null };
}

/** lexicalな..だけでなく、symlinkをたどった先もworkspace内か確認する。 */
function within(root: string, path: string) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !isAbsolute(part);
}

/** 小さい宣言JSONだけを受け付ける。未知の項目や秘密値を例外文へ含めない。 */
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('宣言形式または項目が不正です。');
  }
  return value as Record<string, unknown>;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
}

function isStage(value: unknown): value is Stage {
  return value === 'preflight' || value === 'verify';
}

/** 共通/repoに同じ形式を使い、requirementと実行定義を別々に検証する。 */
function parseHarness(content: string): { requirements: Requirement[]; checks: Check[] } {
  const data = object(JSON.parse(content), ['schemaVersion', 'requirements', 'checks']);
  if (data.schemaVersion !== 1 || (data.requirements !== undefined && !Array.isArray(data.requirements)) ||
    (data.checks !== undefined && !Array.isArray(data.checks))) throw new Error('ハーネスの版または配列が不正です。');
  const requirements = ((data.requirements ?? []) as unknown[]).map(value => {
    const item = object(value, ['id', 'required', 'stage']);
    if (!isId(item.id) || typeof item.required !== 'boolean' || !isStage(item.stage)) throw new Error('必須条件が不正です。');
    return { id: item.id, required: item.required, stage: item.stage };
  });
  const checks = ((data.checks ?? []) as unknown[]).map(value => {
    const item = object(value, ['id', 'stage', 'argv', 'cwd', 'timeoutMs', 'acceptanceIds', 'requiredEnv']);
    if (!isId(item.id) || !isStage(item.stage) || !Array.isArray(item.argv) || !item.argv.length ||
      !item.argv.every(arg => typeof arg === 'string' && arg.length > 0 && !arg.includes('\0')) ||
      typeof item.cwd !== 'string' || !item.cwd || isAbsolute(item.cwd) || item.cwd.includes('\0') ||
      typeof item.timeoutMs !== 'number' || !Number.isSafeInteger(item.timeoutMs) || item.timeoutMs <= 0 ||
      !Array.isArray(item.acceptanceIds) || !item.acceptanceIds.every(isId) ||
      !Array.isArray(item.requiredEnv) || !item.requiredEnv.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      throw new Error('実行定義が不正です。');
    }
    return item as Check;
  });
  return { requirements, checks };
}

/**
 * 共通→repoの規約とハーネスを読み、出所・原本・実効条件をまとめる。
 * Gitの読取以外のprocess起動、モデル呼出し、file書込は行わない。
 */
export function inspectRules(cwd: string, configFile: string, trustRepo = false, overrides: Partial<Settings> = {}) {
  const repository = findRepository(cwd);
  // サブdirectoryから起動しても、同じrepo rootの宣言設定を読む。
  const config = loadConfig(repository?.root ?? cwd, configFile, trustRepo, overrides);
  const sources: Source[] = [];
  const diagnostics: Diagnostic[] = [];
  const requirements = new Map<string, Requirement & { sources: string[] }>();
  const checks: (Check & { source: string; resolvedCwd: string | null; executionApproved: false })[] = [];
  const loadedRules = new Set<string>();
  const inputs: { path: string; present: boolean }[] = [];
  const candidates: { scope: 'common' | 'repo'; kind: 'rules' | 'harness'; path: string }[] = [
    { scope: 'common', kind: 'rules', path: join(dirname(configFile), 'rules.md') },
    { scope: 'common', kind: 'harness', path: join(dirname(configFile), 'harness.json') },
  ];
  if (repository) candidates.push(
    { scope: 'repo', kind: 'rules', path: join(repository.root, 'AGENTS.md') },
    { scope: 'repo', kind: 'harness', path: join(repository.root, '.beethoven', 'harness.json') },
  );

  for (const candidate of candidates) {
    let source: Source;
    let present = false;
    try {
      lstatSync(candidate.path);
      present = true;
      const info = statSync(candidate.path);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('通常の1MiB以下のfileが必要です。');
      const realPath = realpathSync(candidate.path);
      if (candidate.scope === 'repo' && !within(repository!.root, realPath)) throw new Error('repo外を参照しています。');
      const bytes = readFileSync(candidate.path);
      if (bytes.byteLength > 1024 * 1024) throw new Error('読込上限を越えています。');
      source = { ...candidate, realPath, hash: createHash('sha256').update(bytes).digest('hex'), content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
      inputs.push({ path: candidate.path, present: true });
    } catch (error) {
      if (!present && (error as NodeJS.ErrnoException).code === 'ENOENT') { inputs.push({ path: candidate.path, present: false }); continue; }
      diagnostics.push({ code: 'source_unreadable', path: candidate.path, message: '原本の形式・容量・参照先・読込権限を確認してください。' });
      continue;
    }
    if (source.kind === 'rules') {
      // 同じ実体を共通/repoから参照しても、モデルへ同じ原本を二重投入しない。
      if (!loadedRules.has(source.realPath)) { sources.push(source); loadedRules.add(source.realPath); }
      continue;
    }
    let harness: ReturnType<typeof parseHarness>;
    try { harness = parseHarness(source.content); }
    catch {
      // parser例外や不正JSONの本文を返さない。原本が不正ならsnapshot保存も不可。
      diagnostics.push({ code: 'invalid_harness', path: source.path, message: 'ハーネスのJSON、schemaVersion、項目と型を確認してください。' });
      continue;
    }
    sources.push(source);
    for (const item of harness.requirements) {
      const previous = requirements.get(item.id);
      if (previous && previous.stage !== item.stage) diagnostics.push({ code: 'stage_conflict', path: source.path, checkId: item.id, message: '同じ必須checkのstageが競合しています。' });
      if (previous?.required && !item.required) diagnostics.push({ code: 'required_check_disabled', path: source.path, checkId: item.id, message: '上位の必須checkを任意へ変更できません。' });
      // requiredは和集合。後の層がfalseでも、すでに必須のものは必須のまま残す。
      requirements.set(item.id, { ...item, stage: previous?.stage ?? item.stage, required: !!previous?.required || item.required, sources: [...(previous?.sources ?? []), source.path] });
    }
    for (const item of harness.checks) {
      let resolvedCwd: string | null = null;
      try {
        if (!repository) throw new Error('実行repoが必要です。');
        resolvedCwd = realpathSync(resolve(repository.root, item.cwd));
        if (!within(repository.root, resolvedCwd) || !statSync(resolvedCwd).isDirectory()) throw new Error('cwdがworkspace外です。');
      } catch {
        resolvedCwd = null;
        diagnostics.push({ code: 'invalid_check_cwd', path: source.path, checkId: item.id, message: 'checkのcwdは存在するrepo内directoryが必要です。' });
      }
      if (checks.some(check => check.id === item.id)) diagnostics.push({ code: 'duplicate_check', path: source.path, checkId: item.id, message: '実行定義が重複しています。自動上書きせず正本を選んでください。' });
      checks.push({ ...item, source: source.path, resolvedCwd, executionApproved: false });
    }
  }

  for (const item of requirements.values()) {
    const definitions = checks.filter(check => check.id === item.id);
    if (item.required && definitions.length === 0) diagnostics.push({ code: 'missing_required_check', path: item.sources[0]!, checkId: item.id, message: '必須checkの実行定義が不足しています。' });
    if (definitions.some(check => check.stage !== item.stage)) diagnostics.push({ code: 'stage_conflict', path: item.sources[0]!, checkId: item.id, message: '必須条件と実行定義のstageが一致しません。' });
  }
  // 時刻を含めず、同じ入力なら同じhashになるsnapshotを返す。保存は明示commandだけで行う。
  const snapshot = {
    schemaVersion: 1, repository, config, inputs, sources,
    requirements: [...requirements.values()], checks, diagnostics,
    declarationsValid: diagnostics.length === 0,
    executionReady: false, // P1Rの宣言検査に成功しても、コマンド実行の許可にはならない。
  };
  const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { hash, snapshot };
}
