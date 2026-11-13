import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nativeProviders, providerNames } from './providers.js';
import { acquireLock, privateDirectory } from './files.js';

// authとbillingを分け、Coding PlanのAPI keyを従量APIへ取り違えないようにする。
export type Connection = {
  id: string; provider: string; model: string;
  auth: { method: 'oauth' | 'api_key'; credentialRef: string };
  billing: { kind: 'subscription' | 'metered' };
  quotaGroup: string;
  limits: { maxTokens: number; maxDurationMs: number; maxAttempts: number; maxConcurrency: number; maxCostUsd: number | null };
  status: 'configured';
};
export type Connections = { schemaVersion: 1; defaultConnectionId: string; connections: Connection[]; allowFallback: false };

/** 入力値を含まない、利用者へそのまま表示できるsetup用エラー。生のparser例外と区別する。 */
export class SetupError extends Error {
  constructor(message: string, readonly code = 'invalid_connections') { super(message); }
}

/** Piのローカル定義だけを列挙する。ModelRuntime作成・credential取得・OAuth・refreshは行わない。 */
export function connectionCatalog() {
  return nativeProviders().map(provider => ({
    id: provider.id,
    name: providerNames[provider.id] ?? provider.name,
    methods: [provider.auth.oauth && 'oauth', provider.auth.apiKey && 'api_key'].filter(Boolean) as ('oauth' | 'api_key')[],
    subscriptionOAuth: provider.auth.oauth?.isSubscription === true,
    models: provider.getModels().map(model => ({ id: model.id, name: model.name })),
  }));
}

/** 外部JSONは型を信用せず検証する。未知のkeyは秘密値の誤混入も含め拒否する。 */
function record(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new SetupError('接続宣言の形式または項目が不正です。');
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

/** 同梱catalogにある選択肢までを検査する。本人の契約で使えるかは実認証後の確認事項。 */
export function validateConnections(value: unknown, checkCatalog = true): Connections {
  const data = record(value, ['schemaVersion', 'defaultConnectionId', 'connections', 'allowFallback']);
  if (data.schemaVersion !== 1 || data.allowFallback !== false || !Array.isArray(data.connections) ||
    data.connections.length < 1 || data.connections.length > 20) {
    throw new SetupError('schemaVersion=1、allowFallback=false、1〜20件の接続が必要です。');
  }
  const catalog = connectionCatalog();
  const ids = new Set<string>();
  for (const value of data.connections) {
    const item = record(value, ['id', 'provider', 'model', 'auth', 'billing', 'quotaGroup', 'limits', 'status']);
    if (!identifier(item.id) || ids.has(item.id) || !identifier(item.quotaGroup) || item.status !== 'configured') {
      throw new SetupError('接続IDは一意とし、quotaGroupとstatus=configuredを指定してください。');
    }
    ids.add(item.id);
    const provider = catalog.find(provider => provider.id === item.provider);
    if (!identifier(item.provider) || typeof item.model !== 'string' || !/^[A-Za-z0-9@~][A-Za-z0-9@~._:/+-]{0,511}$/.test(item.model)) {
      throw new SetupError('provider/modelの形式が不正です。');
    }
    if (checkCatalog && (!provider || !provider.models.some(model => model.id === item.model))) throw new SetupError('provider/modelが同梱catalogにありません。');
    const auth = record(item.auth, ['method', 'credentialRef']);
    const billing = record(item.billing, ['kind']);
    if ((auth.method !== 'oauth' && auth.method !== 'api_key') || (checkCatalog && !provider?.methods.includes(auth.method)) ||
      auth.credentialRef !== `pi:${item.id}` || (billing.kind !== 'subscription' && billing.kind !== 'metered')) {
      throw new SetupError('認証方式、credentialRef、課金方式を確認してください。秘密値は保存できません。');
    }
    if (auth.method === 'oauth' && provider && billing.kind !== (provider.subscriptionOAuth ? 'subscription' : 'metered')) {
      throw new SetupError('OAuth接続の課金方式がprovider定義と一致しません。');
    }
    if (item.provider === 'openrouter' && billing.kind !== 'metered') throw new SetupError('OpenRouterは従量課金として登録してください。');
    const limits = record(item.limits, ['maxTokens', 'maxDurationMs', 'maxAttempts', 'maxConcurrency', 'maxCostUsd']);
    for (const key of ['maxTokens', 'maxDurationMs', 'maxAttempts', 'maxConcurrency']) {
      if (typeof limits[key] !== 'number' || !Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
        throw new SetupError('token・時間・試行数・並列数は正の整数が必要です。');
      }
    }
    if ((limits.maxConcurrency as number) > 4) throw new SetupError('並列数は最大4です。');
    if (billing.kind === 'subscription' ? limits.maxCostUsd !== null :
      typeof limits.maxCostUsd !== 'number' || !Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd <= 0) {
      throw new SetupError('従量課金には正のUSD上限、subscriptionには金額未確定を示すnullが必要です。');
    }
  }
  if (typeof data.defaultConnectionId !== 'string' || !ids.has(data.defaultConnectionId)) throw new SetupError('既定接続は登録したIDから選んでください。');
  return data as Connections;
}

/** malformed JSONの生の例外には本文が含まれるため、固定メッセージに置き換える。 */
export function parseConnections(text: string, checkCatalog = true) {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new SetupError('接続JSONを読み取れません。内容はログへ出力しません。'); }
  return validateConnections(value, checkCatalog);
}

/** profileは通常の小さいfileのみ。未設定と破損を区別し、破損を空設定として上書きしない。 */
export function readConnections(file: string, checkCatalog = true) {
  let info;
  try { info = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profile: null, hash: null };
    throw new SetupError('接続fileの読込権限を確認してください。');
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new SetupError('接続fileは1MiB以下の通常fileが必要です。');
  const bytes = readFileSync(file);
  if (bytes.byteLength > 1024 * 1024) throw new SetupError('接続fileが読込上限を越えています。');
  return { profile: parseConnections(bytes.toString('utf8'), checkCatalog), hash: createHash('sha256').update(bytes).digest('hex') };
}

/** 保存直前に前回hashを照合する。wizard表示中の手編集や別setupの変更を消さない。 */
export function saveConnections(file: string, profile: Connections, expectedHash: string | null, stateDir: string) {
  validateConnections(profile);
  const release = acquireLock(stateDir);
  const temp = join(dirname(file), `${randomUUID()}.tmp`);
  try {
    // 保存済みの旧modelは読めるようにし、廃止modelからの変更・削除を妨げない。
    if (readConnections(file, false).hash !== expectedHash) throw new SetupError('設定が別の操作で変更されました。読み直して再設定してください。', 'settings_changed');
    privateDirectory(dirname(file));
    writeFileSync(temp, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); release(); }
}
