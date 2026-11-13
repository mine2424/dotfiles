import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Provider } from '@earendil-works/pi-ai';
import { estimateTokens, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { selectedProvider } from './auth.js';
import { validateConnections } from './connections.js';
import { codingTools } from './tools.js';
import { inspectRules } from './rules.js';
import { runHarness } from './harness.js';
import { hash } from './workspace.js';

/** 評価runnerが明示指定するextension。通常のSDKでは自動探索しない。
 * toolとprovider認証にはSDK経路と同じBeethovenのPolicyを使う。 */
export default function evaluationExtension(pi: ExtensionAPI) {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error('Explicit evaluation manifest required');
  const manifest = JSON.parse(readFileSync(join(agentDir, 'beethoven-evaluation.json'), 'utf8')) as {
    configFile: string; cwd: string; stateDir: string; connection: unknown; maxTokens: number; maxDurationMs: number;
  };
  const connection = validateConnections({ schemaVersion: 1, allowFallback: false, defaultConnectionId: (manifest.connection as { id: string }).id, connections: [manifest.connection] }).connections[0]!;
  if (connection.billing.kind !== 'subscription' || !Number.isSafeInteger(manifest.maxTokens) || manifest.maxTokens <= 0 || manifest.maxTokens > connection.limits.maxTokens || realpathSync(manifest.cwd) !== process.cwd() || manifest.maxDurationMs !== 120000) throw new Error('Evaluation bounds required');
  const rules = inspectRules(manifest.cwd, manifest.configFile);
  if (!rules.snapshot.declarationsValid || !rules.snapshot.config.settings.allowedConnections.includes(connection.id)) throw new Error('Evaluation declarations invalid');
  const log = (type: string, data: unknown) => appendFileSync(join(agentDir, 'beethoven-events.jsonl'), JSON.stringify({ type, data }) + '\n', { mode: 0o600 });
  let deadline = Date.now() + manifest.maxDurationMs;
  let tokens = 0, reserved = 0, requests = 0, missingRequests = 0, lastInput = 0;
  let blocked = false;
  const usageFile = join(agentDir, 'beethoven-usage.json');
  const save = () => writeFileSync(usageFile, JSON.stringify({ tokens, reserved, requests, missingRequests }), { mode: 0o600 });
  const assertCurrent = () => {
    if (blocked || Date.now() >= deadline || inspectRules(manifest.cwd, manifest.configFile).hash !== rules.hash) throw new Error('Evaluation conditions changed');
  };
  const provider = selectedProvider(connection);
  const wrapped: Provider = { ...provider, streamSimple(model, context, options) {
    const stream = createAssistantMessageEventStream();
    const fail = () => {
      const error: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'error', errorMessage: 'Evaluation budget or policy blocked', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: 'error', reason: 'error', error });
    };
    void (async () => {
      let reservation = 0, terminal = false;
      try {
        assertCurrent();
        if (model.id !== connection.model || model.provider !== connection.provider || ++requests > 20 || options?.signal?.aborted) throw new Error('Policy blocked');
        const estimate = Math.ceil(Math.max(context.messages.reduce((n, m) => n + estimateTokens(m as Parameters<typeof estimateTokens>[0]), 0), lastInput) * 1.5) + 256;
        const maxOutput = Math.min(2048, manifest.maxTokens - tokens - reserved - estimate);
        if (maxOutput < 1) throw new Error('Budget blocked');
        reservation = estimate + maxOutput; reserved += reservation; save();
        const source = provider.streamSimple(model, context, { ...options, maxTokens: maxOutput, maxRetryDelayMs: 1 });
        for await (const event of source) {
          if (event.type === 'done' || event.type === 'error') {
            terminal = true;
            const message = event.type === 'done' ? event.message : event.error;
            const usage = message.usage;
            const total = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(n => Number.isFinite(n) && n >= 0) ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;
            if (total > 0) { tokens += total; reserved -= reservation; lastInput = usage.input + usage.cacheRead + usage.cacheWrite; }
            else missingRequests++;
            save();
          }
          stream.push(event);
        }
        if (!terminal) { missingRequests++; blocked = true; save(); fail(); }
      } catch { if (reservation && !terminal) missingRequests++; blocked = true; save(); fail(); }
    })();
    return stream;
  } };
  pi.registerProvider(wrapped);
  pi.on('agent_start', () => { deadline = Date.now() + manifest.maxDurationMs; });
  pi.on('before_agent_start', () => ({ systemPrompt: `You are Beethoven. Use Japanese. Read before edit. Preserve existing changes. Only edit cart.js. Call verify after editing. Never commit or transmit using tools.\nRules snapshot: ${rules.hash}\n` + rules.snapshot.sources.filter(s => s.kind === 'rules').map(s => s.content).join('\n') }));
  const approve = async (_message: string, key: string) => key.startsWith('harness:') || key.startsWith(`shell:${hash(`${process.execPath} --test`)}:`);
  const tools = codingTools({ cwd: manifest.cwd, stateDir: manifest.stateDir, permission: rules.snapshot.config.settings.permission, planOnly: () => false, allowedPaths: ['cart.js'], assertCurrent,
    remainingMs: () => Math.max(1, deadline - Date.now()), approve, ask: async () => null,
    verify: signal => runHarness(rules, 'verify', { cwd: manifest.cwd, stateDir: manifest.stateDir, approve, assertCurrent, signal, remainingMs: Math.max(1, deadline - Date.now()), event: log }),
    blocked: reason => { blocked = true; log('blocked', reason); }, event: log });
  for (const tool of tools) pi.registerTool(tool);
  save();
}
