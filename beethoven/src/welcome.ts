import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TuiTerminal } from './tui.js';
import { readConnections, saveConnections, SetupError } from './connections.js';
import { loadConfig } from './config.js';
import { promptConnections } from './setup.js';
import { acquireLock } from './files.js';
import { hash, replaceFile } from './workspace.js';
import { authDirectory } from './auth.js';
import { findRepository } from './rules.js';
import { quickConnect, type ConnectContext } from './connect.js';

/** 初回も通信せず画面を開く。宣言保存・送信許可・login・モデル開始は別操作にする。 */
export async function welcome(locations: { configFile: string; stateDir: string }, login: (id?: string, terminal?: TuiTerminal) => Promise<unknown>, connectionId?: string, options: { terminal?: TuiTerminal; forceConnect?: boolean; trustRepo?: boolean; overrides?: Partial<import('./config.js').Settings> } = {}) {
  const terminal = options.terminal ?? new TuiTerminal(process.cwd());
  const previousInterrupt = terminal.onInterrupt;
  let leaving = false;
  const configure = () => {
    terminal.onInterrupt = () => { leaving = true; terminal.cancel(); };
    terminal.message('接続先とモデルを選び、ブラウザ認証またはAPIキー登録で始められます。\n\n/connect  接続を追加・変更\n/status  登録状況と保存先\n/advanced  詳細な宣言設定\n/exit  終了\n\n接続の設定中にモデル要求は送りません。', 'はじめに');
  };
  const context: ConnectContext = { ...locations, cwd: process.cwd(), trustRepo: options.trustRepo, overrides: options.overrides };
  const connect = async () => {
    const result = await quickConnect(context, {
      select: (title, items) => terminal.select(title, items), ask: message => terminal.ask(message), message: (text, label) => terminal.message(text, label),
    }, async id => {
      return await login(id, terminal);
    });
    if (findRepository(process.cwd()) || options.forceConnect) return { ready: true as const, connectionId: result.connection.id, consent: result.consent };
    terminal.message('接続を登録しました。作業するGit repoへ移動してbeethovenを起動してください。');
    return false;
  };
  configure();
  try {
    if (options.forceConnect || !readConnections(join(dirname(locations.configFile), 'connections.json'), false).profile) {
      try { const result = await connect(); if (result) return result; }
      catch (error) { terminal.message(error instanceof SetupError ? error.message : '接続を完了できませんでした。/connectで再試行できます。', '接続設定'); if (options.forceConnect) return false; }
    }
    while (!leaving) {
      const input = (await terminal.prompt())?.trim();
      if (input === null || input === undefined || input === '/exit') return false;
      try {
        const file = join(dirname(locations.configFile), 'connections.json');
        const previous = readConnections(file, false);
        if (input === '/connect' || input === '/setup') {
          const result = await connect(); if (result) return result;
        } else if (input === '/advanced') {
          const settings = loadConfig(process.cwd(), locations.configFile).settings;
          const draft = await promptConnections(previous.profile, settings, async message => {
            const answer = await terminal.ask(message);
            if (answer === null) throw new SetupError('設定を取り消しました。', 'setup_cancelled');
            return answer;
          }, text => terminal.message(text, '接続設定'));
          if (draft) { saveConnections(file, draft, previous.hash, locations.stateDir); terminal.message('接続宣言を保存しました。送信許可と認証はまだ変更していません。次は /allow <接続ID> と /login <接続ID> を実行してください。'); }
        } else if (input.startsWith('/allow ')) {
          const id = input.slice(7).trim();
          const connection = previous.profile?.connections.find(c => c.id === id);
          if (!connection) throw new SetupError('登録した接続IDを指定してください。');
          const before = existsSync(locations.configFile) ? hash(readFileSync(locations.configFile)) : null;
          const settings = loadConfig(process.cwd(), locations.configFile).settings;
          if (await terminal.approve(`${connection.id}: ${connection.provider}/${connection.model} (${connection.auth.method}, ${connection.billing.kind}) を個人の送信許可リストへ追加します。\n権限: ${settings.permission}、token上限: ${settings.maxTokens}。ここではモデル送信しません。`)) {
            const release = acquireLock(locations.stateDir);
            try { replaceFile(locations.configFile, JSON.stringify({ ...settings, allowedConnections: [...new Set([...settings.allowedConnections, id])] }, null, 2) + '\n', before, 0o600); }
            finally { release(); }
            terminal.message('送信先を許可しました。/login で認証し、/start で開始できます。');
          }
        } else if (input === '/login' || input.startsWith('/login ')) {
          await login(input.slice(6).trim() || undefined, terminal);
        } else if (input === '/start') {
          if (!findRepository(process.cwd())) throw new SetupError('作業するGit repoへ移動してbeethovenを起動してください。設定は保持されます。');
          const connection = previous.profile?.connections.find(c => c.id === (connectionId ?? previous.profile?.defaultConnectionId));
          if (!connection) throw new SetupError('/setupで既定接続を登録してください。');
          if (!loadConfig(process.cwd(), locations.configFile).settings.allowedConnections.includes(connection.id)) throw new SetupError(`/allow ${connection.id} で送信先を許可してください。`);
          if (!existsSync(join(authDirectory(locations.configFile, connection), 'credentials.json'))) throw new SetupError(`/login ${connection.id} で認証してください。`);
          return { ready: true as const, connectionId: connection.id, consent: undefined };
        } else if (input === '/status') {
          terminal.message(`設定: ${locations.configFile}\n状態: ${locations.stateDir}\n登録接続: ${previous.profile?.connections.map(c => c.id).join(', ') || 'なし'}\nモデル通信: 未開始`, '現在の設定');
        } else terminal.message('/connect · /status · /advanced · /exit');
      } catch (error) { terminal.message(error instanceof SetupError ? error.message : '設定を完了できません。保存先・権限・lockを確認してください。', '確認してください'); }
    }
    return false;
  } finally { terminal.onInterrupt = previousInterrupt; if (!options.terminal) terminal.close(); }
}
