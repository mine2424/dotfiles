import { spawn } from 'node:child_process';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import type { TuiTerminal } from './tui.js';

/** 本人が開始したnative OAuthのHTTPS URLだけを開く。shellを経由しない。 */
export function openAuthBrowser(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Unsupported authentication URL');
  if (process.env.SSH_CONNECTION || process.env.BEETHOVEN_NO_BROWSER === '1') return;
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!command) return;
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {}); child.unref();
}

/** 認証の通知・選択・秘密入力を同じTUIへ送る。stdout/stderrへは書かない。 */
export function tuiLoginInteraction(terminal: TuiTerminal, signal: AbortSignal, openUrl = openAuthBrowser): AuthInteraction {
  return {
    signal,
    async prompt(prompt) {
      const effective = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
      effective.throwIfAborted();
      const cancel = () => terminal.cancel(); effective.addEventListener('abort', cancel, { once: true });
      try {
        const value = prompt.type === 'select' ? await terminal.select(prompt.message, prompt.options.map(o => ({ value: o.id, label: o.label, description: o.description })))
          : prompt.type === 'secret' || prompt.type === 'manual_code' ? await terminal.secret(prompt.message) : await terminal.ask(prompt.message);
        if (value === null) throw new Error('認証を取り消しました。');
        return value;
      } finally { effective.removeEventListener('abort', cancel); }
    },
    notify(event) {
      if (event.type === 'auth_url') {
        terminal.message(`${event.instructions ?? 'ブラウザで認証してください。'}\n${event.url}`, 'ブラウザ認証');
        try { openUrl(event.url); } catch { terminal.message('表示された認証URLをブラウザで開いてください。', '認証'); }
      } else if (event.type === 'device_code') terminal.message(`${event.verificationUri}\nコード: ${event.userCode}`, 'デバイス認証');
      else terminal.message(event.message, '認証');
    },
  };
}
