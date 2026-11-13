import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnedRpcClient } from '../dist/src/rpc.js';
import { rpcTurnAdapter } from '../dist/src/pi.js';
import { withRpcCredentials } from '../dist/src/auth.js';
import { selectedConnection } from '../dist/src/dialogue.js';
import { hash, workspaceState } from '../dist/src/workspace.js';

const [manifestFile, configFile, connectionId, tokenArgument] = process.argv.slice(2);
const maxTokens = Number(tokenArgument);
if (!manifestFile || !configFile || !connectionId || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('manifest config connection remaining-tokens required');
const manifest = JSON.parse(readFileSync(resolve(manifestFile), 'utf8'));
const connection = selectedConnection(resolve(configFile), connectionId);
if (maxTokens > connection.limits.maxTokens) throw new Error('Connection limit exceeded');
const root = join(manifest.root, `rpc-${connectionId}`); mkdirSync(root, { recursive: true, mode: 0o700 });
const before = workspaceState(manifest.repo);
const records = [];
const evidenceFile = join(root, 'evidence.json');
if (existsSync(evidenceFile)) {
  const previous = readFileSync(evidenceFile);
  writeFileSync(join(root, `attempt-${hash(previous)}.json`), previous, { mode: 0o600 });
}
const evidence = () => writeFileSync(evidenceFile, JSON.stringify({ connectionId, provider: connection.provider, model: connection.model, piVersion: '1.4.0', fixtureSha: manifest.baseSha, fixtureTreeHash: hash(JSON.stringify(before.files)), maxTokens, records }, null, 2), { mode: 0o600 });
let used = 0;
await withRpcCredentials(resolve(configFile), connection, async agentDir => {
  let client;
  let allGone = true;
  const usageFile = join(agentDir, 'beethoven-usage.json');
  const eventFile = join(agentDir, 'beethoven-events.jsonl');
  let sessionFile;
  const stop = async () => {
    if (!client) return;
    const result = await client.stop(); allGone &&= result.groupGone;
    const usage = existsSync(usageFile) ? JSON.parse(readFileSync(usageFile, 'utf8')) : { tokens: 0, reserved: 0 };
    used += usage.tokens + usage.reserved;
    records.push({ kind: 'stop', ...result, stderrBytes: client.stderrBytes, usage, accountedTotal: used });
    client = undefined; evidence();
  };
  const start = async () => {
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, cacheWarming: 'off', transport: 'sse' }), { mode: 0o600 });
    writeFileSync(join(agentDir, 'beethoven-evaluation.json'), JSON.stringify({ configFile: resolve(configFile), cwd: manifest.repo, stateDir: root, connection, maxTokens: maxTokens - used, maxDurationMs: 120000 }), { mode: 0o600 });
    client = new OwnedRpcClient({ cwd: manifest.repo, home: root, agentDir, args: [
      '--provider', connection.provider, '--model', connection.model, '--thinking', 'off', ...(sessionFile ? ['--session', sessionFile] : ['--session-dir', join(root, 'sessions')]),
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp', '--offline',
      '--tools', 'read,search,edit,write,shell,verify,ask_user', '-e', fileURLToPath(new URL('../dist/src/rpc-evaluation-extension.js', import.meta.url)),
    ], onSpawn: pid => { records.push({ kind: 'spawn', pid }); evidence(); } });
    const state = await client.start();
    if (state.model?.id !== connection.model || state.model?.provider !== connection.provider) throw new Error('RPC selected model mismatch');
    sessionFile = state.sessionFile;
    records.push({ kind: 'start', model: { id: state.model.id, provider: state.model.provider }, sessionFile }); evidence();
  };
  const run = async (kind, prompt, abortAfterText = false) => {
    const tools = [], controller = new AbortController();
    const adapter = rpcTurnAdapter(client);
    const result = await adapter.run(prompt, { maxDurationMs: 120000, signal: controller.signal, onEvent: e => {
      if (e.type === 'tool_start') tools.push(e.name);
      if (abortAfterText && e.type === 'text') controller.abort();
    } });
    const stats = await client.request('get_session_stats');
    records.push({ kind, result, tools, stats }); evidence();
    console.log(JSON.stringify({ kind, result, tools }));
    return result;
  };
  try {
    await start();
    const task = await run('smoke-task', manifest.task + ` 最初にcart.jsとcart.test.jsをreadし、修正後verifyを実行してください。その後shellで次の承認済みコマンドだけを実行してください: ${process.execPath} --test。日本語で報告してください。`);
    await stop();
    if (task.status !== 'completed' || !task.settled) throw new Error('Task not complete');
    await start();
    await run('resume', 'これまでの依頼と検証結果を日本語で1文で説明してください。追加のtool実行は不要です。');
    await run('abort-in-flight', '1から500まで、日本語でそれぞれ別行の長い説明を書いてください。toolは不要です。', true);
    await stop();
    const after = workspaceState(manifest.repo);
    const protectedFiles = Object.entries(before.files).every(([file, value]) => file === 'cart.js' || after.files[file] === value) && Object.keys(after.files).every(file => Object.hasOwn(before.files, file));
    const tests = execFileSync(process.execPath, ['--test'], { cwd: manifest.repo, encoding: 'utf8' });
    const events = existsSync(eventFile) ? readFileSync(eventFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const groups = events.filter(e => e.type === 'process_started').map(e => e.data.pid);
    const groupsGone = groups.every(pid => { try { process.kill(-pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
    records.push({ kind: 'independent-checks', protectedFiles, testsPassed: true, tests, groups, groupsGone, beforeHash: before.hash, afterHash: after.hash });
  } catch (error) { records.push({ kind: 'evaluation-failed', code: typeof error?.code === 'string' ? error.code : 'evaluation_failed' }); process.exitCode = 1; }
  finally { await stop(); evidence(); }
  return { value: null, groupGone: allGone };
});
console.log(JSON.stringify({ evidenceFile, accountedTokens: used }));
