/**
 * Aggregated declarative help for the top-level `assistant` CLI commands that
 * have adopted the static-help split (`<command>.help.ts`).
 *
 * Plugins — notably the memory capability indexer — import this to read command
 * help without importing `cli/program.ts`, which pulls every command's action
 * handler (and its daemon/IPC deps) into the import graph. Entries are pure data
 * (see {@link ./lib/cli-command-help.CliCommandHelp}); consumers iterate them.
 *
 * Extend this as commands adopt the split. Once every command is listed here,
 * the memory indexer no longer needs `buildCliProgramTree()`.
 */

import { attachmentHelp } from "./commands/attachment.help.js";
import { auditHelp } from "./commands/audit.help.js";
import { authHelp } from "./commands/auth.help.js";
import type { CliCommandHelp } from "./lib/cli-command-help.js";

export const CLI_COMMAND_HELP: readonly CliCommandHelp[] = [
  attachmentHelp,
  auditHelp,
  authHelp,
];
