import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { findRepository, inspectRules } from '../src/rules.js';

/** 本人のrepo・認証・Git hookを使わず、Git identityだけを試す一時repoを用意する。 */
function fixture(t: { after: (cleanup: () => void) => void }) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'beethoven-rules-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configFile = join(directory, 'config', 'beethoven', 'config.json');
  mkdirSync(dirname(configFile), { recursive: true });
  return { directory, configFile };
}

function write(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

// テスト専用の初期commitだけを作る。署名・hook・本人のGit環境変数は使わない。
function git(cwd: string, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Beethoven tests', '-c', 'user.email=beethoven@example.invalid', '-C', cwd, ...args],
  { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repo(directory: string, name: string) {
  const root = join(directory, name);
  mkdirSync(root);
  git(root, 'init', '--template=', '-b', 'main');
  return root;
}

const requirement = { id: 'tests', required: true, stage: 'verify' };
function check(argv = ['node', '--test']) {
  return { id: 'tests', stage: 'verify', argv, cwd: '.', timeoutMs: 1000, acceptanceIds: ['AC-01'], requiredEnv: [] };
}

test('two repos share common rules but keep their own root rules; subdirectory uses same snapshot', t => {
  const { directory, configFile } = fixture(t);
  write(join(dirname(configFile), 'rules.md'), '共通の原則');
  write(join(dirname(configFile), 'harness.json'), { schemaVersion: 1, requirements: [requirement] });
  const a = repo(directory, 'a');
  const b = repo(directory, 'b');
  for (const root of [a, b]) write(join(root, '.beethoven/harness.json'), { schemaVersion: 1, checks: [check()] });
  write(join(a, 'AGENTS.md'), 'A固有');
  write(join(b, 'AGENTS.md'), 'B固有');
  mkdirSync(join(a, 'src'));
  const first = inspectRules(a, configFile);
  assert.equal(first.hash, inspectRules(join(a, 'src'), configFile).hash);
  assert.equal(first.snapshot.declarationsValid, true);
  assert.deepEqual(first.snapshot.sources.filter(s => s.kind === 'rules').map(s => s.content), ['共通の原則', 'A固有']);
  assert.equal(inspectRules(b, configFile).snapshot.sources.some(s => s.content === 'A固有'), false);
  assert.notEqual(first.snapshot.repository!.commonDir, findRepository(b)!.commonDir);
  assert.equal(first.snapshot.executionReady, false);
  assert.equal(first.snapshot.checks[0]!.executionApproved, false);
});

test('worktree has same repo identity but reads its own rules and ignores inherited GIT_DIR', t => {
  const { directory, configFile } = fixture(t);
  const root = repo(directory, 'repo');
  write(join(root, 'AGENTS.md'), 'commit時の規約');
  git(root, 'add', 'AGENTS.md');
  git(root, 'commit', '-m', 'test baseline');
  const worktree = join(directory, 'worktree');
  git(root, 'worktree', 'add', '--detach', worktree, 'HEAD');
  write(join(worktree, 'AGENTS.md'), 'worktreeの更新');
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(directory, 'not-a-repo');
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  const first = inspectRules(root, configFile);
  const second = inspectRules(worktree, configFile);
  assert.equal(first.snapshot.repository!.commonDir, second.snapshot.repository!.commonDir);
  assert.notEqual(first.hash, second.hash);
  assert.equal(second.snapshot.sources[0]!.content, 'worktreeの更新');
});

test('repo cannot disable mandatory common checks and duplicate definitions do not silently override', t => {
  const { directory, configFile } = fixture(t);
  const root = repo(directory, 'repo');
  write(join(dirname(configFile), 'harness.json'), { schemaVersion: 1, requirements: [requirement], checks: [check()] });
  write(join(root, '.beethoven/harness.json'), { schemaVersion: 1, requirements: [{ ...requirement, required: false }], checks: [check(['other'])] });
  const result = inspectRules(root, configFile).snapshot;
  assert.equal(result.requirements[0]!.required, true);
  assert.equal(result.declarationsValid, false);
  assert.deepEqual(result.diagnostics.map(x => x.code), ['required_check_disabled', 'duplicate_check']);
});

test('missing checks and stage mismatches are diagnosed instead of considered passed', t => {
  const { directory, configFile } = fixture(t);
  const root = repo(directory, 'repo');
  write(join(dirname(configFile), 'harness.json'), { schemaVersion: 1, requirements: [requirement] });
  assert.equal(inspectRules(root, configFile).snapshot.diagnostics[0]!.code, 'missing_required_check');
  write(join(root, '.beethoven/harness.json'), { schemaVersion: 1, checks: [{ ...check(), stage: 'preflight' }] });
  assert.equal(inspectRules(root, configFile).snapshot.diagnostics[0]!.code, 'stage_conflict');
});

test('schema failures do not disclose input; cwd and symlink sources cannot escape the repo', t => {
  const { directory, configFile } = fixture(t);
  const root = repo(directory, 'repo');
  const harness = join(root, '.beethoven/harness.json');
  for (const value of [
    '{"schemaVersion":1,"secret":"never-print-this"',
    { schemaVersion: 1, apiKey: 'never-print-this' },
    { schemaVersion: 1, checks: [{ ...check(), timeoutMs: 0 }] },
    { schemaVersion: 1, checks: [{ ...check(), argv: 'node --test' }] },
    { schemaVersion: 1, requirements: [{ ...requirement, required: 'true' }] },
  ]) {
    write(harness, value);
    const result = inspectRules(root, configFile);
    assert.equal(result.snapshot.diagnostics[0]!.code, 'invalid_harness');
    assert.equal(JSON.stringify(result).includes('never-print-this'), false);
  }
  write(harness, { schemaVersion: 1, checks: [{ ...check(), cwd: '..' }] });
  assert.equal(inspectRules(root, configFile).snapshot.diagnostics[0]!.code, 'invalid_check_cwd');
  const outside = join(directory, 'outside.md');
  write(outside, 'repo外の原本');
  symlinkSync(outside, join(root, 'AGENTS.md'));
  assert.equal(inspectRules(root, configFile).snapshot.diagnostics.some(x => x.code === 'source_unreadable'), true);
});

test('shared source is loaded once; non-git workspace does not pick up parent AGENTS', t => {
  const { directory, configFile } = fixture(t);
  const globalRules = join(dirname(configFile), 'rules.md');
  const root = repo(directory, 'repo');
  write(join(root, 'AGENTS.md'), '同じ原本');
  symlinkSync(join(root, 'AGENTS.md'), globalRules);
  assert.equal(inspectRules(root, configFile).snapshot.sources.length, 1);
  const plain = join(directory, 'plain');
  mkdirSync(plain);
  write(join(directory, 'AGENTS.md'), '親の文章は読まない');
  const result = inspectRules(plain, configFile);
  assert.equal(result.snapshot.repository, null);
  assert.deepEqual(result.snapshot.sources.map(x => x.content), ['同じ原本']);
});

test('CLI show/check/doctor do not execute commands or write state; snapshot is explicit and preserves originals', t => {
  const { directory, configFile } = fixture(t);
  const root = repo(directory, 'repo');
  const env = { ...process.env, XDG_CONFIG_HOME: dirname(dirname(configFile)), XDG_STATE_HOME: join(directory, 'state') };
  const cli = resolve('dist/src/cli.js');
  const marker = join(root, 'must-not-exist');
  write(join(root, '.beethoven/harness.json'), { schemaVersion: 1, checks: [check(['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`])] });
  write(join(root, 'AGENTS.md'), '保存時の原本');
  for (const args of [['rules', 'show'], ['rules', 'check'], ['doctor']]) {
    const output = JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { cwd: root, env, encoding: 'utf8' }));
    if (args[0] === 'rules') assert.equal(output.snapshot.executionReady, false);
  }
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(env.XDG_STATE_HOME), false);
  const saved = JSON.parse(execFileSync(process.execPath, [cli, 'rules', 'snapshot', '--json'], { cwd: root, env, encoding: 'utf8' }));
  const before = inspectRules(root, configFile);
  assert.equal(saved.hash, before.hash);
  write(join(root, 'AGENTS.md'), '更新後の原本');
  assert.notEqual(inspectRules(root, configFile).hash, before.hash);
  const snapshot = JSON.parse(readFileSync(saved.file, 'utf8'));
  assert.equal(snapshot.sources.find((s: { kind: string }) => s.kind === 'rules').content, '保存時の原本');
  assert.equal(snapshot.checks[0].executionApproved, false);
});

test('invalid declarations block snapshot without creating state and trusted config resolves from repo root', t => {
  const { directory, configFile } = fixture(t);
  const root = repo(directory, 'repo');
  const nested = join(root, 'src');
  mkdirSync(nested);
  const env = { ...process.env, XDG_CONFIG_HOME: dirname(dirname(configFile)), XDG_STATE_HOME: join(directory, 'state') };
  write(join(root, '.beethoven/config.json'), { schemaVersion: 1, maxTokens: 500 });
  write(join(dirname(configFile), 'harness.json'), { schemaVersion: 1, requirements: [requirement] });
  const cli = resolve('dist/src/cli.js');
  const result = spawnSync(process.execPath, [cli, 'rules', 'snapshot', '--json', '--trust-repo-config'], { cwd: nested, env, encoding: 'utf8' });
  assert.equal(result.status, 3);
  const output = JSON.parse(result.stdout);
  assert.equal(output.snapshot.config.settings.maxTokens, 500);
  assert.equal(output.snapshot.diagnostics[0].code, 'missing_required_check');
  assert.equal(existsSync(env.XDG_STATE_HOME), false);
});
