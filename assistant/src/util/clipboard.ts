import { execSync } from 'node:child_process';
import { isMacOS, isLinux } from './platform.js';
import { PlatformError } from './errors.js';

export function copyToClipboard(text: string): void {
  let cmd: string;
  if (isMacOS()) {
    cmd = 'pbcopy';
  } else if (isLinux()) {
    cmd = 'xclip -selection clipboard';
  } else {
    throw new PlatformError('Clipboard not supported on this platform');
  }
  execSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
}

export function formatSessionForExport(
  messages: Array<{ role: string; text: string }>,
): string {
  return messages
    .map((m) => {
      const label = m.role === 'user' ? 'you' : 'assistant';
      return `${label}> ${m.text}`;
    })
    .join('\n\n');
}

export function extractLastCodeBlock(text: string): string | null {
  const re = /```[^\n]*\n((?:[\s\S]*?\n)?)```/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m;
  }
  if (!last) return null;
  return last[1].trimEnd();
}
