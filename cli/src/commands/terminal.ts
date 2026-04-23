/**
 * `vellum terminal` — Interactive shell into a managed assistant container.
 *
 * Bridges the local tty to a platform terminal session (K8s exec) so the
 * user can interact with their assistant's sandbox from iTerm2 or any
 * local terminal emulator.
 *
 * Subcommands:
 *   vellum terminal                     — Interactive shell
 *   vellum terminal attach <name>       — Attach to a tmux session
 *   vellum terminal list                — List tmux sessions
 */

import {
  closeTerminalSession,
  createTerminalSession,
  sendTerminalInput,
  subscribeTerminalEvents,
} from "../lib/terminal-client.js";
import {
  interactiveSession,
  resolveManagedAssistant,
} from "../lib/terminal-session.js";
import type { ResolvedManagedAssistant } from "../lib/terminal-session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log("Usage: vellum terminal [subcommand] [options]");
  console.log("");
  console.log(
    "Open an interactive terminal session into a managed assistant container.",
  );
  console.log("");
  console.log("Subcommands:");
  console.log("  (none)              Interactive shell");
  console.log(
    "  attach <name>       Attach to a tmux session inside the container",
  );
  console.log(
    "  list                List tmux sessions running inside the container",
  );
  console.log("");
  console.log("Options:");
  console.log(
    "  <name>              Name of the assistant (defaults to active)",
  );
  console.log(
    "  --assistant <name>  Explicit assistant name (alternative to positional)",
  );
  console.log("");
  console.log("Examples:");
  console.log("  vellum terminal");
  console.log("  vellum terminal attach my-session");
  console.log("  vellum terminal list");
  console.log("  vellum terminal --assistant my-assistant");
}

// ---------------------------------------------------------------------------
// List tmux sessions
// ---------------------------------------------------------------------------

async function listTmuxSessions(
  assistant: ResolvedManagedAssistant,
): Promise<void> {
  const cols = 120;
  const rows = 24;

  const { session_id: sessionId } = await createTerminalSession(
    assistant.token,
    assistant.assistantId,
    cols,
    rows,
    assistant.platformUrl,
  );

  const abortController = new AbortController();
  const output: string[] = [];
  let commandSent = false;

  try {
    const timeout = setTimeout(() => abortController.abort(), 5000);

    const streamPromise = (async () => {
      for await (const event of subscribeTerminalEvents(
        assistant.token,
        assistant.assistantId,
        sessionId,
        assistant.platformUrl,
        abortController.signal,
      )) {
        const text = Buffer.from(event.data, "base64").toString("utf-8");
        output.push(text);

        // Wait for shell prompt before sending command
        if (!commandSent) {
          const joined = output.join("");
          if (
            joined.includes("$") ||
            joined.includes("#") ||
            joined.includes("%")
          ) {
            commandSent = true;
            await sendTerminalInput(
              assistant.token,
              assistant.assistantId,
              sessionId,
              'tmux list-sessions 2>/dev/null || echo "No tmux sessions found"; exit\r',
              assistant.platformUrl,
            );
          }
        }
      }
    })();

    await streamPromise.catch(() => {});
    clearTimeout(timeout);
  } catch {
    // Expected — abort or stream end
  } finally {
    abortController.abort();
    await closeTerminalSession(
      assistant.token,
      assistant.assistantId,
      sessionId,
      assistant.platformUrl,
    ).catch(() => {});
  }

  // Parse and display results
  const raw = output.join("");
  // Strip ANSI escape sequences for clean parsing
  const clean = raw.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][^\n]|\r/g,
    "",
  );

  // Find tmux output lines (format: "session_name: N windows ...")
  const lines = clean.split("\n");
  const sessionLines = lines.filter(
    (l) =>
      /^\S+:\s+\d+\s+windows?/.test(l.trim()) ||
      l.includes("No tmux sessions found"),
  );

  if (sessionLines.length === 0) {
    console.log("No tmux sessions found.");
  } else {
    for (const line of sessionLines) {
      console.log(line.trim());
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function terminal(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // Parse arguments
  //
  // Accepted forms:
  //   vellum terminal [--assistant <name>]
  //   vellum terminal list [--assistant <name>]
  //   vellum terminal attach <session> [--assistant <name>]
  let subcommand: string | undefined;
  let assistantName: string | undefined;
  let tmuxSessionName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--assistant" && args[i + 1]) {
      assistantName = args[++i];
    } else if (args[i].startsWith("-")) {
      // Skip unknown flags
      continue;
    } else if (!subcommand) {
      // First positional — subcommand or assistant name
      if (args[i] === "list" || args[i] === "attach") {
        subcommand = args[i];
      } else {
        assistantName = args[i];
      }
    } else if (subcommand === "attach" && !tmuxSessionName) {
      // Second positional after "attach" — tmux session name
      tmuxSessionName = args[i];
    } else if (!assistantName) {
      // Trailing positional after subcommand args — assistant name
      assistantName = args[i];
    }
  }

  const assistant = resolveManagedAssistant(assistantName);

  if (subcommand === "list") {
    await listTmuxSessions(assistant);
    return;
  }

  if (subcommand === "attach") {
    if (!tmuxSessionName) {
      console.error("Usage: vellum terminal attach <session-name>");
      console.error(
        "\nUse 'vellum terminal list' to see available tmux sessions.",
      );
      process.exit(1);
    }
    // Shell-escape the session name to handle spaces/metacharacters
    const escaped = tmuxSessionName.replace(/'/g, "'\\''");
    await interactiveSession(assistant, `tmux attach -t '${escaped}'`);
    return;
  }

  // Default: interactive shell
  await interactiveSession(assistant);
}
