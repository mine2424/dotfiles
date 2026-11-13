import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

/** 接続候補と実行時で同じprovider定義を使い、追加漏れを防ぐ。通信は開始しない。 */
export function nativeProviders() { return builtinProviders(); }
export const providerNames: Record<string, string> = { openai: 'Codex / OpenAI', anthropic: 'Claude', 'kimi-coding': 'Kimi Code', openrouter: 'OpenRouter' };

/** OpenRouter側のprovider fallbackも明示的に止め、モデルや課金先を増やさない。 */
export function openRouterPayload(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OpenRouter payload');
  const body = value as Record<string, unknown>;
  const provider = body.provider && typeof body.provider === 'object' && !Array.isArray(body.provider) ? body.provider : {};
  return { ...body, provider: { ...provider, allow_fallbacks: false, require_parameters: true } };
}

/** streamの確定usageにある費用だけを取り出す。欠測をcatalog推計や0で埋めない。 */
export function openRouterCost(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as { usage?: { cost?: unknown }; message?: { usage?: { cost?: unknown } } };
  const cost = data.usage?.cost ?? data.message?.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
}
