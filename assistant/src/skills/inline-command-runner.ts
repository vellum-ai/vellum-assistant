/**
 * Sandbox-only runner for inline command expansions (`!\`command\``).
 *
 * Executes the literal command string in the sandbox without going through the
 * general `bash` tool's permission path. Security constraints:
 *
 * - Network mode forced off (no outbound connections)
 * - Sanitized environment variables only (no API keys, tokens, credentials)
 * - No credential proxy, no CES client, no host fallback
 * - Uses the conversation working directory as `cwd` so repo-local commands
 *   remain interoperable with externally authored skills that expect project
 *   context.
 *
 * Output handling:
 * - Captures stdout only (stderr is discarded)
 * - Strips ANSI escape sequences
 * - Rejects binary-ish output
 * - Clamps output to a fixed cap
 * - Returns deterministic sanitized error results for timeout, non-zero exit,
 *   or spawn failures (no raw stderr dumps)
 */

import { spawn } from "node:child_process";

import { getConfig } from "../config/loader.js";
import { buildSanitizedEnv } from "../tools/terminal/safe-env.js";
import { wrapCommand } from "../tools/terminal/sandbox.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("inline-command-runner");

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum wall-clock time for an inline command before it is killed. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Maximum output characters before truncation. */
const MAX_OUTPUT_CHARS = 20_000;

/**
 * ANSI escape sequence pattern (covers SGR, cursor movement, erase, etc.).
 * Matches: ESC[ ... final_byte  and  ESC] ... ST  (OSC sequences).
 */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/**
 * Heuristic for binary output: if more than 10% of the characters are
 * non-printable (control chars excluding \t, \n, \r) then reject.
 */
const BINARY_THRESHOLD = 0.1;

// ─── Result type ─────────────────────────────────────────────────────────────

/** Deterministic result shape returned by the inline command runner. */
export interface InlineCommandResult {
  /** The sanitized stdout output, or a human-readable error description. */
  output: string;
  /** Whether the command completed successfully. */
  ok: boolean;
  /**
   * Machine-readable failure reason.
   * - `"timeout"` — command exceeded the wall-clock limit
   * - `"non_zero_exit"` — command exited with a non-zero code
   * - `"binary_output"` — stdout contained binary-ish data
   * - `"spawn_failure"` — the subprocess could not be spawned
   * - `undefined` — success
   */
  failureReason?:
    | "timeout"
    | "non_zero_exit"
    | "binary_output"
    | "spawn_failure";
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface InlineCommandRunnerOptions {
  /** Override the default timeout (ms). */
  timeoutMs?: number;
  /** Override the default output cap (chars). */
  maxOutputChars?: number;
}

/**
 * Run an inline command expansion in the sandbox.
 *
 * @param command  The literal command string from the `!\`...\`` token.
 * @param workingDir  The conversation's working directory (repo root).
 * @param options  Optional overrides for timeout and output cap.
 */
export async function runInlineCommand(
  command: string,
  workingDir: string,
  options?: InlineCommandRunnerOptions,
): Promise<InlineCommandResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = options?.maxOutputChars ?? MAX_OUTPUT_CHARS;

  // Build sandbox-wrapped command. Always use the sandbox config with
  // network forced off — inline commands never need network access.
  const config = getConfig();
  const sandboxConfig = { ...config.sandbox, enabled: true };

  const wrapped = wrapCommand(command, workingDir, sandboxConfig, {
    networkMode: "off",
  });

  // Build a minimal, sanitized environment. Explicitly exclude gateway URL
  // and workspace dir since inline commands have no business calling internal
  // APIs or mutating workspace state.
  const env = buildSanitizedEnv();
  delete env.INTERNAL_GATEWAY_BASE_URL;
  delete env.VELLUM_WORKSPACE_DIR;

  return new Promise<InlineCommandResult>((resolve) => {
    let timedOut = false;
    const stdoutChunks: Buffer[] = [];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(wrapped.command, wrapped.args, {
        cwd: workingDir,
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ command, error: message }, "Failed to spawn inline command");
      resolve({
        output: "Inline command could not be started.",
        ok: false,
        failureReason: "spawn_failure",
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout!.on("data", (data: Buffer) => stdoutChunks.push(data));

    child.on("close", (code) => {
      clearTimeout(timer);

      // ── Timeout ──────────────────────────────────────────────────────
      if (timedOut) {
        log.debug({ command, timeoutMs }, "Inline command timed out");
        resolve({
          output: `Inline command timed out after ${timeoutMs}ms.`,
          ok: false,
          failureReason: "timeout",
        });
        return;
      }

      // ── Non-zero exit ────────────────────────────────────────────────
      if (code !== 0) {
        log.debug(
          { command, exitCode: code },
          "Inline command exited with non-zero code",
        );
        resolve({
          output: `Inline command failed (exit code ${code}).`,
          ok: false,
          failureReason: "non_zero_exit",
        });
        return;
      }

      // ── Process stdout ───────────────────────────────────────────────
      const raw = Buffer.concat(stdoutChunks).toString("utf-8");

      // Strip ANSI sequences first — these are terminal artifacts, not
      // binary data. Stripping before the binary check prevents legitimate
      // color-coded tool output from being rejected.
      let cleaned = raw.replace(ANSI_RE, "");

      // Reject binary-ish output (after ANSI stripping)
      if (isBinaryish(cleaned)) {
        log.debug({ command }, "Inline command produced binary-ish output");
        resolve({
          output: "Inline command produced binary output.",
          ok: false,
          failureReason: "binary_output",
        });
        return;
      }

      // Clamp to max output
      if (cleaned.length > maxChars) {
        cleaned = cleaned.slice(0, maxChars) + "\n[output truncated]";
      }

      // Trim trailing whitespace
      cleaned = cleaned.trimEnd();

      resolve({
        output: cleaned,
        ok: true,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      log.warn({ command, error: err.message }, "Inline command spawn error");
      resolve({
        output: "Inline command could not be started.",
        ok: false,
        failureReason: "spawn_failure",
      });
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Heuristic check for binary output. Returns true if more than
 * {@link BINARY_THRESHOLD} of the characters are non-printable control
 * characters (excluding tab, newline, carriage return).
 */
function isBinaryish(text: string): boolean {
  if (text.length === 0) return false;

  let controlCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Control characters: 0x00-0x1F (excluding \t=0x09, \n=0x0A, \r=0x0D)
    // and 0x7F (DEL)
    if (
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    ) {
      controlCount++;
    }
  }

  return controlCount / text.length > BINARY_THRESHOLD;
}
