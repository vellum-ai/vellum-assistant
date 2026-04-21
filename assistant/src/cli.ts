import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as readline from "node:readline";

import {
  type MainScreenLayout,
  renderMainScreen,
  updateDaemonText,
  updateStatusText,
} from "./cli/main-screen.jsx";
import { renderHistoryContent } from "./daemon/handlers/shared.js";
import type {
  ConfirmationRequest,
  ServerMessage,
} from "./daemon/message-protocol.js";
import { getConversation, getMessages } from "./memory/conversation-crud.js";
import {
  getConversationByKey,
  getOrCreateConversation,
  setConversationKeyIfAbsent,
} from "./memory/conversation-key-store.js";
import { listConversations } from "./memory/conversation-queries.js";
import {
  type EventStreamWatcher,
  watchEventStream,
} from "./signals/event-stream.js";
import { formatDiff, formatNewFileDiff } from "./util/diff.js";
import { getHistoryPath, getSignalsDir } from "./util/platform.js";
import { Spinner } from "./util/spinner.js";
import { timeAgo } from "./util/time.js";
import { truncate } from "./util/truncate.js";

/** Stable conversation key used by the built-in CLI. */
const CLI_CONVERSATION_KEY = "builtin-cli:default";

export function sanitizeUrlForDisplay(rawUrl: unknown): string {
  const value = typeof rawUrl === "string" ? rawUrl : String(rawUrl ?? "");
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) {
      return value;
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return value.replace(/\/\/([^/?#\s@]+)@/g, "//[REDACTED]@");
  }
}

function stringifyConfirmationInputValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value == null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatConfirmationInputLines(
  input: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(input).sort()) {
    const rawValue = input[key];
    const value =
      key.toLowerCase().includes("url") && typeof rawValue === "string"
        ? sanitizeUrlForDisplay(rawValue)
        : rawValue;
    const rendered = stringifyConfirmationInputValue(value);
    const renderedLines = rendered.split("\n");
    if (renderedLines.length === 0) {
      lines.push(`${key}:`);
      continue;
    }
    lines.push(`${key}: ${renderedLines[0]}`);
    for (const continuation of renderedLines.slice(1)) {
      lines.push(`  ${continuation}`);
    }
  }
  return lines;
}

export function formatConfirmationCommandPreview(
  req: Pick<ConfirmationRequest, "toolName" | "input">,
): string {
  if (req.toolName === "bash" || req.toolName === "host_bash") {
    return String(req.input.command ?? "");
  }
  if (req.toolName === "file_read" || req.toolName === "host_file_read") {
    return `read ${req.input.path ?? ""}`;
  }
  if (req.toolName === "file_write" || req.toolName === "host_file_write") {
    return `write ${req.input.path ?? ""}`;
  }
  if (req.toolName === "file_edit" || req.toolName === "host_file_edit") {
    return `edit ${req.input.path ?? ""}`;
  }
  if (req.toolName === "web_fetch") {
    return `fetch ${sanitizeUrlForDisplay(req.input.url ?? "")}`;
  }
  return req.toolName;
}

export async function startCli(): Promise<void> {
  let conversationKey = CLI_CONVERSATION_KEY;
  let conversationId = "";
  let pendingUserContent: string | null = null;
  let generating = false;
  let lastUsage: {
    inputTokens: number;
    outputTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCost: number;
    model: string;
  } | null = null;
  let pendingSessionPick = false;
  let toolStreaming = false;
  let lastDisplayedError: string | null = null;
  let eventSubscription: EventStreamWatcher | null = null;
  const spinner = new Spinner();

  process.stdout.write("\x1b[2J\x1b[H");
  let mainScreenLayout: MainScreenLayout = renderMainScreen();
  let canvasHeight = mainScreenLayout.height;
  const terminalRows = process.stdout.rows || 24;
  process.stdout.write(`\x1b[${canvasHeight + 1};${terminalRows}r`);
  process.stdout.write(`\x1b[${canvasHeight + 1};1H`);

  function formatToolProgress(
    toolName: string,
    input: Record<string, unknown>,
  ): string {
    switch (toolName) {
      case "bash":
        return `Running \`${String(input.command ?? "").slice(0, 60)}\`...`;
      case "file_read":
        return `Reading ${input.path ?? ""}...`;
      case "file_write":
        return `Writing ${input.path ?? ""}...`;
      case "file_edit":
        return `Editing ${input.path ?? ""}...`;
      case "web_fetch":
        return `Fetching ${sanitizeUrlForDisplay(input.url).slice(0, 80)}...`;
      default:
        return `Running ${toolName}...`;
    }
  }

  const historyPath = getHistoryPath();
  const MAX_HISTORY = 1000;
  let savedHistory: string[] = [];
  try {
    savedHistory = readFileSync(historyPath, "utf-8")
      .split("\n")
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
    rl.setPrompt("you> ");
    rl.prompt();
  }

  /** Send a user message via signal file to the daemon. */
  async function sendUserMessage(
    content: string,
    options?: { bypassSecretCheck?: boolean },
  ): Promise<{ ok: boolean; error?: string; message?: string }> {
    try {
      const signalsDir = getSignalsDir();
      mkdirSync(signalsDir, { recursive: true });
      const requestId = randomUUID();
      const signalFile = `user-message.${requestId}`;
      const resultFile = `${signalFile}.result`;
      const resultPath = join(signalsDir, resultFile);
      writeFileSync(
        join(signalsDir, signalFile),
        JSON.stringify({
          conversationKey,
          content,
          sourceChannel: "vellum",
          interface: "cli",
          requestId,
          ...(options?.bypassSecretCheck
            ? { bypassSecretCheck: true }
            : undefined),
        }),
      );

      const result = await new Promise<{
        ok: boolean;
        error?: string;
        message?: string;
      }>((resolve) => {
        let settled = false;
        const settle = (value: {
          ok: boolean;
          error?: string;
          message?: string;
        }): void => {
          if (settled) return;
          settled = true;
          watcher.close();
          clearTimeout(timeoutId);
          resolve(value);
        };

        const checkResult = (): void => {
          try {
            const raw = readFileSync(resultPath, "utf-8");
            const parsed = JSON.parse(raw) as {
              ok?: boolean;
              accepted?: boolean;
              requestId?: string;
              error?: string;
              message?: string;
            };
            if (parsed.requestId === requestId) {
              const ok = parsed.ok === true && parsed.accepted !== false;
              settle({ ok, error: parsed.error, message: parsed.message });
            }
          } catch {
            // Result file not yet readable; ignore.
          }
        };

        const watcher = watch(signalsDir, (_event, filename) => {
          if (filename === resultFile) {
            checkResult();
          }
        });

        const timeoutId = setTimeout(() => settle({ ok: false }), 10_000);

        if (existsSync(resultPath)) {
          checkResult();
        }
      });

      return result;
    } catch {
      return { ok: false };
    }
  }

  function renderConversationPicker(
    conversations: Array<{ id: string; title: string; updatedAt: number }>,
  ): void {
    process.stdout.write("\n  Recent conversations:\n");
    for (let i = 0; i < conversations.length; i++) {
      const c = conversations[i];
      const ago = timeAgo(c.updatedAt);
      const title = truncate(c.title, 50);
      const padding = " ".repeat(Math.max(1, 55 - title.length));
      process.stdout.write(`  [${i + 1}] ${title}${padding}${ago}\n`);
    }
    process.stdout.write("  [n] New conversation\n\n");
    process.stdout.write("  Pick a conversation> ");

    rl.once("line", async (answer) => {
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "n") {
        // Create a new conversation by using a unique key
        conversationKey = `builtin-cli:${randomUUID()}`;
        conversationId = "";
        pendingSessionPick = false;
        reconnectEvents();
        process.stdout.write(
          `\n  New conversation started.\n  Type your message. Ctrl+D to detach.\n\n`,
        );
        prompt();
        return;
      }
      const parsed = parseInt(trimmed, 10);
      if (Number.isNaN(parsed)) {
        process.stdout.write('  Invalid input — enter a number or "n".\n');
        renderConversationPicker(conversations);
        return;
      }
      const idx = parsed - 1;
      if (idx >= 0 && idx < conversations.length) {
        const selected = conversations[idx];
        if (selected.id === conversationId) {
          // Already on this conversation
          pendingSessionPick = false;
          process.stdout.write(
            `\n  Conversation: ${selected.title}\n  Type your message. Ctrl+D to detach.\n\n`,
          );
          prompt();
        } else {
          try {
            const conversation = getConversation(selected.id);
            if (!conversation) {
              process.stdout.write("  Failed to switch conversation.\n");
              renderConversationPicker(conversations);
              return;
            }
            const newKey = `builtin-cli:${selected.id}`;
            setConversationKeyIfAbsent(newKey, selected.id);
            conversationId = conversation.id;
            conversationKey = newKey;
            pendingSessionPick = false;
            reconnectEvents();
            process.stdout.write(
              `\n  Conversation: ${conversation.title ?? "Untitled"}\n  Type your message. Ctrl+D to detach.\n\n`,
            );
            prompt();
          } catch {
            process.stdout.write("  Failed to switch conversation.\n");
            renderConversationPicker(conversations);
          }
        }
      } else {
        process.stdout.write("  Invalid selection.\n");
        renderConversationPicker(conversations);
      }
    });
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "conversation_info":
        pendingSessionPick = false;
        conversationId = msg.conversationId;
        process.stdout.write(
          `\n  Conversation: ${msg.title}\n  Type your message. Ctrl+D to detach.\n\n`,
        );
        if (pendingUserContent) {
          const content = pendingUserContent;
          pendingUserContent = null;
          sendUserMessage(content).then((result) => {
            if (result.ok) {
              generating = true;
              spinner.start("Thinking...");
            } else {
              if (result.error === "secret_blocked" && result.message) {
                process.stdout.write(`${result.message}\n`);
                rl.question("Send anyway? (y/N): ", (answer) => {
                  if (answer.trim().toLowerCase() === "y") {
                    sendUserMessage(content, {
                      bypassSecretCheck: true,
                    }).then((retryResult) => {
                      if (retryResult.ok) {
                        generating = true;
                        spinner.start("Thinking...");
                      } else {
                        process.stdout.write(
                          "[Not connected — message not sent]\n",
                        );
                        prompt();
                      }
                    });
                  } else {
                    prompt();
                  }
                });
              } else {
                process.stdout.write("[Not connected — message not sent]\n");
                prompt();
              }
            }
          });
        } else {
          prompt();
        }
        break;

      case "assistant_text_delta":
        spinner.stop();
        process.stdout.write(msg.text);
        break;

      case "assistant_thinking_delta":
        spinner.stop();
        process.stdout.write(`\x1B[2m${msg.thinking}\x1B[0m`);
        break;

      case "usage_update":
        lastUsage = msg;
        break;

      case "context_compacted": {
        spinner.stop();
        const summaryOverhead =
          msg.summaryCalls > 0
            ? ` | summary: ${msg.summaryCalls} call${msg.summaryCalls === 1 ? "" : "s"}`
            : "";
        process.stdout.write(
          `\n\x1B[2m[Context compacted: ${msg.previousEstimatedInputTokens.toLocaleString()} -> ${msg.estimatedInputTokens.toLocaleString()} est input tokens, ${msg.compactedMessages} messages${summaryOverhead}]\x1B[0m\n`,
        );
        spinner.start("Thinking...");
        break;
      }

      case "memory_status":
        if (msg.degraded) {
          spinner.stop();
          process.stdout.write(
            `\n\x1B[2m[Memory degraded: ${msg.reason ?? "unknown"}]\x1B[0m\n`,
          );
          spinner.start("Thinking...");
        }
        break;

      case "memory_recalled":
        spinner.stop();
        process.stdout.write(
          `\n\x1B[2m[Memory recalled: ${msg.injectedTokens} tokens | t1 ${msg.tier1Count} t2 ${msg.tier2Count} | semantic ${msg.semanticHits} | merged ${msg.mergedCount} → selected ${msg.selectedCount}${msg.sparseVectorUsed ? " (sparse)" : ""} | hybrid ${msg.hybridSearchLatencyMs}ms | ${msg.provider}/${msg.model} | ${msg.latencyMs}ms]\x1B[0m\n`,
        );
        spinner.start("Thinking...");
        break;

      case "message_complete": {
        spinner.stop();
        generating = false;
        if (lastUsage) {
          const cost =
            lastUsage.estimatedCost > 0
              ? ` ~$${lastUsage.estimatedCost.toFixed(4)}`
              : "";
          process.stdout.write(
            `\n\n\x1B[2m[${lastUsage.inputTokens.toLocaleString()} in / ${lastUsage.outputTokens.toLocaleString()} out${cost}]\x1B[0m\n\n`,
          );
          lastUsage = null;
        } else {
          process.stdout.write("\n\n");
        }
        prompt();
        break;
      }

      case "message_request_complete": {
        // Request-level terminal for inline approval consumption.
        // When no agent turn remains active, clear busy state and re-prompt.
        if (msg.runStillActive !== true) {
          spinner.stop();
          generating = false;
          process.stdout.write("\n\n");
          prompt();
        }
        break;
      }

      case "generation_handoff": {
        spinner.stop();
        generating = false;
        if (lastUsage) {
          const cost =
            lastUsage.estimatedCost > 0
              ? ` ~$${lastUsage.estimatedCost.toFixed(4)}`
              : "";
          process.stdout.write(
            `\n\n\x1B[2m[${lastUsage.inputTokens.toLocaleString()} in / ${lastUsage.outputTokens.toLocaleString()} out${cost}]\x1B[0m\n\n`,
          );
          lastUsage = null;
        } else {
          process.stdout.write("\n\n");
        }
        prompt();
        break;
      }

      case "generation_cancelled":
        spinner.stop();
        generating = false;
        lastUsage = null;
        process.stdout.write("\n[Cancelled]\n\n");
        prompt();
        break;

      case "tool_use_preview_start":
        // Early preview of tool use — ignored by CLI; full tool_use_start follows.
        break;

      case "tool_use_start":
        toolStreaming = false;
        spinner.start(formatToolProgress(msg.toolName, msg.input));
        break;

      case "tool_output_chunk":
        if (!toolStreaming) {
          spinner.stop();
          toolStreaming = true;
        }
        process.stdout.write(msg.chunk);
        break;

      case "tool_result":
        if (!toolStreaming) spinner.stop();
        if (toolStreaming) {
          if (msg.status) {
            process.stdout.write(`\n${msg.status}`);
          }
          process.stdout.write("\n");
        } else {
          process.stdout.write(`\n[Tool: ${truncate(msg.result, 200)}]\n`);
        }
        toolStreaming = false;
        if (msg.diff) {
          const diffOutput = msg.diff.isNewFile
            ? formatNewFileDiff(msg.diff.newContent, msg.diff.filePath, null)
            : formatDiff(
                msg.diff.oldContent,
                msg.diff.newContent,
                msg.diff.filePath,
              );
          if (diffOutput) {
            process.stdout.write(diffOutput);
          }
        }
        spinner.start("Thinking...");
        break;

      case "conversation_error":
        spinner.stop();
        if (lastDisplayedError !== msg.userMessage) {
          process.stdout.write(`\n[Error: ${msg.userMessage}]\n`);
        }
        lastDisplayedError = null;
        break;

      case "error":
        spinner.stop();
        generating = false;
        if (pendingSessionPick) {
          pendingSessionPick = false;
          rl.removeAllListeners("line");
          rl.on("line", handleLine);
        }
        lastDisplayedError = msg.message;
        process.stdout.write(`\n[Error: ${msg.message}]\n`);
        prompt();
        break;

      case "secret_detected": {
        const wasSpinning = spinner.isSpinning;
        spinner.stop();
        const types = msg.matches.map((m) => m.type).join(", ");
        const actionLabel =
          msg.action === "redact"
            ? "redacted"
            : msg.action === "block"
              ? "blocked"
              : "detected";
        process.stdout.write(
          `\n  ⚠ Secret ${actionLabel} in ${msg.toolName} output: ${types}\n`,
        );
        for (const match of msg.matches) {
          process.stdout.write(`    • ${match.type}: ${match.redactedValue}\n`);
        }
        process.stdout.write("\n");
        if (wasSpinning) spinner.start("Thinking...");
        break;
      }

      case "conversation_list_response":
        if (pendingSessionPick) {
          renderConversationPicker(msg.conversations);
        } else {
          for (const conversation of msg.conversations) {
            process.stdout.write(
              `  ${conversation.id}  ${conversation.title}\n`,
            );
          }
          prompt();
        }
        break;

      case "model_info":
        process.stdout.write(`\n  Model: ${msg.model} (${msg.provider})\n\n`);
        prompt();
        break;

      case "history_response":
        process.stdout.write("\n");
        if (msg.messages.length === 0) {
          process.stdout.write("  No messages in this conversation.\n");
        } else {
          for (const m of msg.messages) {
            const label = m.role === "user" ? "you" : "assistant";
            const preview = truncate(m.text, 120);
            process.stdout.write(
              `  ${label}> ${preview.replace(/\n/g, " ")}\n`,
            );
          }
        }
        process.stdout.write("\n");
        prompt();
        break;

      case "undo_complete":
        if (msg.removedCount === 0) {
          process.stdout.write("\n  Nothing to undo.\n\n");
        } else {
          process.stdout.write(
            `\n  Removed last exchange (${msg.removedCount} messages).\n\n`,
          );
        }
        prompt();
        break;

      case "usage_response": {
        process.stdout.write("\n");
        process.stdout.write(`  Model:          ${msg.model}\n`);
        process.stdout.write(
          `  Input tokens:   ${msg.totalInputTokens.toLocaleString()}\n`,
        );
        process.stdout.write(
          `  Output tokens:  ${msg.totalOutputTokens.toLocaleString()}\n`,
        );
        const costStr =
          msg.estimatedCost > 0
            ? `$${msg.estimatedCost.toFixed(4)}`
            : "N/A (unknown model pricing)";
        process.stdout.write(`  Estimated cost: ${costStr}\n`);
        process.stdout.write("\n");
        prompt();
        break;
      }
    }
  }

  /** Stop watching the current conversation's event stream file. */
  function disconnectEvents(): void {
    if (eventSubscription) {
      eventSubscription.dispose();
      eventSubscription = null;
    }
  }

  /** Restart the file-stream watcher (e.g., after switching conversations). */
  function reconnectEvents(): void {
    disconnectEvents();
    connectEvents();
  }

  /** Watch the file-based event stream for the current conversation. */
  function connectEvents(): void {
    const mapping = getOrCreateConversation(conversationKey);

    eventSubscription = watchEventStream(mapping.conversationId, (event) => {
      if (!conversationId && event.conversationId) {
        conversationId = event.conversationId;
      }
      handleMessage(event.message);
    });
  }

  function handleLine(line: string): void {
    const content = line.trim();
    if (!content) return;
    if (pendingSessionPick) return;

    // Persist to history file (ensure parent directory exists)
    try {
      mkdirSync(dirname(historyPath), { recursive: true });
      appendFileSync(historyPath, content + "\n");
    } catch {
      /* ignore */
    }

    if (content === "/conversations") {
      pendingSessionPick = true;
      try {
        const rows = listConversations(20);
        const conversations = rows.map((r) => ({
          id: r.id,
          title: r.title || "Untitled",
          updatedAt: r.updatedAt,
        }));
        renderConversationPicker(conversations);
      } catch {
        pendingSessionPick = false;
        process.stdout.write("[Failed to fetch conversations]\n");
        prompt();
      }
      return;
    }

    if (content === "/new") {
      // Create a new conversation by using a unique key
      conversationKey = `builtin-cli:${randomUUID()}`;
      conversationId = "";
      reconnectEvents();
      process.stdout.write(
        `\n  New conversation started.\n  Type your message. Ctrl+D to detach.\n\n`,
      );
      prompt();
      return;
    }

    if (content === "/clear") {
      process.stdout.write("\x1b[r");
      process.stdout.write("\x1b[2J\x1b[H");
      mainScreenLayout = renderMainScreen();
      canvasHeight = mainScreenLayout.height;
      const rows = process.stdout.rows || 24;
      process.stdout.write(`\x1b[${canvasHeight + 1};${rows}r`);
      process.stdout.write(`\x1b[${canvasHeight + 1};1H`);
      prompt();
      return;
    }

    if (content === "/model" || content.startsWith("/model ")) {
      process.stdout.write(
        "\n  The /model command has been removed. Use Settings to change your model and provider.\n\n",
      );
      prompt();
      return;
    }

    if (content === "/history") {
      try {
        const mapping = getConversationByKey(conversationKey);
        process.stdout.write("\n");
        if (!mapping) {
          process.stdout.write("  No messages in this conversation.\n");
        } else {
          const rawMessages = getMessages(mapping.conversationId);
          if (rawMessages.length === 0) {
            process.stdout.write("  No messages in this conversation.\n");
          } else {
            for (const msg of rawMessages) {
              let parsedContent: unknown;
              try {
                parsedContent = JSON.parse(msg.content);
              } catch {
                parsedContent = msg.content;
              }
              const text = renderHistoryContent(parsedContent).text;
              const label = msg.role === "user" ? "you" : "assistant";
              const preview = truncate(text, 120);
              process.stdout.write(
                `  ${label}> ${preview.replace(/\n/g, " ")}\n`,
              );
            }
          }
        }
        process.stdout.write("\n");
      } catch {
        process.stdout.write("[Failed to fetch history]\n");
      }
      prompt();
      return;
    }

    if (content === "/undo") {
      if (!conversationId) {
        process.stdout.write("\n  No active conversation.\n\n");
        prompt();
        return;
      }
      try {
        const signalsDir = getSignalsDir();
        mkdirSync(signalsDir, { recursive: true });
        const resultPath = join(signalsDir, "conversation-undo.result");
        try {
          unlinkSync(resultPath);
        } catch {
          // May not exist yet.
        }
        const requestId = randomUUID();
        writeFileSync(
          join(signalsDir, "conversation-undo"),
          JSON.stringify({ conversationId, requestId }),
        );

        let settled = false;

        const onResult = (): void => {
          try {
            const raw = readFileSync(resultPath, "utf-8");
            const result = JSON.parse(raw) as {
              ok?: boolean;
              removedCount?: number;
              requestId?: string;
              error?: string;
            };
            if (result.requestId !== requestId) return;
            if (settled) return;
            settled = true;
            undoWatcher.close();
            clearTimeout(undoTimeoutId);
            if (result.ok && result.removedCount !== undefined) {
              if (result.removedCount === 0) {
                process.stdout.write("\n  Nothing to undo.\n\n");
              } else {
                process.stdout.write(
                  `\n  Removed last exchange (${result.removedCount} messages).\n\n`,
                );
              }
            } else {
              process.stdout.write(
                `[Failed to undo: ${result.error ?? "unknown error"}]\n`,
              );
            }
            prompt();
          } catch {
            // Result file not yet readable; ignore.
          }
        };

        const undoWatcher = watch(signalsDir, (_event, filename) => {
          if (filename === "conversation-undo.result") {
            onResult();
          }
        });

        const undoTimeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            undoWatcher.close();
            process.stdout.write("[Undo timed out]\n");
            prompt();
          }
        }, 5_000);

        if (existsSync(resultPath)) {
          onResult();
        }
      } catch {
        process.stdout.write("[Failed to undo]\n");
        prompt();
      }
      return;
    }

    if (content === "/usage") {
      process.stdout.write(
        "\n  [Usage tracking is not available via HTTP yet]\n\n",
      );
      prompt();
      return;
    }

    if (content === "/help") {
      process.stdout.write("\n  Available commands:\n");
      process.stdout.write("  /new                Start a new conversation\n");
      process.stdout.write(
        "  /conversations      Switch between conversations\n",
      );
      process.stdout.write("  /clear              Clear the screen\n");
      process.stdout.write("  /history            Show conversation history\n");
      process.stdout.write(
        "  /undo               Remove last message exchange\n",
      );
      process.stdout.write("  /usage              Show token usage and cost\n");
      process.stdout.write("  /help               Show this help\n");
      process.stdout.write("\n");
      prompt();
      return;
    }

    // Regular user message
    sendUserMessage(content).then((result) => {
      if (!result.ok) {
        if (result.error === "secret_blocked" && result.message) {
          process.stdout.write(`${result.message}\n`);
          rl.question("Send anyway? (y/N): ", (answer) => {
            if (answer.trim().toLowerCase() === "y") {
              sendUserMessage(content, { bypassSecretCheck: true }).then(
                (retryResult) => {
                  if (retryResult.ok) {
                    generating = true;
                    spinner.start("Thinking...");
                  } else {
                    process.stdout.write(
                      "[Not connected — message not sent]\n",
                    );
                    prompt();
                  }
                },
              );
            } else {
              prompt();
            }
          });
        } else {
          process.stdout.write("[Not connected — message not sent]\n");
          prompt();
        }
        return;
      }
      generating = true;
      spinner.start("Thinking...");
    });
  }

  rl.on("line", handleLine);

  rl.on("close", () => {
    disconnectEvents();
    process.stdout.write("\x1b[r\x1b[2J\x1b[H");
    process.stdout.write("\x1b[2mDetached.\x1b[0m\n");
    process.exit(0);
  });

  // Ctrl+C: cancel generation if in progress, otherwise detach
  process.on("SIGINT", () => {
    spinner.stop();
    if (generating && conversationId) {
      try {
        const signalsDir = getSignalsDir();
        mkdirSync(signalsDir, { recursive: true });
        writeFileSync(
          join(signalsDir, "cancel"),
          JSON.stringify({ conversationId }),
        );
      } catch {
        // Best-effort cancel
      }
    } else {
      rl.close();
    }
  });

  process.stdout.on("resize", () => {
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b[${canvasHeight + 1};${rows}r`);
  });

  // Initial connection
  connectEvents();
  updateDaemonText(mainScreenLayout, "connected");
  updateStatusText(mainScreenLayout, "ready");
  process.stdout.write(`\n  Type your message. Ctrl+D to detach.\n\n`);
  prompt();
}
