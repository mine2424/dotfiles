import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { InMemoryModelsStore, type AuthInteraction, type AuthOperationOptions, type Credential, type CredentialStore, type Provider } from '@earendil-works/pi-ai';
import { nativeProviders } from './providers.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { acquireLock, privateDirectory } from './files.js';
import { replaceFile, hash } from './workspace.js';
import { type Connection, SetupError } from './connections.js';

/** connectionごとの保管先。別アプリ・別接続のcredentialを自動でコピーしない。 */
export function authDirectory(configFile: string, connection: Connection) {
  return join(dirname(configFile), 'auth', connection.id);
}

/** Pi公開CredentialStore契約の小さなfile実装。refreshも同じlock内で保存する。 */
export class ConnectionCredentials implements CredentialStore {
  private file: string;
  constructor(private directory: string, private provider: string) { this.file = join(directory, 'credentials.json'); }
  async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (provider !== this.provider || !existsSync(this.file)) return undefined;
    const info = lstatSync(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new SetupError('認証fileの所有者・権限を確認してください。');
    let credential: Credential;
    try { credential = JSON.parse(readFileSync(this.file, 'utf8')) as Credential; }
    catch { throw new SetupError('認証fileを読み込めません。loginをやり直してください。'); }
    if (!credential || (credential.type !== 'oauth' && credential.type !== 'api_key') ||
      (credential.type === 'api_key' && (credential.key !== undefined && (typeof credential.key !== 'string' || !credential.key || credential.key.startsWith('!')) || credential.env !== undefined && (!credential.env || typeof credential.env !== 'object' || Array.isArray(credential.env) || Object.entries(credential.env).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string')))) ||
      (credential.type === 'oauth' && (typeof credential.access !== 'string' || !credential.access || typeof credential.refresh !== 'string' || typeof credential.expires !== 'number' || !Number.isFinite(credential.expires)))) {
      throw new SetupError('認証fileの形式が不正です。');
    }
    return credential;
  }
  async list(options?: AuthOperationOptions) { const credential = await this.read(this.provider, options); return credential ? [{ providerId: this.provider, type: credential.type }] : []; }
  async modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    if (provider !== this.provider) throw new SetupError('別providerの認証は保存できません。');
    privateDirectory(dirname(this.directory));
    const release = acquireLock(this.directory);
    try {
      const before = existsSync(this.file) ? hash(readFileSync(this.file)) : null;
      const current = await this.read(provider, options);
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next) replaceFile(this.file, JSON.stringify(next), before, 0o600);
      return next ?? current;
    } finally { release(); }
  }
  async delete() { throw new SetupError('認証削除はこの版では未対応です。'); }
}

/** Beethoven自身の選択接続だけをPi CLI形式へ変換する。
 * 子の停止・OAuth refreshの書戻しまで認証lockを保持する。
 * 親がcrashした場合はmarkerと更新済みfileを残し、次の起動で自動上書きしない。 */
export async function withRpcCredentials<T>(configFile: string, connection: Connection, operation: (agentDir: string) => Promise<{ value: T; groupGone: boolean }>): Promise<T> {
  const directory = authDirectory(configFile, connection);
  const credentials = new ConnectionCredentials(directory, connection.provider);
  const agentDir = join(directory, 'rpc');
  privateDirectory(agentDir);
  const marker = join(agentDir, 'pending.json');
  if (existsSync(marker)) throw new SetupError('前回RPCの認証同期・停止確認が未完了です。保管fileとprocessを確認してください。', 'rpc_recovery_required');
  let result!: T;
  await credentials.modify(connection.provider, async credential => {
    if (!credential || credential.type !== connection.auth.method) throw new SetupError('この接続のloginが必要です。', 'authentication_required');
    writeFileSync(marker, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    const file = join(agentDir, 'auth.json');
    replaceFile(file, JSON.stringify({ [connection.provider]: credential }), existsSync(file) ? hash(readFileSync(file)) : null, 0o600);
    const stopped = await operation(agentDir);
    if (!stopped.groupGone) throw new SetupError('RPC processの停止未確認です。認証と所有記録を保持しました。', 'process_remaining');
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0) throw new SetupError('RPC認証fileを検査できません。');
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new SetupError('RPC認証fileを読み取れません。'); }
    if (!data || Object.keys(data).length !== 1 || !Object.hasOwn(data, connection.provider)) throw new SetupError('RPC認証のproviderが一致しません。');
    const next = data[connection.provider] as Credential;
    // refresh結果にも通常の認証validatorを適用し、形式不正を正本へ反映しない。
    const validation = new ConnectionCredentials(agentDir, connection.provider);
    const validationFile = join(agentDir, 'credentials.json');
    replaceFile(validationFile, JSON.stringify(next), existsSync(validationFile) ? hash(readFileSync(validationFile)) : null, 0o600);
    const checked = await validation.read(connection.provider);
    if (!checked || checked.type !== connection.auth.method) throw new SetupError('RPC認証方式が変更されました。');
    result = stopped.value;
    return checked;
  });
  // 更新済み認証の保存と子process group消失の両方を確認してから解除する。
  rmSync(marker);
  return result;
}

/** auth方式を一つに絞る。OAuth失敗時にambient API keyへ切り替える経路を作らない。 */
export function selectedProvider(connection: Connection): Provider {
  const provider = nativeProviders().find(item => item.id === connection.provider);
  if (!provider) throw new SetupError('未対応のproviderです。');
  const auth = connection.auth.method === 'oauth' ? { oauth: provider.auth.oauth } : { apiKey: provider.auth.apiKey };
  if (auth.apiKey) {
    const original = auth.apiKey;
    auth.apiKey = { ...original, resolve: async args => {
      if (!args.credential || args.credential.type !== 'api_key') return undefined;
      const credential = args.credential;
      // cloudのprofile/ADCは本人がnative loginで選択した場合だけ使う。
      const cloud = ['amazon-bedrock', 'google-vertex'].includes(connection.provider) && !credential.key;
      return original.resolve({ ...args, ctx: { env: async key => credential.env?.[key] ?? (cloud ? args.ctx.env(key) : undefined), fileExists: path => cloud ? args.ctx.fileExists(path) : Promise.resolve(false) } });
    } };
  }
  if (connection.billing.kind === 'subscription' && connection.auth.method === 'oauth' && !auth.oauth?.isSubscription) throw new SetupError('subscriptionの認証定義を確認できません。');
  return { ...provider, auth };
}

export async function connectionRuntime(configFile: string, connection: Connection, requireCredential = true) {
  const credentials = new ConnectionCredentials(authDirectory(configFile, connection), connection.provider);
  if (requireCredential) {
    const stored = await credentials.read(connection.provider);
    if (!stored || stored.type !== connection.auth.method) throw new SetupError('この接続の認証が必要です。beethoven login --connection <ID>を実行してください。', 'authentication_required');
  }
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(selectedProvider(connection));
  return runtime;
}

/** loginだけが認証通信を開始する。戻り値にcredential本体を含めない。 */
export async function loginConnection(configFile: string, connection: Connection, interaction: AuthInteraction) {
  const runtime = await connectionRuntime(configFile, connection, false);
  const directory = authDirectory(configFile, connection);
  const credential = await runtime.login(connection.provider, connection.auth.method, interaction, {
    agentName: 'Beethoven',
    getDeviceId: () => {
      privateDirectory(directory);
      const file = join(directory, 'device-id');
      if (!existsSync(file)) replaceFile(file, randomUUID(), null, 0o600);
      return readFileSync(file, 'utf8');
    },
  });
  if (credential.type !== connection.auth.method) throw new SetupError('選択した認証方式と結果が一致しません。');
  if (connection.provider === 'azure' && credential.type === 'api_key') {
    const resource = await interaction.prompt({ type: 'text', message: 'Azure OpenAI resource name' });
    const deployment = await interaction.prompt({ type: 'text', message: 'Azure deployment name for the selected model' });
    if (!/^[A-Za-z0-9-]{1,63}$/.test(resource) || !/^[A-Za-z0-9_.-]{1,128}$/.test(deployment)) throw new SetupError('Azureのresource/deployment名を確認してください。');
    const storage = new ConnectionCredentials(directory, connection.provider);
    await storage.modify(connection.provider, async current => ({ ...credential, env: { ...(current?.type === 'api_key' ? current.env : {}), AZURE_OPENAI_RESOURCE_NAME: resource, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: JSON.stringify({ [connection.model]: deployment }) } }));
  }
  return { connectionId: connection.id, authenticated: true, billing: connection.billing.kind, smokePassed: false };
}
