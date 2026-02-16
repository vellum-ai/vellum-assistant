import { basename } from 'node:path';
import { getSocketPath, getWorkspaceDir } from '../util/platform.js';
import { APP_VERSION } from '../version.js';

const LEFT_PANEL_WIDTH = 36;
const TOTAL_WIDTH = 72;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  magenta: '\x1b[35m',
} as const;

const VELLY_ART = [
  '    ,___,',
  '   ( O O )',
  '    /)V(\\',
  '   //   \\\\',
  '  /"     "\\',
  '  ^       ^',
];

function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - str.length);
}

export interface MainScreenLayout {
  height: number;
  statusLine: number;
  statusCol: number;
}

export function renderMainScreen(): MainScreenLayout {
  const socketPath = getSocketPath();
  const workspace = getWorkspaceDir();
  const dirName = basename(workspace);

  const tips = [
    'Send a message to start chatting',
    'Use /help to see available commands',
  ];

  const leftLines = [
    ' ',
    '    Meet your Assistant!',
    ' ',
    ...VELLY_ART.map((l) => `  ${l}`),
    ' ',
    `  ${socketPath}`,
    `  ~/${dirName}`,
  ];

  const rightLines = [
    ' ',
    'Tips for getting started',
    ...tips,
    ' ',
    'Daemon',
    'connecting...',
    'Version',
    APP_VERSION,
    'Status',
    'checking...',
  ];

  const maxLines = Math.max(leftLines.length, rightLines.length);

  process.stdout.write(`${ANSI.dim}\u2500\u2500 Vellum ${'\u2500'.repeat(62)}${ANSI.reset}\n`);

  for (let i = 0; i < maxLines; i++) {
    const leftLine = leftLines[i] ?? ' ';
    const rightLine = rightLines[i] ?? ' ';

    let left: string;
    if (i === 1) {
      left = `${ANSI.bold}${pad(leftLine, LEFT_PANEL_WIDTH)}${ANSI.reset}`;
    } else if (i > 2 && i <= 2 + VELLY_ART.length) {
      left = `${ANSI.magenta}${pad(leftLine, LEFT_PANEL_WIDTH)}${ANSI.reset}`;
    } else if (i > 2 + VELLY_ART.length) {
      left = `${ANSI.dim}${pad(leftLine, LEFT_PANEL_WIDTH)}${ANSI.reset}`;
    } else {
      left = pad(leftLine, LEFT_PANEL_WIDTH);
    }

    const isHeading = i === 1 || i === 6;
    const isDim = i === 5 || i === 7 || i === 9;

    let right: string;
    if (isHeading) {
      right = `${ANSI.magenta}${rightLine}${ANSI.reset}`;
    } else if (isDim) {
      right = `${ANSI.dim}${rightLine}${ANSI.reset}`;
    } else {
      right = rightLine;
    }

    process.stdout.write(`${left}${right}\n`);
  }

  process.stdout.write(`${ANSI.dim}${'\u2500'.repeat(TOTAL_WIDTH)}${ANSI.reset}\n`);
  process.stdout.write(' \n');
  process.stdout.write(`${ANSI.dim} ? for shortcuts${ANSI.reset}\n`);
  process.stdout.write(' \n');

  const rightLineCount = rightLines.length;
  const statusCanvasLine = rightLineCount + 1;
  const statusCol = LEFT_PANEL_WIDTH + 1;

  const height = 1 + maxLines + 4;

  return { height, statusLine: statusCanvasLine, statusCol };
}

export function updateStatusText(layout: MainScreenLayout, text: string): void {
  process.stdout.write(`\x1b7\x1b[${layout.statusLine};${layout.statusCol}H\x1b[K${text}\x1b8`);
}

export function updateDaemonText(layout: MainScreenLayout, text: string): void {
  const daemonLine = layout.statusLine - 4;
  process.stdout.write(`\x1b7\x1b[${daemonLine};${layout.statusCol}H\x1b[K${ANSI.magenta}${text}${ANSI.reset}\x1b8`);
}
