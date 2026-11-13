import { spawn } from 'node:child_process';

/** hostで許可済みのコマンドだけを起動する。POSIX process groupを所有し、孫processも停止する。 */
export async function runProcess(argv: string[], cwd: string, options: {
  timeoutMs: number; signal?: AbortSignal; requiredEnv?: string[]; onSpawn?: (pid: number) => void;
}) {
  if (process.platform === 'win32') throw new Error('この版のprocess回収はPOSIXのみ対応しています。');
  if (!argv.length || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('コマンドまたは期限が不正です。');
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', ...(options.requiredEnv ?? [])]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  let output = '';
  let truncated = false;
  let timedOut = false;
  let signalDenied = false;
  let aborted = options.signal?.aborted === true;
  if (aborted) return { exitCode: null, output, truncated, timedOut, aborted, groupGone: true, signalDenied, processGroup: null };
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new Error('コマンドを起動できません。実行fileとcwdを確認してください。')));
    child.once('exit', code => { terminate(); resolve(code); });
  });
  const groupSignal = (signal: NodeJS.Signals | 0) => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      // sandbox等でsignalを拒否された場合も、event handlerから未処理例外を投げない。
      // processが残っている可能性を結果へ返し、呼出し側をblockedにする。
      signalDenied = true; return true;
    }
  };
  const consume = (chunk: Buffer) => {
    const remaining = 64 * 1024 - Buffer.byteLength(output);
    if (chunk.length > remaining) truncated = true;
    if (remaining > 0) output += chunk.subarray(0, remaining).toString('utf8');
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    groupSignal('SIGTERM');
    killTimer ??= setTimeout(() => groupSignal('SIGKILL'), 250);
  };
  const onAbort = () => { aborted = true; terminate(); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; terminate(); }, Math.min(options.timeoutMs, 2_147_483_647));
  try {
    let receiptError: unknown;
    try { if (child.pid) options.onSpawn?.(child.pid); } catch (error) { receiptError = error; terminate(); }
    const exitCode = await exited;
    // leader終了後もstdoutを保持する孫processがあり得る。TERM→KILL後にgroupの消失を検査する。
    for (let count = 0; count < 30 && groupSignal(0); count++) {
      if (count >= 5) groupSignal('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (receiptError) throw receiptError;
    // 一時的なEPERMは別に記録する。最後のprobeがESRCHなら消失を確認できた扱いとし、
    // 最後までprobeを拒否された場合はgroupSignal(0)=trueなので停止未確認を維持する。
    const groupGone = !groupSignal(0);
    return { exitCode, output, truncated, timedOut, aborted, groupGone, signalDenied, processGroup: child.pid ?? null };
  } finally {
    clearTimeout(timer); clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', onAbort);
    child.stdout.destroy(); child.stderr.destroy();
  }
}

/** Leader exit is not group exit. Keep cleanup alive for descendants before releasing ownership. */
export async function reapProcessGroup(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const signal = (value: NodeJS.Signals | 0) => {
    try { process.kill(-pid, value); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  };
  if (!signal(0)) return true;
  signal('SIGTERM');
  for (let count = 0; count < 40; count++) {
    if (!signal(0)) return true;
    if (count >= 5) signal('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return !signal(0);
}
