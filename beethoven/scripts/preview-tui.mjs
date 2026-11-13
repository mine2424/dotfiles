/** Deterministic real-renderer preview. No credentials, provider requests or sessions are opened. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TuiTerminal } from '../dist/src/tui.js';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
delete process.env.NO_COLOR; // Capture each explicit palette, independent of the invoking shell.
const directory = process.argv[2] ?? '/tmp/beethoven-tui-brand';
mkdirSync(directory, { recursive: true });
class PreviewTerminal {
  columns = 104; rows = 30; kittyProtocolActive = false;
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {} write() {} async drainInput() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
}
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function runs(line, foreground, background) {
  const tokens = line.split(/(\x1b\[[0-9;]*m)/); let fg = foreground, bg = background, bold = false, inverse = false, col = 0;
  const result = [];
  for (const token of tokens) {
    if (token.startsWith('\x1b[')) {
      const codes = token.slice(2, -1).split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) { fg = foreground; bg = background; bold = false; inverse = false; }
        if (code === 1) bold = true;
        if (code === 22) bold = false;
        if (code === 7) inverse = true;
        if (code === 27) inverse = false;
        if (code === 39) fg = foreground;
        if (code === 49) bg = background;
        if ((code === 38 || code === 48) && codes[i + 1] === 2) { const color = '#' + codes.slice(i + 2, i + 5).map(n => n.toString(16).padStart(2, '0')).join(''); if (code === 38) fg = color; else bg = color; i += 4; }
      }
    } else {
      const text = stripTerminalSequences(token); const width = visibleWidth(text);
      if (text) result.push({ text, col, width, fg: inverse ? bg : fg, bg: inverse ? fg : bg, bold });
      col += width;
    }
  }
  return result;
}
for (const mode of ['dark', 'light', 'mono']) {
  process.env.BEETHOVEN_THEME = mode;
  const terminal = new PreviewTerminal(); const ui = new TuiTerminal('/workspace/beethoven', terminal);
  const info = { sessionId: '047ba643-d838-4bfe-a9ed-6d92cb3e4276', provider: 'openai-codex', model: 'gpt-6.1-sol', connectionId: 'codex-sub', billing: 'subscription', permission: 'workspace-write', limits: { maxTokens: 20000 }, usage: { tokens: 2840, costUsd: null } };
  ui.setInfo(info);
  ui.beginTurn('数量を反映して合計金額を修正してください。既存テストも確認してください。');
  ui.event({ type: 'text', delta: '数量の扱いを確認し、合計金額の計算を修正しました。\n\n- `cart.js` に数量を反映\n- 既存テストはそのまま維持\n\n最後に検証を実行します。' });
  ui.event({ type: 'tool_start', id: 'read', name: 'read', target: 'src/cart.js' });
  ui.event({ type: 'tool_end', id: 'read', name: 'read', target: 'src/cart.js' });
  ui.event({ type: 'tool_start', id: 'verify', name: 'verify', target: 'node --test' });
  ui.worker({ id: 'b8df79a2-3a1b-4895-b3ab-27229451ada0', stage: 'verify', provider: 'openai-codex', model: 'gpt-6.1-sol', directory: '/private/worker/worktree', pid: 41802, startedAt: Date.now() });
  ui.editor.setText('確認後、変更点をまとめてください'); ui.setPhase('検証中');
  function capture(stem) {
  ui.tui.renderNow(true);
  const lines = ui.tui.getScreenLines();
  const bg = mode === 'light' ? '#FCFAF5' : '#0B121D', fg = mode === 'light' ? '#182332' : '#F4EFE4';
  const capture = { mode, columns: terminal.columns, rows: terminal.rows, bg, fg, lines: lines.map(line => runs(line, fg, bg)) };
  writeFileSync(join(directory, `${stem}.json`), JSON.stringify(capture, null, 2));
  writeFileSync(join(directory, `${stem}.txt`), lines.map(stripTerminalSequences).join('\n'));
  const cell = 8.5, height = 25, padding = 20;
  const elements = capture.lines.flatMap((line, row) => line.flatMap(run => [
    `<rect x="${padding + run.col * cell}" y="${padding + row * height}" width="${run.width * cell}" height="${height}" fill="${run.bg}"/>`,
    `<text x="${padding + run.col * cell}" y="${padding + row * height + 18}" fill="${run.fg}" font-weight="${run.bold ? '700' : '400'}">${escape(run.text)}</text>`,
  ]));
  writeFileSync(join(directory, `${stem}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="${terminal.columns * cell + padding * 2}" height="${terminal.rows * height + padding * 2}"><rect width="100%" height="100%" fill="${bg}"/><g font-family="Menlo, monospace" font-size="14" xml:space="preserve">${elements.join('')}</g></svg>`);
  }
  capture(mode);
  const picker = ui.select('接続先を選んでください', [
    { value: 'codex', label: 'Codex subscription', description: 'OpenAI · ブラウザで認証' },
    { value: 'claude', label: 'Claude subscription', description: 'Anthropic · ブラウザで認証' },
    { value: 'openrouter', label: 'OpenRouter API', description: 'APIキーで接続' },
  ]);
  capture(`${mode}-connect`); ui.cancel(); await picker;
  const secret = ui.secret('Enter OpenRouter API key');
  terminal.input('preview-secret-not-rendered'); capture(`${mode}-private`); ui.cancel(); await secret;
  ui.close();
}
console.log(`Real-renderer previews: ${directory}/{dark,light,mono}.{svg,json,txt}`);
