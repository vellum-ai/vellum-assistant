/**
 * Shared interactive confirmation for destructive CLI commands (retire, unpair,
 * …). Per cli/AGENTS.md, a command that removes assistant state must print the
 * resolved identity and require confirmation, with a `--yes` bypass for
 * automation.
 */

/** True only when we can run an interactive raw-mode confirmation prompt. */
export function canPromptForConfirmation(): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    typeof process.stdin.setRawMode === "function"
  );
}

/**
 * Show `prompt` and resolve true on Enter, false on Esc/q/Ctrl-C. Restores the
 * prior stdin raw/paused state on exit. Caller must gate on
 * {@link canPromptForConfirmation} first.
 *
 * `unref()`s stdin on cleanup so the resumed handle doesn't keep the process
 * alive after the prompt resolves.
 */
export async function confirmAction(prompt: string): Promise<boolean> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw === true;
  const wasPaused = stdin.isPaused();

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();

  return await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      if (wasPaused) {
        stdin.pause();
      }
      stdin.unref?.();
      stdout.write("\n");
    };

    const onData = (chunk: Buffer) => {
      const byte = chunk[0];
      if (byte === 13 || byte === 10) {
        cleanup();
        resolve(true);
        return;
      }
      if (byte === 27 || byte === 3 || byte === 113 || byte === 81) {
        cleanup();
        resolve(false);
      }
    };

    stdin.on("data", onData);
  });
}
