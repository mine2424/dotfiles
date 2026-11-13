import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { loadConfig, type Settings } from './config.js';
import { connectionCatalog, readConnections, saveConnections, SetupError, validateConnections, type Connection, type Connections } from './connections.js';

type Ask = (question: string) => Promise<string>;

/** 対話部分だけを分け、端末でも試験の回答列でも同じ選択・確認処理を使う。 */
export async function promptConnections(existing: Connections | null, settings: Settings, ask: Ask, print: (text: string) => void) {
  const draft: Connections = structuredClone(existing ?? { schemaVersion: 1, defaultConnectionId: '', connections: [], allowFallback: false });
  const catalog = connectionCatalog();
  async function answer(question: string) {
    const text = (await ask(question)).trim();
    if (text === '/cancel') throw new SetupError('設定を取り消しました。保存していません。', 'setup_cancelled');
    return text;
  }
  async function pick(question: string, options: { id: string; label: string }[], initial?: string): Promise<string> {
    print(options.map((item, i) => `${i + 1}. ${item.label} [${item.id}]`).join('\n'));
    while (true) {
      const value = await answer(`${question}${initial ? ` [${initial}]` : ''}: `);
      const found = options.find(item => item.id === (value || initial)) ?? options[Number(value) - 1];
      if (found) return found.id;
      print('表示された番号またはIDを入力してください。');
    }
  }
  async function positive(question: string, initial: number, maximum = Number.MAX_SAFE_INTEGER, integer = true) {
    while (true) {
      const value = await answer(`${question} [${initial}]: `);
      const number = value ? Number(value) : initial;
      if (Number.isFinite(number) && number > 0 && number <= maximum && (!integer || Number.isSafeInteger(number))) return number;
      print('範囲内の正の数を入力してください。');
    }
  }

  print('利用者ごとの接続設定です。秘密値は入力しません。/cancel またはCtrl-Cで全体を取り消せます。');
  while (true) {
    print(`登録中: ${draft.connections.map(item => `${item.id} (${item.provider}/${item.model})`).join(', ') || 'なし'}`);
    const action = await pick('操作', [
      { id: 'add', label: '追加' }, { id: 'edit', label: '変更' }, { id: 'remove', label: '削除' },
      { id: 'save', label: '保存へ進む' }, { id: 'cancel', label: '取消' },
    ]);
    if (action === 'cancel') throw new SetupError('設定を取り消しました。保存していません。', 'setup_cancelled');
    if (action === 'save') {
      if (!draft.connections.length) { print('接続を1つ以上追加してください。'); continue; }
      draft.defaultConnectionId = await pick('普段使う接続', draft.connections.map(item => ({ id: item.id, label: `${item.provider}/${item.model}` })), draft.connections.some(item => item.id === draft.defaultConnectionId) ? draft.defaultConnectionId : undefined);
      validateConnections(draft);
      // 書込前に全体を提示する。モデル応答・認証・送信許可は設定保存から推定しない。
      print(JSON.stringify(draft, null, 2));
      print(`現在の送信許可ID: ${settings.allowedConnections.join(', ') || 'なし'}。この設定は変更しません。`);
      print('保存後も認証・モデル利用可否は未確認です。ログインやモデル呼出しは行いません。');
      return (await answer('この内容をローカル保存しますか？ [yes/no]: ')) === 'yes' ? draft : null;
    }
    let id: string;
    if (action === 'add') {
      if (draft.connections.length >= 20) { print('接続は最大20件です。'); continue; }
      id = await answer('新しい接続ID（英字から始まる英数・_・-、最大64字。秘密値不可）: ');
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || draft.connections.some(item => item.id === id)) {
        print('重複しない接続IDを指定してください。'); continue;
      }
    } else {
      if (!draft.connections.length) { print('接続がまだありません。'); continue; }
      id = await pick('対象接続', draft.connections.map(item => ({ id: item.id, label: item.id })));
      if (action === 'remove') { draft.connections = draft.connections.filter(item => item.id !== id); continue; }
    }
    const old = draft.connections.find(item => item.id === id);
    const providerId = await pick('接続先', catalog.map(item => ({ id: item.id, label: item.name })), old?.provider);
    const provider = catalog.find(item => item.id === providerId)!;
    const method = await pick('認証方式', provider.methods.map(id => ({ id, label: id === 'oauth' ? `${provider.subscriptionOAuth ? 'サブスクリプション' : '従量課金'}のブラウザログイン（認証は後で実施）` : 'API key（秘密値の設定は後で実施）' })), old?.provider === providerId ? old.auth.method : undefined) as Connection['auth']['method'];
    const kind = providerId === 'openrouter' ? 'metered' : method === 'oauth' ? 'subscription' : await pick('契約の課金方式（API keyからは推定しません）', [
      { id: 'subscription', label: 'サブスクリプション/Coding Plan枠' }, { id: 'metered', label: 'API従量課金' },
    ], old?.provider === providerId ? old.billing.kind : undefined) as Connection['billing']['kind'];
    const model = await pick('モデル（同梱catalog上の候補。契約での利用可否は未確認）', provider.models.map(item => ({ id: item.id, label: item.name })), old?.provider === providerId ? old.model : undefined);
    const group = await answer(`同じ契約枠を共有するquotaGroup [${old?.quotaGroup ?? `${providerId}-${kind}`}]: `);
    const quotaGroup = group || old?.quotaGroup || `${providerId}-${kind}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(quotaGroup)) { print('quotaGroupの形式が不正です。接続を選び直してください。'); continue; }
    const limits = {
      maxTokens: await positive('token上限', old?.limits.maxTokens ?? settings.maxTokens),
      maxDurationMs: await positive('実行時間上限(ms)', old?.limits.maxDurationMs ?? settings.maxDurationMs),
      maxAttempts: await positive('実装試行の上限', old?.limits.maxAttempts ?? 2),
      maxConcurrency: await positive('並列数上限(1〜4)', old?.limits.maxConcurrency ?? 1, 4),
      maxCostUsd: kind === 'metered' ? await positive('従量課金の上限(USD)', old?.limits.maxCostUsd ?? settings.maxCostUsd, Number.MAX_VALUE, false) : null,
    };
    const connection: Connection = { id, provider: providerId, model, auth: { method, credentialRef: `pi:${id}` }, billing: { kind }, quotaGroup, limits, status: 'configured' };
    // 下書きだけを変更する。編集途中で取り消した場合に既存fileを壊さない。
    draft.connections = [...draft.connections.filter(item => item.id !== id), connection];
  }
}

/** 初回設定の制御。非TTYは宣言fileを要求し、保存だけで認証や通信を開始しない。 */
export async function runSetup(configFile: string, stateDir: string, options: { from?: string; yes?: boolean; json?: boolean }) {
  const file = join(dirname(configFile), 'connections.json');
  // 旧catalogの接続も編集できるよう読み込む。新しく保存する内容は現catalogで再検証する。
  const previous = readConnections(file, false);
  const settings = loadConfig(process.cwd(), configFile).settings;
  if (options.yes && !options.from) throw new SetupError('--yesには--fromで明示した宣言fileが必要です。');
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !options.json;
  if (!options.from && !interactive) return { status: 'blocked', code: 'setup_requires_input', message: '端末でsetupを開くか、--from <file>で非機密の接続宣言を指定してください。', exitCode: 3 };
  let profile = options.from ? readConnections(options.from).profile : null;
  if (options.from && !profile) throw new SetupError('--fromの接続宣言fileがありません。');
  if (profile && !options.yes && !interactive) return { status: 'blocked', code: 'save_confirmation_required', profile, message: '検査済み・未保存です。内容を確認して--yesを明示すると保存できます。', exitCode: 3 };

  if (interactive && !options.yes) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const abort = new AbortController();
    terminal.on('SIGINT', () => abort.abort());
    terminal.on('close', () => abort.abort());
    const ask: Ask = question => terminal.question(question, { signal: abort.signal });
    try {
      if (profile) {
        console.log(JSON.stringify(profile, null, 2));
        console.log('認証・通信は行わず、送信先の許可設定も変更しません。');
        if ((await ask('この宣言を保存しますか？ [yes/no]: ')).trim() !== 'yes') profile = null;
      } else profile = await promptConnections(previous.profile, settings, ask, text => console.log(text));
    } catch (error) {
      if (abort.signal.aborted || (error instanceof SetupError && error.code === 'setup_cancelled')) profile = null;
      else throw error;
    } finally { terminal.close(); }
    if (!profile) return { status: 'cancelled', message: '設定を取り消しました。保存していません。', exitCode: 130 };
  }
  if (!profile) throw new SetupError('保存する接続がありません。');
  saveConnections(file, profile, previous.hash, stateDir);
  return {
    status: 'saved', file, profile, authentication: 'not_checked', modelAccess: 'not_checked', executionReady: false,
    notAllowedConnectionIds: profile.connections.filter(item => !settings.allowedConnections.includes(item.id)).map(item => item.id),
    message: '接続宣言を保存しました。認証・疎通・送信許可は別の確認が必要です。', exitCode: 0,
  };
}
