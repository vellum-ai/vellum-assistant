export type ClientCommandGroup = "conversation" | "message" | "utility";

export interface ClientCommandEntry {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
  group: ClientCommandGroup;
}

export interface ParsedClientCommand {
  entry: ClientCommandEntry;
  command: string;
  args: string;
}

export const CLIENT_COMMANDS: ClientCommandEntry[] = [
  {
    name: "/new",
    usage: "/new [title]",
    description: "Start a new conversation",
    group: "conversation",
  },
  {
    name: "/resume",
    usage: "/resume [search]",
    description: "Search and resume an earlier conversation",
    group: "conversation",
  },
  {
    name: "/rename",
    usage: "/rename <title>",
    description: "Rename the current conversation",
    group: "conversation",
  },
  {
    name: "/archive",
    usage: "/archive",
    description: "Archive the current conversation",
    group: "conversation",
  },
  {
    name: "/btw",
    usage: "/btw <question>",
    description: "Ask a side question in the current conversation",
    group: "message",
  },
  {
    name: "/copy",
    usage: "/copy [all]",
    description: "Copy the last response or full conversation",
    group: "message",
  },
  {
    name: "/export",
    usage: "/export [path]",
    description: "Export the current conversation as Markdown",
    group: "message",
  },
  {
    name: "/clear",
    usage: "/clear",
    description: "Clear the current screen",
    group: "utility",
  },
  {
    name: "/help",
    aliases: ["?"],
    usage: "/help",
    description: "Show commands and keyboard shortcuts",
    group: "utility",
  },
  {
    name: "/exit",
    aliases: ["/quit", "/q"],
    usage: "/exit",
    description: "Exit the terminal client",
    group: "utility",
  },
];

export const KEYBOARD_SHORTCUTS = [
  { keys: "Enter", description: "Send message or confirm selection" },
  { keys: "Tab", description: "Accept or cycle command completion" },
  { keys: "Shift+Tab", description: "Cycle command completion backward" },
  { keys: "Up/Down", description: "Navigate history or picker options" },
  { keys: "Shift+Up/Down", description: "Scroll conversation" },
  { keys: "Cmd+Up/Down", description: "Jump to top or bottom" },
  { keys: "Esc", description: "Cancel an open modal" },
  { keys: "Ctrl+C", description: "Exit" },
] as const;

export function allCommandNames(
  commands: readonly ClientCommandEntry[] = CLIENT_COMMANDS,
): string[] {
  return commands.flatMap((command) => [
    command.name,
    ...(command.aliases ?? []),
  ]);
}

export function parseClientCommand(
  input: string,
  commands: readonly ClientCommandEntry[] = CLIENT_COMMANDS,
): ParsedClientCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const firstSpace = trimmed.search(/\s/);
  const command =
    firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace).trim();
  if (!command.startsWith("/") && command !== "?") return null;

  const entry = commands.find(
    (candidate) =>
      candidate.name === command || candidate.aliases?.includes(command),
  );
  if (!entry) return null;

  return {
    entry,
    command,
    args: firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim(),
  };
}

export function filterCommandSuggestions(
  input: string,
  commands: readonly ClientCommandEntry[] = CLIENT_COMMANDS,
): ClientCommandEntry[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/") && trimmed !== "?") return [];

  const query = trimmed.split(/\s/, 1)[0] ?? "";
  if (query === "/") return [...commands];

  return commands.filter((command) => {
    if (command.name.startsWith(query)) return true;
    return command.aliases?.some((alias) => alias.startsWith(query)) ?? false;
  });
}

export function groupCommandsForHelp(
  commands: readonly ClientCommandEntry[] = CLIENT_COMMANDS,
): Record<ClientCommandGroup, ClientCommandEntry[]> {
  return {
    conversation: commands.filter(
      (command) => command.group === "conversation",
    ),
    message: commands.filter((command) => command.group === "message"),
    utility: commands.filter((command) => command.group === "utility"),
  };
}
