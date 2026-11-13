import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 状態・ログを保存する本人専用のディレクトリを用意し、所有者と末尾pathを確認する。 */
export function privateDirectory(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  // statではリンク先を見てしまうためlstatで確認する。これはOS sandboxの代わりではない。
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('状態保存先は本人が所有する通常のディレクトリが必要です。');
  }
  chmodSync(dir, 0o700);
}

/**
 * DB初期化などを同時実行しないためのmaintenance lockを取り、解放用の関数を返す。
 * プロセス消失後のlockも自動回収しない。所有者を確認する復旧処理は後続段階で追加する。
 */
export function acquireLock(stateDir: string) {
  privateDirectory(stateDir);
  const lockDir = join(stateDir, 'maintenance.lock');
  // 「存在確認してから作成」では競合する。mkdirの成功/既存エラーで取得を判定する。
  try { mkdirSync(lockDir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('状態保存先は使用中、または未確認のlockが残っています。');
    throw error;
  }
  const token = randomUUID();
  const file = join(lockDir, 'owner.json');
  try { writeFileSync(file, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { rmSync(lockDir, { recursive: true }); throw error; }
  return () => {
    // PIDは再利用され得るため、取得時のtokenが一致するlockだけを解放する。
    const owner = JSON.parse(readFileSync(file, 'utf8')) as { token: string };
    if (owner.token !== token) throw new Error('lock所有者が変わったため解放できません。');
    rmSync(lockDir, { recursive: true });
  };
}

/** 証拠・ログ等のbytesを内容hash名で保存し、DBへの登録に使う参照情報を返す。 */
export function saveArtifact(stateDir: string, content: Uint8Array) {
  privateDirectory(stateDir);
  const directory = join(stateDir, 'artifacts');
  privateDirectory(directory);
  const hash = createHash('sha256').update(content).digest('hex');
  const file = join(directory, hash);
  const temp = join(directory, `${randomUUID()}.tmp`);
  try {
    // 同じdirectory内へ書き切ってからrenameし、読取側に途中の内容を見せない。
    // flushはfileの書込を同期するが、directoryを含む完全な電源断耐性は保証しない。
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); } // rename失敗でも今回の一時fileだけを除去する。
  return { hash, file, bytes: content.byteLength };
}

/** crash後の明示復旧。生存するPIDのlockは奪わず、所有者記録の一致を再確認して解除する。 */
export function recoverLock(stateDir: string, confirmed = false) {
  const directory = join(stateDir, 'maintenance.lock');
  const file = join(directory, 'owner.json');
  const content = readFileSync(file, 'utf8');
  const owner = JSON.parse(content) as { token: string; pid: number };
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') throw new Error('lock所有者の形式が不正です。');
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
  if (alive) throw new Error('所有者のprocessが生存しているため復旧できません。');
  if (confirmed) {
    if (readFileSync(file, 'utf8') !== content) throw new Error('lock所有者が変わりました。');
    rmSync(directory, { recursive: true });
  }
  return { recovered: confirmed, ownerPid: owner.pid, processAbsent: true };
}
