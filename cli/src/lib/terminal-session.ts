/**
 * Shared terminal session primitives for managed (cloud-hosted) assistants.
 *
 * Extracted from commands/terminal.ts so that ssh.ts, exec.ts, and
 * terminal.ts can all use the same interactive session and assistant
 * resolver without cross-importing commands (per cli/CONTRIBUTING.md).
 */

import { resolveAssistant, resolveCloud } from "./assistant-config.js";
import { getPlatformUrl, readPlatformToken } from "./platform-client.js";
import {
  closeTerminalSession,
  createTerminalSession,
  resizeTerminalSession,
  sendTerminalInput,
  subscribeTerminalEvents,
} from "./terminal-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedManagedAssistant {
  assistantId: string;
  token: string;
  platformUrl: string;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a managed (cloud-hosted) assistant from the lockfile. Exits with
 * an error if the assistant is not found, not managed, or the user isn't
 * logged in.
 */
export function resolveManagedAssistant(
  nameArg?: string,
): ResolvedManagedAssistant {
  const entry = resolveAssistant(nameArg);

  if (!entry) {
    if (nameArg) {
      console.error(`No assistant instance found with name '${nameArg}'.`);
    } else {
      console.error("No assistant instance found. Run `vellum hatch` first.");
    }
    process.exit(1);
  }

  const cloud = resolveCloud(entry);
  if (cloud !== "vellum") {
    if (cloud === "local") {
      console.error(
        "This assistant runs locally on your machine. You can access it directly.",
      );
    } else if (cloud === "docker") {
      console.error(
        `Use 'vellum exec -it -- /bin/bash' or 'vellum ssh' for ${cloud} instances.`,
      );
    } else {
      console.error(
        `'vellum terminal' is for managed (cloud-hosted) assistants. This assistant uses '${cloud}'.`,
      );
    }
    process.exit(1);
  }

  const token = readPlatformToken();
  if (!token) {
    console.error(
      "Not logged in. Run `vellum login` first to authenticate with the platform.",
    );
    process.exit(1);
  }

  return {
    assistantId: entry.assistantId,
    token,
    platformUrl: getPlatformUrl(),
  };
}

// ---------------------------------------------------------------------------
// Interactive session
// ---------------------------------------------------------------------------

/**
 * Open an interactive raw-tty terminal session to a managed assistant.
 * Bridges local stdin/stdout to the platform terminal session API.
 */
export async function interactiveSession(
  assistant: ResolvedManagedAssistant,
  initialCommand?: string,
  service?: string,
): Promise<void> {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  console.error(`\x1b[2m🔗 Connecting to ${assistant.assistantId}...\x1b[0m`);

  const { session_id: sessionId } = await createTerminalSession(
    assistant.token,
    assistant.assistantId,
    cols,
    rows,
    assistant.platformUrl,
    service,
  );

  // --- TTY raw mode setup ---
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");

  // Abort controller for the SSE stream
  const abortController = new AbortController();
  let exiting = false;

  // --- Cleanup function (idempotent) ---
  async function cleanup(): Promise<void> {
    if (exiting) return;
    exiting = true;

    // Restore tty
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(wasRaw ?? false);
    }
    process.stdin.pause();

    // Abort SSE stream
    abortController.abort();

    // Close remote session (best-effort)
    try {
      await closeTerminalSession(
        assistant.token,
        assistant.assistantId,
        sessionId,
        assistant.platformUrl,
      );
    } catch {
      // Best-effort cleanup
    }
  }

  // --- Signal handlers ---
  const onSigInt = () => {
    cleanup().then(() => process.exit(0));
  };
  const onSigTerm = () => {
    cleanup().then(() => process.exit(0));
  };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  // --- SIGWINCH (terminal resize) ---
  const onResize = () => {
    const newCols = process.stdout.columns || 80;
    const newRows = process.stdout.rows || 24;
    resizeTerminalSession(
      assistant.token,
      assistant.assistantId,
      sessionId,
      newCols,
      newRows,
      assistant.platformUrl,
    ).catch(() => {
      // Resize failures are non-fatal
    });
  };
  process.stdout.on("resize", onResize);

  // --- Input: stdin → remote ---
  let inputBuffer = "";
  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  const INPUT_DEBOUNCE_MS = 30;

  function flushInput(): void {
    if (inputBuffer.length === 0) return;
    const data = inputBuffer;
    inputBuffer = "";
    sendTerminalInput(
      assistant.token,
      assistant.assistantId,
      sessionId,
      data,
      assistant.platformUrl,
    ).catch((err) => {
      if (!exiting) {
        console.error(`\r\nInput error: ${err.message}\r\n`);
      }
    });
  }

  process.stdin.on("data", (chunk: string) => {
    if (exiting) return;
    inputBuffer += chunk;
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = setTimeout(flushInput, INPUT_DEBOUNCE_MS);
  });

  // --- Send initial command (for `attach` subcommand) ---
  if (initialCommand) {
    // Brief delay to let the shell initialize
    await new Promise((resolve) => setTimeout(resolve, 300));
    await sendTerminalInput(
      assistant.token,
      assistant.assistantId,
      sessionId,
      initialCommand + "\r",
      assistant.platformUrl,
    );
  }

  // --- Output: remote SSE → stdout ---
  try {
    for await (const event of subscribeTerminalEvents(
      assistant.token,
      assistant.assistantId,
      sessionId,
      assistant.platformUrl,
      abortController.signal,
    )) {
      if (exiting) break;
      // Decode base64 output and write raw bytes to stdout
      const bytes = Buffer.from(event.data, "base64");
      process.stdout.write(bytes);
    }
  } catch (err) {
    if (!exiting) {
      const msg = err instanceof Error ? err.message : String(err);
      // AbortError is expected on cleanup
      if (!msg.includes("abort")) {
        console.error(`\r\nConnection lost: ${msg}\r\n`);
      }
    }
  } finally {
    await cleanup();

    // Remove listeners
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.stdout.off("resize", onResize);
  }
}

// ---------------------------------------------------------------------------
// Shell escape helper
// ---------------------------------------------------------------------------

/**
 * Shell-escape an array of command arguments for safe transmission to a
 * remote shell. Each arg is wrapped in single quotes with internal single
 * quotes escaped.
 */
export function shellEscapeArgs(args: string[]): string {
  return args
    .map((c) => c.replace(/'/g, "'\\''"))
    .map((c) => `'${c}'`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Non-interactive exec
// ---------------------------------------------------------------------------

/**
 * Run a command non-interactively in a managed assistant service. Creates
 * an ephemeral terminal session, sends the command wrapped in sentinels for
 * reliable output extraction, captures the result, and exits with the
 * remote command's exit code.
 */
export interface NonInteractiveExecOptions {
  verbose?: boolean;
  /** Timeout in milliseconds. 0 disables the timeout entirely. Default: 30_000. */
  timeoutMs?: number;
}

export async function nonInteractiveExec(
  assistant: ResolvedManagedAssistant,
  command: string[],
  options?: NonInteractiveExecOptions & { service?: string },
): Promise<void> {
  const verbose = options?.verbose ?? false;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const dbg = verbose
    ? (msg: string) => console.error(`\x1b[2m[exec] ${msg}\x1b[0m`)
    : (_msg: string) => {};

  dbg(`creating terminal session (cols=120, rows=24)`);

  const { session_id: sessionId } = await createTerminalSession(
    assistant.token,
    assistant.assistantId,
    120,
    24,
    assistant.platformUrl,
    options?.service,
  );

  dbg(`session created: ${sessionId}`);

  const abortController = new AbortController();
  const output: Buffer[] = [];
  let commandSent = false;
  let eventCount = 0;
  let timedOut = false;

  // Unique sentinels to delimit command output
  const startSentinel = `__VELLUM_EXEC_START_${Date.now()}__`;
  const endSentinel = `__VELLUM_EXEC_END_${Date.now()}__`;
  const exitCodeSentinel = `__VELLUM_EXIT_`;

  dbg(`sentinels: start=${startSentinel} end=${endSentinel}`);

  const timeout =
    timeoutMs > 0
      ? setTimeout(() => {
          dbg(`${timeoutMs / 1000}s timeout reached — aborting`);
          timedOut = true;
          abortController.abort();
        }, timeoutMs)
      : null;

  try {
    for await (const event of subscribeTerminalEvents(
      assistant.token,
      assistant.assistantId,
      sessionId,
      assistant.platformUrl,
      abortController.signal,
    )) {
      eventCount++;
      const bytes = Buffer.from(event.data, "base64");
      output.push(bytes);

      if (verbose) {
        const text = bytes.toString("utf-8");
        dbg(
          `SSE event #${eventCount} (seq=${event.seq}, ${bytes.length}B): ${JSON.stringify(text)}`,
        );
      }

      // Wait for shell prompt before sending command
      if (!commandSent) {
        const joined = Buffer.concat(output).toString("utf-8");
        if (
          joined.includes("$") ||
          joined.includes("#") ||
          joined.includes("%")
        ) {
          commandSent = true;
          const shellCmd = shellEscapeArgs(command);
          const fullCmd = `echo '${startSentinel}'; ${shellCmd}; __ec=$?; echo '${endSentinel}'; echo '${exitCodeSentinel}'$__ec; exit $__ec\r`;
          dbg(`prompt detected — sending command`);
          if (verbose) {
            dbg(`full command: ${JSON.stringify(fullCmd)}`);
          }
          // Wrap command: print start sentinel, run command, capture exit
          // code, print end sentinel with exit code, then exit the shell
          await sendTerminalInput(
            assistant.token,
            assistant.assistantId,
            sessionId,
            fullCmd,
            assistant.platformUrl,
          );
        }
      }

      // Check for completion: require the end sentinel before looking for the
      // exit code sentinel. The exit code string also appears in the command
      // echo (the shell printing what was typed), so matching it alone would
      // trigger a premature abort before the command even starts running.
      if (commandSent) {
        const accumulated = Buffer.concat(output).toString("utf-8");
        // Normalize CR so CRLF line endings from the PTY don't prevent matching
        const normalized = accumulated.replace(/\r/g, "");
        if (
          normalized.includes(endSentinel + "\n") &&
          normalized.includes(exitCodeSentinel)
        ) {
          dbg(
            `end + exit code sentinels detected — waiting 500ms for final output`,
          );
          // Give a moment for final output to arrive
          setTimeout(() => abortController.abort(), 500);
        }
      }
    }
  } catch {
    // Expected: abort on timeout or sentinel detection
  } finally {
    if (timeout) clearTimeout(timeout);
    dbg(`stream ended after ${eventCount} events — closing session`);
    await closeTerminalSession(
      assistant.token,
      assistant.assistantId,
      sessionId,
      assistant.platformUrl,
    ).catch(() => {});
  }

  const raw = Buffer.concat(output).toString("utf-8");

  if (verbose) {
    dbg(`--- raw output (${raw.length} chars) ---`);
    console.error(raw);
    dbg(`--- end raw output ---`);
  }

  const clean = stripAnsi(raw);

  if (verbose) {
    dbg(`--- cleaned output (${clean.length} chars) ---`);
    console.error(clean);
    dbg(`--- end cleaned output ---`);
  }

  const { output: result, exitCode } = parseSentinelOutput(
    clean,
    startSentinel,
    endSentinel,
  );

  dbg(`extracted result: ${result.length} chars, exit code: ${exitCode}`);

  if (timedOut && !result) {
    const secs = timeoutMs / 1000;
    console.error(
      `\x1b[31mError: command timed out after ${secs}s with no output.\x1b[0m`,
    );
    console.error(
      `\x1b[2mTip: use --timeout <seconds> to increase the limit, or --timeout 0 to disable.\x1b[0m`,
    );
    process.exit(124);
  }

  if (timedOut && result) {
    const secs = timeoutMs / 1000;
    process.stdout.write(result + "\n");
    console.error(
      `\x1b[33mWarning: command timed out after ${secs}s (partial output above).\x1b[0m`,
    );
    process.exit(124);
  }

  if (result) {
    process.stdout.write(result + "\n");
  } else {
    dbg(`no output extracted between sentinels`);
  }

  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Exported helpers — pure functions extracted for testability
// ---------------------------------------------------------------------------

const EXIT_CODE_SENTINEL = "__VELLUM_EXIT_";

/**
 * Strip ANSI escape sequences and carriage returns from raw PTY output.
 */
export function stripAnsi(raw: string): string {
  return raw.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
    /\x1b\[[?]?[0-9;]*[a-zA-Z-~]|\x1b\][^\x07]*\x07|\x1b[()][^\n]|\r/g,
    "",
  );
}

export interface ParsedSentinelOutput {
  output: string;
  exitCode: number;
}

/**
 * Extract command output and exit code from cleaned (ANSI-stripped) terminal
 * output using sentinel markers.
 *
 * Each sentinel appears twice: once in the command echo (the shell printing
 * what was typed) and once in the actual output. We find the last start
 * sentinel then search forward for the first end sentinel after it.
 */
export function parseSentinelOutput(
  cleaned: string,
  startSentinel: string,
  endSentinel: string,
): ParsedSentinelOutput {
  const lines = cleaned.split("\n");

  // Find the last start sentinel (the real output one, not the echo)
  let startIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(startSentinel)) {
      startIdx = i;
      break;
    }
  }

  // Find the first end sentinel after the start sentinel
  let endIdx = -1;
  if (startIdx >= 0) {
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].includes(endSentinel)) {
        endIdx = i;
        break;
      }
    }
  }

  const start = startIdx >= 0 ? startIdx + 1 : 0;
  const end = endIdx >= 0 ? endIdx : lines.length;
  const output = lines.slice(start, end).join("\n").trim();

  // Extract exit code — search backwards from the end
  let exitCode = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(EXIT_CODE_SENTINEL)) {
      const match = lines[i].match(/__VELLUM_EXIT_(\d+)/);
      if (match) {
        exitCode = parseInt(match[1], 10);
      }
      break;
    }
  }

  return { output, exitCode };
}
