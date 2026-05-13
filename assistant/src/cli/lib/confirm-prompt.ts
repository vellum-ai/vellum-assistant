/**
 * Interactive y/N prompt for destructive CLI subcommands. Uses
 * `readline.createInterface` so EOF (Ctrl+D) is reported via the
 * `close` event rather than hanging the process indefinitely.
 *
 * Returns one of:
 *  - `"confirmed"`            user answered y/yes
 *  - `"denied"`               user answered anything else (incl. EOF)
 *  - `"non-interactive"`      stdin is not a TTY and the prompt was
 *                             refused before any read happened
 *
 * Callers decide what each outcome means for `process.exitCode`. The
 * convention used by `assistant plugins uninstall` is:
 *   confirmed       → proceed
 *   denied          → print "cancelled.", exit 0
 *   non-interactive → exit 1 (script must pass `--force`)
 */

import readline from "node:readline";

export type ConfirmResult = "confirmed" | "denied" | "non-interactive";

export interface ConfirmPromptOptions {
  /** The line written to stdout before reading. Should end with a space. */
  question: string;
  /** Whether stdin is attached to a TTY. Inject for testability. */
  isTTY: boolean;
  /**
   * Message written to stderr when stdin is not a TTY. The caller chooses
   * the wording so it can name the subject (plugin, file, command, etc.).
   */
  refuseNonInteractiveMessage: string;
  /** Stream to read the answer from. Defaults to `process.stdin`. */
  stdin?: NodeJS.ReadableStream;
  /** Stream to write the prompt to. Defaults to `process.stdout`. */
  stdout?: NodeJS.WritableStream;
  /** Stream for the non-interactive refusal. Defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
}

/**
 * Pattern matched against the trimmed user response to decide
 * confirmation. Case-insensitive. Anything else (including the empty
 * string surfaced on EOF) is treated as denial — never trust silence
 * to mean yes on a destructive prompt.
 */
const CONFIRM_PATTERN = /^(y|yes)$/i;

export async function confirmPrompt(
  opts: ConfirmPromptOptions,
): Promise<ConfirmResult> {
  const stderr = opts.stderr ?? process.stderr;

  if (!opts.isTTY) {
    stderr.write(`${opts.refuseNonInteractiveMessage}\n`);
    return "non-interactive";
  }

  const rl = readline.createInterface({
    input: opts.stdin ?? process.stdin,
    output: opts.stdout ?? process.stdout,
    terminal: false,
  });

  const answer = await new Promise<string>((resolve) => {
    let settled = false;
    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rl.question(opts.question, (line) => settle(line));
    rl.on("close", () => settle(""));
  });

  rl.close();

  return CONFIRM_PATTERN.test(answer.trim()) ? "confirmed" : "denied";
}
