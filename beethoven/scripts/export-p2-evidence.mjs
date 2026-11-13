import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionFingerprint, saveEvaluation } from '../dist/src/routing.js';
import { selectedConnection } from '../dist/src/dialogue.js';
import { selectedProvider } from '../dist/src/auth.js';
import { saveArtifact } from '../dist/src/files.js';
import { hash } from '../dist/src/workspace.js';

// Only sanitized fields are published. Private raw logs, messages, session paths and auth are excluded.
const [sdkManifestFile, codexManifestFile, claudeManifestFile, configFile, stateDir, outputFile, testReportFile] = process.argv.slice(2);
if (!testReportFile) throw new Error('sdk-manifest codex-rpc-manifest claude-rpc-manifest config state output test-report required');
const project = fileURLToPath(new URL('../', import.meta.url));
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const sdkManifest = read(sdkManifestFile), codexManifest = read(codexManifestFile), claudeManifest = read(claudeManifestFile);
const sdkFile = join(sdkManifest.root, 'sdk-claude-subscription.json');
const rpcFiles = [codexManifest, claudeManifest].map((m, i) => join(m.root, `rpc-${i === 0 ? 'codex' : 'claude'}-subscription`, 'evidence.json'));
const sdk = read(sdkFile), rpc = rpcFiles.map(read);
const p3File = join(project, 'docs/evidence/p3-2026-10-25.json'), p3 = read(p3File);
assert.equal(p3.acceptance.implementationAndDeveloperLiveChecks, 'passed');
const tree = m => execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD^{tree}'], { cwd: m.repo, encoding: 'utf8' }).trim();
const fixtureTrees = [sdkManifest, codexManifest, claudeManifest].map(tree);
assert.equal(new Set(fixtureTrees).size, 1);
const now = new Date().toISOString();
const testReport = readFileSync(resolve(testReportFile));
const testCount = Number(testReport.toString().match(/^# tests (\d+)$/m)?.[1]);
const passCount = Number(testReport.toString().match(/^# pass (\d+)$/m)?.[1]);
const failCount = Number(testReport.toString().match(/^# fail (\d+)$/m)?.[1]);
assert.ok(testCount > 0 && passCount === testCount && failCount === 0);
const sdkTask = sdk.records.find(r => r.kind === 'smoke-task');
const sdkResume = sdk.records.find(r => r.kind === 'resume-with-approved-budget');
assert.equal(sdkTask.result.status, 'completed');
assert.equal(sdkResume.result.result.status, 'completed');
const sdkTokens = sdkResume.info.usage.tokens;
const rpcTotals = rpc.map(e => e.records.filter(r => r.kind === 'stop').reduce((n, r) => ({ reported: n.reported + r.usage.tokens, reserved: n.reserved + r.usage.reserved, missing: n.missing + r.usage.missingRequests }), { reported: 0, reserved: 0, missing: 0 }));
assert.ok(sdkTokens + rpcTotals[1].reported + rpcTotals[1].reserved <= 60000);
assert.ok(rpcTotals[0].reported + rpcTotals[0].reserved <= 40000);
for (const e of rpc) {
  assert.equal(e.records.find(r => r.kind === 'smoke-task')?.result.status, 'completed');
  assert.equal(e.records.find(r => r.kind === 'resume')?.result.status, 'completed');
  assert.equal(e.records.find(r => r.kind === 'abort-in-flight')?.result.status, 'aborted');
  const checks = e.records.find(r => r.kind === 'independent-checks');
  assert.ok(checks?.testsPassed && checks.protectedFiles && checks.groupsGone);
  assert.ok(e.records.filter(r => r.kind === 'stop').every(r => r.groupGone));
}
const sourceFiles = ['src', 'tests', 'scripts'].flatMap(dir => readdirSync(join(project, dir)).filter(name => /\.(?:ts|mjs)$/.test(name)).map(name => join(project, dir, name)))
  .concat(['package.json', 'package-lock.json', 'connections.example.json', 'routing.example.json'].map(file => join(project, file)));
const connections = rpc.map(e => selectedConnection(resolve(configFile), e.connectionId));
// 実モデル試験時と、その後のローカル修正を含む最終sourceを混同しない。
const previousExport = existsSync(resolve(outputFile)) ? read(resolve(outputFile)) : null;
const evidence = {
  schemaVersion: 1, recordedAt: now, piVersion: '1.4.0', nodeVersion: process.versions.node,
  stage: 'P2-developer-acceptance', fixture: { gitTree: fixtureTrees[0], acceptance: sdkManifest.acceptance, identicalBaselineContent: true },
  localTests: { command: 'node --test --test-reporter=tap dist/tests/*.test.js', tests: testCount, passed: passCount, failed: failCount, logHash: hash(testReport) },
  connections: connections.map((connection, i) => {
    const model = selectedProvider(connection).getModels().find(m => m.id === connection.model);
    return { id: connection.id, provider: connection.provider, model: connection.model, authMethod: connection.auth.method, billing: connection.billing.kind,
      connectionHash: connectionFingerprint(connection), observedModel: { id: model.id, contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens, reasoning: model.reasoning, input: model.input },
      pricing: { kind: 'subscription', basis: 'User selected subscription; pinned provider OAuth isSubscription=true; successful OAuth and live inference. Invoice and remaining allowance unavailable. Pi catalog cost is not subscription billing.', observedAt: now, amountUsd: null },
      rpc: { accounted: rpcTotals[i].reported + rpcTotals[i].reserved, ...rpcTotals[i], records: rpc[i].records.map(r => {
        if (r.kind === 'spawn') return { kind: r.kind, processGroup: r.pid };
        if (r.kind === 'start') return { kind: r.kind, model: r.model, persistedSession: Boolean(r.sessionFile) };
        if (r.kind === 'stop') return r;
        if (r.kind === 'independent-checks') return { kind: r.kind, protectedFiles: r.protectedFiles, testsPassed: r.testsPassed, groups: r.groups, groupsGone: r.groupsGone, beforeHash: r.beforeHash, afterHash: r.afterHash };
        return { kind: r.kind, result: r.result, tools: r.tools };
      }) },
    };
  }),
  claudeSdk: { reported: sdkTokens, reserved: sdkResume.info.usage.reservedUnknownTokens,
    records: sdk.records.filter(r => r.result).map(r => ({ kind: r.kind, status: r.result.status, blockedReason: r.result.blockedReason, provider: r.result.result, verification: r.result.verification?.status, tools: r.tools, usage: r.info?.usage, changedFiles: r.result.changedFiles })) },
  limits: { claudeTotal: 60000, claudeAccounted: sdkTokens + rpcTotals[1].reported + rpcTotals[1].reserved, codexRpcTotal: 40000, turnMs: 120000, concurrencyPerConnection: 1, retries: 0 },
  preparatoryFailures: [
    { kind: 'RPC-startup', attemptsPerConnection: 2, reason: 'Evaluation cwd string check rejected macOS /var versus /private/var; canonical path check fixed before model dispatch.', tokensSent: 0, allGroupsGone: true },
    { kind: 'Claude-SDK-resume', reason: '30k budget lacked input reservation; blocked before dispatch. User then approved 60k.' },
    { kind: 'Claude-SDK-resume-verification', reason: 'Model resumed and settled; runner declined a harness approval, so report stayed blocked. Independent tests subsequently passed; original blocked record retained.' },
    { kind: 'Local-process-test', reason: 'One full-suite run failed process-group absence confirmation. The focused process suite then passed outside execution restrictions; final full-suite TAP is linked separately.' },
  ],
  faultCoverage: { structuredStatus: ['401', '403', '429', '408', '504', 'ETIMEDOUT'], messageInference: true, live429Induced: false, missingUsage: 'Codex live RPC abort reservation; adapter null retained even when a late provider ledger arrives.', fallback: false },
  priorCodexSdk: { evidenceHash: hash(readFileSync(p3File)), acceptance: p3.acceptance.implementationAndDeveloperLiveChecks },
  rawEvidenceHashes: [sdkFile, ...rpcFiles].map(file => hash(readFileSync(file))),
  sourceHashes: Object.fromEntries(sourceFiles.map(file => [relative(project, file), hash(readFileSync(file))])),
  liveSourceHashes: previousExport?.liveSourceHashes ?? previousExport?.sourceHashes ?? null,
  acceptance: { developer: 'passed', userDailyUse: 'not_confirmed', githubCI: 'not_run', providerInvoiceReconciliation: 'not_available', rankingOrSuccessRate: 'not_measured', backupRestore: 'P4_not_implemented' },
};
const content = Buffer.from(JSON.stringify(evidence, null, 2) + '\n');
saveArtifact(resolve(stateDir), testReport);
const artifact = saveArtifact(resolve(stateDir), content);
for (const [i, connection] of connections.entries()) {
  const evaluation = { schemaVersion: 1, connectionHash: connectionFingerprint(connection), piVersion: '1.4.0', observedAt: now,
    fixtureHash: hash(fixtureTrees[0]), evidenceHash: artifact.hash, pricing: evidence.connections[i].pricing,
    checks: { sdkSmoke: true, rpcSmoke: true, task: true, abort: true, resume: true, protectedFiles: true },
    usage: { reportedTokens: rpcTotals[i].reported + (i === 1 ? sdkTokens : 0), missingRequests: rpcTotals[i].missing }, outcome: 'supported' };
  assert.equal(saveEvaluation(resolve(stateDir), connection, evaluation).status, 'task_evaluated');
}
writeFileSync(resolve(outputFile), content);
console.log(JSON.stringify({ output: resolve(outputFile), artifactHash: artifact.hash, statuses: 'task_evaluated' }));
