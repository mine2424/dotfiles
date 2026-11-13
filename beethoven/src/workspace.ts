import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { findRepository } from './rules.js';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function within(root: string, file: string) { const part = relative(root, file); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); }
/** 未作成の末尾を残しつつ、存在する親のsymlinkを解決して保存先の実体を比較する。 */
export function canonicalTarget(input: string): string {
  const file = resolve(input);
  if (existsSync(file)) return realpathSync(file);
  const parent = dirname(file);
  return join(canonicalTarget(parent), relative(parent, file));
}

/** .gitと認証の定型保存先はAgentのfile toolから除外する。symlinkは経路の途中も拒否する。 */
export function workspacePath(root: string, input: string, allowMissing = false) {
  const file = resolve(root, input);
  if (!within(root, file) || file === root) throw new Error('対象はworkspace内のfileが必要です。');
  const parts = relative(root, file).split('/');
  if (parts.some(part => part === '.git' || part === 'auth.json' || part === 'credentials.json' || /^\.env(?:\.|$)/.test(part))) throw new Error('管理情報・認証fileは対象外です。');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (allowMissing && index === parts.length - 1) break;
      throw new Error('対象または親directoryが存在しません。');
    }
    if (lstatSync(current).isSymbolicLink()) throw new Error('symlink経由の操作は許可しません。');
  }
  return file;
}

/** Gitの読取もhook/fsmonitorと外部diffを使わず、親のGIT_*設定を引き継がない。 */
export function git(cwd: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args],
    { cwd, stdio: 'pipe', env: { ...env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
}

export function workspaceState(cwd: string) {
  const repository = findRepository(cwd);
  if (!repository) throw new Error('対話実行にはGit repoを指定してください。');
  const root = realpathSync(cwd);
  const names = git(repository.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  if (names.length > 20000) throw new Error('workspaceのfile数が検査上限を越えました。');
  const files: Record<string, string> = {};
  for (const name of [...new Set(names)].sort()) {
    const file = join(repository.root, name);
    if (!within(root, file)) continue;
    try {
      workspacePath(root, file);
      const info = lstatSync(file);
      if (!info.isFile()) continue;
      files[relative(root, file)] = info.size <= 4 * 1024 * 1024 ? hash(readFileSync(file)) : `large:${info.size}:${info.mtimeMs}`;
    } catch (error) {
      if (!existsSync(file)) files[relative(root, file)] = 'deleted';
      // symlink・credentialは本文を取得せず、その存在を識別する。
      else files[relative(root, file)] = 'excluded';
    }
  }
  const status = git(repository.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const data = { root, repoRoot: repository.root, head: repository.head, status, files };
  return { ...data, hash: hash(JSON.stringify(data)) };
}

/** 同一directory内のrenameで確定する。別processによる変更は直前の内容hashで拒否する。 */
export function replaceFile(file: string, content: string, expected: string | null, privateMode?: number) {
  const actual = existsSync(file) ? hash(readFileSync(file)) : null;
  if (actual !== expected) throw new Error('読取後にfileが変更されました。再読込してください。');
  const temp = join(dirname(file), `.beethoven-${randomUUID()}.tmp`);
  try {
    const mode = privateMode ?? (existsSync(file) ? lstatSync(file).mode & 0o777 : 0o644);
    writeFileSync(temp, content, { flag: 'wx', mode, flush: true });
    if ((existsSync(file) ? hash(readFileSync(file)) : null) !== expected) throw new Error('fileが競合しました。');
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}
