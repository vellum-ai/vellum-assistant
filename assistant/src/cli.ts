import * as net from 'node:net';
import * as readline from 'node:readline';
import { getSocketPath } from './util/platform.js';
import {
  serialize,
  createMessageParser,
  type ClientMessage,
  type ServerMessage,
  type ConfirmationRequest,
} from './daemon/ipc-protocol.js';
import { formatDiff, formatNewFileDiff } from './util/diff.js';
import { Spinner } from './util/spinner.js';
import { copyToClipboard, extractLastCodeBlock } from './util/clipboard.js';
import { timeAgo } from './util/time.js';

export async function startCli(): Promise<void> {
  const socketPath = getSocketPath();
  const socket = net.createConnection(socketPath);
  const parser = createMessageParser();
  let sessionId = '';
  let generating = false;
  let lastResponse = '';
  let pendingSessionPick = false;
  let pendingSessionList: Array<{ id: string; title: string; updatedAt: number }> = [];
  const spinner = new Spinner();

  function formatToolProgress(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'shell':
        return `Running \`${String(input.command ?? '').slice(0, 60)}\`...`;
      case 'file_read':
        return `Reading ${input.path ?? ''}...`;
      case 'file_write':
        return `Writing ${input.path ?? ''}...`;
      case 'file_edit':
        return `Editing ${input.path ?? ''}...`;
      default:
        return `Running ${toolName}...`;
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function prompt(): void {
    rl.setPrompt('you> ');
    rl.prompt();
  }

  function send(msg: ClientMessage): void {
    socket.write(serialize(msg));
  }

  function formatCommandPreview(req: ConfirmationRequest): string {
    if (req.toolName === 'shell') {
      return String(req.input.command ?? '');
    }
    if (req.toolName === 'file_read') {
      return `read ${req.input.path ?? ''}`;
    }
    if (req.toolName === 'file_write') {
      return `write ${req.input.path ?? ''}`;
    }
    return `${req.toolName}: ${JSON.stringify(req.input).slice(0, 80)}`;
  }

  function renderConfirmationPrompt(req: ConfirmationRequest): void {
    const preview = formatCommandPreview(req);
    process.stdout.write('\n');
    process.stdout.write(`\u250C ${req.toolName}: ${preview}\n`);
    process.stdout.write(`\u2502 Risk: ${req.riskLevel}\n`);
    process.stdout.write(`\u2502\n`);
    process.stdout.write(`\u2502 [a] Allow once\n`);
    process.stdout.write(`\u2502 [d] Deny once\n`);
    if (req.allowlistOptions.length > 0) {
      process.stdout.write(`\u2502 [A] Allowlist...\n`);
      process.stdout.write(`\u2502 [D] Denylist...\n`);
    }
    process.stdout.write(`\u2514 > `);

    rl.once('line', (answer) => {
      const trimmed = answer.trim();
      const choice = trimmed.toLowerCase();

      // Uppercase 'A' → allowlist pattern selection (check before lowercase 'a')
      if (trimmed === 'A' || choice === 'allowlist') {
        renderPatternSelection(req, 'always_allow');
        return;
      }

      // Uppercase 'D' → denylist pattern selection (check before lowercase 'd')
      if (trimmed === 'D' || choice === 'denylist') {
        renderPatternSelection(req, 'always_deny');
        return;
      }

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
        renderScopeSelection(req, selectedPattern, decision);
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

  function renderScopeSelection(req: ConfirmationRequest, selectedPattern: string, decision: 'always_allow' | 'always_deny'): void {
    const label = decision === 'always_allow' ? 'Allowlist' : 'Denylist';
    process.stdout.write('\n');
    process.stdout.write(`\u250C ${label}: choose scope\n`);
    for (let i = 0; i < req.scopeOptions.length; i++) {
      process.stdout.write(`\u2502 [${i + 1}] ${req.scopeOptions[i].label}\n`);
    }
    process.stdout.write(`\u2514 > `);

    rl.once('line', (answer) => {
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

  socket.on('data', (data) => {
    const messages = parser.feed(data.toString()) as ServerMessage[];
    for (const msg of messages) {
      switch (msg.type) {
        case 'session_info':
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

        case 'message_complete':
          spinner.stop();
          generating = false;
          process.stdout.write('\n\n');
          prompt();
          break;

        case 'generation_cancelled':
          spinner.stop();
          generating = false;
          process.stdout.write('\n[Cancelled]\n\n');
          prompt();
          break;

        case 'tool_use_start':
          spinner.start(formatToolProgress(msg.toolName, msg.input));
          break;

        case 'tool_result':
          spinner.stop();
          process.stdout.write(`\n[Tool: ${msg.result.slice(0, 200)}]\n`);
          if (msg.diff) {
            const diffOutput = msg.diff.isNewFile
              ? formatNewFileDiff(msg.diff.newContent, msg.diff.filePath)
              : formatDiff(msg.diff.oldContent, msg.diff.newContent, msg.diff.filePath);
            if (diffOutput) {
              process.stdout.write(diffOutput);
            }
          }
          // Agent will call the LLM again after tool results
          spinner.start('Thinking...');
          break;

        case 'confirmation_request':
          spinner.stop();
          renderConfirmationPrompt(msg);
          break;

        case 'error':
          spinner.stop();
          generating = false;
          process.stdout.write(`\n[Error: ${msg.message}]\n`);
          prompt();
          break;

        case 'session_list_response':
          if (pendingSessionPick) {
            pendingSessionPick = false;
            pendingSessionList = msg.sessions;
            renderSessionPicker(msg.sessions);
          } else {
            for (const session of msg.sessions) {
              process.stdout.write(`  ${session.id}  ${session.title}\n`);
            }
            prompt();
          }
          break;

        case 'pong':
          break;
      }
    }
  });

  rl.on('line', (line) => {
    const content = line.trim();
    if (!content) return;

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
      if (!code) {
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

    lastResponse = '';
    generating = true;
    send({ type: 'user_message', sessionId, content });
    spinner.start('Thinking...');
  });

  rl.on('close', () => {
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

  socket.on('close', () => {
    process.stdout.write('\nDisconnected from daemon.\n');
    process.exit(1);
  });

  socket.on('error', (err) => {
    process.stderr.write(`Connection error: ${err.message}\n`);
    process.exit(1);
  });
}
