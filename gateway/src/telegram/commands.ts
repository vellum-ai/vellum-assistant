/**
 * Canonical Telegram bot command list.
 *
 * Single source of truth for both `setMyCommands` registration and the
 * `/help` reply, so the menu the client shows and the help text the bot
 * prints can never drift apart.
 */
export const TELEGRAM_BOT_COMMANDS = [
  { command: "new", description: "Start a new conversation" },
  { command: "stop", description: "Interrupt the running assistant" },
  { command: "fork", description: "Fork this topic into a new topic" },
  { command: "rename", description: "Rename this topic (guardian)" },
  { command: "archive", description: "Archive this topic and close it" },
  { command: "profile", description: "Choose inference profile" },
  { command: "access", description: "Assistant access mode (guardian)" },
  { command: "help", description: "Show available commands" },
] as const;
