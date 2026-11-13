import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { backup, DatabaseSync } from 'node:sqlite';
import { loadConfig, paths } from '../src/config.js';
import { acquireLock, saveArtifact } from '../src/files.js';
import { initializeStore, readDatabaseVersion, schemaVersion } from '../src/store.js';

// 本人の設定・状態を触らず、試験終了時には失敗した場合も一時領域を片付ける。
function temporary(t: { after: (cleanup: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'beethoven-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('repo config can narrow personal permission, budget, and connections but cannot expand them', t => {
  const dir = temporary(t);
  const personal = join(dir, 'personal.json');
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.beethoven'), { recursive: true });
  // repoが書込権限・予算・送信先を増やそうとしても、個人の制約を越えないことを確かめる。
  writeFileSync(personal, JSON.stringify({ schemaVersion: 1, permission: 'read-only', maxCostUsd: 2, allowedConnections: ['a', 'b'] }));
  writeFileSync(join(repo, '.beethoven/config.json'), JSON.stringify({ schemaVersion: 1, permission: 'workspace-write', maxCostUsd: 100, maxTokens: 1000, allowedConnections: ['b', 'other'] }));
  const result = loadConfig(repo, personal, true);
  assert.equal(result.settings.permission, 'read-only');
  assert.equal(result.settings.maxCostUsd, 2);
  assert.equal(result.settings.maxTokens, 1000);
  assert.deepEqual(result.settings.allowedConnections, ['b']);
  assert.equal(result.sources.maxTokens, join(repo, '.beethoven/config.json'));
  assert.equal(loadConfig(repo, personal).settings.maxTokens, 20000);
  assert.equal(loadConfig(repo, personal, true, { maxTokens: 500 }).sources.maxTokens, 'CLI');
  assert.throws(() => loadConfig(repo, personal, true, { permission: 'workspace-write' }));
  assert.throws(() => loadConfig(repo, personal, true, { maxCostUsd: 3 }));
});

test('invalid config rejects unknown keys, wrong types and missing schema without echoing values', t => {
  const dir = temporary(t);
  const file = join(dir, 'config.json');
  for (const value of [{ schemaVersion: 1, apiKey: 'secret-value' }, { schemaVersion: 1, maxTokens: 'secret-value' }, {}, { schemaVersion: 1, maxDurationMs: 1.5 }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadConfig(dir, file), error => error instanceof Error && !error.message.includes('secret-value'));
  }
  assert.throws(() => paths({ XDG_STATE_HOME: 'relative' }, dir));
});

test('maintenance lock excludes another process and does not steal a stale-looking lock', t => {
  const dir = temporary(t);
  const release = acquireLock(dir);
  // 同一process内の判定だけでは不十分なので、別Node processからも取得を試す。
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(new URL('../src/files.js', import.meta.url).href)}; acquireLock(process.argv[1]);`, dir]);
  assert.notEqual(child.status, 0);
  assert.throws(() => acquireLock(dir));
  release();
  acquireLock(dir)();
});

test('SQLite initialization, foreign keys, WAL, snapshot and newer-schema rejection', async t => {
  const dir = temporary(t);
  await initializeStore(dir);
  const file = join(dir, 'state.sqlite');
  assert.equal(readDatabaseVersion(file), schemaVersion);
  await initializeStore(dir);
  assert.equal(readdirSync(dir).filter(x => x.startsWith('before-schema-')).length, 1);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    assert.throws(() => db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?)').run('turn', 'missing', 'idle', 'now'));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('session', dir, 'idle', 'now');
    // snapshotを別接続で開き、元DBから独立して保存済みデータを読めることを確認する。
    const snapshot = join(dir, 'snapshot.sqlite');
    await backup(db, snapshot);
    const restored = new DatabaseSync(snapshot, { readOnly: true });
    try { assert.equal(restored.prepare('SELECT id FROM sessions').get()!.id, 'session'); }
    finally { restored.close(); }
    // 将来版を模擬する。古いCLIで開いてもversionを書き戻さずlockを解放することが必要。
    db.exec('PRAGMA user_version = 999');
  } finally { db.close(); }
  await assert.rejects(initializeStore(dir));
  assert.equal(readDatabaseVersion(file), 999);
  assert.equal(existsSync(join(dir, 'maintenance.lock')), false);
});

test('artifacts preserve bytes and hash, reject symlink roots, and leave no partial file on failure', t => {
  const dir = temporary(t);
  const content = Buffer.from('検証証拠\n');
  const saved = saveArtifact(join(dir, 'state'), content);
  assert.equal(saved.hash, createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(readFileSync(saved.file), content);
  assert.equal(statSync(saved.file).mode & 0o777, 0o600);
  symlinkSync(join(dir, 'state'), join(dir, 'link'));
  assert.throws(() => saveArtifact(join(dir, 'link'), content));
  const failing = join(dir, 'failure');
  // 保存先を同名directoryで塞ぎ、renameに失敗しても一時fileが残らないことを確認する。
  mkdirSync(join(failing, 'artifacts', saved.hash), { recursive: true });
  assert.throws(() => saveArtifact(failing, content));
  assert.deepEqual(readdirSync(join(failing, 'artifacts')), [saved.hash]);
});

test('doctor is local and read-only; init is explicit; malformed config never leaks to JSON/stderr', t => {
  const dir = temporary(t);
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state') };
  // 実CLIを別processで呼び、doctorだけでは保存先を作らず、initで初めてDBができることを見る。
  const cli = resolve('dist/src/cli.js');
  const report = JSON.parse(execFileSync(process.execPath, [cli, 'doctor', '--json'], { cwd: dir, env, encoding: 'utf8' }));
  assert.equal(report.pi.installed, '1.4.0');
  assert.equal(report.pi.rpcEntryExists, true);
  assert.equal(report.database.version, null);
  assert.equal(report.capabilities.interactive, true);
  assert.equal(report.connections.authentication, 'not_checked');
  assert.equal(existsSync(env.XDG_STATE_HOME), false);
  execFileSync(process.execPath, [cli, 'init'], { cwd: dir, env });
  assert.equal(readDatabaseVersion(join(env.XDG_STATE_HOME, 'beethoven/state.sqlite')), schemaVersion);
  mkdirSync(join(env.XDG_CONFIG_HOME, 'beethoven'), { recursive: true });
  // 壊れたJSONに秘密値が混入しても、parserの生エラーをstdout/stderrへ出してはいけない。
  writeFileSync(join(env.XDG_CONFIG_HOME, 'beethoven/config.json'), '{"secret":"never-print-this"');
  const bad = spawnSync(process.execPath, [cli, 'doctor', '--json'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).error, 'startup_failed');
  assert.equal((bad.stdout + bad.stderr).includes('never-print-this'), false);
});
