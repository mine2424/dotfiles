import { openAgent, type AgentOptions } from './agent.js';
import { SetupError } from './connections.js';

type Agent = Awaited<ReturnType<typeof openAgent>>;
export type ControllerState = 'opening' | 'idle' | 'running' | 'paused' | 'closing' | 'closed';

/** UIや入力queueから独立して1実行の所有権を持つ。解放後の遅延eventと二重実行を拒否する。 */
export class SessionController {
  private agent?: Agent;
  private cached!: ReturnType<Agent['info']>;
  private phase: ControllerState = 'opening';
  private generation = 0;
  private closing?: Promise<void>;
  private constructor() {}
  static async open(options: AgentOptions, factory: typeof openAgent = openAgent) {
    const controller = new SessionController();
    const generation = controller.generation;
    controller.agent = await factory({ ...options, onActivity: activity => {
      if (controller.generation === generation && ['opening', 'running'].includes(controller.phase)) options.onActivity?.(activity);
    } });
    try { controller.cached = controller.agent.info(); controller.phase = 'idle'; }
    catch (error) { await controller.agent.close(); throw error; }
    return controller;
  }
  get id() { return this.cached.sessionId; }
  get state() { return this.phase; }
  info() {
    if (this.agent) this.cached = this.agent.info();
    return { ...this.cached, controller: this.phase };
  }
  async run(text: string, options: Parameters<Agent['run']>[1] = {}) {
    if (this.phase !== 'idle' || !this.agent) throw new SetupError('実行中または保留中です。停止確認後に/resumeで再開してください。', 'controller_not_ready');
    this.phase = 'running'; const generation = this.generation;
    try {
      return await this.agent.run(text, { ...options, onEvent: event => {
        if (this.generation === generation && this.phase === 'running') options.onEvent?.(event);
      } });
    } catch (error) {
      // 送信前に拒否された設定・予算エラー以外は、明示resumeまで再利用しない。
      if (!(error instanceof SetupError) || !['budget_blocked', 'prompt_required', 'send_approval_required'].includes(error.code)) this.phase = 'paused';
      throw error;
    } finally { if (this.phase === 'running') this.phase = 'idle'; }
  }
  abort() { this.agent?.abort(); }
  close() {
    if (this.closing) return this.closing;
    if (this.phase === 'running') return Promise.reject(new SetupError('実行の停止完了を待ってください。', 'controller_busy'));
    if (!this.agent) return Promise.resolve();
    const owned = this.agent;
    try { this.cached = owned.info(); } catch { /* workspace診断の失敗でも実行所有権は必ず閉じる */ }
    this.agent = undefined; this.phase = 'closing'; this.generation++;
    this.closing = (async () => {
      try { await owned.close(); this.phase = 'closed'; }
      catch (error) { this.phase = 'paused'; throw error; }
    })();
    return this.closing;
  }
}
