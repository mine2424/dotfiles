import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 本人の既存repo・認証を使わず、独立した評価repoと設定を作る。正解の実装は含めない。
const root = mkdtempSync(join(tmpdir(), 'beethoven-p3-evaluation-'));
const repo = join(root, 'repo');
const configRoot = join(root, 'config');
const config = join(configRoot, 'beethoven');
const stateRoot = join(root, 'state');
mkdirSync(join(repo, '.beethoven'), { recursive: true }); mkdirSync(config, { recursive: true, mode: 0o700 });
writeFileSync(join(repo, 'cart.js'), 'export const total = items => items.reduce((sum, item) => sum + item.price, 0);\n');
writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
writeFileSync(join(repo, 'cart.test.js'), `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { total } from './cart.js';
test('empty', () => assert.equal(total([]), 0));
test('quantity', () => assert.equal(total([{price:100,quantity:3}]), 300));
test('multiple', () => assert.equal(total([{price:100,quantity:3},{price:20,quantity:2}]), 340));\n`);
writeFileSync(join(repo, 'AGENTS.md'), '日本語で報告してください。cart.jsの数量不具合を修正し、cart.test.js・package.json・この規約・ハーネスは変更しないでください。commit・外部送信commandは禁止です。\n');
writeFileSync(join(repo, '.beethoven/harness.json'), JSON.stringify({ schemaVersion: 1,
  requirements: [{ id: 'tests', stage: 'verify', required: true }],
  checks: [{ id: 'tests', stage: 'verify', argv: [process.execPath, '--test'], cwd: '.', timeoutMs: 20000,
    requiredEnv: [], acceptanceIds: ['AC-01', 'AC-02', 'AC-03'] }] }, null, 2));
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' });
git('-c', 'init.templateDir=', 'init', '-q'); git('add', '.');
git('-c', 'user.name=Beethoven Evaluation', '-c', 'user.email=evaluation@example.invalid', 'commit', '-qm', 'evaluation baseline');
const baseSha = git('rev-parse', 'HEAD').trim();
writeFileSync(join(config, 'config.json'), JSON.stringify({ schemaVersion: 1, permission: 'workspace-write',
  allowedConnections: ['codex-subscription'], maxTokens: 75000, maxDurationMs: 600000, maxCostUsd: 1 }, null, 2), { mode: 0o600 });
writeFileSync(join(config, 'connections.json'), JSON.stringify({ schemaVersion: 1, defaultConnectionId: 'codex-subscription', allowFallback: false,
  connections: [{ id: 'codex-subscription', provider: 'openai', model: 'gpt-6.1-sol', auth: { method: 'oauth', credentialRef: 'pi:codex-subscription' },
    billing: { kind: 'subscription' }, quotaGroup: 'codex-subscription', status: 'configured',
    limits: { maxTokens: 75000, maxDurationMs: 120000, maxAttempts: 1, maxConcurrency: 1, maxCostUsd: null } }] }, null, 2), { mode: 0o600 });
copyFileSync(new URL('../rules.example.md', import.meta.url), join(config, 'rules.md'));
const manifest = { root, repo, configRoot, stateRoot, baseSha, node: process.versions.node, pi: '1.4.0', model: 'gpt-6.1-sol',
  task: '数量を反映するようcart.jsを修正し、既存テストを通す。テスト・規約・ハーネスは変更しない。',
  acceptance: ['空配列は0', '単価100・数量3は300', '複数商品の合計は340', '依頼外fileと既存dirty差分を保護'],
  command: [process.execPath, '--test'], limits: { maxTurnDurationMs: 120000, maxSessionDurationMs: 600000, totalEvaluationTokens: 75000, concurrency: 1, retries: 0 } };
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(JSON.stringify(manifest, null, 2));
