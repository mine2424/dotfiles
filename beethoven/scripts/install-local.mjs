import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// 実行した対応Nodeを固定する。利用者のcwd・XDG設定・既定Nodeは変更しない。
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 21) throw new Error('Node 24.21.0以降の24系でinstallしてください。');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--bin-dir')) throw new Error('Usage: install-local.mjs [--bin-dir <directory>]');
const binDir = resolve(args[1] ?? join(homedir(), '.local', 'bin'));
const entry = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
if (!existsSync(entry)) throw new Error('先に npm run build を実行してください。');
const node = realpathSync(process.execPath);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const marker = `# Beethoven local launcher: ${entry}`;
const launcher = `#!/bin/sh\n${marker}\n# cwdと利用者設定を維持し、検証したNodeで起動する。\nif [ ! -x ${quote(node)} ] || [ ! -f ${quote(entry)} ]; then\n  echo 'BeethovenのNodeまたはbuildが見つかりません。再build・installしてください。' >&2\n  exit 1\nfi\nexec ${quote(node)} ${quote(entry)} "$@"\n`;
mkdirSync(binDir, { recursive: true });
const target = join(binDir, 'beethoven');
let previous = null;
try {
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('既存のbeethovenが通常fileではないため上書きしません。');
  previous = readFileSync(target, 'utf8');
  if (!previous.includes(marker + '\n')) throw new Error('別のbeethovenコマンドがあるため上書きしません。');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const temp = join(dirname(target), `.beethoven-install-${randomUUID()}`);
try {
  writeFileSync(temp, launcher, { flag: 'wx', mode: 0o755, flush: true });
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current !== previous) throw new Error('install中に既存コマンドが変更されました。');
  renameSync(temp, target);
} finally { rmSync(temp, { force: true }); }
console.log(JSON.stringify({ installed: target, node, entry, cwdPreserved: true, authenticationChanged: false }));
