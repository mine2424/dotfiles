import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { SetupError } from './connections.js';

/** 固定版bundled entryを、環境・JSONL上限・process groupを所有して実行する。
 * 公式RpcClientは親環境とstderrを引き継ぐため、通信契約を維持して所有処理を置き換える。 */
export class OwnedRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private listeners = new Set<(event: JsonAgentSessionEvent) => void>();
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private failed = false;
  private stopped = false;
  processGroup: number | null = null;
  stderrBytes = 0;
  constructor(private options: { cwd: string; home: string; agentDir: string; args?: string[]; requestTimeoutMs?: number; onSpawn?: (pid: number) => void }) {}
  async start() {
    if (process.platform === 'win32') throw new SetupError('RPC process group回収はPOSIXのみ対応です。');
    if (this.child || this.stopped) throw new SetupError('RPC processは再起動できません。');
    const timeout = this.options.requestTimeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new SetupError('RPC要求には正の有限な期限が必要です。');
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
    const child = spawn(process.execPath, [entry, ...(this.options.args ?? [])], {
      cwd: this.options.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: this.options.home, XDG_CONFIG_HOME: `${this.options.home}/.config`, XDG_STATE_HOME: `${this.options.home}/.local/state`,
        PI_CODING_AGENT_DIR: this.options.agentDir, PI_OFFLINE: '1', LANG: 'en_US.UTF-8' },
    });
    this.child = child;
    this.processGroup = child.pid ?? null;
    child.on('error', () => this.fail());
    child.on('exit', () => this.fail());
    child.stdin.on('error', () => this.fail());
    // stderrには認証値やprovider本文が含まれ得るため、本文を保持・表示しない。
    child.stderr.on('data', (data: Buffer) => {
      this.stderrBytes += data.length;
      if (this.stderrBytes > 1024 * 1024) this.fail();
    });
    const decoder = new StringDecoder('utf8');
    let buffered = '';
    child.stdout.on('data', (data: Buffer) => {
      if (this.failed) return;
      buffered += decoder.write(data);
      let index: number;
      while ((index = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) { this.fail(); return; }
        try {
          const value = JSON.parse(line);
          if (value.type === 'response') {
            const pending = this.pending.get(value.id);
            if (!pending) continue;
            clearTimeout(pending.timer); this.pending.delete(value.id);
            if (value.success === true) pending.resolve(value.data);
            else pending.reject(new SetupError('RPC要求が拒否されました。', 'rpc_request_failed'));
          } else if (value && typeof value.type === 'string') {
            for (const listener of this.listeners) listener(value as JsonAgentSessionEvent);
          } else { this.fail(); return; }
        } catch { this.fail(); return; }
      }
      if (Buffer.byteLength(buffered) > 4 * 1024 * 1024) this.fail();
    });
    if (child.pid) {
      try { this.options.onSpawn?.(child.pid); } catch { await this.stop(); throw new SetupError('RPC所有記録を保存できません。'); }
    }
    try { return await this.request('get_state'); }
    catch { await this.stop(); throw new SetupError('bundled RPCの起動を確認できません。', 'rpc_start_failed'); }
  }
  private fail(error = new SetupError('RPC通信が終了または破損しました。', 'rpc_transport_failed')) {
    this.failed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  request(type: string, body: Record<string, unknown> = {}): Promise<any> {
    if (!this.child || this.failed || this.stopped) return Promise.reject(new SetupError('RPCが停止しています。', 'rpc_transport_failed'));
    const id = String(++this.sequence);
    const line = JSON.stringify({ ...body, type, id }) + '\n';
    if (Buffer.byteLength(line) > 1024 * 1024 || this.pending.size >= 16) return Promise.reject(new SetupError('RPC送信上限です。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new SetupError('RPC要求の期限を越えました。', 'ETIMEDOUT')); }, this.options.requestTimeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timer });
      // 送信件数・bytesを制限し、stream callbackでも書込失敗を検出する。
      this.child!.stdin.write(line, 'utf8', error => { if (error) this.fail(); });
    });
  }
  onEvent(listener: (event: JsonAgentSessionEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async prompt(message: string): Promise<'started' | 'handled' | 'queued'> {
    const data = await this.request('prompt', { message });
    if (!data || !['started', 'handled', 'queued'].includes(data.disposition)) throw new SetupError('RPCの受付結果が不正です。');
    return data.disposition;
  }
  async abort() { await this.request('abort'); }
  async stop(): Promise<{ groupGone: boolean; processGroup: number | null }> {
    this.stopped = true; this.fail();
    const pid = this.processGroup;
    const gone = () => {
      if (!pid) return true;
      try { process.kill(-pid, 0); return false; }
      catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    const signal = (name: NodeJS.Signals) => { if (pid) { try { process.kill(-pid, name); } catch { /* absence is checked independently */ } } };
    signal('SIGTERM');
    for (let i = 0; i < 30 && !gone(); i++) {
      if (i === 5) signal('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return { processGroup: pid, groupGone: gone() };
  }
}
