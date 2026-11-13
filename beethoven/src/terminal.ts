import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import type { AuthInteraction } from '@earendil-works/pi-ai';

/** 追加入力はrun中もqueueへ残す。承認への回答は、その質問を表示した後の入力だけを使う。 */
export class Terminal {
  private lines: string[] = [];
  private waiter?: (line: string | null) => void;
  private ended = false;
  private hidden = false;
  private rl: Interface;
  onInterrupt: () => void = () => this.cancel();
  constructor() {
    // readlineのechoだけを抑止できる出力。秘密入力を端末・historyへ残さない。
    const output = new Writable({ write: (chunk, _encoding, done) => { if (!this.hidden) process.stderr.write(chunk); done(); } });
    Object.defineProperty(output, 'columns', { get: () => process.stderr.columns });
    this.rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
    this.rl.on('line', line => {
      if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(line); }
      else this.lines.push(line);
    });
    this.rl.on('SIGINT', () => this.onInterrupt());
    this.rl.on('close', () => { this.ended = true; this.cancel(); });
  }
  private next(fresh = false) {
    if (!fresh && this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.resolve(null);
    if (this.waiter) throw new Error('入力要求が重複しました。');
    return new Promise<string | null>(resolve => { this.waiter = resolve; });
  }
  async prompt(label = '\nbeethoven> '): Promise<string | null> {
    process.stderr.write(label);
    let line = await this.next();
    if (line === null) return null;
    if (line === '/paste') {
      process.stderr.write('複数行入力（単独の . で送信）\n');
      const lines: string[] = [];
      while ((line = await this.next()) !== null && line !== '.') lines.push(line);
      return line === null ? null : lines.join('\n');
    }
    while (line.endsWith('\\')) {
      const part = await this.next();
      if (part === null) return null;
      line = `${line.slice(0, -1)}\n${part}`;
    }
    return line;
  }
  async ask(message: string): Promise<string | null> { process.stderr.write(`\n${message}\n回答> `); return this.next(true); }
  async secret(message: string): Promise<string | null> {
    process.stderr.write(`\n${message}\n入力（表示しません）> `); this.hidden = true;
    try { return await this.next(true); } finally { this.hidden = false; process.stderr.write('\n'); }
  }
  async approve(message: string) { process.stderr.write(`\n${message}\n許可する場合は yes、取消はそれ以外> `); return (await this.next(true)) === 'yes'; }
  cancel() { if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(null); } }
  close() { this.cancel(); this.rl.close(); }
}

/** OAuthはURL/device codeだけを表示し、認証tokenを結果やログへ出力しない。 */
export function loginInteraction(terminal: Terminal, signal: AbortSignal): AuthInteraction {
  return {
    signal,
    async prompt(prompt) {
      const effectiveSignal = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
      effectiveSignal.throwIfAborted();
      const abort = () => terminal.cancel();
      effectiveSignal.addEventListener('abort', abort, { once: true });
      try {
        const selection = prompt.type === 'select' ? `\n${prompt.options.map((option, i) => `${i + 1}. ${option.label}`).join('\n')}\n番号を入力してください（空欄で1）` : '';
        while (true) {
          effectiveSignal.throwIfAborted();
          const answer = prompt.type === 'secret' || prompt.type === 'manual_code' ? await terminal.secret(prompt.message) : await terminal.ask(`${prompt.message}${selection}`);
          if (answer === null) throw new Error('認証を取り消しました。');
          if (prompt.type !== 'select') return answer;
          const value = answer.trim();
          const item = prompt.options.find(option => option.id === value) ?? prompt.options[Number(value || '1') - 1];
          if (item) return item.id;
          process.stderr.write('表示された番号から選んでください。\n');
        }
      } finally { effectiveSignal.removeEventListener('abort', abort); }
    },
    notify(event) {
      if (event.type === 'auth_url') process.stderr.write(`\n認証URL: ${event.url}\n${event.instructions ?? ''}\n`);
      else if (event.type === 'device_code') process.stderr.write(`\n認証URL: ${event.verificationUri}\nコード: ${event.userCode}\n`);
      else process.stderr.write(`\n${event.message}\n`);
    },
  };
}
