import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('local launcher pins Node, preserves cwd and quoted arguments, and refuses unrelated commands', t => {
  const root = mkdtempSync(join(tmpdir(), "beethoven-install 'quoted-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'dist', 'src'), { recursive: true });
  copyFileSync(new URL('../../scripts/install-local.mjs', import.meta.url), join(root, 'scripts', 'install-local.mjs'));
  writeFileSync(join(root, 'dist', 'src', 'cli.js'), 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),node:process.versions.node}));');
  const bin = join(root, 'local bin');
  const install = () => spawnSync(process.execPath, [join(root, 'scripts', 'install-local.mjs'), '--bin-dir', bin], { encoding: 'utf8' });
  assert.equal(install().status, 0);
  const launcher = join(bin, 'beethoven'); assert.equal(statSync(launcher).mode & 0o777, 0o755);
  const result = spawnSync(launcher, ['日本語', 'with spaces', "quote'", '$(no-shell-expansion)'], { cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(result.status, 0); const output = JSON.parse(result.stdout);
  assert.deepEqual(output.args, ['日本語', 'with spaces', "quote'", '$(no-shell-expansion)']);
  assert.equal(output.node, process.versions.node);
  assert.equal(output.cwd, realpathSync(tmpdir()));
  assert.equal(install().status, 0);
  writeFileSync(launcher, '# unrelated existing command\n');
  assert.notEqual(install().status, 0); assert.equal(readFileSync(launcher, 'utf8'), '# unrelated existing command\n');
});
