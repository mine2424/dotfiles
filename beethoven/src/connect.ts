import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { authDirectory, ConnectionCredentials } from './auth.js';
import { connectionCatalog, readConnections, saveConnections, SetupError, type Connection } from './connections.js';
import { loadConfig, type Settings } from './config.js';
import { inspectRules } from './rules.js';
import { acquireLock } from './files.js';
import { hash, replaceFile } from './workspace.js';

export type ConnectContext = { cwd: string; configFile: string; stateDir: string; trustRepo?: boolean; overrides?: Partial<Settings> };
export type ConnectUI = {
  select(title: string, items: { value: string; label: string; description?: string }[]): Promise<string | null>;
  ask(message: string): Promise<string | null>;
  message(text: string, label?: string): unknown;
};
const cancelled = () => new SetupError('接続設定を取り消しました。', 'connect_cancelled');

/** 認証待ちの間に規約・権限・上限・送信先が変われば、開始前の確認を取り直す。 */
export function connectionConsent(context: ConnectContext, connection: Connection, allowed?: boolean) {
  const rules = inspectRules(context.cwd, context.configFile, context.trustRepo, context.overrides);
  const settings = rules.snapshot.config.settings;
  return hash(JSON.stringify({ cwd: realpathSync(context.cwd), connection, sources: rules.snapshot.sources.map(s => ({ path: s.path, hash: s.hash })),
    permission: settings.permission, maxTokens: settings.maxTokens, maxDurationMs: settings.maxDurationMs, maxCostUsd: settings.maxCostUsd,
    allowed: allowed ?? settings.allowedConnections.includes(connection.id) }));
}

/** 全providerをPiの公開定義から列挙。認証と課金を同じ選択肢に明記する。 */
export function connectRoutes() {
  const plans = /^(kimi-coding|github-copilot|opencode-go|qwen-token-plan(?:-.*)?|xiaomi-token-plan-.*|zai-coding-cn)$/;
  const routes = connectionCatalog().flatMap(provider => provider.methods.map(method => {
    const billing: Connection['billing']['kind'] = method === 'oauth' ? provider.subscriptionOAuth ? 'subscription' : 'metered' : plans.test(provider.id) ? 'subscription' : 'metered';
    return { value: `${provider.id}:${method}`, label: `${provider.name} · ${billing === 'subscription' ? 'サブスク／契約枠' : 'API従量課金'} · ${method === 'oauth' ? 'ブラウザ認証' : 'APIキー／接続情報'}`,
      description: provider.models.length ? `${provider.models.length}モデル` : '対話モデルなし（分類・画像などの専用provider）', provider, method, billing };
  }));
  const first = ['openai:oauth', 'anthropic:oauth', 'kimi-coding:oauth', 'openrouter:oauth', 'openrouter:api_key', 'openai:api_key', 'anthropic:api_key'];
  return routes.sort((a, b) => (first.includes(a.value) ? first.indexOf(a.value) : 100) - (first.includes(b.value) ? first.indexOf(b.value) : 100));
}

/** 一つのフローで宣言・認証・送信許可を進める。有料疎通やRouter enableは行わない。 */
export async function quickConnect(context: ConnectContext, ui: ConnectUI, authenticate: (id: string) => Promise<unknown>) {
  const file = join(dirname(context.configFile), 'connections.json');
  const previous = readConnections(file, false);
  const configHash = existsSync(context.configFile) ? hash(readFileSync(context.configFile)) : null;
  const personal = loadConfig(context.cwd, context.configFile).settings;
  const routes = connectRoutes();
  const selected = await ui.select('接続先を選んでください', routes);
  if (!selected) throw cancelled();
  const choice = routes.find(r => r.value === selected)!;
  if (!choice.provider.models.length) throw new SetupError('このproviderには対話モデルがありません。Coding Agent用の接続先を選んでください。', 'chat_not_supported');
  const existing = previous.profile?.connections.find(c => c.provider === choice.provider.id && c.auth.method === choice.method && c.billing.kind === choice.billing);
  const models = [...choice.provider.models].filter(m => choice.provider.id !== 'openrouter' || !m.id.startsWith('openrouter/') && !m.id.startsWith('~'));
  if (existing) models.sort((a, b) => Number(b.id === existing.model) - Number(a.id === existing.model));
  const model = await ui.select('モデルを選んでください（名前・IDで検索できます）', models.map(m => ({ value: m.id, label: `${m.name} · ${m.id}` })));
  if (!model) throw cancelled();
  let id = existing?.id ?? `${choice.provider.id}-${choice.billing === 'subscription' ? 'sub' : choice.method === 'oauth' ? 'oauth' : 'api'}`;
  let suffix = 2;
  while (!existing && previous.profile?.connections.some(c => c.id === id)) id = `${choice.provider.id}-${choice.method}-${suffix++}`;
  const connection: Connection = { id, provider: choice.provider.id, model, auth: { method: choice.method, credentialRef: `pi:${id}` },
    billing: { kind: choice.billing }, quotaGroup: existing?.quotaGroup ?? `${choice.provider.id}-${choice.billing}`, status: 'configured',
    limits: existing?.limits ?? { maxTokens: personal.maxTokens, maxDurationMs: Math.min(personal.maxDurationMs, 120000), maxAttempts: 1, maxConcurrency: 1, maxCostUsd: choice.billing === 'metered' ? Math.min(personal.maxCostUsd, 1) : null } };
  connection.limits = { ...connection.limits };
  let forceLogin = false;
  while (true) {
    const effective = loadConfig(context.cwd, context.configFile, context.trustRepo, context.overrides).settings;
    ui.message(`接続: ${choice.label}\nmodel: ${model}\n権限: ${effective.permission}\n上限: ${Math.min(effective.maxTokens, connection.limits.maxTokens)} token / Turn ${Math.min(effective.maxDurationMs, connection.limits.maxDurationMs) / 1000}秒${connection.billing.kind === 'metered' ? ` / USD ${Math.min(effective.maxCostUsd, connection.limits.maxCostUsd!)}` : ' / 金額未確定'}\n\nこの接続を既定にし、次に入力する依頼・規約・toolで読む作業内容の送信を許可します。設定中のモデル要求はありません。APIの上限は実行予算で、提供元のキー上限も利用できます。`, '接続内容');
    const action = await ui.select('この内容で接続しますか？', [
      { value: 'connect', label: '接続して入力画面へ' }, { value: 'limits', label: '上限を変更する' },
      { value: 'reauth', label: '再認証して接続する' }, { value: 'cancel', label: '取消' },
    ]);
    if (!action || action === 'cancel') throw cancelled();
    if (action === 'connect' || action === 'reauth') { forceLogin = action === 'reauth'; break; }
    for (const [key, label, cap] of [['maxTokens', 'token上限', personal.maxTokens], ['maxDurationMs', 'Turnの上限(ms)', personal.maxDurationMs], ...(connection.billing.kind === 'metered' ? [['maxCostUsd', '金額上限(USD)', personal.maxCostUsd]] : [])] as [keyof Connection['limits'], string, number][]) {
      const answer = await ui.ask(`${label} [${connection.limits[key]}]（最大${cap}、空欄で維持）`);
      if (answer === null) throw cancelled();
      const value = answer.trim() ? Number(answer) : connection.limits[key]!;
      if (!Number.isFinite(value) || value <= 0 || value > cap || key !== 'maxCostUsd' && !Number.isSafeInteger(value)) throw new SetupError('上限は個人設定以下の正の値にしてください。');
      connection.limits[key] = value;
    }
  }
  const consent = connectionConsent(context, connection, true);
  const draft = previous.profile ?? { schemaVersion: 1 as const, defaultConnectionId: id, allowFallback: false as const, connections: [] };
  draft.connections = [...draft.connections.filter(c => c.id !== id), connection];
  saveConnections(file, draft, previous.hash, context.stateDir);
  const saved = readConnections(file, false);
  const credentials = new ConnectionCredentials(authDirectory(context.configFile, connection), connection.provider);
  if (forceLogin || !(await credentials.read(connection.provider))) await authenticate(id);
  const credential = await credentials.read(connection.provider);
  if (!credential || credential.type !== connection.auth.method) throw new SetupError('認証登録を確認できません。/connectで再試行してください。', 'authentication_required');
  if (connection.provider === 'azure' && credential.type === 'api_key') {
    let deployments: Record<string, string>;
    try { deployments = JSON.parse(credential.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? '{}'); }
    catch { throw new SetupError('保存済みのAzure deployment設定を確認してください。'); }
    if (!deployments || typeof deployments !== 'object' || Array.isArray(deployments)) throw new SetupError('Azure deployment設定の形式が不正です。');
    if (!credential.env?.AZURE_OPENAI_RESOURCE_NAME || !deployments[model]) {
      const resource = credential.env?.AZURE_OPENAI_RESOURCE_NAME ?? await ui.ask('Azure OpenAI resource name');
      const deployment = await ui.ask('選択したモデルに対応するAzure deployment name');
      if (!resource || !deployment) throw cancelled();
      if (!/^[A-Za-z0-9-]{1,63}$/.test(resource) || !/^[A-Za-z0-9_.-]{1,128}$/.test(deployment)) throw new SetupError('Azureのresource/deployment名を確認してください。');
      await credentials.modify(connection.provider, async () => ({ ...credential, env: { ...credential.env, AZURE_OPENAI_RESOURCE_NAME: resource, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: JSON.stringify({ ...deployments, [model]: deployment }) } }));
    }
  }
  // 認証中の別setup・手編集を上書きしない。失敗時の宣言と認証は次回の再開に残す。
  if ((existsSync(context.configFile) ? hash(readFileSync(context.configFile)) : null) !== configHash) throw new SetupError('個人設定が変更されました。/connectをやり直してください。', 'settings_changed');
  saveConnections(file, { ...draft, defaultConnectionId: id }, saved.hash, context.stateDir);
  const release = acquireLock(context.stateDir);
  try { replaceFile(context.configFile, JSON.stringify({ ...personal, allowedConnections: [...new Set([...personal.allowedConnections, id])] }, null, 2) + '\n', configHash, 0o600); }
  finally { release(); }
  ui.message('認証情報を登録しました。初回応答・Task評価は未確認です。次の入力から選択した接続を使用します。');
  return { connection, consent };
}
