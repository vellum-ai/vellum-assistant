// Slash command catalog — web-platform subset of ChatSlashCommandCatalog.allCommands.

/** Matches a bare `/` or `/filter` occupying the entire input. */
export const SLASH_PREFIX_RE = /^\/(\w*)$/;

export type SlashCommandSelectionBehavior = "autoSend" | "insertTrailingSpace";

export interface SlashCommand {
  name: string;
  description: string;
  selectionBehavior: SlashCommandSelectionBehavior;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "commands",
    description: "List all available commands",
    selectionBehavior: "autoSend",
  },
  {
    name: "compact",
    description: "Force context compaction immediately",
    selectionBehavior: "autoSend",
  },
  {
    name: "clean",
    description:
      "Strip injected runtime context and reset memory injection state",
    selectionBehavior: "autoSend",
  },
  {
    name: "models",
    description: "List all available models",
    selectionBehavior: "autoSend",
  },
  {
    name: "status",
    description: "Show conversation status and context usage",
    selectionBehavior: "autoSend",
  },
  {
    name: "doctor",
    description:
      "Open the Doctor with a first message (e.g. /doctor fix my profiles)",
    selectionBehavior: "insertTrailingSpace",
  },
  {
    name: "btw",
    description: "Ask a side question while the assistant is working",
    selectionBehavior: "insertTrailingSpace",
  },
];

/**
 * Matches `/doctor` optionally followed by a first message. `\s+` requires a
 * boundary after the command word so lookalikes (`/doctorfoo`) don't match.
 */
const DOCTOR_COMMAND_RE = /^\/doctor(?:\s+([\s\S]*))?$/i;

/**
 * Parses a `/doctor <message>` invocation. Returns the trimmed first message
 * (empty string when `/doctor` is sent alone) or `null` when `input` is not a
 * doctor command. Unlike the local meta commands, `/doctor` navigates to the
 * Doctor panel rather than starting an assistant turn.
 */
export function parseDoctorCommand(input: string): string | null {
  const match = input.trim().match(DOCTOR_COMMAND_RE);
  if (!match) {
    return null;
  }
  return (match[1] ?? "").trim();
}

/**
 * Slash commands handled locally without starting an assistant turn. They are
 * resolved via the daemon's meta-command endpoint and rendered as an ephemeral
 * card at the transcript tail. `/compact` is intentionally excluded — it runs
 * the LLM (summarization) and is a real turn.
 */
const LOCAL_META_COMMAND_NAMES = new Set([
  "clean",
  "status",
  "commands",
  "models",
]);

/** True when `input` invokes a local meta command (e.g. `/clean`, `/status`). */
export function isLocalMetaCommand(input: string): boolean {
  const match = input.trim().match(/^\/([a-z]+)(?:\s|$)/i);
  return match ? LOCAL_META_COMMAND_NAMES.has(match[1].toLowerCase()) : false;
}

/**
 * True when `input` is a command the send resolves on its own, so nothing about
 * it ever becomes a chat message.
 *
 * The union of the two turn-free early returns in `useSendMessage`'s
 * `sendMessage`: `/doctor`, which navigates to the Doctor panel, and the local
 * meta commands, which render an ephemeral card. Stated once so a caller that
 * has to know BEFORE handing content to the send cannot drift from what the
 * send then does with it. A command added to either of those returns belongs
 * here too.
 *
 * Read it against the same assembled content the send is given, not the raw
 * draft: a staged quote or channel reference leads the message, which makes
 * `/status` ordinary text there, and the send agrees.
 */
export function isLocallyHandledCommand(input: string): boolean {
  return parseDoctorCommand(input) !== null || isLocalMetaCommand(input);
}

/** Returns commands whose name starts with `filter` (case-insensitive). Empty filter returns all. */
export function filteredCommands(filter: string): SlashCommand[] {
  if (!filter) {
    return SLASH_COMMANDS;
  }
  const lower = filter.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(lower));
}

/** Returns the input text to set after selecting a command. */
export function selectedInputText(command: SlashCommand): string {
  return command.selectionBehavior === "autoSend"
    ? `/${command.name}`
    : `/${command.name} `;
}
