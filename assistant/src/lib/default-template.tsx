import type {
  ConfirmationRequest,
  SecretDetected,
  ContextCompacted,
  MemoryRecalled,
} from '../daemon/ipc-protocol.js';
import { formatDiff, formatNewFileDiff } from '../util/diff.js';
import { timeAgo } from '../util/time.js';

export interface TerminalWriter {
  write(text: string): void;
}

export const PROMPT_STRING = 'you> ';

export function sanitizeUrlForDisplay(rawUrl: unknown): string {
  const value = typeof rawUrl === 'string' ? rawUrl : String(rawUrl ?? '');
  if (!value) return '';

  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) {
      return value;
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return value.replace(/\/\/([^/?#\s@]+)@/g, '//[REDACTED]@');
  }
}

export function formatToolProgress(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'bash':
      return `Running \`${String(input.command ?? '').slice(0, 60)}\`...`;
    case 'file_read':
      return `Reading ${input.path ?? ''}...`;
    case 'file_write':
      return `Writing ${input.path ?? ''}...`;
    case 'file_edit':
      return `Editing ${input.path ?? ''}...`;
    case 'web_fetch':
      return `Fetching ${sanitizeUrlForDisplay(input.url).slice(0, 80)}...`;
    case 'browser_navigate':
      return `Navigating to ${sanitizeUrlForDisplay(input.url).slice(0, 80)}...`;
    case 'browser_snapshot':
      return 'Taking page snapshot...';
    case 'browser_close':
      return 'Closing browser...';
    case 'browser_click':
      return `Clicking ${String(input.element_id ?? input.selector ?? '').slice(0, 60)}...`;
    case 'browser_type':
      return `Typing into ${String(input.element_id ?? input.selector ?? '').slice(0, 60)}...`;
    case 'browser_press_key':
      return `Pressing "${String(input.key ?? '')}"...`;
    case 'browser_wait_for':
      if (input.selector) return `Waiting for ${String(input.selector).slice(0, 60)}...`;
      if (input.text) return `Waiting for text "${String(input.text).slice(0, 40)}"...`;
      return `Waiting ${input.duration ?? 0}ms...`;
    case 'browser_extract':
      return 'Extracting page content...';
    default:
      return `Running ${toolName}...`;
  }
}

export function formatCommandPreview(req: ConfirmationRequest): string {
  if (req.toolName === 'bash') {
    return String(req.input.command ?? '');
  }
  if (req.toolName === 'file_read') {
    return `read ${req.input.path ?? ''}`;
  }
  if (req.toolName === 'file_write') {
    return `write ${req.input.path ?? ''}`;
  }
  if (req.toolName === 'web_fetch') {
    return `fetch ${sanitizeUrlForDisplay(req.input.url ?? '')}`;
  }
  if (req.toolName === 'browser_navigate') {
    return `navigate ${sanitizeUrlForDisplay(req.input.url ?? '')}`;
  }
  if (req.toolName === 'browser_close') {
    return req.input.close_all_pages ? 'close all browser pages' : 'close browser page';
  }
  if (req.toolName === 'browser_click') {
    return `click ${req.input.element_id ?? req.input.selector ?? ''}`;
  }
  if (req.toolName === 'browser_type') {
    return `type into ${req.input.element_id ?? req.input.selector ?? ''}`;
  }
  if (req.toolName === 'browser_press_key') {
    return `press "${req.input.key ?? ''}"`;
  }
  return `${req.toolName}: ${JSON.stringify(req.input).slice(0, 80)}`;
}

export function renderSessionInfo(title: string, w: TerminalWriter): void {
  w.write(`\n  Session: ${title}\n  Type your message. Ctrl+D to detach.\n\n`);
}

export function renderAssistantText(text: string, w: TerminalWriter): void {
  w.write(text);
}

export function renderThinking(thinking: string, w: TerminalWriter): void {
  w.write(`\x1B[2m${thinking}\x1B[0m`);
}

export function renderContextCompacted(msg: ContextCompacted, w: TerminalWriter): void {
  const summaryOverhead = msg.summaryCalls > 0
    ? ` | summary: ${msg.summaryCalls} call${msg.summaryCalls === 1 ? '' : 's'}`
    : '';
  w.write(
    `\n\x1B[2m[Context compacted: ${msg.previousEstimatedInputTokens.toLocaleString()} -> ${msg.estimatedInputTokens.toLocaleString()} est input tokens, ${msg.compactedMessages} messages${summaryOverhead}]\x1B[0m\n`,
  );
}

export function renderMemoryDegraded(reason: string | undefined, w: TerminalWriter): void {
  w.write(`\n\x1B[2m[Memory degraded: ${reason ?? 'unknown'}]\x1B[0m\n`);
}

export function renderMemoryRecalled(msg: MemoryRecalled, w: TerminalWriter): void {
  w.write(
    `\n\x1B[2m[Memory recalled: ${msg.injectedTokens} tokens | lexical ${msg.lexicalHits} | semantic ${msg.semanticHits} | recency ${msg.recencyHits} | entity ${msg.entityHits} | merged ${msg.mergedCount} → selected ${msg.selectedCount}${msg.rerankApplied ? ' (reranked)' : ''} | ${msg.provider}/${msg.model} | ${msg.latencyMs}ms]\x1B[0m\n`,
  );
}

export function renderMessageComplete(
  usage: { inputTokens: number; outputTokens: number; estimatedCost: number; model: string } | null,
  w: TerminalWriter,
): void {
  if (usage) {
    const cost = usage.estimatedCost > 0
      ? ` ~$${usage.estimatedCost.toFixed(4)}`
      : '';
    w.write(
      `\n\n\x1B[2m[${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out${cost}]\x1B[0m\n\n`,
    );
  } else {
    w.write('\n\n');
  }
}

export function renderGenerationCancelled(w: TerminalWriter): void {
  w.write('\n[Cancelled]\n\n');
}

export function renderToolResult(
  result: string,
  toolStreaming: boolean,
  diff: { filePath: string; oldContent: string; newContent: string; isNewFile: boolean } | undefined,
  status: string | undefined,
  w: TerminalWriter,
): void {
  if (toolStreaming) {
    if (status) {
      w.write(`\n${status}`);
    }
    w.write('\n');
  } else {
    w.write(`\n[Tool: ${result.slice(0, 200)}]\n`);
  }
  if (diff) {
    const diffOutput = diff.isNewFile
      ? formatNewFileDiff(diff.newContent, diff.filePath)
      : formatDiff(diff.oldContent, diff.newContent, diff.filePath);
    if (diffOutput) {
      w.write(diffOutput);
    }
  }
}

export function renderConfirmationPrompt(req: ConfirmationRequest, w: TerminalWriter): void {
  const preview = formatCommandPreview(req);
  w.write('\n');
  w.write(`\u250C ${req.toolName}: ${preview}\n`);
  w.write(`\u2502 Risk: ${req.riskLevel}${req.sandboxed ? '  [sandboxed]' : ''}\n`);
  if (req.diff) {
    const diffOutput = req.diff.isNewFile
      ? formatNewFileDiff(req.diff.newContent, req.diff.filePath)
      : formatDiff(req.diff.oldContent, req.diff.newContent, req.diff.filePath);
    if (diffOutput) {
      w.write(`\u2502\n`);
      for (const line of diffOutput.split('\n')) {
        if (line) w.write(`\u2502 ${line}\n`);
      }
    }
  }
  w.write(`\u2502\n`);
  w.write(`\u2502 [a] Allow once\n`);
  w.write(`\u2502 [d] Deny once\n`);
  if (req.allowlistOptions.length > 0) {
    w.write(`\u2502 [A] Allowlist...\n`);
    w.write(`\u2502 [D] Denylist...\n`);
  }
  w.write(`\u2514 > `);
}

export function renderPatternSelection(
  options: Array<{ label: string }>,
  decision: 'always_allow' | 'always_deny',
  w: TerminalWriter,
): void {
  const label = decision === 'always_allow' ? 'Allowlist' : 'Denylist';
  w.write('\n');
  w.write(`\u250C ${label}: choose command pattern\n`);
  for (let i = 0; i < options.length; i++) {
    w.write(`\u2502 [${i + 1}] ${options[i].label}\n`);
  }
  w.write(`\u2514 > `);
}

export function renderScopeSelection(
  options: Array<{ label: string }>,
  decision: 'always_allow' | 'always_deny',
  w: TerminalWriter,
): void {
  const label = decision === 'always_allow' ? 'Allowlist' : 'Denylist';
  w.write('\n');
  w.write(`\u250C ${label}: choose scope\n`);
  for (let i = 0; i < options.length; i++) {
    w.write(`\u2502 [${i + 1}] ${options[i].label}\n`);
  }
  w.write(`\u2514 > `);
}

export function renderSessionPicker(
  sessions: Array<{ id: string; title: string; updatedAt: number }>,
  w: TerminalWriter,
): void {
  w.write('\n  Recent sessions:\n');
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const ago = timeAgo(s.updatedAt);
    const title = s.title.length > 50 ? s.title.slice(0, 47) + '...' : s.title;
    const padding = ' '.repeat(Math.max(1, 55 - title.length));
    w.write(`  [${i + 1}] ${title}${padding}${ago}\n`);
  }
  w.write('  [n] New session\n\n');
  w.write('  Pick a session> ');
}

export function renderError(message: string, w: TerminalWriter): void {
  w.write(`\n[Error: ${message}]\n`);
}

export function renderSecretDetected(msg: SecretDetected, w: TerminalWriter): void {
  const actionLabel = msg.action === 'redact' ? 'redacted' : msg.action === 'block' ? 'blocked' : 'detected';
  const types = msg.matches.map((m) => m.type).join(', ');
  w.write(`\n  ⚠ Secret ${actionLabel} in ${msg.toolName} output: ${types}\n`);
  for (const match of msg.matches) {
    w.write(`    • ${match.type}: ${match.redactedValue}\n`);
  }
  w.write('\n');
}

export function renderModelInfo(model: string, provider: string, w: TerminalWriter): void {
  w.write(`\n  Model: ${model} (${provider})\n\n`);
}

export function renderHistoryMessages(
  messages: Array<{ role: string; text: string }>,
  w: TerminalWriter,
): void {
  w.write('\n');
  if (messages.length === 0) {
    w.write('  No messages in this session.\n');
  } else {
    for (const m of messages) {
      const label = m.role === 'user' ? 'you' : 'assistant';
      const preview = m.text.length > 120 ? m.text.slice(0, 117) + '...' : m.text;
      w.write(`  ${label}> ${preview.replace(/\n/g, ' ')}\n`);
    }
  }
  w.write('\n');
}

export function renderUndoComplete(removedCount: number, w: TerminalWriter): void {
  if (removedCount === 0) {
    w.write('\n  Nothing to undo.\n\n');
  } else {
    w.write(`\n  Removed last exchange (${removedCount} messages).\n\n`);
  }
}

export function renderUsageResponse(
  msg: { totalInputTokens: number; totalOutputTokens: number; estimatedCost: number; model: string },
  w: TerminalWriter,
): void {
  w.write('\n');
  w.write(`  Model:          ${msg.model}\n`);
  w.write(`  Input tokens:   ${msg.totalInputTokens.toLocaleString()}\n`);
  w.write(`  Output tokens:  ${msg.totalOutputTokens.toLocaleString()}\n`);
  const costStr = msg.estimatedCost > 0
    ? `$${msg.estimatedCost.toFixed(4)}`
    : 'N/A (unknown model pricing)';
  w.write(`  Estimated cost: ${costStr}\n`);
  w.write('\n');
}

export function renderSlashCommandHelp(w: TerminalWriter): void {
  w.write('\n  Available commands:\n');
  w.write('  /new              Start a new session\n');
  w.write('  /sessions         Switch between sessions\n');
  w.write('  /clear            Clear the screen\n');
  w.write('  /model [name]     Show or change the model\n');
  w.write('  /history          Show conversation history\n');
  w.write('  /undo             Remove last message exchange\n');
  w.write('  /usage            Show token usage and cost\n');
  w.write('  /copy             Copy last response to clipboard\n');
  w.write('  /copy-code        Copy last code block to clipboard\n');
  w.write('  /copy-session     Copy entire session to clipboard\n');
  w.write('  /help             Show this help\n');
  w.write('\n');
}
