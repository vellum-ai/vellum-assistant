import * as net from 'node:net';
import * as readline from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
import { getSocketPath, getHistoryPath } from './util/platform.js';
import {
  serialize,
  createMessageParser,
  type ClientMessage,
  type ServerMessage,
  type ConfirmationRequest,
} from './daemon/ipc-protocol.js';
import { formatDiff, formatNewFileDiff } from './util/diff.js';
import { Spinner } from './util/spinner.js';
import { copyToClipboard, extractLastCodeBlock, formatSessionForExport } from './util/clipboard.js';
import { timeAgo } from './util/time.js';
import { ensureDaemonRunning } from './daemon/lifecycle.js';
import { shouldAutoStartDaemon } from './daemon/connection-policy.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 5;

export interface CliOptions {
  noSandbox?: boolean;
}

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

export async function startCli(options: CliOptions = {}): Promise<void> {
  const socketPath = getSocketPath();
  let socket: net.Socket;
  let parser = createMessageParser();
  let sessionId = '';
  let generating = false;
  let lastResponse = '';
  let lastUsage: { inputTokens: number; outputTokens: number; totalInputTokens: number; totalOutputTokens: number; estimatedCost: number; model: string } | null = null;
  let pendingSessionPick = false;
  let pendingConfirmation = false;
  let pendingCopySession = false;
  let toolStreaming = false;
  let reconnecting = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  const spinner = new Spinner();

  function formatToolProgress(toolName: string, input: Record<string, unknown>): string {
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

  const historyPath = getHistoryPath();
  let savedHistory: string[] = [];
  try {
    savedHistory = readFileSync(historyPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .reverse();
  } catch {
    // No history file yet — start fresh
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: savedHistory,
    historySize: 1000,
  });

  function prompt(): void {
    rl.setPrompt('you> ');
    rl.prompt();
  }

  function send(msg: ClientMessage): boolean {
    if (socket && !socket.destroyed) {
      socket.write(serialize(msg));
      return true;
    }
    return false;
  }

  function formatCommandPreview(req: ConfirmationRequest): string {
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

  function renderConfirmationPrompt(req: ConfirmationRequest): void {
    const preview = formatCommandPreview(req);
    process.stdout.write('\n');
    process.stdout.write(`\u250C ${req.toolName}: ${preview}\n`);
    process.stdout.write(`\u2502 Risk: ${req.riskLevel}${req.sandboxed ? '  [sandboxed]' : ''}\n`);
    if (req.diff) {
      const diffOutput = req.diff.isNewFile
        ? formatNewFileDiff(req.diff.newContent, req.diff.filePath)
        : formatDiff(req.diff.oldContent, req.diff.newContent, req.diff.filePath);
      if (diffOutput) {
        process.stdout.write(`\u2502\n`);
        for (const line of diffOutput.split('\n')) {
          if (line) process.stdout.write(`\u2502 ${line}\n`);
        }
      }
    }
    process.stdout.write(`\u2502\n`);
    process.stdout.write(`\u2502 [a] Allow once\n`);
    process.stdout.write(`\u2502 [d] Deny once\n`);
    if (req.allowlistOptions.length > 0) {
      process.stdout.write(`\u2502 [A] Allowlist...\n`);
      process.stdout.write(`\u2502 [D] Denylist...\n`);
    }
    process.stdout.write(`\u2514 > `);

    pendingConfirmation = true;
    rl.once('line', (answer) => {
      const trimmed = answer.trim();
      const choice = trimmed.toLowerCase();

      // Uppercase 'A' → allowlist pattern selection (check before lowercase 'a')
      if (trimmed === 'A' || choice === 'allowlist') {
        // pendingConfirmation stays true through sub-prompts
        renderPatternSelection(req, 'always_allow');
        return;
      }

      // Uppercase 'D' → denylist pattern selection (check before lowercase 'd')
      if (trimmed === 'D' || choice === 'denylist') {
        // pendingConfirmation stays true through sub-prompts
        renderPatternSelection(req, 'always_deny');
        return;
      }

      pendingConfirmation = false;
      if (choice === 'a') {
        send({
          type: 'confirmation_response',
          requestId: req.requestId,
          decision: 'allow',
        });
        return;
      }

      if (choice === 'd') {
        send({
          type: 'confirmation_response',
          requestId: req.requestId,
          decision: 'deny',
        });
        return;
      }

      // Default to deny for unrecognized input
      send({
        type: 'confirmation_response',
        requestId: req.requestId,
        decision: 'deny',
      });
    });
  }

  function renderPatternSelection(req: ConfirmationRequest, decision: 'always_allow' | 'always_deny'): void {
    const label = decision === 'always_allow' ? 'Allowlist' : 'Denylist';
    process.stdout.write('\n');
    process.stdout.write(`\u250C ${label}: choose command pattern\n`);
    for (let i = 0; i < req.allowlistOptions.length; i++) {
      process.stdout.write(`\u2502 [${i + 1}] ${req.allowlistOptions[i].label}\n`);
    }
    process.stdout.write(`\u2514 > `);

    rl.once('line', (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < req.allowlistOptions.length) {
        const selectedPattern = req.allowlistOptions[idx].pattern;
        // pendingConfirmation stays true through scope selection
        renderScopeSelection(req, selectedPattern, decision);
      } else {
        // Invalid selection → deny
        pendingConfirmation = false;
        send({
          type: 'confirmation_response',
          requestId: req.requestId,
          decision: 'deny',
        });
      }
    });
  }

  function renderScopeSelection(req: ConfirmationRequest, selectedPattern: string, decision: 'always_allow' | 'always_deny'): void {
    const label = decision === 'always_allow' ? 'Allowlist' : 'Denylist';
    process.stdout.write('\n');
    process.stdout.write(`\u250C ${label}: choose scope\n`);
    for (let i = 0; i < req.scopeOptions.length; i++) {
      process.stdout.write(`\u2502 [${i + 1}] ${req.scopeOptions[i].label}\n`);
    }
    process.stdout.write(`\u2514 > `);

    rl.once('line', (answer) => {
      pendingConfirmation = false;
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < req.scopeOptions.length) {
        send({
          type: 'confirmation_response',
          requestId: req.requestId,
          decision,
          selectedPattern,
          selectedScope: req.scopeOptions[idx].scope,
        });
      } else {
        // Invalid selection → deny
        send({
          type: 'confirmation_response',
          requestId: req.requestId,
          decision: 'deny',
        });
      }
    });
  }

  function renderSessionPicker(sessions: Array<{ id: string; title: string; updatedAt: number }>): void {
    process.stdout.write('\n  Recent sessions:\n');
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const ago = timeAgo(s.updatedAt);
      const title = s.title.length > 50 ? s.title.slice(0, 47) + '...' : s.title;
      const padding = ' '.repeat(Math.max(1, 55 - title.length));
      process.stdout.write(`  [${i + 1}] ${title}${padding}${ago}\n`);
    }
    process.stdout.write('  [n] New session\n\n');
    process.stdout.write('  Pick a session> ');

    rl.once('line', (answer) => {
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'n') {
        send({ type: 'session_create' });
        return;
      }
      const idx = parseInt(trimmed, 10) - 1;
      if (idx >= 0 && idx < sessions.length) {
        if (sessions[idx].id === sessionId) {
          // Already on this session
          pendingSessionPick = false;
          process.stdout.write(
            `\n  Session: ${sessions[idx].title}\n  Type your message. Ctrl+D to detach.\n\n`,
          );
          prompt();
        } else {
          send({ type: 'session_switch', sessionId: sessions[idx].id });
        }
      } else {
        process.stdout.write('  Invalid selection.\n');
        renderSessionPicker(sessions);
      }
    });
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'session_info':
        pendingSessionPick = false;
        sessionId = msg.sessionId;
        process.stdout.write(
          `\n  Session: ${msg.title}\n  Type your message. Ctrl+D to detach.\n\n`,
        );
        prompt();
        break;

      case 'assistant_text_delta':
        spinner.stop();
        lastResponse += msg.text;
        process.stdout.write(msg.text);
        break;

      case 'assistant_thinking_delta':
        spinner.stop();
        process.stdout.write(`\x1B[2m${msg.thinking}\x1B[0m`);
        break;

      case 'usage_update':
        lastUsage = msg;
        break;

      case 'context_compacted': {
        spinner.stop();
        const summaryOverhead = msg.summaryCalls > 0
          ? ` | summary: ${msg.summaryCalls} call${msg.summaryCalls === 1 ? '' : 's'}`
          : '';
        process.stdout.write(
          `\n\x1B[2m[Context compacted: ${msg.previousEstimatedInputTokens.toLocaleString()} -> ${msg.estimatedInputTokens.toLocaleString()} est input tokens, ${msg.compactedMessages} messages${summaryOverhead}]\x1B[0m\n`,
        );
        spinner.start('Thinking...');
        break;
      }

      case 'memory_status':
        if (msg.degraded) {
          spinner.stop();
          process.stdout.write(`\n\x1B[2m[Memory degraded: ${msg.reason ?? 'unknown'}]\x1B[0m\n`);
          spinner.start('Thinking...');
        }
        break;

      case 'memory_recalled':
        spinner.stop();
        process.stdout.write(
          `\n\x1B[2m[Memory recalled: ${msg.injectedTokens} tokens | lexical ${msg.lexicalHits} | semantic ${msg.semanticHits} | recency ${msg.recencyHits} | ${msg.provider}/${msg.model} | ${msg.latencyMs}ms]\x1B[0m\n`,
        );
        spinner.start('Thinking...');
        break;

      case 'message_complete': {
        spinner.stop();
        generating = false;
        if (lastUsage) {
          const cost = lastUsage.estimatedCost > 0
            ? ` ~$${lastUsage.estimatedCost.toFixed(4)}`
            : '';
          process.stdout.write(
            `\n\n\x1B[2m[${lastUsage.inputTokens.toLocaleString()} in / ${lastUsage.outputTokens.toLocaleString()} out${cost}]\x1B[0m\n\n`,
          );
          lastUsage = null;
        } else {
          process.stdout.write('\n\n');
        }
        prompt();
        break;
      }

      case 'generation_handoff': {
        // Treat handoff the same as message_complete from the CLI's perspective:
        // the generation for the current request is done.
        spinner.stop();
        generating = false;
        if (lastUsage) {
          const cost = lastUsage.estimatedCost > 0
            ? ` ~$${lastUsage.estimatedCost.toFixed(4)}`
            : '';
          process.stdout.write(
            `\n\n\x1B[2m[${lastUsage.inputTokens.toLocaleString()} in / ${lastUsage.outputTokens.toLocaleString()} out${cost}]\x1B[0m\n\n`,
          );
          lastUsage = null;
        } else {
          process.stdout.write('\n\n');
        }
        prompt();
        break;
      }

      case 'generation_cancelled':
        spinner.stop();
        generating = false;
        lastUsage = null;
        process.stdout.write('\n[Cancelled]\n\n');
        prompt();
        break;

      case 'tool_use_start':
        toolStreaming = false;
        spinner.start(formatToolProgress(msg.toolName, msg.input));
        break;

      case 'tool_output_chunk':
        if (!toolStreaming) {
          spinner.stop();
          toolStreaming = true;
        }
        process.stdout.write(msg.chunk);
        break;

      case 'tool_result':
        if (!toolStreaming) spinner.stop();
        if (toolStreaming) {
          if (msg.status) {
            process.stdout.write(`\n${msg.status}`);
          }
          process.stdout.write('\n');
        } else {
          process.stdout.write(`\n[Tool: ${msg.result.slice(0, 200)}]\n`);
        }
        toolStreaming = false;
        if (msg.diff) {
          const diffOutput = msg.diff.isNewFile
            ? formatNewFileDiff(msg.diff.newContent, msg.diff.filePath)
            : formatDiff(msg.diff.oldContent, msg.diff.newContent, msg.diff.filePath);
          if (diffOutput) {
            process.stdout.write(diffOutput);
          }
        }
        spinner.start('Thinking...');
        break;

      case 'confirmation_request':
        spinner.stop();
        renderConfirmationPrompt(msg);
        break;

      case 'error':
        spinner.stop();
        generating = false;
        if (pendingConfirmation || pendingSessionPick || pendingCopySession) {
          pendingConfirmation = false;
          pendingSessionPick = false;
          pendingCopySession = false;
          rl.removeAllListeners('line');
          rl.on('line', handleLine);
        }
        process.stdout.write(`\n[Error: ${msg.message}]\n`);
        prompt();
        break;

      case 'secret_detected': {
        const wasSpinning = spinner.isSpinning;
        spinner.stop();
        const types = msg.matches.map((m) => m.type).join(', ');
        const actionLabel = msg.action === 'redact' ? 'redacted' : msg.action === 'block' ? 'blocked' : 'detected';
        process.stdout.write(`\n  ⚠ Secret ${actionLabel} in ${msg.toolName} output: ${types}\n`);
        for (const match of msg.matches) {
          process.stdout.write(`    • ${match.type}: ${match.redactedValue}\n`);
        }
        process.stdout.write('\n');
        if (wasSpinning) spinner.start('Thinking...');
        break;
      }

      case 'session_list_response':
        if (pendingSessionPick) {
          renderSessionPicker(msg.sessions);
        } else {
          for (const session of msg.sessions) {
            process.stdout.write(`  ${session.id}  ${session.title}\n`);
          }
          prompt();
        }
        break;

      case 'model_info':
        process.stdout.write(`\n  Model: ${msg.model} (${msg.provider})\n\n`);
        prompt();
        break;

      case 'history_response':
        if (pendingCopySession) {
          pendingCopySession = false;
          if (msg.messages.length === 0) {
            process.stdout.write('\n  No messages to copy.\n\n');
          } else {
            try {
              const formatted = formatSessionForExport(msg.messages);
              copyToClipboard(formatted);
              process.stdout.write(`\n  Copied session (${msg.messages.length} messages) to clipboard.\n\n`);
            } catch (err) {
              process.stdout.write(`\n  Clipboard error: ${(err as Error).message}\n\n`);
            }
          }
          prompt();
          break;
        }
        process.stdout.write('\n');
        if (msg.messages.length === 0) {
          process.stdout.write('  No messages in this session.\n');
        } else {
          for (const m of msg.messages) {
            const label = m.role === 'user' ? 'you' : 'assistant';
            const preview = m.text.length > 120 ? m.text.slice(0, 117) + '...' : m.text;
            process.stdout.write(`  ${label}> ${preview.replace(/\n/g, ' ')}\n`);
          }
        }
        process.stdout.write('\n');
        prompt();
        break;

      case 'undo_complete':
        if (msg.removedCount === 0) {
          process.stdout.write('\n  Nothing to undo.\n\n');
        } else {
          lastResponse = '';
          process.stdout.write(`\n  Removed last exchange (${msg.removedCount} messages).\n\n`);
        }
        prompt();
        break;

      case 'usage_response': {
        process.stdout.write('\n');
        process.stdout.write(`  Model:          ${msg.model}\n`);
        process.stdout.write(`  Input tokens:   ${msg.totalInputTokens.toLocaleString()}\n`);
        process.stdout.write(`  Output tokens:  ${msg.totalOutputTokens.toLocaleString()}\n`);
        const costStr = msg.estimatedCost > 0
          ? `$${msg.estimatedCost.toFixed(4)}`
          : 'N/A (unknown model pricing)';
        process.stdout.write(`  Estimated cost: ${costStr}\n`);
        process.stdout.write('\n');
        prompt();
        break;
      }

      case 'pong':
        // Heartbeat response — clear the timeout
        if (heartbeatTimeout) {
          clearTimeout(heartbeatTimeout);
          heartbeatTimeout = null;
        }
        break;
    }
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (heartbeatTimeout) {
      clearTimeout(heartbeatTimeout);
      heartbeatTimeout = null;
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket.destroyed) return;
      send({ type: 'ping' });
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
      }
      heartbeatTimeout = setTimeout(() => {
        // No pong received — daemon is unresponsive, trigger reconnect
        socket.destroy();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  async function reconnect(): Promise<void> {
    if (reconnecting) return;
    reconnecting = true;
    stopHeartbeat();
    spinner.stop();

    // Reset generation state — any in-flight request is lost
    generating = false;
    toolStreaming = false;
    pendingSessionPick = false;
    pendingConfirmation = false;
    pendingCopySession = false;
    lastUsage = null;

    // Remove stale rl.once('line') handlers from confirmation/selection prompts
    // and re-register the main line handler
    rl.removeAllListeners('line');
    rl.on('line', handleLine);

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      process.stdout.write(`\n  Reconnecting to daemon (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})...\n`);
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));

      try {
        if (shouldAutoStartDaemon()) await ensureDaemonRunning();
        await connect();
        if (options.noSandbox) {
          send({ type: 'sandbox_set', enabled: false });
        }
        reconnecting = false;
        return;
      } catch {
        // Will retry
      }
    }

    process.stderr.write('\n  Failed to reconnect after multiple attempts.\n  Check that the daemon is running (vellum daemon start) and the socket at ~/.vellum/vellum.sock is accessible.\n');
    reconnecting = false;
    process.exit(1);
  }

  function connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      parser = createMessageParser();
      const newSocket = net.createConnection(socketPath);
      let connected = false;

      newSocket.on('connect', () => {
        connected = true;
        socket = newSocket;
        startHeartbeat();
        resolve();
      });

      newSocket.on('data', (data) => {
        const messages = parser.feed(data.toString()) as ServerMessage[];
        for (const msg of messages) {
          handleMessage(msg);
        }
      });

      newSocket.on('close', () => {
        stopHeartbeat();
        if (!connected) return; // handled by 'error'
        // Only auto-reconnect if we're not intentionally exiting
        if (!reconnecting) {
          reconnect();
        }
      });

      newSocket.on('error', (err) => {
        stopHeartbeat();
        if (!connected) {
          reject(err);
          return;
        }
        // Connected socket error — will trigger 'close' → reconnect
      });
    });
  }

  function handleLine(line: string): void {
    const content = line.trim();
    if (!content) return;
    if (pendingSessionPick) return;
    if (pendingConfirmation) return;
    if (reconnecting) return;

    // Persist to history file
    try { appendFileSync(historyPath, content + '\n'); } catch { /* ignore */ }

    if (content === '/copy') {
      if (!lastResponse) {
        process.stdout.write('No response to copy.\n');
      } else {
        try {
          copyToClipboard(lastResponse);
          process.stdout.write('Copied to clipboard.\n');
        } catch (err) {
          process.stdout.write(`Clipboard error: ${(err as Error).message}\n`);
        }
      }
      prompt();
      return;
    }

    if (content === '/sessions') {
      pendingSessionPick = true;
      send({ type: 'session_list' });
      return;
    }

    if (content === '/copy-code') {
      const code = extractLastCodeBlock(lastResponse);
      if (code === null) {
        process.stdout.write('No code block found.\n');
      } else {
        try {
          copyToClipboard(code);
          process.stdout.write('Copied code block to clipboard.\n');
        } catch (err) {
          process.stdout.write(`Clipboard error: ${(err as Error).message}\n`);
        }
      }
      prompt();
      return;
    }

    if (content === '/copy-session') {
      if (!send({ type: 'history_request', sessionId })) {
        process.stdout.write('[Not connected — command not sent]\n');
        prompt();
        return;
      }
      pendingCopySession = true;
      return;
    }

    if (content === '/new') {
      send({ type: 'session_create' });
      return;
    }

    if (content === '/clear') {
      lastResponse = '';
      process.stdout.write('\x1B[2J\x1B[H');
      process.stdout.write('  Screen cleared.\n\n');
      prompt();
      return;
    }

    if (content === '/model' || content.startsWith('/model ')) {
      const modelArg = content.slice('/model'.length).trim();
      if (modelArg) {
        send({ type: 'model_set', model: modelArg });
      } else {
        send({ type: 'model_get' });
      }
      return;
    }

    if (content === '/history') {
      send({ type: 'history_request', sessionId });
      return;
    }

    if (content === '/undo') {
      send({ type: 'undo', sessionId });
      return;
    }

    if (content === '/usage') {
      send({ type: 'usage_request', sessionId });
      return;
    }

    if (content === '/help') {
      process.stdout.write('\n  Available commands:\n');
      process.stdout.write('  /new              Start a new session\n');
      process.stdout.write('  /sessions         Switch between sessions\n');
      process.stdout.write('  /clear            Clear the screen\n');
      process.stdout.write('  /model [name]     Show or change the model\n');
      process.stdout.write('  /history          Show conversation history\n');
      process.stdout.write('  /undo             Remove last message exchange\n');
      process.stdout.write('  /usage            Show token usage and cost\n');
      process.stdout.write('  /copy             Copy last response to clipboard\n');
      process.stdout.write('  /copy-code        Copy last code block to clipboard\n');
      process.stdout.write('  /copy-session     Copy entire session to clipboard\n');
      process.stdout.write('  /help             Show this help\n');
      process.stdout.write('\n');
      prompt();
      return;
    }

    lastResponse = '';
    if (!send({ type: 'user_message', sessionId, content })) {
      process.stdout.write('[Not connected — message not sent]\n');
      prompt();
      return;
    }
    generating = true;
    spinner.start('Thinking...');
  }

  rl.on('line', handleLine);

  rl.on('close', () => {
    stopHeartbeat();
    process.stdout.write('\nDetaching from vellum...\n');
    process.exit(0);
  });

  // Ctrl+C: cancel generation if in progress, otherwise detach
  process.on('SIGINT', () => {
    spinner.stop();
    if (generating) {
      send({ type: 'cancel' });
    } else {
      rl.close();
    }
  });

  // Initial connection
  await connect();

  // Send sandbox override if --no-sandbox was passed
  if (options.noSandbox) {
    send({ type: 'sandbox_set', enabled: false });
  }
}
