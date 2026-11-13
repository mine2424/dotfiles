import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// 設定には権限・上限・接続IDだけを持たせる。認証情報そのものは扱わない。
export type Settings = {
  schemaVersion: 1;
  permission: 'read-only' | 'workspace-write';
  maxTokens: number;
  maxDurationMs: number;
  maxCostUsd: number;
  allowedConnections: string[];
};

// 初回起動では書込とモデル接続を許可しない。上限値はP2以降の実行制御へ渡す。
const defaults: Settings = {
  schemaVersion: 1, permission: 'read-only', maxTokens: 20000,
  maxDurationMs: 600000, maxCostUsd: 1, allowedConnections: [],
};

/** 個人設定と実行状態をdotfiles外に置く。env/homeを差し替えると試験先を隔離できる。 */
export function paths(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const configRoot = env.XDG_CONFIG_HOME || join(home, '.config');
  const stateRoot = env.XDG_STATE_HOME || join(home, '.local', 'state');
  if (!isAbsolute(configRoot) || !isAbsolute(stateRoot)) {
    // 相対パスだと起動したcwd次第で保存先が変わり、状態を取り違えるため拒否する。
    throw new Error('XDGの保存先には絶対パスを指定してください。');
  }
  return { configFile: join(configRoot, 'beethoven', 'config.json'), stateDir: join(stateRoot, 'beethoven') };
}

/** 未作成の設定は既定値で補う。読込失敗・不正JSONは無視せず起動を止める。 */
function readSettings(file: string): Partial<Settings> {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`設定ファイルを読み込めません: ${file}`);
  }
  let value: unknown;
  // JSON.parseの例外には入力本文が含まれ得るため、値を含まないエラーに置き換える。
  try { value = JSON.parse(text); }
  catch { throw new Error(`設定JSONが不正です: ${file}`); }
  return validateSettings(value, file);
}

/** ファイルとCLIで共通の検証。TypeScriptの型だけでは外部入力を保証できない。 */
function validateSettings(value: unknown, file: string): Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`設定形式が不正です: ${file}`);
  const data = value as Record<string, unknown>;
  // 設定ミスや秘密値の混入を黙って無視せず、未対応の項目として拒否する。
  if (Object.keys(data).some(key => !Object.hasOwn(defaults, key))) throw new Error(`未対応の設定項目があります: ${file}`);
  if (data.schemaVersion !== 1) throw new Error(`設定schemaVersionは1が必要です: ${file}`);
  if (data.permission !== undefined && data.permission !== 'read-only' && data.permission !== 'workspace-write') {
    throw new Error(`permissionが不正です: ${file}`);
  }
  for (const key of ['maxTokens', 'maxDurationMs', 'maxCostUsd'] as const) {
    const number = data[key];
    // token数・時間(ms)は整数、金額(USD)は小数を許す。0を「無制限」にはしない。
    if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number <= 0 ||
      (key !== 'maxCostUsd' && !Number.isSafeInteger(number)))) throw new Error(`実行上限が不正です: ${file}`);
  }
  if (data.allowedConnections !== undefined && (!Array.isArray(data.allowedConnections) ||
    !data.allowedConnections.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id)))) {
    throw new Error(`allowedConnectionsが不正です: ${file}`);
  }
  return data as Partial<Settings>;
}

/**
 * builtin → 個人 → 信頼済みrepo → CLIの順で、実効設定と値の出所を返す。
 * 後の設定が強い単純な上書きではなく、個人・repoの明示した制約を守って合成する。
 */
export function loadConfig(cwd: string, configFile: string, trustRepo = false, overrides: Partial<Settings> = {}) {
  const personal = readSettings(configFile);
  const repoFile = join(cwd, '.beethoven', 'config.json');
  // cloneしたrepoの設定を本人の同意なしに有効化しない。未信頼なら読込自体をしない。
  const repo = trustRepo ? readSettings(repoFile) : {};
  const settings: Settings = { ...defaults, ...personal };
  // doctorで「なぜこの値になったか」を追えるよう、最終値の採用元も保持する。
  const sources = Object.fromEntries(Object.keys(defaults).map(key => [key, Object.hasOwn(personal, key) ? configFile : 'builtin']));
  // repoは上限と権限を狭めることだけができる。
  for (const key of ['maxTokens', 'maxDurationMs', 'maxCostUsd'] as const) {
    if (repo[key] !== undefined && repo[key] < settings[key]) {
      settings[key] = repo[key]; sources[key] = repoFile;
    }
  }
  if (repo.permission === 'read-only') {
    settings.permission = 'read-only'; sources.permission = repoFile;
  }
  if (repo.allowedConnections) {
    // 接続先は積集合。repoだけに書かれたIDを新しく送信先へ追加しない。
    settings.allowedConnections = settings.allowedConnections.filter(id => repo.allowedConnections!.includes(id));
    sources.allowedConnections = repoFile;
  }
  const cli = validateSettings({ schemaVersion: 1, ...overrides }, 'CLI');
  // builtinは既定値。個人・repoに明示した制約をCLIで越えない。
  for (const key of ['maxTokens', 'maxDurationMs', 'maxCostUsd'] as const) {
    if (cli[key] !== undefined) {
      const cap = Math.min(personal[key] ?? Infinity, repo[key] ?? Infinity);
      // Infinityは「この層に明示上限なし」の計算用。実効設定の上限は有限値のまま。
      if (cli[key] > cap) throw new Error('CLIの実行上限が設定の制約を越えています。');
      settings[key] = cli[key]; sources[key] = 'CLI';
    }
  }
  if (cli.permission !== undefined) {
    if (cli.permission === 'workspace-write' && (personal.permission === 'read-only' || repo.permission === 'read-only')) {
      throw new Error('CLIの権限が設定の制約を越えています。');
    }
    settings.permission = cli.permission; sources.permission = 'CLI';
  }
  return { settings, sources, repoConfig: trustRepo ? 'explicitly-trusted' : 'not-loaded' };
}
