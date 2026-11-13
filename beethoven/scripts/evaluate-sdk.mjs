import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openAgent } from '../dist/src/agent.js';
import { selectedConnection } from '../dist/src/dialogue.js';

// Explicit private fixture/config only. Never uses the caller's development repo as a task.
const [manifestFile, configFile, connectionId] = process.argv.slice(2);
if (!manifestFile || !configFile || !connectionId) throw new Error('manifest config connection required');
const manifest = JSON.parse(readFileSync(resolve(manifestFile), 'utf8'));
const connection = selectedConnection(resolve(configFile), connectionId);
const stateDir = join(manifest.root, `sdk-${connectionId}`);
const evidenceFile = join(manifest.root, `sdk-${connectionId}.json`);
const records = [];
const options = { cwd: manifest.repo, configFile: resolve(configFile), stateDir, connection, send: true,
  allowedPaths: ['cart.js'], approve: async (_message, key) => key.startsWith('harness:'), ask: async () => null };
let agent;
const save = () => writeFileSync(evidenceFile, JSON.stringify({ connectionId, fixtureSha: manifest.baseSha, records }, null, 2), { mode: 0o600 });
try {
  agent = await openAgent(options);
  const run = async (kind, prompt, signal) => {
    const tools = [];
    const result = await agent.run(prompt, { signal, onEvent: e => { if (e.type === 'tool_start') tools.push(e.name); } });
    records.push({ kind, result, tools, info: agent.info() }); save();
    console.log(JSON.stringify({ kind, status: result.status, usage: agent.info().usage, tools }));
    return result;
  };
  await run('smoke-task', manifest.task + ' 実装後はverifyで検証し、日本語で結果を報告してください。');
  const id = agent.id; await agent.close(); agent = undefined;
  agent = await openAgent({ ...options, resume: id });
  await run('resume', '先ほどの依頼と検証結果を日本語で1文で説明してください。追加の編集とtool実行は不要です。');
  const controller = new AbortController();
  controller.abort();
  await run('cancel-before-send', '続けてください。', controller.signal);
  const test = execFileSync(process.execPath, ['--test'], { cwd: manifest.repo, encoding: 'utf8' });
  records.push({ kind: 'independent-tests', passed: true, output: test }); save();
} catch (error) {
  records.push({ kind: 'failure', code: typeof error?.code === 'string' ? error.code : 'evaluation_failed' }); save();
  process.exitCode = 1;
} finally { if (agent) await agent.close(); }
console.log(JSON.stringify({ evidenceFile }));
