import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { workerMain } from '../src/worker-entry.js';
export async function scriptedRuntime(slow = false, mode = 'edit') {
  const faux = fauxProvider({ provider: 'fixture', models: [{ id: 'fixture', maxTokens: 4096 }], tokensPerSecond: slow ? 1 : Infinity });
  faux.setResponses(mode === 'ask' ? [fauxAssistantMessage(fauxToolCall('ask_user', { question: '数量の扱いを教えてください。' }), { stopReason: 'toolUse' })] : slow ? [fauxAssistantMessage('長い応答'.repeat(1000))] : [
    context => {
      if (mode === 'resume' && (!JSON.stringify(context).includes('数量の扱い') || !JSON.stringify(context).includes('two'))) throw new Error('saved conversation was not restored');
      return fauxAssistantMessage(fauxToolCall('read', { path: 'value.txt' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage(fauxToolCall('edit', { path: 'value.txt', oldText: 'one', newText: 'two' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('変更しました。'),
  ]);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  runtime.registerNativeProvider({ ...faux.provider, auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'test-only' } }) } } });
  return runtime;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
  await workerMain(process.argv[2]!, await scriptedRuntime(manifest.task === 'slow', manifest.task === 'ask' ? 'ask' : manifest.options.resume ? 'resume' : 'edit'));
}
