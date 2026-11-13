import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type Connection, type Connections, SetupError } from './connections.js';
import { acquireLock, privateDirectory, saveArtifact } from './files.js';
import { hash, replaceFile } from './workspace.js';

// 実際に解決された同梱Piの版を使い、依存更新後に旧評価を有効としない。
const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
export const evaluationPiVersion = (JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8')) as { version: string }).version;
export const modelRoles = ['dialogue', 'planner', 'explorer', 'implementer', 'reviewer'] as const;
export type ModelRole = typeof modelRoles[number];
export type Routing = {
  schemaVersion: 1; allowFallback: false;
  roles: Partial<Record<ModelRole, string>>;
  tasks: { type: string; role: ModelRole; connectionId: string }[];
};
export type Evaluation = {
  schemaVersion: 1; connectionHash: string; piVersion: string;
  observedAt: string; fixtureHash: string; evidenceHash: string;
  pricing: { kind: 'subscription' | 'metered'; basis: string; observedAt: string; amountUsd: number | null };
  checks: { sdkSmoke: boolean; rpcSmoke: boolean; task: boolean; abort: boolean; resume: boolean; protectedFiles: boolean };
  usage: { reportedTokens: number; missingRequests: number };
  outcome: 'supported' | 'unsupported';
};
type Receipt = { schemaVersion: 1; evaluationHash: string; enabled: boolean };
export type ConnectionStatus = 'configured' | 'smoke_passed' | 'task_evaluated' | 'enabled' | 'unsupported';

/** 認証・課金・上限を含む宣言全体を評価へ結び、変更後の使い回しを防ぐ。 */
export function connectionFingerprint(connection: Connection) {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(connection))).digest('hex');
}
function invalid(): never { throw new SetupError('routingまたは接続評価の形式が不正です。', 'invalid_routing'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value); }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function date(value: unknown) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function readJson(file: string): unknown {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) invalid();
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return invalid(); }
}
export function validateRouting(value: unknown, profile: Connections): Routing {
  const data = object(value, ['schemaVersion', 'allowFallback', 'roles', 'tasks']);
  if (data.schemaVersion !== 1 || data.allowFallback !== false || !Array.isArray(data.tasks) || data.tasks.length > 100) invalid();
  const roles = object(data.roles, [...modelRoles]);
  const known = new Set(profile.connections.map(c => c.id));
  for (const id of Object.values(roles)) if (typeof id !== 'string' || !known.has(id)) invalid();
  const keys = new Set<string>();
  for (const item of data.tasks) {
    const task = object(item, ['type', 'role', 'connectionId']);
    if (!identifier(task.type) || !modelRoles.includes(task.role as ModelRole) || typeof task.connectionId !== 'string' || !known.has(task.connectionId)) invalid();
    const key = `${task.role}:${task.type}`;
    if (keys.has(key)) invalid();
    keys.add(key);
  }
  return data as Routing;
}
export function readRouting(file: string, profile: Connections) { return existsSync(file) ? validateRouting(readJson(file), profile) : null; }
export function validateEvaluation(value: unknown): Evaluation {
  const data = object(value, ['schemaVersion', 'connectionHash', 'piVersion', 'observedAt', 'fixtureHash', 'evidenceHash', 'pricing', 'checks', 'usage', 'outcome']);
  if (data.schemaVersion !== 1 || !digest(data.connectionHash) || !digest(data.fixtureHash) || !digest(data.evidenceHash) || typeof data.piVersion !== 'string' || !date(data.observedAt) || !['supported', 'unsupported'].includes(String(data.outcome))) invalid();
  const pricing = object(data.pricing, ['kind', 'basis', 'observedAt', 'amountUsd']);
  if (!['subscription', 'metered'].includes(String(pricing.kind)) || typeof pricing.basis !== 'string' || !pricing.basis.trim() || pricing.basis.length > 2000 || !date(pricing.observedAt) ||
    (pricing.kind === 'subscription' ? pricing.amountUsd !== null : typeof pricing.amountUsd !== 'number' || !Number.isFinite(pricing.amountUsd) || pricing.amountUsd < 0)) invalid();
  const checks = object(data.checks, ['sdkSmoke', 'rpcSmoke', 'task', 'abort', 'resume', 'protectedFiles']);
  if (['sdkSmoke', 'rpcSmoke', 'task', 'abort', 'resume', 'protectedFiles'].some(k => typeof checks[k] !== 'boolean')) invalid();
  const usage = object(data.usage, ['reportedTokens', 'missingRequests']);
  if ([usage.reportedTokens, usage.missingRequests].some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) invalid();
  return data as Evaluation;
}
function receiptFile(stateDir: string, connection: Connection) {
  if (!identifier(connection.id)) invalid();
  return join(stateDir, 'evaluations', `${connection.id}.json`);
}
export function connectionEvaluation(stateDir: string, connection: Connection): { status: ConnectionStatus; evaluation: Evaluation | null; evaluationHash: string | null } {
  const file = receiptFile(stateDir, connection);
  if (!existsSync(file)) return { status: 'configured', evaluation: null, evaluationHash: null };
  const receipt = object(readJson(file), ['schemaVersion', 'evaluationHash', 'enabled']);
  if (receipt.schemaVersion !== 1 || !digest(receipt.evaluationHash) || typeof receipt.enabled !== 'boolean') invalid();
  const artifact = join(stateDir, 'artifacts', receipt.evaluationHash);
  const evaluation = validateEvaluation(readJson(artifact));
  if (hash(readFileSync(artifact)) !== receipt.evaluationHash) invalid();
  const evidenceFile = join(stateDir, 'artifacts', evaluation.evidenceHash);
  readJson(evidenceFile);
  if (hash(readFileSync(evidenceFile)) !== evaluation.evidenceHash) invalid();
  if (evaluation.connectionHash !== connectionFingerprint(connection) || evaluation.piVersion !== evaluationPiVersion || evaluation.pricing.kind !== connection.billing.kind)
    return { status: 'configured', evaluation: null, evaluationHash: null };
  const smoke = evaluation.checks.sdkSmoke && evaluation.checks.rpcSmoke;
  const task = smoke && Object.values(evaluation.checks).every(Boolean);
  const status: ConnectionStatus = evaluation.outcome === 'unsupported' ? 'unsupported' : task ? receipt.enabled ? 'enabled' : 'task_evaluated' : smoke ? 'smoke_passed' : 'configured';
  return { status, evaluation, evaluationHash: receipt.evaluationHash };
}
/** 評価runnerから記録する。証拠の保存だけでは接続を有効化しない。 */
export function saveEvaluation(stateDir: string, connection: Connection, value: Evaluation) {
  const evaluation = validateEvaluation(value);
  if (evaluation.connectionHash !== connectionFingerprint(connection) || evaluation.piVersion !== evaluationPiVersion || evaluation.pricing.kind !== connection.billing.kind) invalid();
  const release = acquireLock(stateDir);
  try {
    const evidenceFile = join(stateDir, 'artifacts', evaluation.evidenceHash);
    readJson(evidenceFile);
    if (hash(readFileSync(evidenceFile)) !== evaluation.evidenceHash) invalid();
    const artifact = saveArtifact(stateDir, Buffer.from(JSON.stringify(evaluation)));
    const file = receiptFile(stateDir, connection);
    // replaceFileは親directoryを作成しないため、writeReceipt側で用意する。
    const { hash: evaluationHash } = artifact;
    writeReceipt(file, { schemaVersion: 1, evaluationHash, enabled: false });
    return connectionEvaluation(stateDir, connection);
  } finally { release(); }
}
function writeReceipt(file: string, receipt: Receipt) {
  privateDirectory(dirname(file));
  replaceFile(file, JSON.stringify(receipt), existsSync(file) ? hash(readFileSync(file)) : null, 0o600);
}
export function enableConnection(stateDir: string, connection: Connection, expectedEvaluationHash: string) {
  const release = acquireLock(stateDir);
  try {
    const current = connectionEvaluation(stateDir, connection);
    if (!['task_evaluated', 'enabled'].includes(current.status) || current.evaluationHash !== expectedEvaluationHash) throw new SetupError('現在の接続定義に一致する評価が必要です。', 'evaluation_required');
    writeReceipt(receiptFile(stateDir, connection), { schemaVersion: 1, evaluationHash: expectedEvaluationHash, enabled: true });
  } finally { release(); }
}
/** 接続選択だけを行う。provider障害を理由に別接続で自動再試行してはいけない。 */
export function routedConnection(routing: Routing | null, role: ModelRole, taskType: string | undefined, profile: Connections, allowed: string[], stateDir: string) {
  if (!routing) throw new SetupError('routingが未設定です。', 'routing_unconfigured');
  validateRouting(routing, profile);
  const id = routing.tasks.find(t => t.role === role && t.type === taskType)?.connectionId ?? routing.roles[role];
  if (!id) throw new SetupError('この役割の接続が未設定です。', 'routing_unconfigured');
  const connection = profile.connections.find(c => c.id === id)!;
  if (!allowed.includes(id)) throw new SetupError('routingの送信先が許可されていません。', 'connection_not_allowed');
  if (connectionEvaluation(stateDir, connection).status !== 'enabled') throw new SetupError('接続は未評価・未有効化、または非対応です。', 'connection_not_enabled');
  return connection;
}
