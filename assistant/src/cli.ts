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

import { httpSend } from "./cli/http-client.js";
import {
  type MainScreenLayout,
  renderMainScreen,
  updateDaemonText,
  updateStatusText,
} from "./cli/main-screen.jsx";
import { loadRawConfig, saveRawConfig } from "./config/loader.js";
import { shouldAutoStartDaemon } from "./daemon/connection-policy.js";
import { isHttpHealthy } from "./daemon/daemon-control.js";
import { getModelInfo } from "./daemon/handlers/config-model.js";
import { renderHistoryContent } from "./daemon/handlers/shared.js";
import { ensureDaemonRunning } from "./daemon/lifecycle.js";
import type {
  ConfirmationRequest,
  ServerMessage,
} from "./daemon/message-protocol.js";
import { MODEL_TO_PROVIDER } from "./daemon/session-slash.js";
import { getMessages } from "./memory/conversation-crud.js";
import { getConversationByKey } from "./memory/conversation-key-store.js";
import { listConversations } from "./memory/conversation-queries.js";
import {
  copyToClipboard,
  extractLastCodeBlock,
  formatSessionForExport,
} from "./util/clipboard.js";
import { formatDiff, formatNewFileDiff } from "./util/diff.js";
import { getHistoryPath, getWorkspaceDir } from "./util/platform.js";
import { Spinner } from "./util/spinner.js";
import { timeAgo } from "./util/time.js";
import { truncate } from "./util/truncate.js";

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

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
  if (req.toolName === "browser_navigate") {
    return `navigate ${sanitizeUrlForDisplay(req.input.url ?? "")}`;
  }
  if (req.toolName === "browser_close") {
    return req.input.close_all_pages
      ? "close all browser pages"
      : "close browser page";
  }
  if (req.toolName === "browser_click") {
    return `click ${req.input.element_id ?? req.input.selector ?? ""}`;
  }
  if (req.toolName === "browser_type") {
    return `type into ${req.input.element_id ?? req.input.selector ?? ""}`;
  }
  if (req.toolName === "browser_press_key") {
    return `press "${req.input.key ?? ""}"`;
  }
  return req.toolName;
}

export async function startCli(): Promise<void> {
  let conversationKey = CLI_CONVERSATION_KEY;
  let sessionId = "";
  let pendingUserContent: string | null = null;
  let generating = false;
  let lastResponse = "";
  let lastUsage: {
    inputTokens: number;
    outputTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    estimatedCost: number;
    model: string;
  } | null = null;
  let pendingSessionPick = false;
  let pendingConfirmation = false;
  let pendingCopySession = false;
  let toolStreaming = false;
  let reconnecting = false;
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;
  let sseAbortController: AbortController | null = null;
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
      case "browser_navigate":
        return `Navigating to ${sanitizeUrlForDisplay(input.url).slice(0, 80)}...`;
      case "browser_snapshot":
        return "Taking page snapshot...";
      case "browser_close":
        return "Closing browser...";
      case "browser_click":
        return `Clicking ${String(input.element_id ?? input.selector ?? "").slice(0, 60)}...`;
      case "browser_type":
        return `Typing into ${String(input.element_id ?? input.selector ?? "").slice(0, 60)}...`;
      case "browser_press_key":
        return `Pressing "${String(input.key ?? "")}"...`;
      case "browser_wait_for":
        if (input.selector)
          return `Waiting for ${String(input.selector).slice(0, 60)}...`;
        if (input.text)
          return `Waiting for text "${String(input.text).slice(0, 40)}"...`;
        return `Waiting ${input.duration ?? 0}ms...`;
      case "browser_extract":
        return "Extracting page content...";
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

  /** Send a confirmation decision via signal file (read by the daemon). */
  function sendConfirmation(requestId: string, decision: string): void {
    try {
      const signalsDir = join(getWorkspaceDir(), "signals");
      mkdirSync(signalsDir, { recursive: true });
      writeFileSync(
        join(signalsDir, "confirm"),
        JSON.stringify({ requestId, decision }),
      );
    } catch {
      process.stdout.write("[Failed to send confirmation]\n");
    }
  }

  /** Add a trust rule via signal file, then confirm once the daemon acknowledges. */
  function sendTrustRuleAndConfirm(
    requestId: string,
    pattern: string,
    scope: string,
    decision: "allow" | "deny",
    confirmDecision: string,
    options?: { allowHighRisk?: boolean },
  ): void {
    try {
      const signalsDir = join(getWorkspaceDir(), "signals");
      mkdirSync(signalsDir, { recursive: true });
      const resultPath = join(signalsDir, "trust-rule.result");
      writeFileSync(
        join(signalsDir, "trust-rule"),
        JSON.stringify({
          requestId,
          pattern,
          scope,
          decision,
          ...(options?.allowHighRisk ? { allowHighRisk: true } : {}),
        }),
      );

      let settled = false;

      const onResult = (): void => {
        try {
          const raw = readFileSync(resultPath, "utf-8");
          const result = JSON.parse(raw) as {
            ok?: boolean;
            requestId?: string;
            error?: string;
          };
          if (result.requestId !== requestId) return;
          settled = true;
          watcher.close();
          clearTimeout(timeoutId);
          if (result.ok) {
            sendConfirmation(requestId, confirmDecision);
          } else {
            process.stdout.write(
              `[Failed to add trust rule: ${result.error ?? "unknown error"}]\n`,
            );
          }
        } catch {
          // Result file not yet readable; ignore.
        }
      };

      const watcher = watch(signalsDir, (_event, filename) => {
        if (filename === "trust-rule.result") {
          onResult();
        }
      });

      const timeoutId = setTimeout(() => {
        if (!settled) {
          watcher.close();
          process.stdout.write("[Trust rule timed out]\n");
        }
      }, 5_000);

      if (existsSync(resultPath)) {
        onResult();
      }
    } catch {
      process.stdout.write("[Failed to send trust rule]\n");
    }
  }

  /** Send a user message via HTTP POST. */
  async function sendUserMessage(content: string): Promise<boolean> {
    try {
      const response = await httpSend("/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          conversationKey,
          content,
          sourceChannel: "vellum",
          interface: "cli",
        }),
      });
      return response.ok || response.status === 202;
    } catch {
      return false;
    }
  }

  function renderConfirmationPrompt(req: ConfirmationRequest): void {
    const preview = formatConfirmationCommandPreview(req);
    const inputLines = formatConfirmationInputLines(req.input);
    process.stdout.write("\n");
    process.stdout.write(`\u250C ${req.toolName}: ${preview}\n`);
    process.stdout.write(
      `\u2502 Risk: ${req.riskLevel}${req.sandboxed ? "  [sandboxed]" : ""}\n`,
    );
    if (req.executionTarget) {
      process.stdout.write(`\u2502 Target: ${req.executionTarget}\n`);
    }
    if (inputLines.length > 0) {
      process.stdout.write(`\u2502\n`);
      for (const line of inputLines) {
        process.stdout.write(`\u2502 ${line}\n`);
      }
    }
    if (req.diff) {
      const diffOutput = req.diff.isNewFile
        ? formatNewFileDiff(req.diff.newContent, req.diff.filePath, null)
        : formatDiff(
            req.diff.oldContent,
            req.diff.newContent,
            req.diff.filePath,
          );
      if (diffOutput) {
        process.stdout.write(`\u2502\n`);
        for (const line of diffOutput.split("\n")) {
          if (line) process.stdout.write(`\u2502 ${line}\n`);
        }
      }
    }
    process.stdout.write(`\u2502\n`);
    process.stdout.write(`\u2502 [a] Allow once\n`);
    if (req.temporaryOptionsAvailable?.includes("allow_10m")) {
      process.stdout.write(`\u2502 [t] Allow 10m\n`);
    }
    if (req.temporaryOptionsAvailable?.includes("allow_thread")) {
      process.stdout.write(`\u2502 [T] Allow Thread\n`);
    }
    process.stdout.write(`\u2502 [d] Deny once\n`);
    if (req.allowlistOptions.length > 0 && req.scopeOptions.length > 0) {
      process.stdout.write(`\u2502 [A] Allowlist...\n`);
      process.stdout.write(`\u2502 [H] Allowlist (high-risk)...\n`);
      process.stdout.write(`\u2502 [D] Denylist...\n`);
    }
    process.stdout.write(`\u2514 > `);

    pendingConfirmation = true;
    rl.once("line", (answer) => {
      const trimmed = answer.trim();
      const choice = trimmed.toLowerCase();

      // Uppercase 'A' → allowlist pattern selection (check before lowercase 'a')
      // Only process when scope options exist, matching the display guard above
      if (
        (trimmed === "A" || choice === "allowlist") &&
        req.allowlistOptions.length > 0 &&
        req.scopeOptions.length > 0
      ) {
        // pendingConfirmation stays true through sub-prompts
        renderPatternSelection(req, "always_allow");
        return;
      }

      // Uppercase 'H' → high-risk allowlist pattern selection
      if (
        trimmed === "H" &&
        req.allowlistOptions.length > 0 &&
        req.scopeOptions.length > 0
      ) {
        // pendingConfirmation stays true through sub-prompts
        renderPatternSelection(req, "always_allow_high_risk");
        return;
      }

      // Uppercase 'D' → denylist pattern selection (check before lowercase 'd')
      if (
        (trimmed === "D" || choice === "denylist") &&
        req.allowlistOptions.length > 0 &&
        req.scopeOptions.length > 0
      ) {
        // pendingConfirmation stays true through sub-prompts
        renderPatternSelection(req, "always_deny");
        return;
      }

      pendingConfirmation = false;
      if (choice === "a") {
        sendConfirmation(req.requestId, "allow");
        return;
      }

      if (
        choice === "t" &&
        trimmed === "t" &&
        req.temporaryOptionsAvailable?.includes("allow_10m")
      ) {
        sendConfirmation(req.requestId, "allow_10m");
        return;
      }

      if (
        trimmed === "T" &&
        req.temporaryOptionsAvailable?.includes("allow_thread")
      ) {
        sendConfirmation(req.requestId, "allow_thread");
        return;
      }

      if (choice === "d") {
        sendConfirmation(req.requestId, "deny");
        return;
      }

      // Default to deny for unrecognized input
      sendConfirmation(req.requestId, "deny");
    });
  }

  function renderPatternSelection(
    req: ConfirmationRequest,
    decision: "always_allow" | "always_allow_high_risk" | "always_deny",
  ): void {
    const label =
      decision === "always_deny"
        ? "Denylist"
        : decision === "always_allow_high_risk"
          ? "Allowlist (high-risk)"
          : "Allowlist";
    process.stdout.write("\n");
    process.stdout.write(`\u250C ${label}: choose command pattern\n`);
    for (let i = 0; i < req.allowlistOptions.length; i++) {
      process.stdout.write(
        `\u2502 [${i + 1}] ${req.allowlistOptions[i].label}\n`,
      );
    }
    process.stdout.write(`\u2514 > `);

    rl.once("line", (answer) => {
      const parsed = parseInt(answer.trim(), 10);
      if (Number.isNaN(parsed)) {
        process.stdout.write("  Invalid input — enter a number.\n");
        renderPatternSelection(req, decision);
        return;
      }
      const idx = parsed - 1;
      if (idx >= 0 && idx < req.allowlistOptions.length) {
        const selectedPattern = req.allowlistOptions[idx].pattern;
        // pendingConfirmation stays true through scope selection
        renderScopeSelection(req, selectedPattern, decision);
      } else {
        // Invalid selection → deny
        pendingConfirmation = false;
        sendConfirmation(req.requestId, "deny");
      }
    });
  }

  function renderScopeSelection(
    req: ConfirmationRequest,
    selectedPattern: string,
    decision: "always_allow" | "always_allow_high_risk" | "always_deny",
  ): void {
    const label =
      decision === "always_deny"
        ? "Denylist"
        : decision === "always_allow_high_risk"
          ? "Allowlist (high-risk)"
          : "Allowlist";
    process.stdout.write("\n");
    process.stdout.write(`\u250C ${label}: choose scope\n`);
    for (let i = 0; i < req.scopeOptions.length; i++) {
      process.stdout.write(`\u2502 [${i + 1}] ${req.scopeOptions[i].label}\n`);
    }
    process.stdout.write(`\u2514 > `);

    rl.once("line", (answer) => {
      const parsed = parseInt(answer.trim(), 10);
      if (Number.isNaN(parsed)) {
        process.stdout.write("  Invalid input — enter a number.\n");
        renderScopeSelection(req, selectedPattern, decision);
        return;
      }
      pendingConfirmation = false;
      const idx = parsed - 1;
      if (idx >= 0 && idx < req.scopeOptions.length) {
        const trustDecision = decision === "always_deny" ? "deny" : "allow";
        sendTrustRuleAndConfirm(
          req.requestId,
          selectedPattern,
          req.scopeOptions[idx].scope,
          trustDecision,
          trustDecision,
          decision === "always_allow_high_risk"
            ? { allowHighRisk: true }
            : undefined,
        );
      } else {
        // Invalid selection → deny
        sendConfirmation(req.requestId, "deny");
      }
    });
  }

  function renderSessionPicker(
    sessions: Array<{ id: string; title: string; updatedAt: number }>,
  ): void {
    process.stdout.write("\n  Recent sessions:\n");
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const ago = timeAgo(s.updatedAt);
      const title = truncate(s.title, 50);
      const padding = " ".repeat(Math.max(1, 55 - title.length));
      process.stdout.write(`  [${i + 1}] ${title}${padding}${ago}\n`);
    }
    process.stdout.write("  [n] New session\n\n");
    process.stdout.write("  Pick a session> ");

    rl.once("line", async (answer) => {
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "n") {
        // Create a new conversation by using a unique key
        conversationKey = `builtin-cli:${randomUUID()}`;
        sessionId = "";
        pendingSessionPick = false;
        // Reconnect SSE with new conversation key
        await reconnectSse();
        process.stdout.write(
          `\n  New session started.\n  Type your message. Ctrl+D to detach.\n\n`,
        );
        prompt();
        return;
      }
      const parsed = parseInt(trimmed, 10);
      if (Number.isNaN(parsed)) {
        process.stdout.write('  Invalid input — enter a number or "n".\n');
        renderSessionPicker(sessions);
        return;
      }
      const idx = parsed - 1;
      if (idx >= 0 && idx < sessions.length) {
        const selected = sessions[idx];
        if (selected.id === sessionId) {
          // Already on this session
          pendingSessionPick = false;
          process.stdout.write(
            `\n  Session: ${selected.title}\n  Type your message. Ctrl+D to detach.\n\n`,
          );
          prompt();
        } else {
          try {
            const newKey = `builtin-cli:${selected.id}`;
            const resp = await httpSend("/v1/conversations/switch", {
              method: "POST",
              body: JSON.stringify({
                conversationId: selected.id,
                conversationKey: newKey,
              }),
            });
            if (resp.ok) {
              const data = (await resp.json()) as {
                sessionId: string;
                title: string;
              };
              sessionId = data.sessionId;
              conversationKey = newKey;
              pendingSessionPick = false;
              await reconnectSse();
              process.stdout.write(
                `\n  Session: ${data.title}\n  Type your message. Ctrl+D to detach.\n\n`,
              );
              prompt();
            } else {
              process.stdout.write("  Failed to switch session.\n");
              renderSessionPicker(sessions);
            }
          } catch {
            process.stdout.write("  Failed to switch session.\n");
            renderSessionPicker(sessions);
          }
        }
      } else {
        process.stdout.write("  Invalid selection.\n");
        renderSessionPicker(sessions);
      }
    });
  }

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "session_info":
        pendingSessionPick = false;
        sessionId = msg.sessionId;
        process.stdout.write(
          `\n  Session: ${msg.title}\n  Type your message. Ctrl+D to detach.\n\n`,
        );
        if (pendingUserContent) {
          const content = pendingUserContent;
          pendingUserContent = null;
          lastResponse = "";
          sendUserMessage(content).then((ok) => {
            if (ok) {
              generating = true;
              spinner.start("Thinking...");
            } else {
              process.stdout.write("[Not connected — message not sent]\n");
              prompt();
            }
          });
        } else {
          prompt();
        }
        break;

      case "assistant_text_delta":
        spinner.stop();
        lastResponse += msg.text;
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
          `\n\x1B[2m[Memory recalled: ${msg.injectedTokens} tokens | t1 ${msg.tier1Count} t2 ${msg.tier2Count} | semantic ${msg.semanticHits} | recency ${msg.recencyHits} | merged ${msg.mergedCount} → selected ${msg.selectedCount}${msg.sparseVectorUsed ? " (sparse)" : ""} | hybrid ${msg.hybridSearchLatencyMs}ms | ${msg.provider}/${msg.model} | ${msg.latencyMs}ms]\x1B[0m\n`,
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

      case "confirmation_request":
        spinner.stop();
        renderConfirmationPrompt(msg);
        break;

      case "error":
        spinner.stop();
        generating = false;
        if (pendingConfirmation || pendingSessionPick || pendingCopySession) {
          pendingConfirmation = false;
          pendingSessionPick = false;
          pendingCopySession = false;
          rl.removeAllListeners("line");
          rl.on("line", handleLine);
        }
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

      case "session_list_response":
        if (pendingSessionPick) {
          renderSessionPicker(msg.sessions);
        } else {
          for (const session of msg.sessions) {
            process.stdout.write(`  ${session.id}  ${session.title}\n`);
          }
          prompt();
        }
        break;

      case "model_info":
        process.stdout.write(`\n  Model: ${msg.model} (${msg.provider})\n\n`);
        prompt();
        break;

      case "history_response":
        if (pendingCopySession) {
          pendingCopySession = false;
          if (msg.messages.length === 0) {
            process.stdout.write("\n  No messages to copy.\n\n");
          } else {
            try {
              const formatted = formatSessionForExport(msg.messages);
              copyToClipboard(formatted);
              process.stdout.write(
                `\n  Copied session (${msg.messages.length} messages) to clipboard.\n\n`,
              );
            } catch (err) {
              process.stdout.write(
                `\n  Clipboard error: ${(err as Error).message}\n\n`,
              );
            }
          }
          prompt();
          break;
        }
        process.stdout.write("\n");
        if (msg.messages.length === 0) {
          process.stdout.write("  No messages in this session.\n");
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
          lastResponse = "";
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

  /** Disconnect the current SSE stream. */
  function disconnectSse(): void {
    if (sseAbortController) {
      sseAbortController.abort();
      sseAbortController = null;
    }
  }

  /** Reconnect the SSE stream (e.g., after switching conversations). */
  async function reconnectSse(): Promise<void> {
    disconnectSse();
    await connectSse();
  }

  /** Connect the SSE event stream for the current conversation. */
  async function connectSse(): Promise<void> {
    const controller = new AbortController();
    sseAbortController = controller;

    const url = `/v1/events?conversationKey=${encodeURIComponent(conversationKey)}`;

    try {
      const response = await httpSend(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      // Read the SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readLoop = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse SSE frames from the buffer
            const frames = buffer.split("\n\n");
            // Keep the last (potentially incomplete) frame in the buffer
            buffer = frames.pop() ?? "";

            for (const frame of frames) {
              if (!frame.trim()) continue;
              // Skip heartbeat comments
              if (frame.startsWith(":")) continue;

              // Parse event type and data
              let data = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("data: ")) {
                  data += line.slice(6);
                }
              }

              if (!data) continue;

              try {
                const event = JSON.parse(data) as {
                  message: ServerMessage;
                  sessionId?: string;
                };
                // Extract the sessionId from the event envelope if we don't have one
                if (!sessionId && event.sessionId) {
                  sessionId = event.sessionId;
                }
                handleMessage(event.message);
              } catch {
                // Skip malformed events
              }
            }
          }
        } catch {
          if (controller.signal.aborted) return; // intentional disconnect
          // Connection lost — trigger reconnect
        } finally {
          reader.releaseLock();
        }

        // If not intentionally disconnected, reconnect
        if (!controller.signal.aborted && !reconnecting) {
          reconnect();
        }
      };

      // Start reading in the background (don't await — it runs for the lifetime of the connection)
      readLoop();
    } catch (err) {
      if (controller.signal.aborted) return;
      throw err;
    }
  }

  async function reconnect(): Promise<void> {
    if (reconnecting) return;
    reconnecting = true;
    disconnectSse();
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
    rl.removeAllListeners("line");
    rl.on("line", handleLine);

    // Retry with exponential backoff (1s → 2s → 4s → … → 30s cap) until connected
    while (true) {
      const delaySec = (reconnectDelay / 1000).toFixed(0);
      process.stdout.write(
        `\n  Reconnecting to assistant in ${delaySec}s...\n`,
      );
      await new Promise((r) => setTimeout(r, reconnectDelay));

      // Increase backoff for next attempt before trying
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);

      try {
        if (shouldAutoStartDaemon()) await ensureDaemonRunning();
        // Verify the daemon is healthy before attempting SSE
        const healthy = await isHttpHealthy();
        if (!healthy) throw new Error("Health check failed");
        await connectSse();
        reconnectDelay = RECONNECT_BASE_DELAY_MS;
        reconnecting = false;
        updateDaemonText(mainScreenLayout, "connected");
        updateStatusText(mainScreenLayout, "ready");
        return;
      } catch {
        // Will retry with increased backoff
      }
    }
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
      appendFileSync(historyPath, content + "\n");
    } catch {
      /* ignore */
    }

    if (content === "/copy") {
      if (!lastResponse) {
        process.stdout.write("No response to copy.\n");
      } else {
        try {
          copyToClipboard(lastResponse);
          process.stdout.write("Copied to clipboard.\n");
        } catch (err) {
          process.stdout.write(`Clipboard error: ${(err as Error).message}\n`);
        }
      }
      prompt();
      return;
    }

    if (content === "/sessions") {
      pendingSessionPick = true;
      try {
        const rows = listConversations(20);
        const sessions = rows.map((r) => ({
          id: r.id,
          title: r.title || "Untitled",
          updatedAt: r.updatedAt,
        }));
        renderSessionPicker(sessions);
      } catch {
        pendingSessionPick = false;
        process.stdout.write("[Failed to fetch sessions]\n");
        prompt();
      }
      return;
    }

    if (content === "/copy-code") {
      const code = extractLastCodeBlock(lastResponse);
      if (code == null) {
        process.stdout.write("No code block found.\n");
      } else {
        try {
          copyToClipboard(code);
          process.stdout.write("Copied code block to clipboard.\n");
        } catch (err) {
          process.stdout.write(`Clipboard error: ${(err as Error).message}\n`);
        }
      }
      prompt();
      return;
    }

    if (content === "/copy-session") {
      try {
        const mapping = getConversationByKey(conversationKey);
        if (!mapping) {
          process.stdout.write("\n  No messages to copy.\n\n");
          prompt();
          return;
        }
        const rawMessages = getMessages(mapping.conversationId);
        if (rawMessages.length === 0) {
          process.stdout.write("\n  No messages to copy.\n\n");
        } else {
          const rendered = rawMessages.map((msg) => {
            let parsedContent: unknown;
            try {
              parsedContent = JSON.parse(msg.content);
            } catch {
              parsedContent = msg.content;
            }
            return {
              role: msg.role as "user" | "assistant",
              text: renderHistoryContent(parsedContent).text,
            };
          });
          try {
            const formatted = formatSessionForExport(rendered);
            copyToClipboard(formatted);
            process.stdout.write(
              `\n  Copied session (${rawMessages.length} messages) to clipboard.\n\n`,
            );
          } catch (err) {
            process.stdout.write(
              `\n  Clipboard error: ${(err as Error).message}\n\n`,
            );
          }
        }
      } catch {
        process.stdout.write("[Failed to fetch history]\n");
      }
      prompt();
      return;
    }

    if (content === "/new") {
      // Create a new conversation by using a unique key
      conversationKey = `builtin-cli:${randomUUID()}`;
      sessionId = "";
      reconnectSse().then(() => {
        process.stdout.write(
          `\n  New session started.\n  Type your message. Ctrl+D to detach.\n\n`,
        );
        prompt();
      });
      return;
    }

    if (content === "/clear") {
      lastResponse = "";
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
      const modelArg = content.slice("/model".length).trim();
      if (modelArg) {
        try {
          const raw = loadRawConfig();
          const provider = MODEL_TO_PROVIDER[modelArg];
          raw.model = modelArg;
          if (provider) raw.provider = provider;
          saveRawConfig(raw);
          process.stdout.write(
            `\n  Model: ${modelArg} (${provider ?? raw.provider})\n\n`,
          );
        } catch {
          process.stdout.write("[Failed to set model]\n");
        }
      } else {
        getModelInfo()
          .then((info) => {
            process.stdout.write(
              `\n  Model: ${info.model} (${info.provider})\n\n`,
            );
            prompt();
          })
          .catch(() => {
            process.stdout.write("[Failed to get model info]\n");
            prompt();
          });
        return;
      }
      prompt();
      return;
    }

    if (content === "/history") {
      try {
        const mapping = getConversationByKey(conversationKey);
        process.stdout.write("\n");
        if (!mapping) {
          process.stdout.write("  No messages in this session.\n");
        } else {
          const rawMessages = getMessages(mapping.conversationId);
          if (rawMessages.length === 0) {
            process.stdout.write("  No messages in this session.\n");
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
      if (!sessionId) {
        process.stdout.write("\n  No active session.\n\n");
        prompt();
        return;
      }
      try {
        const signalsDir = join(getWorkspaceDir(), "signals");
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
          JSON.stringify({ sessionId, requestId }),
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
                lastResponse = "";
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
      process.stdout.write("  /new              Start a new session\n");
      process.stdout.write("  /sessions         Switch between sessions\n");
      process.stdout.write("  /clear            Clear the screen\n");
      process.stdout.write("  /model [name]     Show or change the model\n");
      process.stdout.write("  /history          Show conversation history\n");
      process.stdout.write(
        "  /undo             Remove last message exchange\n",
      );
      process.stdout.write("  /usage            Show token usage and cost\n");
      process.stdout.write(
        "  /copy             Copy last response to clipboard\n",
      );
      process.stdout.write(
        "  /copy-code        Copy last code block to clipboard\n",
      );
      process.stdout.write(
        "  /copy-session     Copy entire session to clipboard\n",
      );
      process.stdout.write("  /help             Show this help\n");
      process.stdout.write("\n");
      prompt();
      return;
    }

    // Regular user message
    lastResponse = "";
    sendUserMessage(content).then((ok) => {
      if (!ok) {
        process.stdout.write("[Not connected — message not sent]\n");
        prompt();
        return;
      }
      generating = true;
      spinner.start("Thinking...");
    });
  }

  rl.on("line", handleLine);

  rl.on("close", () => {
    disconnectSse();
    process.stdout.write("\x1b[r\x1b[2J\x1b[H");
    process.stdout.write("\x1b[2mDetached.\x1b[0m\n");
    process.exit(0);
  });

  // Ctrl+C: cancel generation if in progress, otherwise detach
  process.on("SIGINT", () => {
    spinner.stop();
    if (generating && sessionId) {
      try {
        const signalsDir = join(getWorkspaceDir(), "signals");
        mkdirSync(signalsDir, { recursive: true });
        writeFileSync(
          join(signalsDir, "cancel"),
          JSON.stringify({ sessionId }),
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
  await connectSse();
  updateDaemonText(mainScreenLayout, "connected");
  updateStatusText(mainScreenLayout, "ready");

  // Show initial prompt since HTTP doesn't have the session_info flow
  process.stdout.write(`\n  Type your message. Ctrl+D to detach.\n\n`);
  prompt();
}
