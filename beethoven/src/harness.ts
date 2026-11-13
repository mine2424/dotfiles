import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRules } from './rules.js';
import { hash, workspaceState, replaceFile, within } from './workspace.js';
import { privateDirectory, saveArtifact } from './files.js';
import { runProcess } from './process.js';

export type Rules = ReturnType<typeof inspectRules>;
export type Approval = (message: string, key: string) => Promise<boolean>;
export type CheckEvidence = { id: string; stage: string; status: 'pass' | 'fail' | 'blocked'; workspaceHash: string; logHash?: string; exitCode?: number | null; reason?: string; output?: string };

/** 定義だけでなく実行するworkspace内容にも信頼を結ぶ。変更後は再確認する保守的な初版。 */
export function harnessTrust(rules: Rules, cwd: string) {
  const workspace = workspaceState(cwd);
  return { hash: hash(JSON.stringify({ rulesHash: rules.hash, workspaceHash: workspace.hash })), rulesHash: rules.hash,
    workspaceHash: workspace.hash, repository: rules.snapshot.repository, checks: rules.snapshot.checks };
}
export function trustFile(stateDir: string, cwd: string) { return join(stateDir, 'harness-trust', `${hash(cwd)}.json`); }
export function saveHarnessTrust(stateDir: string, cwd: string, trust: ReturnType<typeof harnessTrust>) {
  privateDirectory(join(stateDir, 'harness-trust'));
  const file = trustFile(stateDir, cwd);
  replaceFile(file, JSON.stringify(trust), existsSync(file) ? hash(readFileSync(file)) : null, 0o600);
}
export function hasHarnessTrust(stateDir: string, cwd: string, expected: string) {
  const file = trustFile(stateDir, cwd);
  if (!existsSync(file)) return false;
  try { return JSON.parse(readFileSync(file, 'utf8')).hash === expected; } catch { return false; }
}

/** stageの全checkを独立processで実行する。必須条件はresolverの診断で先に検査する。 */
export async function runHarness(rules: Rules, stage: 'preflight' | 'verify', options: {
  cwd: string; stateDir: string; approve: Approval; assertCurrent: () => void; signal?: AbortSignal; remainingMs: number;
  event?: (type: string, payload: unknown) => void;
}) {
  if (!rules.snapshot.declarationsValid) throw new Error('ハーネス宣言が不正です。');
  const evidence: CheckEvidence[] = [];
  const started = Date.now();
  for (const check of rules.snapshot.checks.filter(check => check.stage === stage)) {
    options.assertCurrent();
    const trust = harnessTrust(rules, options.cwd);
    const base = { id: check.id, stage, workspaceHash: trust.workspaceHash };
    if (rules.snapshot.config.settings.permission === 'read-only') {
      evidence.push({ ...base, status: 'blocked', reason: 'read_only' }); break;
    }
    const missingEnv = check.requiredEnv.filter(name => process.env[name] === undefined);
    if (!check.resolvedCwd || !within(options.cwd, check.resolvedCwd) || missingEnv.length) {
      evidence.push({ ...base, status: 'blocked', reason: 'environment_missing' }); break;
    }
    const message = `hostでハーネスを実行します（OS隔離なし）。\n${JSON.stringify({ ...check, workspaceHash: trust.workspaceHash }, null, 2)}`;
    if (!hasHarnessTrust(options.stateDir, options.cwd, trust.hash) && !(await options.approve(message, `harness:${trust.hash}`))) {
      evidence.push({ ...base, status: 'blocked', reason: 'approval_required' }); break;
    }
    options.assertCurrent();
    if (workspaceState(options.cwd).hash !== trust.workspaceHash) { evidence.push({ ...base, status: 'blocked', reason: 'workspace_changed' }); break; }
    const timeoutMs = Math.min(check.timeoutMs, options.remainingMs - (Date.now() - started));
    if (timeoutMs <= 0) { evidence.push({ ...base, status: 'blocked', reason: 'deadline' }); break; }
    const result = await runProcess(check.argv, check.resolvedCwd, { timeoutMs, signal: options.signal, requiredEnv: check.requiredEnv,
      onSpawn: pid => options.event?.('process_started', { pid, checkId: check.id }) });
    options.event?.('process_finished', { pid: result.processGroup, groupGone: result.groupGone });
    const log = saveArtifact(options.stateDir, Buffer.from(JSON.stringify({ check, workspaceHash: trust.workspaceHash, ...result })));
    const unchanged = workspaceState(options.cwd).hash === trust.workspaceHash;
    evidence.push({ ...base, status: result.exitCode === 0 && !result.timedOut && !result.aborted && result.groupGone && unchanged ? 'pass' : 'fail',
      logHash: log.hash, exitCode: result.exitCode, output: result.output.slice(-12000),
      ...(!unchanged ? { reason: 'workspace_changed' } : !result.groupGone ? { reason: 'process_remaining' } : result.timedOut ? { reason: 'timeout' } : result.aborted ? { reason: 'aborted' } : {}) });
    // 停止不明なprocessや実行中の定義変更があれば、次のcheckへ進まない。
    if (!result.groupGone || !unchanged || result.aborted || result.timedOut) break;
  }
  return evidence;
}
