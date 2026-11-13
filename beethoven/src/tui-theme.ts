import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

// Logo references: midnight navy, warm ivory, champagne gold. Keep terminal typography native.
export const brandPalettes = {
  dark: { ink: '#F4EFE4', muted: '#ACB7C5', gold: '#D6B36A', line: '#526079', surface: '#101D2D', success: '#A5C9A4', error: '#F09A8C' },
  light: { ink: '#182332', muted: '#536073', gold: '#856019', line: '#8B8070', surface: '#F4F0E7', success: '#35633C', error: '#A1372A' },
} as const;
export type TuiTheme = ReturnType<typeof createTuiTheme>;
export function createTuiTheme(env: NodeJS.ProcessEnv = process.env) {
  const background = Number(env.COLORFGBG?.split(';').at(-1));
  const mode = env.BEETHOVEN_THEME === 'light' || env.BEETHOVEN_THEME !== 'dark' && Number.isFinite(background) && background >= 7 ? 'light' : 'dark';
  const palette = brandPalettes[mode];
  const noColor = env.NO_COLOR !== undefined || env.BEETHOVEN_THEME === 'mono';
  const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(';');
  const foreground = (hex: string) => (text: string) => noColor ? text : `\x1b[38;2;${rgb(hex)}m${text}\x1b[39m`;
  const gold = foreground(palette.gold), ink = foreground(palette.ink), muted = foreground(palette.muted), line = foreground(palette.line);
  const bold = (text: string) => noColor ? text : `\x1b[1m${text}\x1b[22m`;
  const surface = (text: string) => {
    if (noColor) return text;
    const bg = `\x1b[48;2;${rgb(palette.surface)}m`;
    return bg + ink(text).replace(/\x1b\[0m/g, `\x1b[0m${bg}`).replace(/\x1b\[49m/g, bg) + '\x1b[49m';
  };
  return { mode, noColor, palette, gold, ink, muted, line, bold, surface, success: foreground(palette.success), error: foreground(palette.error),
    markdown: { heading: (text: string) => bold(gold(text)), link: gold, linkUrl: muted, code: gold, codeBlock: (text: string) => text,
      codeBlockBorder: line, quote: (text: string) => text, quoteBorder: gold, hr: line, listBullet: gold,
      bold, italic: (text: string) => text, strikethrough: (text: string) => text, underline: (text: string) => text } };
}
/** Align metadata without wrapping long models, Japanese paths or narrow terminal widths. */
export function splitRow(left: string, right: string, width: number) {
  if (visibleWidth(left) + visibleWidth(right) + 3 > width) return truncateToWidth(left, width, '…');
  return left + ' '.repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}
export function panelLines(title: string, lines: string[], width: number, theme: TuiTheme) {
  if (width < 8) return lines.map(line => truncateToWidth(line, width, ''));
  const label = truncateToWidth(` ${title} `, width - 4, '…');
  const top = theme.gold(`╭─${label}${'─'.repeat(Math.max(0, width - 3 - visibleWidth(label)))}╮`);
  const body = lines.map(line => { const text = truncateToWidth(line, width - 4, '…'); return theme.line('│ ') + text + ' '.repeat(Math.max(0, width - 4 - visibleWidth(text))) + theme.line(' │'); });
  return [top, ...body, theme.line(`╰${'─'.repeat(width - 2)}╯`)].map(line => theme.surface(line));
}
