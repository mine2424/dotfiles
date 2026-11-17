// Real Pi SDK and extensions, using an in-process scripted model: no paid API calls.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sdkRoot, agentDir, cwd] = process.argv.slice(2);
const sdkEntry = join(sdkRoot, 'dist/index.js');
const require = createRequire(sdkEntry);
const sdk = await import(pathToFileURL(sdkEntry));
const aiEntry = require.resolve.paths('@earendil-works/pi-ai')
  .map((path) => join(path, '@earendil-works/pi-ai/dist/index.js')).find(existsSync);
assert(aiEntry, 'Pi AI runtime missing');
const ai = await import(pathToFileURL(aiEntry));
const { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } = ai;
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
const fake = fauxProvider({ tokensPerSecond: Infinity });
const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
  refreshOnCreate: false, allowModelNetwork: false });
runtime.registerNativeProvider(fake.provider);
const settings = SettingsManager.create(cwd, agentDir);
const resources = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings });
await resources.reload();
assert.equal(resources.getExtensions().errors.length, 0, 'Extension loading failed');
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime,
  model: fake.getModel(), resourceLoader: resources, settingsManager: settings,
  sessionManager: SessionManager.inMemory(cwd) });
const errors = [];
try {
  await session.bindExtensions({ mode: 'rpc', onError: (event) => errors.push(event.event) });
  assert(session.getAllTools().some((tool) => tool.name === 'subagent'), 'subagent tool missing');
  assert(!session.getAllTools().some((tool) => tool.name === 'ponytail'), 'unexpected Ponytail tool');
  session.setActiveToolsByName([...session.getActiveToolNames(), 'subagent']);
  let prompt;
  fake.setResponses([
    (context) => {
      prompt = getCurrentSystemPrompt(context.messages);
      return fauxAssistantMessage(fauxToolCall('subagent', { action: 'list' }), { stopReason: 'toolUse' });
    },
    fauxAssistantMessage(fauxToolCall('subagent', {
      action: 'list', options: { tools: 'read,grep,find,ls' },
    }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('subagent', {
      action: 'get', agent: 'reviewer',
    }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Local smoke complete.'),
  ]);
  await session.prompt('/skill:poteto-mode Check local agent discovery only. Do not start a child.');
  assert(prompt.includes('Poteto Mode is ON.'), 'pstack instructions lost');
  assert(prompt.includes('PRINCIPLES.md'), 'shared principle pointer lost');
  const result = session.state.messages.filter((item) => item.role === 'toolResult' && item.toolName === 'subagent');
  assert.equal(result.length, 3, 'subagent API checks missing');
  assert(!result[0].isError, 'agent discovery tool failed');
  const listed = JSON.stringify(result[0]);
  assert(listed.includes('poteto-agent') && listed.includes('comment-sicko'), 'pstack delegates not discovered');
  assert(result[1].isError && JSON.stringify(result[1]).includes("unknown options key 'tools'"),
    'unsupported options.tools no longer reproduces; revisit compatibility instructions');
  assert(!result[2].isError, 'read-only reviewer definition lookup failed');
  const reviewer = result[2].content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  assert(reviewer.includes('Acceptance role: read-only'), 'reviewer is not read-only');
  assert(reviewer.split('\n').includes('Tools: read, grep, find, ls, watchdog_diff, contact_supervisor'),
    'reviewer tool restrictions changed');
  assert(prompt.includes('options.tools') && prompt.includes('agent: "reviewer"'),
    'subagent API compatibility instructions missing from effective prompt');
  await session.prompt('/poteto-mode off');
  fake.setResponses([(context) => {
    const text = getCurrentSystemPrompt(context.messages);
    assert(text.includes('Poteto Mode is OFF.'), 'pstack mode off lost');
    assert(!text.includes('Poteto Mode is ON.'), 'stale pstack activation');
    return fauxAssistantMessage('Mode off verified.');
  }]);
  await session.prompt('Check mode state only.');
  assert.equal(errors.length, 0, 'extension event failed');
  console.log(JSON.stringify({ ok: true, scriptedModel: true, paidModelTested: false,
    checks: ['pstack_prompt_composition', 'shared_principle_pointer', 'subagent_tool_execution',
      'pstack_agent_discovery', 'unsupported_tools_reproduced', 'read_only_reviewer_definition',
      'subagent_compatibility_instructions', 'poteto_mode_off', 'extension_event_errors'] }));
} finally {
  await session.abort();
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
  await runtime.settleCredentialWrites();
}
