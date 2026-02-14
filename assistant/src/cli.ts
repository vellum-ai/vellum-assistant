import * as net from 'node:net';
import * as readline from 'node:readline';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getSocketPath, getHistoryPath } from './util/platform.js';
import {
  serialize,
  createMessageParser,
  type ClientMessage,
  type ConfirmationRequest,
  type ServerMessage,
} from './daemon/ipc-protocol.js';
import { Spinner } from './util/spinner.js';
import { copyToClipboard, extractLastCodeBlock, formatSessionForExport } from './util/clipboard.js';
import { ensureDaemonRunning } from './daemon/lifecycle.js';
import { shouldAutoStartDaemon } from './daemon/connection-policy.js';
import * as template from './lib/default-template.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 5;

export interface CliOptions {
  noSandbox?: boolean;
}

export { sanitizeUrlForDisplay } from './lib/default-template.js';

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


  const historyPath = getHistoryPath();
  const MAX_HISTORY = 1000;
  let savedHistory: string[] = [];
  try {
    savedHistory = readFileSync(historyPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-MAX_HISTORY)
      .reverse();
  } catch {
    // No history file yet — start fresh
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: savedHistory,
    historySize: MAX_HISTORY,
  });

  function prompt(): void {
    rl.setPrompt(template.PROMPT_STRING);
    rl.prompt();
  }

  function send(msg: ClientMessage): boolean {
    if (socket && !socket.destroyed) {
      socket.write(serialize(msg));
      return true;
    }
    return false;
  }


  function handleConfirmationPrompt(req: ConfirmationRequest): void {
    template.renderConfirmationPrompt(req, process.stdout);

    pendingConfirmation = true;
    rl.once('line', (answer) => {
      const trimmed = answer.trim();
      const choice = trimmed.toLowerCase();

      if (trimmed === 'A' || choice === 'allowlist') {
        handlePatternSelection(req, 'always_allow');
        return;
      }

      if (trimmed === 'D' || choice === 'denylist') {
        handlePatternSelection(req, 'always_deny');
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

      send({
        type: 'confirmation_response',
        requestId: req.requestId,
        decision: 'deny',
      });
    });
  }

  function handlePatternSelection(req: ConfirmationRequest, decision: 'always_allow' | 'always_deny'): void {
    template.renderPatternSelection(req.allowlistOptions, decision, process.stdout);

    rl.once('line', (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < req.allowlistOptions.length) {
        const selectedPattern = req.allowlistOptions[idx].pattern;
        handleScopeSelection(req, selectedPattern, decision);
      } else {
        pendingConfirmation = false;
        send({
          type: 'confirmation_response',
          requestId: req.requestId,
          decision: 'deny',
        });
      }
    });
  }

  function handleScopeSelection(req: ConfirmationRequest, selectedPattern: string, decision: 'always_allow' | 'always_deny'): void {
    template.renderScopeSelection(req.scopeOptions, decision, process.stdout);

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
        send({
          type: 'confirmation_response',
          requestId: req.requestId,
          decision: 'deny',
        });
      }
    });
  }

  function handleSessionPicker(sessions: Array<{ id: string; title: string; updatedAt: number }>): void {
    template.renderSessionPicker(sessions, process.stdout);

    rl.once('line', (answer) => {
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'n') {
        send({ type: 'session_create' });
        return;
      }
      const idx = parseInt(trimmed, 10) - 1;
      if (idx >= 0 && idx < sessions.length) {
        if (sessions[idx].id === sessionId) {
          pendingSessionPick = false;
          template.renderSessionInfo(sessions[idx].title, process.stdout);
          prompt();
        } else {
          send({ type: 'session_switch', sessionId: sessions[idx].id });
        }
      } else {
        process.stdout.write('  Invalid selection.\n');
        handleSessionPicker(sessions);
      }
    });
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'session_info':
        pendingSessionPick = false;
        sessionId = msg.sessionId;
        template.renderSessionInfo(msg.title, process.stdout);
        prompt();
        break;

      case 'assistant_text_delta':
        spinner.stop();
        lastResponse += msg.text;
        template.renderAssistantText(msg.text, process.stdout);
        break;

      case 'assistant_thinking_delta':
        spinner.stop();
        template.renderThinking(msg.thinking, process.stdout);
        break;

      case 'usage_update':
        lastUsage = msg;
        break;

      case 'context_compacted':
        spinner.stop();
        template.renderContextCompacted(msg, process.stdout);
        spinner.start('Thinking...');
        break;

      case 'memory_status':
        if (msg.degraded) {
          spinner.stop();
          template.renderMemoryDegraded(msg.reason, process.stdout);
          spinner.start('Thinking...');
        }
        break;

      case 'memory_recalled':
        spinner.stop();
        template.renderMemoryRecalled(msg, process.stdout);
        spinner.start('Thinking...');
        break;

      case 'message_complete':
        spinner.stop();
        generating = false;
        template.renderMessageComplete(lastUsage, process.stdout);
        lastUsage = null;
        prompt();
        break;

      case 'generation_handoff':
        spinner.stop();
        generating = false;
        template.renderMessageComplete(lastUsage, process.stdout);
        lastUsage = null;
        prompt();
        break;

      case 'generation_cancelled':
        spinner.stop();
        generating = false;
        lastUsage = null;
        template.renderGenerationCancelled(process.stdout);
        prompt();
        break;

      case 'tool_use_start':
        toolStreaming = false;
        spinner.start(template.formatToolProgress(msg.toolName, msg.input));
        break;

      case 'tool_output_chunk':
        if (!toolStreaming) {
          spinner.stop();
          toolStreaming = true;
        }
        template.renderAssistantText(msg.chunk, process.stdout);
        break;

      case 'tool_result':
        if (!toolStreaming) spinner.stop();
        template.renderToolResult(msg.result, toolStreaming, msg.diff, msg.status, process.stdout);
        toolStreaming = false;
        spinner.start('Thinking...');
        break;

      case 'confirmation_request':
        spinner.stop();
        handleConfirmationPrompt(msg);
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
        template.renderError(msg.message, process.stdout);
        prompt();
        break;

      case 'secret_detected': {
        const wasSpinning = spinner.isSpinning;
        spinner.stop();
        template.renderSecretDetected(msg, process.stdout);
        if (wasSpinning) spinner.start('Thinking...');
        break;
      }

      case 'session_list_response':
        if (pendingSessionPick) {
          handleSessionPicker(msg.sessions);
        } else {
          for (const session of msg.sessions) {
            process.stdout.write(`  ${session.id}  ${session.title}\n`);
          }
          prompt();
        }
        break;

      case 'model_info':
        template.renderModelInfo(msg.model, msg.provider, process.stdout);
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
        template.renderHistoryMessages(msg.messages, process.stdout);
        prompt();
        break;

      case 'undo_complete':
        if (msg.removedCount > 0) {
          lastResponse = '';
        }
        template.renderUndoComplete(msg.removedCount, process.stdout);
        prompt();
        break;

      case 'usage_response':
        template.renderUsageResponse(msg, process.stdout);
        prompt();
        break;

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

    // Persist to history file (ensure parent directory exists)
    try {
      mkdirSync(dirname(historyPath), { recursive: true });
      appendFileSync(historyPath, content + '\n');
    } catch { /* ignore */ }

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
      template.renderSlashCommandHelp(process.stdout);
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
