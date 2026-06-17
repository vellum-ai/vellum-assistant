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
  { name: "commands", description: "List all available commands", selectionBehavior: "autoSend" },
  { name: "compact", description: "Force context compaction immediately", selectionBehavior: "autoSend" },
  { name: "clean", description: "Strip injected runtime context and reset memory injection state", selectionBehavior: "autoSend" },
  { name: "models", description: "List all available models", selectionBehavior: "autoSend" },
  { name: "status", description: "Show conversation status and context usage", selectionBehavior: "autoSend" },
  { name: "btw", description: "Ask a side question while the assistant is working", selectionBehavior: "insertTrailingSpace" },
];

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

/** Returns commands whose name starts with `filter` (case-insensitive). Empty filter returns all. */
export function filteredCommands(filter: string): SlashCommand[] {
  if (!filter) return SLASH_COMMANDS;
  const lower = filter.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(lower));
}

/** Returns the input text to set after selecting a command. */
export function selectedInputText(command: SlashCommand): string {
  return command.selectionBehavior === "autoSend"
    ? `/${command.name}`
    : `/${command.name} `;
}
