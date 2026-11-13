import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('noninteractive startup emits a structured blocker and does not read ambient authentication or create state', t => {
  const dir = mkdtempSync(join(tmpdir(), 'beethoven-dialogue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state'), OPENAI_API_KEY: 'must-not-be-used' };
  const missing = spawnSync(process.execPath, [cli, '--print', '調査のみ', '--json'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(missing.status, 3);
  assert.equal(JSON.parse(missing.stdout).error, 'setup_required');
  const config = join(env.XDG_CONFIG_HOME, 'beethoven'); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'connections.json'), readFileSync(new URL('../../connections.example.json', import.meta.url)));
  const noLogin = spawnSync(process.execPath, [cli, 'login'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(noLogin.status, 3);
  assert.equal(existsSync(env.XDG_STATE_HOME), false);
  assert.equal(existsSync(join(config, 'auth')), false);
  assert.equal((missing.stdout + missing.stderr + noLogin.stdout + noLogin.stderr).includes('must-not-be-used'), false);
});
